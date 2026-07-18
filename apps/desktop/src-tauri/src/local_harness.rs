use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::env;
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::ipc::Channel;
use tauri::State;

const PROCESS_TIMEOUT: Duration = Duration::from_secs(20 * 60);
const PROCESS_OUTPUT_LIMIT: usize = 20 * 1024 * 1024;
const PROCESS_POLL_INTERVAL: Duration = Duration::from_millis(50);
const PROCESS_KILL_GRACE: Duration = Duration::from_secs(2);

type HeartbeatCallback = Arc<dyn Fn() + Send + Sync>;
type LineCallback = Arc<dyn Fn(&str) + Send + Sync>;

#[derive(Clone, Default)]
pub struct HarnessProcessState {
    active: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
}

impl HarnessProcessState {
    fn register(&self, request_id: &str) -> Result<Arc<AtomicBool>, String> {
        if !valid_request_id(request_id) {
            return Err("Invalid local harness request ID".to_string());
        }
        let mut active = self
            .active
            .lock()
            .map_err(|_| "Harness state is unavailable")?;
        if active.contains_key(request_id) {
            return Err("A local harness request with this ID is already running".to_string());
        }
        let cancelled = Arc::new(AtomicBool::new(false));
        active.insert(request_id.to_string(), cancelled.clone());
        Ok(cancelled)
    }

    fn finish(&self, request_id: &str) {
        if let Ok(mut active) = self.active.lock() {
            active.remove(request_id);
        }
    }

    fn cancel(&self, request_id: &str) -> bool {
        self.active
            .lock()
            .ok()
            .and_then(|active| active.get(request_id).cloned())
            .map(|cancelled| {
                cancelled.store(true, Ordering::SeqCst);
                true
            })
            .unwrap_or(false)
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelRequest {
    workspace_path: Option<String>,
    model_id: String,
    reasoning_effort: Option<String>,
    #[serde(default)]
    messages: Vec<ModelMessage>,
    structured_output: Option<StructuredOutput>,
    #[allow(dead_code)]
    temperature: Option<f64>,
    #[allow(dead_code)]
    max_tokens: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct ModelMessage {
    role: String,
    content: String,
}

#[derive(Debug, Deserialize)]
struct StructuredOutput {
    name: String,
    schema: Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelResponse {
    content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    structured_output: Option<Value>,
    tool_calls: Vec<Value>,
    finish_reason: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodingIterationRequest {
    goal: String,
    workspace_path: String,
    model_id: String,
    previous_plan: Option<Value>,
    #[serde(default)]
    judge_feedback: Vec<String>,
    iteration: u32,
    max_iterations: u32,
    reasoning_effort: Option<String>,
    permission_mode: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodingIterationResult {
    changed_files: Vec<String>,
    validation_results: Vec<Value>,
    agent_summary: String,
    tool_calls: Vec<Value>,
    messages: Vec<Value>,
}

#[derive(Debug)]
pub(crate) struct ProcessCapture {
    pub(crate) stdout: String,
    pub(crate) stderr: String,
    pub(crate) exit_code: i32,
}

#[derive(Debug, Default, Clone)]
struct KiloRun {
    summary: String,
    tool_calls: Vec<Value>,
}

#[derive(Debug, Default, Clone)]
struct KimiRun {
    summary: String,
    tool_calls: Vec<Value>,
}

#[tauri::command]
pub async fn local_harness_models(provider_id: String) -> Result<Vec<Value>, String> {
    tauri::async_runtime::spawn_blocking(move || match provider_id.as_str() {
        "codex" => load_codex_models(),
        "kilo" => load_kilo_models(),
        "kimi" => load_kimi_models(),
        _ => Err("Unsupported local harness provider".to_string()),
    })
    .await
    .map_err(|error| format!("Local model discovery task failed: {error}"))?
}

#[tauri::command]
pub async fn local_harness_health() -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(harness_health)
        .await
        .map_err(|error| format!("Local harness health task failed: {error}"))?
}

fn harness_health() -> Result<Value, String> {
    let codex_installed = resolve_executable("codex").is_ok();
    let codex_auth = if !codex_installed {
        "unknown"
    } else if codex_home().is_some_and(|home| home.join("auth.json").is_file()) {
        "yes"
    } else {
        "no"
    };
    let kilo_installed = resolve_executable("kilo").is_ok();
    let (kilo_auth, kilo_detail) = if !kilo_installed {
        ("unknown", None)
    } else {
        match load_kilo_models() {
            Ok(_) => ("yes", None),
            Err(error) => ("unknown", Some(error)),
        }
    };
    let kimi_installed = resolve_executable("kimi").is_ok();
    let (kimi_auth, kimi_detail) = if !kimi_installed {
        ("unknown", None)
    } else {
        match load_kimi_models() {
            Ok(_) => ("yes", None),
            Err(error) => ("unknown", Some(error)),
        }
    };
    Ok(json!({
        "codex": { "installed": codex_installed, "authenticated": codex_auth },
        "kilo": { "installed": kilo_installed, "authenticated": kilo_auth, "detail": kilo_detail },
        "kimi": { "installed": kimi_installed, "authenticated": kimi_auth, "detail": kimi_detail },
    }))
}

#[tauri::command]
pub async fn local_harness_response(
    provider_id: String,
    request_id: String,
    request: ModelRequest,
    on_event: Channel<Value>,
    state: State<'_, HarnessProcessState>,
) -> Result<ModelResponse, String> {
    let owned_state = state.inner().clone();
    let cancelled = owned_state.register(&request_id)?;
    let task_request_id = request_id.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let result = run_response(&provider_id, request, cancelled, on_event);
        owned_state.finish(&task_request_id);
        result
    })
    .await
    .map_err(|error| format!("Local harness response task failed: {error}"))?;
    // A panicking worker cannot execute its cleanup closure.
    state.finish(&request_id);
    result
}

#[tauri::command]
pub async fn local_harness_coding_iteration(
    provider_id: String,
    request_id: String,
    request: CodingIterationRequest,
    on_event: Channel<Value>,
    state: State<'_, HarnessProcessState>,
) -> Result<CodingIterationResult, String> {
    let owned_state = state.inner().clone();
    let cancelled = owned_state.register(&request_id)?;
    let task_request_id = request_id.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let result = run_coding_iteration(&provider_id, request, cancelled, on_event);
        owned_state.finish(&task_request_id);
        result
    })
    .await
    .map_err(|error| format!("Local harness coding task failed: {error}"))?;
    state.finish(&request_id);
    result
}

#[tauri::command]
pub fn local_harness_cancel(request_id: String, state: State<'_, HarnessProcessState>) -> bool {
    state.cancel(&request_id)
}

fn run_response(
    provider_id: &str,
    request: ModelRequest,
    cancelled: Arc<AtomicBool>,
    on_event: Channel<Value>,
) -> Result<ModelResponse, String> {
    let workspace = require_git_workspace(request.workspace_path.as_deref())?;
    let prompt = build_judge_prompt(&request.messages, request.structured_output.as_ref());
    match provider_id {
        "codex" => {
            let runtime_model = runtime_model_id("codex", &request.model_id)?;
            let mut output = tempfile::NamedTempFile::new()
                .map_err(|error| format!("Could not create Codex output file: {error}"))?;
            output.flush().map_err(|error| error.to_string())?;
            let mut schema_file = None;
            if let Some(structured) = request.structured_output.as_ref() {
                let mut file = tempfile::NamedTempFile::new()
                    .map_err(|error| format!("Could not create Codex schema file: {error}"))?;
                serde_json::to_writer(&mut file, &structured.schema)
                    .map_err(|error| format!("Could not write Codex schema: {error}"))?;
                file.flush().map_err(|error| error.to_string())?;
                schema_file = Some(file);
            }
            let args = build_codex_judge_args(
                &workspace,
                &runtime_model,
                &prompt,
                output.path(),
                schema_file.as_ref().map(|file| file.path()),
                request.reasoning_effort.as_deref(),
            );
            run_process("codex", &args, &workspace, cancelled, None)?;
            let content = fs::read_to_string(output.path())
                .map_err(|error| format!("Could not read Codex response: {error}"))?;
            Ok(ModelResponse {
                structured_output: serde_json::from_str(&content).ok(),
                content,
                tool_calls: Vec::new(),
                finish_reason: "stop".to_string(),
            })
        }
        "kilo" => {
            let runtime_model = kilo_runtime_model_id(&request.model_id)?;
            let run = run_kilo(
                &workspace,
                &runtime_model,
                &prompt,
                "judge",
                None,
                cancelled,
                None,
            )?;
            if !run.summary.is_empty() {
                let _ = on_event.send(json!({ "type": "content_delta", "content": run.summary }));
            }
            let structured_output = request
                .structured_output
                .as_ref()
                .and_then(|_| try_parse_structured_output(&run.summary));
            Ok(ModelResponse {
                content: run.summary,
                structured_output,
                tool_calls: Vec::new(),
                finish_reason: "stop".to_string(),
            })
        }
        "kimi" => {
            let runtime_model = runtime_model_id("kimi", &request.model_id)?;
            let run = run_kimi(
                &workspace,
                &runtime_model,
                &prompt,
                "judge",
                None,
                cancelled,
                None,
            )?;
            if !run.summary.is_empty() {
                let _ = on_event.send(json!({ "type": "content_delta", "content": run.summary }));
            }
            let structured_output = request
                .structured_output
                .as_ref()
                .and_then(|_| try_parse_structured_output(&run.summary));
            Ok(ModelResponse {
                content: run.summary,
                structured_output,
                tool_calls: Vec::new(),
                finish_reason: "stop".to_string(),
            })
        }
        _ => Err("Unsupported local harness provider".to_string()),
    }
}

fn run_coding_iteration(
    provider_id: &str,
    request: CodingIterationRequest,
    cancelled: Arc<AtomicBool>,
    on_event: Channel<Value>,
) -> Result<CodingIterationResult, String> {
    let workspace = require_git_workspace(Some(&request.workspace_path))?;
    let prompt = build_worker_prompt(&request);
    send_status(
        &on_event,
        &format!(
            "Initializing {} agent…",
            provider_display_name(provider_id)?
        ),
    );

    let (summary, tool_calls) = match provider_id {
        "codex" => {
            let runtime_model = runtime_model_id("codex", &request.model_id)?;
            let output = tempfile::NamedTempFile::new()
                .map_err(|error| format!("Could not create Codex output file: {error}"))?;
            send_status(&on_event, &format!("Starting Codex {runtime_model}…"));
            let args = build_codex_worker_args(
                &workspace,
                &runtime_model,
                &prompt,
                output.path(),
                request.reasoning_effort.as_deref(),
            );
            let heartbeat_channel = on_event.clone();
            run_process(
                "codex",
                &args,
                &workspace,
                cancelled,
                Some(Arc::new(move || {
                    send_heartbeat(&heartbeat_channel, "Codex")
                })),
            )?;
            let summary = fs::read_to_string(output.path())
                .map_err(|error| format!("Could not read Codex worker summary: {error}"))?;
            (summary, Vec::new())
        }
        "kilo" => {
            let runtime_model = kilo_runtime_model_id(&request.model_id)?;
            send_status(&on_event, &format!("Starting Kilo {runtime_model}…"));
            let run = run_kilo(
                &workspace,
                &runtime_model,
                &prompt,
                "worker",
                request.permission_mode.as_deref(),
                cancelled,
                Some(on_event.clone()),
            )?;
            (run.summary, run.tool_calls)
        }
        "kimi" => {
            let runtime_model = runtime_model_id("kimi", &request.model_id)?;
            send_status(&on_event, &format!("Starting Kimi {runtime_model}…"));
            let run = run_kimi(
                &workspace,
                &runtime_model,
                &prompt,
                "worker",
                request.permission_mode.as_deref(),
                cancelled,
                Some(on_event.clone()),
            )?;
            (run.summary, run.tool_calls)
        }
        _ => return Err("Unsupported local harness provider".to_string()),
    };

    send_status(
        &on_event,
        &format!(
            "{} finished; collecting changes…",
            provider_display_name(provider_id)?
        ),
    );
    let changed_files = git_changed_files(&workspace)?;
    for path in &changed_files {
        let _ = on_event.send(json!({ "type": "file_changed", "path": path }));
    }
    if !summary.is_empty() {
        let _ = on_event.send(json!({
            "type": "agent_message",
            "content": summary,
            "messageId": unique_id("message"),
        }));
    }
    Ok(CodingIterationResult {
        changed_files,
        validation_results: Vec::new(),
        agent_summary: summary,
        tool_calls,
        messages: Vec::new(),
    })
}

fn codex_home() -> Option<PathBuf> {
    env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|home| home.join(".codex")))
}

fn load_codex_models() -> Result<Vec<Value>, String> {
    let home =
        codex_home().ok_or_else(|| "Could not determine the Codex home directory".to_string())?;
    let content = fs::read_to_string(home.join("models_cache.json"))
        .map_err(|error| format!("Codex model cache unavailable: {error}"))?;
    let cache: Value = serde_json::from_str(&content)
        .map_err(|error| format!("Codex model cache is invalid: {error}"))?;
    Ok(cache
        .get("models")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|model| {
            model.get("visibility").and_then(Value::as_str) == Some("list")
                && model.get("supported_in_api").and_then(Value::as_bool) != Some(false)
        })
        .cloned()
        .collect())
}

fn load_kilo_models() -> Result<Vec<Value>, String> {
    let cwd =
        dirs::home_dir().ok_or_else(|| "Could not determine the home directory".to_string())?;
    let capture = run_process(
        "kilo",
        &["models".to_string()],
        &cwd,
        Arc::new(AtomicBool::new(false)),
        None,
    )?;
    Ok(capture
        .stdout
        .lines()
        .map(str::trim)
        .filter(|id| id.starts_with("kilo/") && id.len() > "kilo/".len())
        .map(|runtime_id| {
            let display_name = runtime_id
                .rsplit('/')
                .next()
                .unwrap_or(runtime_id)
                .replace(['-', '_'], " ");
            json!({
                "id": format!("kilo/{runtime_id}"),
                "provider": "kilo",
                "displayName": title_case(&display_name),
                "supportsTools": true,
                "supportsStructuredOutput": false,
                "supportsReasoning": true,
                "supportsAsk": true,
                "supportsGoal": true,
                "supportsJudge": true,
            })
        })
        .collect())
}

fn load_kimi_models() -> Result<Vec<Value>, String> {
    let cwd =
        dirs::home_dir().ok_or_else(|| "Could not determine the home directory".to_string())?;
    let capture = run_process(
        "kimi",
        &["provider", "list", "--json"].map(String::from),
        &cwd,
        Arc::new(AtomicBool::new(false)),
        None,
    )?;
    parse_kimi_models_from_json(&capture.stdout)
}

fn parse_kimi_models_from_json(output: &str) -> Result<Vec<Value>, String> {
    let catalog: Value = serde_json::from_str(output)
        .map_err(|error| format!("Kimi model catalog is invalid: {error}"))?;
    let models = catalog
        .get("models")
        .and_then(Value::as_object)
        .ok_or_else(|| "Kimi model catalog has no models".to_string())?;
    Ok(models
        .iter()
        .map(|(alias, model)| {
            let capabilities: Vec<&str> = model
                .get("capabilities")
                .and_then(Value::as_array)
                .map(|capabilities| capabilities.iter().filter_map(Value::as_str).collect())
                .unwrap_or_default();
            let display_name = model
                .get("displayName")
                .and_then(Value::as_str)
                .map(String::from)
                .unwrap_or_else(|| {
                    title_case(
                        &alias
                            .rsplit('/')
                            .next()
                            .unwrap_or(alias)
                            .replace(['-', '_'], " "),
                    )
                });
            json!({
                "id": format!("kimi/{alias}"),
                "provider": "kimi",
                "displayName": display_name,
                "supportsTools": capabilities.contains(&"tool_use"),
                "supportsStructuredOutput": false,
                "supportsReasoning": capabilities.contains(&"thinking"),
                "supportsAsk": true,
                "supportsGoal": true,
                "supportsJudge": true,
            })
        })
        .collect())
}

fn run_kilo(
    workspace: &Path,
    runtime_model: &str,
    prompt: &str,
    role: &str,
    permission_mode: Option<&str>,
    cancelled: Arc<AtomicBool>,
    event_channel: Option<Channel<Value>>,
) -> Result<KiloRun, String> {
    let args = build_kilo_args(workspace, runtime_model, prompt, role);
    let config = build_kilo_security_config(role, permission_mode)?;
    let collector = Arc::new(Mutex::new(KiloCollector::new(event_channel.clone())));
    let line_collector = collector.clone();
    let on_line: Arc<dyn Fn(&str) + Send + Sync> = Arc::new(move |line| {
        if let Ok(mut collector) = line_collector.lock() {
            collector.consume(line);
        }
    });
    let heartbeat_channel = event_channel.clone();
    let heartbeat = heartbeat_channel.map(|channel| {
        Arc::new(move || send_heartbeat(&channel, "Kilo")) as Arc<dyn Fn() + Send + Sync>
    });
    run_process_with_options(
        "kilo",
        &args,
        workspace,
        cancelled,
        heartbeat,
        Some(on_line),
        Some(vec![
            ("KILO_CONFIG_CONTENT".to_string(), config),
            (
                "KILO_DISABLE_EXTERNAL_SKILLS".to_string(),
                "true".to_string(),
            ),
        ]),
        PROCESS_TIMEOUT,
        true,
    )?;
    collector
        .lock()
        .map(|collector| collector.result())
        .map_err(|_| "Kilo event collector is unavailable".to_string())
}

struct KiloCollector {
    summary: String,
    tool_calls: HashMap<String, Value>,
    event_channel: Option<Channel<Value>>,
}

impl KiloCollector {
    fn new(event_channel: Option<Channel<Value>>) -> Self {
        Self {
            summary: String::new(),
            tool_calls: HashMap::new(),
            event_channel,
        }
    }

    fn consume(&mut self, line: &str) {
        let Ok(event) = serde_json::from_str::<Value>(line) else {
            return;
        };
        let part = event.get("part").and_then(Value::as_object);
        let part_type = part
            .and_then(|part| part.get("type"))
            .and_then(Value::as_str);
        if event.get("type").and_then(Value::as_str) == Some("step_start") {
            self.status("Kilo started a step…");
        }
        if event.get("type").and_then(Value::as_str) == Some("step_finish") {
            self.status("Kilo finished a step");
        }
        if event.get("type").and_then(Value::as_str) == Some("text") || part_type == Some("text") {
            if let Some(text) = event.get("text").and_then(Value::as_str).or_else(|| {
                part.and_then(|part| part.get("text"))
                    .and_then(Value::as_str)
            }) {
                self.summary.push_str(text);
            }
        }

        let event_type = event
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let is_tool = matches!(event_type, "tool_use" | "tool_call" | "tool_result")
            || part_type == Some("tool");
        if !is_tool {
            return;
        }
        let state = part
            .and_then(|part| part.get("state"))
            .and_then(Value::as_object);
        let id = string_at(&event, &["callID", "toolCallId"])
            .or_else(|| part.and_then(|part| string_in(part, &["callID", "id"])))
            .unwrap_or_else(|| unique_id("tool"));
        let existing = self.tool_calls.get(&id).cloned();
        let mut tool = existing.unwrap_or_else(|| json!({
            "id": id,
            "name": string_at(&event, &["tool", "toolName"])
                .or_else(|| part.and_then(|part| string_in(part, &["tool", "name"])))
                .unwrap_or_else(|| "tool".to_string()),
            "arguments": record_at(&event, &["input", "arguments"])
                .or_else(|| state.and_then(|state| state.get("input")).filter(|value| value.is_object()).cloned())
                .or_else(|| part.and_then(|part| part.get("input")).filter(|value| value.is_object()).cloned())
                .unwrap_or_else(|| json!({})),
            "status": "running",
            "startedAt": now(),
        }));
        let completed = state
            .and_then(|state| state.get("status"))
            .and_then(Value::as_str)
            == Some("completed")
            || event_type == "tool_result";
        if completed {
            tool["status"] = json!("completed");
            tool["completedAt"] = json!(now());
            if let Some(result) = state
                .and_then(|state| state.get("output"))
                .or_else(|| event.get("result"))
            {
                tool["result"] = result.clone();
            }
        }
        self.tool_calls.insert(id, tool.clone());
        if let Some(channel) = &self.event_channel {
            let event_type = if completed {
                "tool_completed"
            } else {
                "tool_started"
            };
            let _ = channel.send(json!({ "type": event_type, "toolCall": tool }));
        }
    }

    fn status(&self, message: &str) {
        if let Some(channel) = &self.event_channel {
            send_status(channel, message);
        }
    }

    fn result(&self) -> KiloRun {
        KiloRun {
            summary: self.summary.clone(),
            tool_calls: self.tool_calls.values().cloned().collect(),
        }
    }
}

fn run_kimi(
    workspace: &Path,
    runtime_model: &str,
    prompt: &str,
    // Kimi print mode cannot express Conduit roles or permission modes in v1:
    // `-p` auto-approves tool use non-interactively, and the CLI rejects
    // combining it with `--auto`/`--yolo`.
    _role: &str,
    _permission_mode: Option<&str>,
    cancelled: Arc<AtomicBool>,
    event_channel: Option<Channel<Value>>,
) -> Result<KimiRun, String> {
    let args = build_kimi_args(runtime_model, prompt);
    let collector = Arc::new(Mutex::new(KimiCollector::new(event_channel.clone())));
    let line_collector = collector.clone();
    let on_line: Arc<dyn Fn(&str) + Send + Sync> = Arc::new(move |line| {
        if let Ok(mut collector) = line_collector.lock() {
            collector.consume(line);
        }
    });
    let heartbeat_channel = event_channel.clone();
    let heartbeat = heartbeat_channel.map(|channel| {
        Arc::new(move || send_heartbeat(&channel, "Kimi")) as Arc<dyn Fn() + Send + Sync>
    });
    run_process_with_options(
        "kimi",
        &args,
        workspace,
        cancelled,
        heartbeat,
        Some(on_line),
        None,
        PROCESS_TIMEOUT,
        true,
    )?;
    collector
        .lock()
        .map(|collector| collector.result())
        .map_err(|_| "Kimi event collector is unavailable".to_string())
}

struct KimiCollector {
    summary: String,
    tool_calls: HashMap<String, Value>,
    changed_files: Vec<String>,
    event_channel: Option<Channel<Value>>,
}

impl KimiCollector {
    fn new(event_channel: Option<Channel<Value>>) -> Self {
        Self {
            summary: String::new(),
            tool_calls: HashMap::new(),
            changed_files: Vec::new(),
            event_channel,
        }
    }

    fn consume(&mut self, line: &str) {
        let Ok(event) = serde_json::from_str::<Value>(line) else {
            return;
        };
        match event.get("role").and_then(Value::as_str) {
            Some("assistant") => {
                if let Some(text) = event.get("content").and_then(Value::as_str) {
                    self.summary.push_str(text);
                }
                if let Some(calls) = event.get("tool_calls").and_then(Value::as_array) {
                    for call in calls {
                        self.start_tool(call);
                    }
                }
            }
            Some("tool") => self.complete_tool(&event),
            _ => {}
        }
    }

    fn start_tool(&mut self, call: &Value) {
        let function = call.get("function").and_then(Value::as_object);
        let name = function
            .and_then(|function| function.get("name"))
            .and_then(Value::as_str)
            .unwrap_or("tool");
        let id = call
            .get("id")
            .and_then(Value::as_str)
            .map(String::from)
            .unwrap_or_else(|| unique_id("tool"));
        // Kimi serializes tool arguments as a JSON string; tolerate any other
        // shape by falling back to an empty record.
        let arguments = function
            .and_then(|function| function.get("arguments"))
            .and_then(Value::as_str)
            .and_then(|arguments| serde_json::from_str::<Value>(arguments).ok())
            .filter(|arguments| arguments.is_object())
            .unwrap_or_else(|| json!({}));
        let tool = json!({
            "id": id,
            "name": name,
            "arguments": arguments,
            "status": "running",
            "startedAt": now(),
        });
        self.tool_calls.insert(id, tool.clone());
        if let Some(channel) = &self.event_channel {
            let _ = channel.send(json!({ "type": "tool_started", "toolCall": tool }));
        }
    }

    fn complete_tool(&mut self, event: &Value) {
        let Some(id) = event.get("tool_call_id").and_then(Value::as_str) else {
            return;
        };
        let mut tool = self.tool_calls.get(id).cloned().unwrap_or_else(|| {
            json!({
                "id": id,
                "name": "tool",
                "arguments": {},
                "status": "running",
                "startedAt": now(),
            })
        });
        tool["status"] = json!("completed");
        tool["completedAt"] = json!(now());
        if let Some(result) = event.get("content") {
            tool["result"] = result.clone();
        }
        self.tool_calls.insert(id.to_string(), tool.clone());
        if let Some(channel) = &self.event_channel {
            let _ = channel.send(json!({ "type": "tool_completed", "toolCall": tool }));
        }
        if let Some(path) = kimi_file_change_path(&tool) {
            if !self.changed_files.contains(&path) {
                self.changed_files.push(path.clone());
                if let Some(channel) = &self.event_channel {
                    let _ = channel.send(json!({ "type": "file_changed", "path": path }));
                }
            }
        }
    }

    fn result(&self) -> KimiRun {
        KimiRun {
            summary: self.summary.clone(),
            tool_calls: self.tool_calls.values().cloned().collect(),
        }
    }
}

fn run_process(
    program: &str,
    args: &[String],
    cwd: &Path,
    cancelled: Arc<AtomicBool>,
    heartbeat: Option<HeartbeatCallback>,
) -> Result<ProcessCapture, String> {
    run_process_with_stdout(program, args, cwd, cancelled, heartbeat, None)
}

pub(crate) fn run_shell_command(
    workspace: &str,
    command: &str,
    timeout: Duration,
) -> Result<ProcessCapture, String> {
    let workspace = PathBuf::from(workspace)
        .canonicalize()
        .map_err(|error| format!("Workspace does not exist: {error}"))?;
    if !workspace.is_dir() {
        return Err("Workspace is not a directory".to_string());
    }
    #[cfg(windows)]
    let (program, args) = ("cmd", vec!["/C".to_string(), command.to_string()]);
    #[cfg(not(windows))]
    let (program, args) = ("sh", vec!["-c".to_string(), command.to_string()]);

    run_process_with_options(
        program,
        &args,
        &workspace,
        Arc::new(AtomicBool::new(false)),
        None,
        None,
        None,
        timeout,
        false,
    )
}

fn run_process_with_stdout(
    program: &str,
    args: &[String],
    cwd: &Path,
    cancelled: Arc<AtomicBool>,
    heartbeat: Option<HeartbeatCallback>,
    on_stdout_line: Option<LineCallback>,
) -> Result<ProcessCapture, String> {
    run_process_with_options(
        program,
        args,
        cwd,
        cancelled,
        heartbeat,
        on_stdout_line,
        None,
        PROCESS_TIMEOUT,
        true,
    )
}

#[allow(clippy::too_many_arguments)]
fn run_process_with_options(
    program: &str,
    args: &[String],
    cwd: &Path,
    cancelled: Arc<AtomicBool>,
    heartbeat: Option<HeartbeatCallback>,
    on_stdout_line: Option<LineCallback>,
    environment: Option<Vec<(String, String)>>,
    timeout: Duration,
    require_success: bool,
) -> Result<ProcessCapture, String> {
    let executable = resolve_executable(program)?;
    let mut command = Command::new(&executable);
    command
        .args(args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // Packaged builds inherit a minimal PATH (launchd on macOS), so script
    // CLIs with `#!/usr/bin/env node` shebangs cannot find their runtime.
    if let Some(child_path) = augmented_path() {
        command.env("PATH", child_path);
    }
    if let Some(environment) = environment {
        command.envs(environment);
    }
    configure_process_group(&mut command);
    let mut child = command
        .spawn()
        .map_err(|error| format!("Could not start {program}: {error}"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| format!("Could not capture {program} stdout"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| format!("Could not capture {program} stderr"))?;
    let stdout_thread = thread::spawn(move || read_bounded(stdout, on_stdout_line));
    let stderr_thread = thread::spawn(move || read_bounded(stderr, None));
    let started = Instant::now();
    let mut last_heartbeat = Instant::now();

    let status = loop {
        if cancelled.load(Ordering::SeqCst) {
            terminate_process_tree(&mut child);
            let _ = stdout_thread.join();
            let _ = stderr_thread.join();
            return Err(format!("{program} run was cancelled before completion"));
        }
        if started.elapsed() >= timeout {
            terminate_process_tree(&mut child);
            let _ = stdout_thread.join();
            let _ = stderr_thread.join();
            return Err(format!(
                "{program} run timed out after {} seconds",
                timeout.as_secs()
            ));
        }
        if last_heartbeat.elapsed() >= Duration::from_secs(10) {
            if let Some(heartbeat) = &heartbeat {
                heartbeat();
            }
            last_heartbeat = Instant::now();
        }
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => thread::sleep(PROCESS_POLL_INTERVAL),
            Err(error) => {
                terminate_process_tree(&mut child);
                return Err(format!("Could not wait for {program}: {error}"));
            }
        }
    };

    let stdout = stdout_thread
        .join()
        .map_err(|_| format!("{program} stdout reader panicked"))??;
    let stderr = stderr_thread
        .join()
        .map_err(|_| format!("{program} stderr reader panicked"))??;
    if require_success && !status.success() {
        let detail = stderr.trim();
        return Err(if detail.is_empty() {
            format!("{program} exited with code {}", status.code().unwrap_or(-1))
        } else {
            detail.to_string()
        });
    }
    Ok(ProcessCapture {
        stdout,
        stderr,
        exit_code: status.code().unwrap_or(-1),
    })
}

fn read_bounded<R: Read>(reader: R, on_line: Option<LineCallback>) -> Result<String, String> {
    let mut reader = BufReader::new(reader);
    let mut output = Vec::new();
    let mut overflowed = false;
    loop {
        let mut line = Vec::new();
        let read = reader
            .read_until(b'\n', &mut line)
            .map_err(|error| error.to_string())?;
        if read == 0 {
            break;
        }
        if !overflowed && output.len().saturating_add(line.len()) <= PROCESS_OUTPUT_LIMIT {
            output.extend_from_slice(&line);
            if let Some(callback) = &on_line {
                callback(String::from_utf8_lossy(&line).trim_end_matches(['\r', '\n']));
            }
        } else {
            overflowed = true;
        }
    }
    if overflowed {
        return Err(format!(
            "Process output exceeded {} MiB",
            PROCESS_OUTPUT_LIMIT / 1024 / 1024
        ));
    }
    Ok(String::from_utf8_lossy(&output).into_owned())
}

#[cfg(unix)]
fn configure_process_group(command: &mut Command) {
    use std::os::unix::process::CommandExt;
    command.process_group(0);
}

#[cfg(not(unix))]
fn configure_process_group(_command: &mut Command) {}

#[cfg(unix)]
fn terminate_process_tree(child: &mut Child) {
    let pid = child.id() as i32;
    unsafe {
        libc::kill(-pid, libc::SIGTERM);
    }
    let deadline = Instant::now() + PROCESS_KILL_GRACE;
    while Instant::now() < deadline {
        if child.try_wait().ok().flatten().is_some() {
            return;
        }
        thread::sleep(Duration::from_millis(50));
    }
    unsafe {
        libc::kill(-pid, libc::SIGKILL);
    }
    let _ = child.wait();
}

#[cfg(windows)]
fn terminate_process_tree(child: &mut Child) {
    let _ = Command::new("taskkill")
        .args(["/PID", &child.id().to_string(), "/T", "/F"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(all(not(unix), not(windows)))]
fn terminate_process_tree(child: &mut Child) {
    let _ = child.kill();
    let _ = child.wait();
}

pub(crate) fn extra_executable_dirs() -> Vec<PathBuf> {
    let mut directories = Vec::new();
    if let Some(home) = dirs::home_dir() {
        directories.extend([
            home.join(".local/bin"),
            home.join(".bun/bin"),
            home.join(".cargo/bin"),
            home.join(".kimi-code/bin"),
        ]);
    }
    directories.extend([
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
    ]);
    directories
}

/// Inherited PATH plus the fallback dirs above; needed by script CLIs with
/// `#!/usr/bin/env node` shebangs under launchd's minimal GUI PATH.
pub(crate) fn augmented_path() -> Option<std::ffi::OsString> {
    let mut directories: Vec<PathBuf> = env::var_os("PATH")
        .map(|path| env::split_paths(&path).collect())
        .unwrap_or_default();
    directories.extend(extra_executable_dirs());
    env::join_paths(directories).ok()
}

pub(crate) fn resolve_executable(program: &str) -> Result<PathBuf, String> {
    let candidate = Path::new(program);
    if candidate.components().count() > 1 && candidate.is_file() {
        return Ok(candidate.to_path_buf());
    }
    let mut directories: Vec<PathBuf> = env::var_os("PATH")
        .map(|path| env::split_paths(&path).collect())
        .unwrap_or_default();
    directories.extend(extra_executable_dirs());
    for directory in directories {
        let path = directory.join(program);
        if path.is_file() {
            return Ok(path);
        }
        #[cfg(windows)]
        for extension in ["exe", "cmd", "bat"] {
            let path = directory.join(format!("{program}.{extension}"));
            if path.is_file() {
                return Ok(path);
            }
        }
    }
    Err(format!(
        "{program} executable was not found. Install it and sign in before using this harness."
    ))
}

fn require_git_workspace(workspace: Option<&str>) -> Result<PathBuf, String> {
    let workspace = workspace.ok_or_else(|| "A workspace is required".to_string())?;
    let root = PathBuf::from(workspace)
        .canonicalize()
        .map_err(|error| format!("Workspace does not exist: {error}"))?;
    if !root.join(".git").exists() {
        return Err("Workspace is not a Git repository".to_string());
    }
    Ok(root)
}

fn build_judge_prompt(messages: &[ModelMessage], structured: Option<&StructuredOutput>) -> String {
    let transcript = messages
        .iter()
        .map(|message| format!("## {}\n{}", message.role, message.content))
        .collect::<Vec<_>>()
        .join("\n\n");
    let output = structured.map(|structured| format!(
        "Return only valid JSON without Markdown fences or commentary.\nThe JSON must match this {} schema exactly:\n{}",
        structured.name,
        structured.schema,
    )).unwrap_or_else(|| "Return a concise response to the conversation.".to_string());
    format!(
        "Act on the conversation below as a read-only planning or review judge.\nDo not inspect or modify the workspace and do not call tools. Use only the supplied conversation.\n{output}\n\n{transcript}"
    )
}

fn build_worker_prompt(request: &CodingIterationRequest) -> String {
    let mut lines = vec![
        "Work directly on this repository and complete the goal using your coding tools."
            .to_string(),
        "Preserve pre-existing workspace changes from earlier goals. Do not treat a dirty worktree as part of the current goal; Conduit scopes review evidence to this run."
            .to_string(),
        String::new(),
        format!("Goal: {}", request.goal),
        format!(
            "Iteration: {} of {}",
            request.iteration, request.max_iterations
        ),
    ];
    if let Some(plan) = &request.previous_plan {
        lines.push(format!("Previous plan:\n{plan}"));
    }
    if !request.judge_feedback.is_empty() {
        lines.push(format!(
            "Required judge fixes — address every item and validate them:\n{}",
            request
                .judge_feedback
                .iter()
                .enumerate()
                .map(|(index, item)| format!("{}. {item}", index + 1))
                .collect::<Vec<_>>()
                .join("\n")
        ));
    }
    lines.push("At the end, briefly summarize verified work completed.".to_string());
    lines.join("\n")
}

fn build_kilo_security_config(role: &str, permission_mode: Option<&str>) -> Result<String, String> {
    let agent_role = if role == "judge" { "ask" } else { "code" };
    let permission = if role == "judge" {
        json!("deny")
    } else {
        let bash = match permission_mode.unwrap_or("auto_approve_safe") {
            "ask_every_time" => json!("deny"),
            "auto_approve_all" => json!("allow"),
            "auto_approve_safe" => json!({
                "*": "deny",
                "git status *": "allow",
                "git diff *": "allow",
                "git log *": "allow",
                "npm test *": "allow",
                "npm run test *": "allow",
                "pnpm test *": "allow",
                "yarn test *": "allow",
                "pytest *": "allow",
                "cargo test *": "allow",
                "go test *": "allow",
                "node --version *": "allow",
                "npm --version *": "allow",
                "python --version *": "allow",
                "python3 --version *": "allow",
            }),
            _ => return Err("Invalid command permission mode".to_string()),
        };
        json!({
            "*": "deny",
            "read": { "*": "allow", "*.env": "deny", "*.env.*": "deny" },
            "glob": "allow",
            "grep": "allow",
            "edit": { "*": "allow", "*.env": "deny", "*.env.*": "deny" },
            "write": { "*": "allow", "*.env": "deny", "*.env.*": "deny" },
            "apply_patch": "allow",
            "bash": bash,
            "external_directory": "deny",
            "task": "deny",
            "agent_manager": "deny",
            "webfetch": "deny",
            "websearch": "deny",
            "skill": "deny",
            "question": "deny",
        })
    };

    let mut config = json!({
        "permission": permission.clone(),
        "formatter": false,
        "lsp": false,
        "snapshot": true,
        "agent": {}
    });
    config["agent"][agent_role] = json!({ "permission": permission });
    #[cfg(unix)]
    {
        config["sandbox"] = json!({
            "enabled": true,
            "network": "deny",
            "allowed_hosts": [],
            "writable_paths": [],
        });
    }
    serde_json::to_string(&config).map_err(|error| error.to_string())
}

fn build_kilo_args(workspace: &Path, runtime_model: &str, prompt: &str, role: &str) -> Vec<String> {
    let mut args = vec![
        "run".to_string(),
        "--format".to_string(),
        "json".to_string(),
        "--dir".to_string(),
        workspace.to_string_lossy().into_owned(),
        "--model".to_string(),
        runtime_model.to_string(),
        "--pure".to_string(),
    ];
    if role == "judge" {
        args.extend(["--agent", "ask"].map(String::from));
    } else {
        args.extend(["--agent", "code"].map(String::from));
    }
    args.push(prompt.to_string());
    args
}

fn build_kimi_args(runtime_model: &str, prompt: &str) -> Vec<String> {
    // Never add `--auto`/`--yolo`: print mode auto-approves tool use and the
    // CLI rejects those flags in combination with `-p`.
    vec![
        "-p".to_string(),
        prompt.to_string(),
        "-m".to_string(),
        runtime_model.to_string(),
        "--output-format".to_string(),
        "stream-json".to_string(),
    ]
}

fn kimi_file_change_path(tool: &Value) -> Option<String> {
    let name = tool.get("name").and_then(Value::as_str)?;
    if !matches!(
        name.to_ascii_lowercase().as_str(),
        "write" | "edit" | "multiedit" | "apply_patch"
    ) {
        return None;
    }
    tool.get("arguments")
        .and_then(|arguments| arguments.get("path"))
        .and_then(Value::as_str)
        .filter(|path| !path.is_empty())
        .map(String::from)
}

fn build_codex_judge_args(
    workspace: &Path,
    runtime_model: &str,
    prompt: &str,
    output_file: &Path,
    schema_file: Option<&Path>,
    reasoning_effort: Option<&str>,
) -> Vec<String> {
    let mut args = vec!["exec".to_string()];
    args.extend([
        "-c".to_string(),
        "approval_policy=\"never\"".to_string(),
        "-c".to_string(),
        "web_search=\"disabled\"".to_string(),
    ]);
    if let Some(effort) = reasoning_effort {
        args.extend([
            "-c".to_string(),
            format!("model_reasoning_effort={}", json!(effort)),
        ]);
    }
    args.extend(
        [
            "--ephemeral",
            "--ignore-user-config",
            "--ignore-rules",
            "--skip-git-repo-check",
            "--sandbox",
            "read-only",
            "-C",
        ]
        .map(String::from),
    );
    args.push(workspace.to_string_lossy().into_owned());
    args.extend(["-m".to_string(), runtime_model.to_string()]);
    if let Some(schema_file) = schema_file {
        args.extend([
            "--output-schema".to_string(),
            schema_file.to_string_lossy().into_owned(),
        ]);
    }
    args.extend([
        "-o".to_string(),
        output_file.to_string_lossy().into_owned(),
        prompt.to_string(),
    ]);
    args
}

fn build_codex_worker_args(
    workspace: &Path,
    runtime_model: &str,
    prompt: &str,
    output_file: &Path,
    reasoning_effort: Option<&str>,
) -> Vec<String> {
    let mut args = vec!["exec".to_string()];
    args.extend([
        "-c".to_string(),
        "approval_policy=\"never\"".to_string(),
        "-c".to_string(),
        "sandbox_workspace_write.network_access=false".to_string(),
        "-c".to_string(),
        "web_search=\"disabled\"".to_string(),
    ]);
    if let Some(effort) = reasoning_effort {
        args.extend([
            "-c".to_string(),
            format!("model_reasoning_effort={}", json!(effort)),
        ]);
    }
    args.extend(
        [
            "--json",
            "--ephemeral",
            "--ignore-user-config",
            "--sandbox",
            "workspace-write",
            "--color",
            "never",
            "--skip-git-repo-check",
            "-C",
        ]
        .map(String::from),
    );
    args.push(workspace.to_string_lossy().into_owned());
    args.extend([
        "-m".to_string(),
        runtime_model.to_string(),
        "-o".to_string(),
        output_file.to_string_lossy().into_owned(),
        prompt.to_string(),
    ]);
    args
}

fn runtime_model_id(provider: &str, model_id: &str) -> Result<String, String> {
    model_id
        .strip_prefix(&format!("{provider}/"))
        .filter(|model| !model.is_empty())
        .map(String::from)
        .ok_or_else(|| format!("Invalid {provider} model ID: {model_id}"))
}

fn kilo_runtime_model_id(model_id: &str) -> Result<String, String> {
    if let Some(model) = model_id.strip_prefix("kilo/kilo/") {
        if !model.is_empty() {
            return Ok(format!("kilo/{model}"));
        }
    }
    if model_id.starts_with("kilo/") && model_id.len() > "kilo/".len() {
        return Ok(model_id.to_string());
    }
    Err(format!("Invalid Kilo model ID: {model_id}"))
}

fn git_changed_files(workspace: &Path) -> Result<Vec<String>, String> {
    let output = Command::new(resolve_executable("git")?)
        .args(["status", "--porcelain=v1", "-z", "--untracked-files=all"])
        .current_dir(workspace)
        .output()
        .map_err(|error| format!("Could not inspect Git changes: {error}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    let mut paths = Vec::new();
    let entries = output
        .stdout
        .split(|byte| *byte == 0)
        .filter(|entry| !entry.is_empty());
    for entry in entries {
        if entry.len() < 4 {
            continue;
        }
        let value = String::from_utf8_lossy(&entry[3..]).into_owned();
        let path = value.rsplit(" -> ").next().unwrap_or(&value).to_string();
        if !paths.contains(&path) {
            paths.push(path);
        }
    }
    Ok(paths)
}

fn try_parse_structured_output(content: &str) -> Option<Value> {
    if let Ok(value) = serde_json::from_str(content.trim()) {
        return Some(value);
    }
    for (start, character) in content.char_indices() {
        if character != '{' {
            continue;
        }
        let slice = &content[start..];
        let mut stream = serde_json::Deserializer::from_str(slice).into_iter::<Value>();
        if let Some(Ok(value)) = stream.next() {
            return Some(value);
        }
    }
    None
}

fn send_status(channel: &Channel<Value>, message: &str) {
    let _ = channel.send(json!({ "type": "agent_status", "message": message }));
}

fn send_heartbeat(channel: &Channel<Value>, provider: &str) {
    let timestamp = now();
    let _ = channel.send(json!({
        "type": "agent_heartbeat",
        "provider": provider,
        "at": timestamp,
        "startedAt": timestamp,
        "phase": "coding",
        "source": "process",
        "detail": format!("{provider} process confirmed alive"),
    }));
}

fn provider_display_name(provider_id: &str) -> Result<&'static str, String> {
    match provider_id {
        "codex" => Ok("Codex"),
        "kilo" => Ok("Kilo"),
        "kimi" => Ok("Kimi"),
        _ => Err("Unsupported local harness provider".to_string()),
    }
}

fn string_at(value: &Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| value.get(*key).and_then(Value::as_str).map(String::from))
}

fn string_in(value: &serde_json::Map<String, Value>, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| value.get(*key).and_then(Value::as_str).map(String::from))
}

fn record_at(value: &Value, keys: &[&str]) -> Option<Value> {
    keys.iter()
        .find_map(|key| value.get(*key).filter(|item| item.is_object()).cloned())
}

fn title_case(value: &str) -> String {
    value
        .split_whitespace()
        .map(|word| {
            let mut characters = word.chars();
            characters
                .next()
                .map(|first| first.to_uppercase().collect::<String>() + characters.as_str())
                .unwrap_or_default()
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn now() -> String {
    Utc::now().to_rfc3339()
}

fn unique_id(prefix: &str) -> String {
    format!(
        "{prefix}-{}-{}",
        std::process::id(),
        Utc::now().timestamp_nanos_opt().unwrap_or_default()
    )
}

fn valid_request_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '-')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_model_ids_strip_exactly_one_namespace() {
        assert_eq!(
            runtime_model_id("codex", "codex/gpt-5.6").unwrap(),
            "gpt-5.6"
        );
        assert_eq!(
            kilo_runtime_model_id("kilo/kilo/kilo-auto/free").unwrap(),
            "kilo/kilo-auto/free"
        );
        assert_eq!(
            runtime_model_id("kimi", "kimi/kimi-code/k3").unwrap(),
            "kimi-code/k3"
        );
        assert!(runtime_model_id("codex", "kilo/gpt-5.6").is_err());
        assert!(runtime_model_id("kimi", "kimi/").is_err());
    }

    #[test]
    fn native_role_flags_keep_judges_read_only_and_workers_autonomous() {
        let workspace = Path::new("/repo");
        let judge =
            build_codex_judge_args(workspace, "gpt", "prompt", Path::new("/out"), None, None);
        let worker = build_codex_worker_args(workspace, "gpt", "prompt", Path::new("/out"), None);
        assert!(judge
            .windows(2)
            .any(|pair| pair == ["--sandbox", "read-only"]));
        assert!(!judge
            .iter()
            .any(|arg| arg == "--dangerously-bypass-approvals-and-sandbox"));
        assert!(worker
            .windows(2)
            .any(|pair| pair == ["--sandbox", "workspace-write"]));
        assert!(!worker
            .iter()
            .any(|arg| arg == "--dangerously-bypass-approvals-and-sandbox"));
        assert!(worker.iter().any(|arg| arg == "approval_policy=\"never\""));
        assert!(worker
            .iter()
            .any(|arg| arg == "sandbox_workspace_write.network_access=false"));

        let kilo_judge = build_kilo_args(workspace, "kilo/model", "prompt", "judge");
        let kilo_worker = build_kilo_args(workspace, "kilo/model", "prompt", "worker");
        assert!(kilo_judge.iter().any(|arg| arg == "--pure"));
        assert!(!kilo_judge.iter().any(|arg| arg == "--auto"));
        assert!(kilo_worker.iter().any(|arg| arg == "--pure"));
        assert!(!kilo_worker.iter().any(|arg| arg == "--auto"));
        assert!(!kilo_worker
            .iter()
            .any(|arg| arg == "--dangerously-skip-permissions"));
    }

    #[test]
    fn structured_output_parser_handles_wrapped_json() {
        assert_eq!(
            try_parse_structured_output("Result: ```json\n{\"ok\":true}\n```"),
            Some(json!({ "ok": true }))
        );
        assert_eq!(try_parse_structured_output("not json"), None);
    }

    #[test]
    fn kimi_model_catalog_maps_aliases_to_descriptors() {
        let output = json!({
            "providers": { "managed:kimi-code": { "type": "kimi" } },
            "models": {
                "kimi-code/k3": {
                    "provider": "managed:kimi-code",
                    "model": "k3",
                    "maxContextSize": 1048576,
                    "capabilities": ["thinking", "always_thinking", "tool_use"],
                    "displayName": "K3",
                    "supportEfforts": ["max"],
                    "defaultEffort": "max"
                },
                "kimi-code/plain": {
                    "provider": "managed:kimi-code",
                    "model": "plain",
                    "capabilities": []
                }
            }
        })
        .to_string();
        let models = parse_kimi_models_from_json(&output).unwrap();
        assert_eq!(models.len(), 2);
        let k3 = models
            .iter()
            .find(|model| model["id"] == "kimi/kimi-code/k3")
            .unwrap();
        assert_eq!(k3["provider"], "kimi");
        assert_eq!(k3["displayName"], "K3");
        assert_eq!(k3["supportsTools"], true);
        assert_eq!(k3["supportsReasoning"], true);
        assert_eq!(k3["supportsStructuredOutput"], false);
        assert_eq!(k3["supportsAsk"], true);
        assert_eq!(k3["supportsGoal"], true);
        assert_eq!(k3["supportsJudge"], true);
        let plain = models
            .iter()
            .find(|model| model["id"] == "kimi/kimi-code/plain")
            .unwrap();
        assert_eq!(plain["displayName"], "Plain");
        assert_eq!(plain["supportsTools"], false);
        assert_eq!(plain["supportsReasoning"], false);
        assert!(parse_kimi_models_from_json("not json").is_err());
        assert!(parse_kimi_models_from_json("{}").is_err());
    }

    #[test]
    fn kimi_print_mode_never_combines_auto_flags() {
        let args = build_kimi_args("kimi-code/k3", "prompt");
        assert!(args.windows(2).any(|pair| pair == ["-p", "prompt"]));
        assert!(args.windows(2).any(|pair| pair == ["-m", "kimi-code/k3"]));
        assert!(args
            .windows(2)
            .any(|pair| pair == ["--output-format", "stream-json"]));
        assert!(!args.iter().any(|arg| arg == "--auto"));
        assert!(!args.iter().any(|arg| arg == "--yolo"));
    }

    #[test]
    fn kimi_file_change_path_only_flags_write_style_tools() {
        let write = json!({ "name": "Write", "arguments": { "path": "src/a.ts" } });
        assert_eq!(kimi_file_change_path(&write), Some("src/a.ts".to_string()));
        let edit = json!({ "name": "Edit", "arguments": { "path": "src/b.ts" } });
        assert_eq!(kimi_file_change_path(&edit), Some("src/b.ts".to_string()));
        let read = json!({ "name": "Read", "arguments": { "path": "src/a.ts" } });
        assert_eq!(kimi_file_change_path(&read), None);
        let no_path = json!({ "name": "Write", "arguments": {} });
        assert_eq!(kimi_file_change_path(&no_path), None);
    }

    #[test]
    fn kilo_worker_permissions_are_injected_fail_closed() {
        let safe: Value = serde_json::from_str(
            &build_kilo_security_config("worker", Some("auto_approve_safe")).unwrap(),
        )
        .unwrap();
        assert_eq!(safe["permission"]["external_directory"], "deny");
        assert_eq!(safe["permission"]["bash"]["*"], "deny");
        assert_eq!(safe["permission"]["bash"]["git status *"], "allow");
        assert_eq!(safe["agent"]["code"]["permission"], safe["permission"]);

        let all: Value = serde_json::from_str(
            &build_kilo_security_config("worker", Some("auto_approve_all")).unwrap(),
        )
        .unwrap();
        assert_eq!(all["permission"]["bash"], "allow");

        let ask: Value = serde_json::from_str(
            &build_kilo_security_config("worker", Some("ask_every_time")).unwrap(),
        )
        .unwrap();
        assert_eq!(ask["permission"]["bash"], "deny");
        assert!(build_kilo_security_config("worker", Some("invalid")).is_err());
    }

    #[test]
    fn request_ids_reject_path_and_whitespace_characters() {
        assert!(valid_request_id("550e8400-e29b-41d4-a716-446655440000"));
        assert!(!valid_request_id("../cancel-all"));
        assert!(!valid_request_id("request id"));
    }
}
