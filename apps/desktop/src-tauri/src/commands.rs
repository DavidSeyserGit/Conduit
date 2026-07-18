use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use tauri::AppHandle;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};

const MAX_FILE_BYTES: u64 = 5 * 1024 * 1024;
const MAX_SEARCH_FILE_BYTES: u64 = 2 * 1024 * 1024;
const MAX_LIST_ENTRIES: usize = 10_000;
const MAX_READ_LINES: usize = 10_000;

#[derive(Debug, Serialize, Deserialize)]
pub struct ToolResult {
    pub success: bool,
    pub result: Option<serde_json::Value>,
    pub error: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    #[serde(rename = "type")]
    pub entry_type: String,
    pub size: Option<u64>,
}

fn normalize_path(workspace: &str, target: &str) -> Result<PathBuf, String> {
    let workspace = PathBuf::from(workspace)
        .canonicalize()
        .map_err(|e| format!("Invalid workspace: {e}"))?;

    if !workspace.is_dir() {
        return Err("Workspace is not a directory".to_string());
    }

    let mut resolved = workspace.clone();
    for component in Path::new(target).components() {
        match component {
            Component::CurDir => continue,
            Component::Normal(name) => resolved.push(name),
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(format!("Invalid workspace-relative path: {target}"));
            }
        }

        // Canonicalize every existing component, rather than only the final path.
        // This prevents a not-yet-created file from escaping through a symlinked parent.
        if fs::symlink_metadata(&resolved).is_ok() {
            resolved = resolved
                .canonicalize()
                .map_err(|e| format!("Cannot resolve path: {e}"))?;
        }
        if !resolved.starts_with(&workspace) {
            return Err(format!("Path outside workspace: {target}"));
        }
    }

    Ok(resolved)
}

#[tauri::command]
pub fn tool_list_files(
    workspace: String,
    path: Option<String>,
    max_depth: Option<u32>,
) -> ToolResult {
    let rel = path.unwrap_or_else(|| ".".to_string());
    let max_depth = max_depth.unwrap_or(3).min(10);

    match normalize_path(&workspace, &rel) {
        Ok(abs) => {
            let mut entries = Vec::new();
            collect_entries(&abs, &rel, &mut entries, 0, max_depth);
            ToolResult {
                success: true,
                result: Some(serde_json::json!({ "path": rel, "entries": entries })),
                error: None,
            }
        }
        Err(e) => ToolResult {
            success: false,
            result: None,
            error: Some(e),
        },
    }
}

fn collect_entries(
    abs: &Path,
    rel: &str,
    entries: &mut Vec<FileEntry>,
    depth: u32,
    max_depth: u32,
) {
    if depth > max_depth || entries.len() >= MAX_LIST_ENTRIES {
        return;
    }

    let Ok(read_dir) = fs::read_dir(abs) else {
        return;
    };

    let ignored = ["node_modules", ".git", "dist", "target", "build"];

    for entry in read_dir.flatten() {
        if entries.len() >= MAX_LIST_ENTRIES {
            return;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') || ignored.contains(&name.as_str()) {
            continue;
        }

        let entry_rel = if rel == "." {
            name.clone()
        } else {
            format!("{rel}/{name}")
        };

        let Ok(ft) = entry.file_type() else { continue };

        if ft.is_dir() {
            entries.push(FileEntry {
                name: name.clone(),
                path: entry_rel.clone(),
                entry_type: "directory".to_string(),
                size: None,
            });
            collect_entries(&entry.path(), &entry_rel, entries, depth + 1, max_depth);
        } else if ft.is_file() {
            let size = entry.metadata().ok().map(|m| m.len());
            entries.push(FileEntry {
                name,
                path: entry_rel,
                entry_type: "file".to_string(),
                size,
            });
        }
    }
}

#[tauri::command]
pub fn tool_read_file(
    workspace: String,
    path: String,
    offset: Option<u32>,
    limit: Option<u32>,
) -> ToolResult {
    match normalize_path(&workspace, &path) {
        Ok(abs) => {
            let size = match fs::metadata(&abs) {
                Ok(metadata) if metadata.len() <= MAX_FILE_BYTES => metadata.len(),
                Ok(_) => {
                    return ToolResult {
                        success: false,
                        result: None,
                        error: Some(format!(
                            "File exceeds the {} MiB read limit",
                            MAX_FILE_BYTES / 1024 / 1024
                        )),
                    }
                }
                Err(error) => {
                    return ToolResult {
                        success: false,
                        result: None,
                        error: Some(error.to_string()),
                    }
                }
            };
            match fs::read_to_string(&abs) {
                Ok(content) => {
                    let lines: Vec<&str> = content.lines().collect();
                    let offset = offset.unwrap_or(0) as usize;
                    let limit =
                        (limit.unwrap_or(MAX_READ_LINES as u32) as usize).min(MAX_READ_LINES);
                    let selected: Vec<&str> =
                        lines.iter().skip(offset).take(limit).copied().collect();
                    ToolResult {
                        success: true,
                        result: Some(serde_json::json!({
                            "path": path,
                            "content": selected.join("\n"),
                            "size": size,
                            "truncated": offset > 0 || selected.len() < lines.len()
                        })),
                        error: None,
                    }
                }
                Err(e) => ToolResult {
                    success: false,
                    result: None,
                    error: Some(e.to_string()),
                },
            }
        }
        Err(e) => ToolResult {
            success: false,
            result: None,
            error: Some(e),
        },
    }
}

#[tauri::command]
pub fn tool_write_file(workspace: String, path: String, content: String) -> ToolResult {
    if content.len() as u64 > MAX_FILE_BYTES {
        return ToolResult {
            success: false,
            result: None,
            error: Some(format!(
                "Content exceeds the {} MiB write limit",
                MAX_FILE_BYTES / 1024 / 1024
            )),
        };
    }
    match normalize_path(&workspace, &path) {
        Ok(abs) => {
            let created = !abs.exists();
            if let Some(parent) = abs.parent() {
                let _ = fs::create_dir_all(parent);
            }
            match fs::write(&abs, &content) {
                Ok(()) => ToolResult {
                    success: true,
                    result: Some(serde_json::json!({
                        "path": path,
                        "bytesWritten": content.len(),
                        "created": created
                    })),
                    error: None,
                },
                Err(e) => ToolResult {
                    success: false,
                    result: None,
                    error: Some(e.to_string()),
                },
            }
        }
        Err(e) => ToolResult {
            success: false,
            result: None,
            error: Some(e),
        },
    }
}

#[tauri::command]
pub fn tool_create_file(workspace: String, path: String, content: String) -> ToolResult {
    match normalize_path(&workspace, &path) {
        Ok(abs) if abs.exists() => ToolResult {
            success: false,
            result: None,
            error: Some(format!("File already exists: {path}")),
        },
        Ok(_) => tool_write_file(workspace, path, content),
        Err(e) => ToolResult {
            success: false,
            result: None,
            error: Some(e),
        },
    }
}

#[tauri::command]
pub fn tool_delete_file(workspace: String, path: String) -> ToolResult {
    match normalize_path(&workspace, &path) {
        Ok(abs) => match fs::remove_file(&abs) {
            Ok(()) => ToolResult {
                success: true,
                result: Some(serde_json::json!({ "path": path, "deleted": true })),
                error: None,
            },
            Err(e) => ToolResult {
                success: false,
                result: None,
                error: Some(e.to_string()),
            },
        },
        Err(e) => ToolResult {
            success: false,
            result: None,
            error: Some(e),
        },
    }
}

#[tauri::command]
pub fn tool_replace_in_file(
    workspace: String,
    path: String,
    search: String,
    replace: String,
    replace_all: Option<bool>,
) -> ToolResult {
    let read = tool_read_file(workspace.clone(), path.clone(), None, None);
    if !read.success {
        return read;
    }

    let content = read
        .result
        .as_ref()
        .and_then(|r| r.get("content"))
        .and_then(|c| c.as_str())
        .unwrap_or("");

    if !content.contains(&search) {
        return ToolResult {
            success: false,
            result: None,
            error: Some(format!("Search string not found in {path}")),
        };
    }

    let new_content = if replace_all.unwrap_or(false) {
        content.replace(&search, &replace)
    } else {
        content.replacen(&search, &replace, 1)
    };

    tool_write_file(workspace, path, new_content)
}

#[tauri::command]
pub fn tool_search_files(
    workspace: String,
    query: String,
    regex: Option<bool>,
    case_sensitive: Option<bool>,
) -> ToolResult {
    if query.is_empty() || query.len() > 1_000 {
        return ToolResult {
            success: false,
            result: None,
            error: Some("Search query must be between 1 and 1000 bytes".to_string()),
        };
    }
    let workspace_path = match PathBuf::from(&workspace).canonicalize() {
        Ok(p) => p,
        Err(e) => {
            return ToolResult {
                success: false,
                result: None,
                error: Some(e.to_string()),
            }
        }
    };

    let compiled_regex = if regex.unwrap_or(false) {
        match regex::Regex::new(&query) {
            Ok(value) => Some(value),
            Err(error) => {
                return ToolResult {
                    success: false,
                    result: None,
                    error: Some(format!("Invalid regular expression: {error}")),
                }
            }
        }
    } else {
        None
    };
    let normalized_query = if case_sensitive.unwrap_or(false) {
        None
    } else {
        Some(query.to_lowercase())
    };
    let mut matches = Vec::new();
    search_dir(
        &workspace_path,
        &workspace_path,
        &query,
        compiled_regex.as_ref(),
        case_sensitive.unwrap_or(false),
        normalized_query.as_deref(),
        &mut matches,
        100,
    );

    ToolResult {
        success: true,
        result: Some(serde_json::json!({
            "query": query,
            "matches": matches,
            "totalMatches": matches.len(),
            "truncated": matches.len() >= 100
        })),
        error: None,
    }
}

#[allow(clippy::too_many_arguments)]
fn search_dir(
    workspace: &Path,
    dir: &Path,
    query: &str,
    regex: Option<&regex::Regex>,
    case_sensitive: bool,
    normalized_query: Option<&str>,
    matches: &mut Vec<serde_json::Value>,
    max: usize,
) {
    if matches.len() >= max {
        return;
    }

    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let ignored = ["node_modules", ".git", "dist", "target"];

    for entry in entries.flatten() {
        if matches.len() >= max {
            return;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') || ignored.contains(&name.as_str()) {
            continue;
        }

        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_symlink() {
            continue;
        }
        let path = entry.path();
        if file_type.is_dir() {
            search_dir(
                workspace,
                &path,
                query,
                regex,
                case_sensitive,
                normalized_query,
                matches,
                max,
            );
        } else if file_type.is_file()
            && entry
                .metadata()
                .map(|metadata| metadata.len() <= MAX_SEARCH_FILE_BYTES)
                .unwrap_or(false)
        {
            if let Ok(content) = fs::read_to_string(&path) {
                let rel = path
                    .strip_prefix(workspace)
                    .unwrap_or(&path)
                    .to_string_lossy()
                    .to_string();

                for (i, line) in content.lines().enumerate() {
                    let found = if let Some(regex) = regex {
                        regex.is_match(line)
                    } else if case_sensitive {
                        line.contains(query)
                    } else {
                        line.to_lowercase()
                            .contains(normalized_query.unwrap_or_default())
                    };

                    if found {
                        matches.push(serde_json::json!({
                            "path": rel,
                            "line": i + 1,
                            "text": line.trim()
                        }));
                        if matches.len() >= max {
                            return;
                        }
                    }
                }
            }
        }
    }
}

#[tauri::command]
pub fn tool_run_command(workspace: String, command: String, timeout_ms: Option<u64>) -> ToolResult {
    let timeout =
        std::time::Duration::from_millis(timeout_ms.unwrap_or(120_000).clamp(100, 1_200_000));
    let started_at = std::time::Instant::now();
    match crate::local_harness::run_shell_command(&workspace, &command, timeout) {
        Ok(out) => ToolResult {
            success: true,
            result: Some(serde_json::json!({
                "command": command,
                "exitCode": out.exit_code,
                "stdout": out.stdout,
                "stderr": out.stderr,
                "timedOut": false,
                "durationMs": started_at.elapsed().as_millis() as u64,
            })),
            error: None,
        },
        Err(e) => ToolResult {
            success: false,
            result: None,
            error: Some(e.to_string()),
        },
    }
}

fn is_safe_command(command: &str) -> bool {
    const SAFE: &[&str] = &[
        r"^git\s+status\b",
        r"^git\s+diff\b",
        r"^git\s+log\b",
        r"^npm\s+test\b",
        r"^npm\s+run\s+test\b",
        r"^pnpm\s+test\b",
        r"^yarn\s+test\b",
        r"^pytest\b",
        r"^cargo\s+test\b",
        r"^go\s+test\b",
        r"^node\s+--version\b",
        r"^npm\s+--version\b",
        r"^python3?\s+--version\b",
    ];
    const UNSAFE: &[&str] = &[
        r"\brm\s+-rf?\b",
        r"\bsudo\b",
        r"\bcurl\b",
        r"\bwget\b",
        r"\bssh\b",
        r"\bscp\b",
        r"\b(?:npm|pnpm)\s+install\b",
        r"\byarn\s+add\b",
        r"\bpip\s+install\b",
        r"\bcargo\s+install\b",
        r"\bchmod\b",
        r"\bchown\b",
        r"\bmkfs\b",
        r"\bdd\s+if=",
        r">\s*/dev/",
        r"\|\s*(?:sh|bash)\b",
    ];
    let command = command.trim();
    if command.is_empty()
        || UNSAFE
            .iter()
            .any(|pattern| regex::Regex::new(pattern).is_ok_and(|regex| regex.is_match(command)))
    {
        return false;
    }
    SAFE.iter()
        .any(|pattern| regex::Regex::new(pattern).is_ok_and(|regex| regex.is_match(command)))
}

fn requires_command_approval(command: &str, permission_mode: &str) -> Result<bool, String> {
    match permission_mode {
        "ask_every_time" => Ok(true),
        "auto_approve_safe" => Ok(!is_safe_command(command)),
        "auto_approve_all" => Ok(false),
        _ => Err("Invalid command permission mode".to_string()),
    }
}

fn approve_command(app: &AppHandle, command: &str) -> bool {
    app.dialog()
        .message(format!(
            "A coding model wants to run this command:\n\n{command}\n\nOnly approve commands you trust."
        ))
        .title("Approve command")
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Run command".to_string(),
            "Cancel".to_string(),
        ))
        .blocking_show()
}

#[tauri::command]
pub fn tool_capture_git_snapshot(workspace: String) -> ToolResult {
    match capture_git_tree(&workspace) {
        Ok(tree) => ToolResult {
            success: true,
            result: Some(serde_json::json!({ "tree": tree })),
            error: None,
        },
        Err(error) => ToolResult {
            success: false,
            result: None,
            error: Some(error),
        },
    }
}

fn git_cmd() -> Command {
    let executable =
        crate::local_harness::resolve_executable("git").unwrap_or_else(|_| PathBuf::from("git"));
    let mut command = Command::new(executable);
    if let Some(path) = crate::local_harness::augmented_path() {
        command.env("PATH", path);
    }
    command
}

fn run_git(workspace: &str, args: &[&str], index_path: Option<&Path>) -> Result<String, String> {
    let mut command = git_cmd();
    command.args(args).current_dir(workspace);
    if let Some(index_path) = index_path {
        command.env("GIT_INDEX_FILE", index_path);
    }
    let output = command
        .output()
        .map_err(|error| format!("Could not run git: {error}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            format!(
                "git exited with code {}",
                output.status.code().unwrap_or(-1)
            )
        } else {
            stderr
        });
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

fn capture_git_tree(workspace: &str) -> Result<String, String> {
    run_git(workspace, &["rev-parse", "--git-dir"], None)?;
    let temp = tempfile::tempdir().map_err(|error| error.to_string())?;
    let index_path = temp.path().join("index");
    if run_git(workspace, &["read-tree", "HEAD"], Some(&index_path)).is_err() {
        run_git(workspace, &["read-tree", "--empty"], Some(&index_path))?;
    }
    run_git(workspace, &["add", "-A", "--", "."], Some(&index_path))?;
    let tree = run_git(workspace, &["write-tree"], Some(&index_path))?
        .trim()
        .to_string();
    let valid = (tree.len() == 40 || tree.len() == 64)
        && tree.chars().all(|character| character.is_ascii_hexdigit());
    if !valid {
        return Err("Git returned an invalid workspace snapshot".to_string());
    }
    Ok(tree)
}

#[tauri::command]
pub fn tool_get_git_diff(
    workspace: String,
    path: Option<String>,
    baseline_tree: Option<String>,
) -> ToolResult {
    if let Some(baseline_tree) = baseline_tree {
        let valid = (baseline_tree.len() == 40 || baseline_tree.len() == 64)
            && baseline_tree
                .chars()
                .all(|character| character.is_ascii_hexdigit());
        if !valid {
            return ToolResult {
                success: false,
                result: None,
                error: Some("Invalid Git baseline snapshot".to_string()),
            };
        }
        let tree_expression = format!("{baseline_tree}^{{tree}}");
        if let Err(error) = run_git(&workspace, &["cat-file", "-e", &tree_expression], None) {
            return ToolResult {
                success: false,
                result: None,
                error: Some(error),
            };
        }
        let current_tree = match capture_git_tree(&workspace) {
            Ok(tree) => tree,
            Err(error) => {
                return ToolResult {
                    success: false,
                    result: None,
                    error: Some(error),
                }
            }
        };
        let mut diff_args = vec![
            "diff",
            "--no-ext-diff",
            "--no-color",
            &baseline_tree,
            &current_tree,
        ];
        if let Some(path) = path.as_deref() {
            diff_args.extend(["--", path]);
        }
        let mut names_args = vec!["diff", "--name-only", "-z", &baseline_tree, &current_tree];
        if let Some(path) = path.as_deref() {
            names_args.extend(["--", path]);
        }
        return match (
            run_git(&workspace, &diff_args, None),
            run_git(&workspace, &names_args, None),
        ) {
            (Ok(diff), Ok(names)) => ToolResult {
                success: true,
                result: Some(serde_json::json!({
                    "hasChanges": !diff.is_empty(),
                    "diff": diff,
                    "changedFiles": names.split('\0').filter(|name| !name.is_empty()).collect::<Vec<_>>()
                })),
                error: None,
            },
            (Err(error), _) | (_, Err(error)) => ToolResult {
                success: false,
                result: None,
                error: Some(error),
            },
        };
    }

    let mut args = vec!["diff"];
    if let Some(path) = path.as_deref() {
        args.extend(["--", path]);
    }

    match run_git(&workspace, &args, None) {
        Ok(diff) => ToolResult {
            success: true,
            result: Some(serde_json::json!({
                "diff": diff,
                "hasChanges": !diff.is_empty()
            })),
            error: None,
        },
        Err(error) => ToolResult {
            success: false,
            result: None,
            error: Some(error),
        },
    }
}

fn keychain_fallback_path(name: &str) -> std::path::PathBuf {
    let base = dirs::home_dir().unwrap_or_else(|| std::path::PathBuf::from("."));
    base.join(".conduit").join(name)
}

fn github_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new("conduit", "github-token").map_err(|e| e.to_string())
}

fn openrouter_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new("conduit", "openrouter-api-key").map_err(|e| e.to_string())
}

fn read_fallback_token(name: &str) -> Option<String> {
    std::fs::read_to_string(keychain_fallback_path(name))
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn write_fallback_token(name: &str, token: &str) -> Result<(), String> {
    let path = keychain_fallback_path(name);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, token).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

#[tauri::command]
pub fn openrouter_get_key() -> ToolResult {
    match openrouter_entry() {
        Ok(entry) => match entry.get_password() {
            Ok(key) => ToolResult {
                success: true,
                result: Some(serde_json::json!({ "key": key })),
                error: None,
            },
            Err(keyring::Error::NoEntry) => {
                if let Some(key) = read_fallback_token("openrouter-api-key") {
                    let _ = openrouter_entry()
                        .and_then(|e| e.set_password(&key).map_err(|er| er.to_string()));
                    return ToolResult {
                        success: true,
                        result: Some(serde_json::json!({ "key": key })),
                        error: None,
                    };
                }
                ToolResult {
                    success: true,
                    result: Some(serde_json::json!({ "key": null })),
                    error: None,
                }
            }
            Err(_) => {
                if let Some(key) = read_fallback_token("openrouter-api-key") {
                    return ToolResult {
                        success: true,
                        result: Some(serde_json::json!({ "key": key })),
                        error: None,
                    };
                }
                ToolResult {
                    success: true,
                    result: Some(serde_json::json!({ "key": null })),
                    error: None,
                }
            }
        },
        Err(_) => {
            if let Some(key) = read_fallback_token("openrouter-api-key") {
                return ToolResult {
                    success: true,
                    result: Some(serde_json::json!({ "key": key })),
                    error: None,
                };
            }
            ToolResult {
                success: true,
                result: Some(serde_json::json!({ "key": null })),
                error: None,
            }
        }
    }
}

#[tauri::command]
pub fn openrouter_store_key(key: String) -> ToolResult {
    let key = key.trim().to_string();
    if key.is_empty() {
        if let Ok(entry) = openrouter_entry() {
            let _ = entry.delete_credential();
        }
        let _ = std::fs::remove_file(keychain_fallback_path("openrouter-api-key"));
        return ToolResult {
            success: true,
            result: None,
            error: None,
        };
    }
    let file_result = write_fallback_token("openrouter-api-key", &key);
    let keychain_result =
        openrouter_entry().and_then(|entry| entry.set_password(&key).map_err(|e| e.to_string()));
    if let (Err(keychain_error), Err(file_error)) = (&keychain_result, &file_result) {
        return ToolResult {
            success: false,
            result: None,
            error: Some(format!(
                "could not store key (keychain: {keychain_error}; file: {file_error})"
            )),
        };
    }
    ToolResult {
        success: true,
        result: None,
        error: None,
    }
}

#[tauri::command]
pub fn github_client_id() -> String {
    std::env::var("GITHUB_CLIENT_ID").unwrap_or_else(|_| "Ov23liMo1oJoAzSI7573".to_string())
}

#[tauri::command]
pub fn github_get_token() -> ToolResult {
    match github_entry() {
        Ok(entry) => match entry.get_password() {
            Ok(token) => ToolResult {
                success: true,
                result: Some(serde_json::json!({ "token": token })),
                error: None,
            },
            Err(keyring::Error::NoEntry) => {
                if let Some(token) = read_fallback_token("github-token") {
                    let _ = github_entry()
                        .and_then(|e| e.set_password(&token).map_err(|er| er.to_string()));
                    return ToolResult {
                        success: true,
                        result: Some(serde_json::json!({ "token": token })),
                        error: None,
                    };
                }
                ToolResult {
                    success: true,
                    result: Some(serde_json::json!({ "token": null })),
                    error: None,
                }
            }
            Err(_) => {
                if let Some(token) = read_fallback_token("github-token") {
                    return ToolResult {
                        success: true,
                        result: Some(serde_json::json!({ "token": token })),
                        error: None,
                    };
                }
                ToolResult {
                    success: true,
                    result: Some(serde_json::json!({ "token": null })),
                    error: None,
                }
            }
        },
        Err(_) => {
            if let Some(token) = read_fallback_token("github-token") {
                return ToolResult {
                    success: true,
                    result: Some(serde_json::json!({ "token": token })),
                    error: None,
                };
            }
            ToolResult {
                success: true,
                result: Some(serde_json::json!({ "token": null })),
                error: None,
            }
        }
    }
}

#[tauri::command]
pub fn github_store_token(token: String) -> ToolResult {
    let token = token.trim().to_string();
    if token.is_empty() {
        if let Ok(entry) = github_entry() {
            let _ = entry.delete_credential();
        }
        let _ = std::fs::remove_file(keychain_fallback_path("github-token"));
        return ToolResult {
            success: true,
            result: None,
            error: None,
        };
    }
    let _ = write_fallback_token("github-token", &token);
    match github_entry().and_then(|entry| entry.set_password(&token).map_err(|e| e.to_string())) {
        Ok(()) => ToolResult {
            success: true,
            result: None,
            error: None,
        },
        Err(_) => ToolResult {
            success: true,
            result: None,
            error: None,
        },
    }
}

#[tauri::command]
pub fn github_device_start(client_id: String) -> ToolResult {
    let client_id = if client_id.trim().is_empty() {
        github_client_id()
    } else {
        client_id
    };
    let response = ureq::post("https://github.com/login/device/code")
        .set("Accept", "application/json")
        .send_form(&[("client_id", client_id.as_str()), ("scope", "repo")]);
    match response {
        Ok(resp) => match resp.into_json::<serde_json::Value>() {
            Ok(json) => ToolResult {
                success: true,
                result: Some(json),
                error: None,
            },
            Err(e) => ToolResult {
                success: false,
                result: None,
                error: Some(format!("Failed to parse device flow response: {e}")),
            },
        },
        Err(ureq::Error::Status(code, resp)) => {
            let body = resp.into_string().unwrap_or_default();
            ToolResult {
                success: false,
                result: None,
                error: Some(format!("GitHub device flow failed ({code}): {body}")),
            }
        }
        Err(e) => ToolResult {
            success: false,
            result: None,
            error: Some(format!("GitHub device flow request failed: {e}")),
        },
    }
}

#[tauri::command]
pub fn github_device_poll(client_id: String, device_code: String) -> ToolResult {
    let client_id = if client_id.trim().is_empty() {
        github_client_id()
    } else {
        client_id
    };
    let response = ureq::post("https://github.com/login/oauth/access_token")
        .set("Accept", "application/json")
        .send_form(&[
            ("client_id", client_id.as_str()),
            ("device_code", device_code.as_str()),
            ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
        ]);
    match response {
        Ok(resp) => match resp.into_json::<serde_json::Value>() {
            Ok(json) => {
                if let Some(token) = json.get("access_token").and_then(|v| v.as_str()) {
                    let _ = write_fallback_token("github-token", token);
                    let _ = github_entry()
                        .and_then(|entry| entry.set_password(token).map_err(|e| e.to_string()));
                }
                ToolResult {
                    success: true,
                    result: Some(json),
                    error: None,
                }
            }
            Err(e) => ToolResult {
                success: false,
                result: None,
                error: Some(format!("Failed to parse access token response: {e}")),
            },
        },
        Err(ureq::Error::Status(_, resp)) => match resp.into_json::<serde_json::Value>() {
            Ok(json) => ToolResult {
                success: true,
                result: Some(json),
                error: None,
            },
            Err(_) => ToolResult {
                success: true,
                result: Some(serde_json::json!({"error":"authorization_pending"})),
                error: None,
            },
        },
        Err(e) => ToolResult {
            success: false,
            result: None,
            error: Some(format!("GitHub poll failed: {e}")),
        },
    }
}

#[tauri::command]
pub fn git_clone_repo(url: String, destination: String, name: String) -> ToolResult {
    if name.is_empty() || name == "." || name == ".." || name.contains('/') || name.contains('\\') {
        return ToolResult {
            success: false,
            result: None,
            error: Some("Invalid repository name".to_string()),
        };
    }
    if !is_github_https_clone_url(&url) {
        return ToolResult {
            success: false,
            result: None,
            error: Some("Only HTTPS GitHub repository URLs are supported".to_string()),
        };
    }

    let destination = match PathBuf::from(destination).canonicalize() {
        Ok(path) if path.is_dir() => path,
        _ => {
            return ToolResult {
                success: false,
                result: None,
                error: Some("Destination must be an existing folder".to_string()),
            }
        }
    };
    let target = destination.join(&name);
    if !target.starts_with(&destination) {
        return ToolResult {
            success: false,
            result: None,
            error: Some("Invalid repository destination".to_string()),
        };
    }
    if target.exists() {
        let is_repository = git_cmd()
            .args([
                "-C",
                &target.to_string_lossy(),
                "rev-parse",
                "--is-inside-work-tree",
            ])
            .output()
            .is_ok_and(|output| output.status.success());
        if is_repository {
            let existing_remote =
                git_command(&target.to_string_lossy(), &["remote", "get-url", "origin"])
                    .ok()
                    .and_then(|remote| github_repo_from_remote(&remote));
            let requested_remote = github_repo_from_remote(&url);
            if existing_remote
                .as_deref()
                .zip(requested_remote.as_deref())
                .is_some_and(|(existing, requested)| existing.eq_ignore_ascii_case(requested))
            {
                return ToolResult {
                    success: true,
                    result: Some(serde_json::json!({ "path": target })),
                    error: None,
                };
            }
            return ToolResult {
                success: false,
                result: None,
                error: Some(format!(
                    "Folder already contains a different Git repository: {}",
                    target.display()
                )),
            };
        }
        return ToolResult {
            success: false,
            result: None,
            error: Some(format!(
                "Folder already exists and is not a Git repository: {}",
                target.display()
            )),
        };
    }

    let token = match github_entry()
        .and_then(|entry| entry.get_password().map_err(|e| e.to_string()))
    {
        Ok(t) => t,
        Err(_) => {
            if let Some(fb) = read_fallback_token("github-token") {
                fb
            } else {
                return ToolResult {
                        success: false,
                        result: None,
                        error: Some("GitHub authorization is required: No matching entry found in secure storage. Please reconnect GitHub.".to_string()),
                    };
            }
        }
    };
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    let askpass = std::env::temp_dir().join(format!(
        "conduit-git-askpass-{}-{nonce}",
        std::process::id()
    ));
    let script = if cfg!(target_os = "windows") {
        let path = askpass.with_extension("cmd");
        if let Err(error) = std::fs::write(&path, "@echo off\nif /I \"%1\" == \"Username for 'https://github.com': \" (echo x-access-token) else (echo %LOOPKIT_GITHUB_TOKEN%)\n") {
            return ToolResult { success: false, result: None, error: Some(format!("Could not prepare Git authentication: {error}")) };
        }
        path
    } else {
        if let Err(error) = std::fs::write(&askpass, "#!/bin/sh\ncase \"$1\" in *Username*) echo x-access-token;; *) echo \"$LOOPKIT_GITHUB_TOKEN\";; esac\n") {
            return ToolResult { success: false, result: None, error: Some(format!("Could not prepare Git authentication: {error}")) };
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&askpass, fs::Permissions::from_mode(0o700));
        }
        askpass
    };
    let target_string = target.to_string_lossy().to_string();
    let output = git_cmd()
        .args(["clone", &url, &target_string])
        .env("GIT_ASKPASS", &script)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("LOOPKIT_GITHUB_TOKEN", token)
        .output();
    let _ = fs::remove_file(&script);
    match output {
        Ok(out) if out.status.success() => ToolResult {
            success: true,
            result: Some(serde_json::json!({ "path": target })),
            error: None,
        },
        Ok(out) => ToolResult {
            success: false,
            result: None,
            error: Some(String::from_utf8_lossy(&out.stderr).trim().to_string()),
        },
        Err(e) => ToolResult {
            success: false,
            result: None,
            error: Some(e.to_string()),
        },
    }
}

fn is_github_https_clone_url(url: &str) -> bool {
    regex::Regex::new(r"^https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+(?:\.git)?$")
        .is_ok_and(|regex| regex.is_match(url))
}

fn worktree_root(repository: &Path) -> PathBuf {
    repository
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join(".conduit-worktrees")
        .join(repository.file_name().unwrap_or_default())
}

fn valid_git_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 80
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '/' | '.'))
        && !value.contains("..")
}

#[tauri::command]
pub fn git_worktree_create(repository: String, branch: String, session_id: String) -> ToolResult {
    let repository = match PathBuf::from(&repository).canonicalize() {
        Ok(path) if path.is_dir() => path,
        _ => {
            return ToolResult {
                success: false,
                result: None,
                error: Some("Repository does not exist".to_string()),
            }
        }
    };
    if !valid_git_identifier(&branch)
        || !valid_git_identifier(&session_id)
        || session_id.contains('/')
    {
        return ToolResult {
            success: false,
            result: None,
            error: Some("Invalid branch or session identifier".to_string()),
        };
    }
    let target = worktree_root(&repository).join(&session_id);
    if target.exists() {
        return ToolResult {
            success: false,
            result: None,
            error: Some(format!("Worktree already exists: {}", target.display())),
        };
    }
    if let Err(error) = fs::create_dir_all(target.parent().unwrap_or(Path::new("."))) {
        return ToolResult {
            success: false,
            result: None,
            error: Some(error.to_string()),
        };
    }
    let output = git_cmd()
        .args([
            "-C",
            &repository.to_string_lossy(),
            "worktree",
            "add",
            "-b",
            &branch,
            &target.to_string_lossy(),
            "HEAD",
        ])
        .output();
    match output {
        Ok(out) if out.status.success() => ToolResult {
            success: true,
            result: Some(serde_json::json!({ "path": target, "branch": branch })),
            error: None,
        },
        Ok(out) => ToolResult {
            success: false,
            result: None,
            error: Some(String::from_utf8_lossy(&out.stderr).trim().to_string()),
        },
        Err(error) => ToolResult {
            success: false,
            result: None,
            error: Some(error.to_string()),
        },
    }
}

#[tauri::command]
pub fn git_worktree_remove(repository: String, worktree: String) -> ToolResult {
    let repository = match PathBuf::from(&repository).canonicalize() {
        Ok(path) if path.is_dir() => path,
        _ => {
            return ToolResult {
                success: false,
                result: None,
                error: Some("Repository does not exist".to_string()),
            }
        }
    };
    let worktree = PathBuf::from(&worktree);
    let expected_root = worktree_root(&repository);
    if !worktree.starts_with(&expected_root) || worktree == repository {
        return ToolResult {
            success: false,
            result: None,
            error: Some("Invalid worktree path".to_string()),
        };
    }
    let output = git_cmd()
        .args([
            "-C",
            &repository.to_string_lossy(),
            "worktree",
            "remove",
            "--force",
            &worktree.to_string_lossy(),
        ])
        .output();
    match output {
        Ok(out) if out.status.success() => ToolResult {
            success: true,
            result: Some(serde_json::json!({ "removed": true })),
            error: None,
        },
        Ok(out) => ToolResult {
            success: false,
            result: None,
            error: Some(String::from_utf8_lossy(&out.stderr).trim().to_string()),
        },
        Err(error) => ToolResult {
            success: false,
            result: None,
            error: Some(error.to_string()),
        },
    }
}

fn git_command(workspace: &str, args: &[&str]) -> Result<String, String> {
    let root = PathBuf::from(workspace)
        .canonicalize()
        .map_err(|_| "Workspace does not exist".to_string())?;
    let output = git_cmd()
        .arg("-C")
        .arg(root)
        .args(args)
        .output()
        .map_err(|e| e.to_string())?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

fn github_repo_from_remote(remote: &str) -> Option<String> {
    let remote = remote.trim().trim_end_matches(".git");
    remote
        .strip_prefix("https://github.com/")
        .or_else(|| remote.strip_prefix("http://github.com/"))
        .or_else(|| remote.strip_prefix("git@github.com:"))
        .filter(|repo| repo.split('/').count() == 2)
        .map(String::from)
}

#[tauri::command]
pub fn git_handoff_status(workspace: String) -> ToolResult {
    let branch = match git_command(&workspace, &["rev-parse", "--abbrev-ref", "HEAD"]) {
        Ok(value) => value,
        Err(error) => {
            return ToolResult {
                success: false,
                result: None,
                error: Some(error),
            }
        }
    };
    let changed = match git_command(&workspace, &["status", "--porcelain"]) {
        Ok(value) => !value.is_empty(),
        Err(error) => {
            return ToolResult {
                success: false,
                result: None,
                error: Some(error),
            }
        }
    };
    let remote = git_command(&workspace, &["remote", "get-url", "origin"]).ok();
    let base = git_command(
        &workspace,
        &["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
    )
    .ok()
    .and_then(|value| value.strip_prefix("origin/").map(String::from))
    .unwrap_or_else(|| "main".to_string());
    ToolResult {
        success: true,
        result: Some(
            serde_json::json!({ "branch": branch, "changed": changed, "remote": remote, "githubRepo": remote.as_deref().and_then(github_repo_from_remote), "base": base }),
        ),
        error: None,
    }
}

#[tauri::command]
pub fn git_commit_changes(workspace: String, message: String) -> ToolResult {
    let message = message.trim();
    if message.is_empty() || message.len() > 500 {
        return ToolResult {
            success: false,
            result: None,
            error: Some("Commit message must be between 1 and 500 characters".to_string()),
        };
    }
    if let Err(error) = git_command(&workspace, &["add", "-A"]) {
        return ToolResult {
            success: false,
            result: None,
            error: Some(error),
        };
    }
    let staged = git_command(&workspace, &["diff", "--cached", "--quiet"]).is_err();
    if !staged {
        return ToolResult {
            success: false,
            result: None,
            error: Some("There are no changes to commit".to_string()),
        };
    }
    match git_command(&workspace, &["commit", "-m", message]) {
        Ok(_) => ToolResult {
            success: true,
            result: Some(serde_json::json!({ "committed": true })),
            error: None,
        },
        Err(error) => ToolResult {
            success: false,
            result: None,
            error: Some(error),
        },
    }
}

#[tauri::command]
pub fn git_push_branch(workspace: String) -> ToolResult {
    let branch = match git_command(&workspace, &["rev-parse", "--abbrev-ref", "HEAD"]) {
        Ok(value) => value,
        Err(error) => {
            return ToolResult {
                success: false,
                result: None,
                error: Some(error),
            }
        }
    };
    let remote = match git_command(&workspace, &["remote", "get-url", "origin"]) {
        Ok(value) => value,
        Err(error) => {
            return ToolResult {
                success: false,
                result: None,
                error: Some(error),
            }
        }
    };
    let root = match PathBuf::from(&workspace).canonicalize() {
        Ok(path) => path,
        Err(_) => {
            return ToolResult {
                success: false,
                result: None,
                error: Some("Workspace does not exist".to_string()),
            }
        }
    };
    let token = github_entry()
        .and_then(|entry| entry.get_password().map_err(|e| e.to_string()))
        .ok()
        .or_else(|| read_fallback_token("github-token"));
    let askpass = std::env::temp_dir().join(format!("loopkit-git-push-{}", std::process::id()));
    if let Some(token) = token.as_ref() {
        let _ = std::fs::write(&askpass, "#!/bin/sh\ncase \"$1\" in *Username*) echo x-access-token;; *) echo \"$LOOPKIT_GITHUB_TOKEN\";; esac\n");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&askpass, fs::Permissions::from_mode(0o700));
        }
        let output = git_cmd()
            .args([
                "-C",
                &root.to_string_lossy(),
                "push",
                "-u",
                "origin",
                &branch,
            ])
            .env("GIT_ASKPASS", &askpass)
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("LOOPKIT_GITHUB_TOKEN", token)
            .output();
        let _ = fs::remove_file(&askpass);
        match output {
            Ok(out) if out.status.success() => {}
            Ok(out) => {
                return ToolResult {
                    success: false,
                    result: None,
                    error: Some(String::from_utf8_lossy(&out.stderr).trim().to_string()),
                }
            }
            Err(error) => {
                return ToolResult {
                    success: false,
                    result: None,
                    error: Some(error.to_string()),
                }
            }
        }
    } else if let Err(error) = git_command(&workspace, &["push", "-u", "origin", &branch]) {
        return ToolResult {
            success: false,
            result: None,
            error: Some(error),
        };
    }
    let base = git_command(
        &workspace,
        &["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
    )
    .ok()
    .and_then(|value| value.strip_prefix("origin/").map(String::from))
    .unwrap_or_else(|| "main".to_string());
    let pull_request_url = github_repo_from_remote(&remote)
        .map(|repo| format!("https://github.com/{repo}/compare/{base}...{branch}?expand=1"));
    ToolResult {
        success: true,
        result: Some(serde_json::json!({ "branch": branch, "pullRequestUrl": pull_request_url })),
        error: None,
    }
}

#[tauri::command]
pub async fn tool_execute(
    app: AppHandle,
    workspace: String,
    name: String,
    args: serde_json::Value,
    mode: String,
    permission_mode: String,
    timeout_ms: Option<u64>,
) -> ToolResult {
    tauri::async_runtime::spawn_blocking(move || {
        execute_tool(
            app,
            workspace,
            name,
            args,
            mode,
            permission_mode,
            timeout_ms,
        )
    })
    .await
    .unwrap_or_else(|error| ToolResult {
        success: false,
        result: None,
        error: Some(format!("Native tool task failed: {error}")),
    })
}

fn execute_tool(
    app: AppHandle,
    workspace: String,
    name: String,
    args: serde_json::Value,
    mode: String,
    permission_mode: String,
    timeout_ms: Option<u64>,
) -> ToolResult {
    if mode != "ask" && mode != "goal" {
        return ToolResult {
            success: false,
            result: None,
            error: Some("Invalid tool mode".to_string()),
        };
    }
    let goal_only = [
        "write_file",
        "replace_in_file",
        "create_file",
        "delete_file",
        "run_command",
        "get_git_diff",
        "capture_git_snapshot",
    ];
    if mode == "ask" && goal_only.contains(&name.as_str()) {
        return ToolResult {
            success: false,
            result: None,
            error: Some(format!("{name} is not available in Ask mode")),
        };
    }

    match name.as_str() {
        "list_files" => tool_list_files(
            workspace,
            args.get("path").and_then(|v| v.as_str()).map(String::from),
            args.get("max_depth")
                .and_then(|v| v.as_u64())
                .map(|v| v as u32),
        ),
        "read_file" => tool_read_file(
            workspace,
            args.get("path")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            args.get("offset")
                .and_then(|v| v.as_u64())
                .map(|v| v as u32),
            args.get("limit").and_then(|v| v.as_u64()).map(|v| v as u32),
        ),
        "write_file" => tool_write_file(
            workspace,
            args.get("path")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            args.get("content")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
        ),
        "create_file" => tool_create_file(
            workspace,
            args.get("path")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            args.get("content")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
        ),
        "delete_file" => tool_delete_file(
            workspace,
            args.get("path")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
        ),
        "replace_in_file" => tool_replace_in_file(
            workspace,
            args.get("path")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            args.get("search")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            args.get("replace")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            args.get("replace_all").and_then(|v| v.as_bool()),
        ),
        "search_files" => tool_search_files(
            workspace,
            args.get("query")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            args.get("regex").and_then(|v| v.as_bool()),
            args.get("case_sensitive").and_then(|v| v.as_bool()),
        ),
        "run_command" => {
            let command = args
                .get("command")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            match requires_command_approval(&command, &permission_mode) {
                Err(error) => ToolResult {
                    success: false,
                    result: None,
                    error: Some(error),
                },
                Ok(true) if !approve_command(&app, &command) => ToolResult {
                    success: false,
                    result: None,
                    error: Some("Command was not approved".to_string()),
                },
                _ => tool_run_command(workspace, command, timeout_ms),
            }
        }
        "get_git_diff" => tool_get_git_diff(
            workspace,
            args.get("path").and_then(|v| v.as_str()).map(String::from),
            args.get("baselineTree")
                .and_then(|v| v.as_str())
                .map(String::from),
        ),
        "capture_git_snapshot" => tool_capture_git_snapshot(workspace),
        _ => ToolResult {
            success: false,
            result: None,
            error: Some(format!("Unknown tool: {name}")),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_entries_use_the_shared_type_field() {
        let value = serde_json::to_value(FileEntry {
            name: "client.cpp".to_string(),
            path: "src/client.cpp".to_string(),
            entry_type: "file".to_string(),
            size: Some(12),
        })
        .unwrap();

        assert_eq!(value["type"], "file");
        assert!(value.get("entry_type").is_none());
    }

    #[test]
    fn rejects_parent_components() {
        let temp = tempfile::tempdir().unwrap();
        assert!(normalize_path(temp.path().to_str().unwrap(), "../secret").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_new_files_below_an_external_symlink() {
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().unwrap();
        let workspace = temp.path().join("workspace");
        let outside = temp.path().join("outside");
        fs::create_dir_all(&workspace).unwrap();
        fs::create_dir_all(&outside).unwrap();
        symlink(&outside, workspace.join("escape")).unwrap();

        let result = normalize_path(workspace.to_str().unwrap(), "escape/new-file.txt");
        assert!(result.is_err());
    }

    #[cfg(unix)]
    #[test]
    fn permits_new_files_below_an_internal_symlink() {
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().unwrap();
        let workspace = temp.path().join("workspace");
        let real = workspace.join("real");
        fs::create_dir_all(&real).unwrap();
        symlink(&real, workspace.join("link")).unwrap();

        let result = normalize_path(workspace.to_str().unwrap(), "link/new-file.txt").unwrap();
        assert_eq!(result, real.canonicalize().unwrap().join("new-file.txt"));
    }

    #[test]
    fn command_policy_defaults_to_explicit_approval() {
        assert!(!requires_command_approval("git status", "auto_approve_safe").unwrap());
        assert!(requires_command_approval("npm install", "auto_approve_safe").unwrap());
        assert!(requires_command_approval("git status", "ask_every_time").unwrap());
        assert!(!requires_command_approval("npm install", "auto_approve_all").unwrap());
        assert!(requires_command_approval("git status", "invalid").is_err());
    }

    #[test]
    fn scoped_git_diff_excludes_the_preexisting_workspace_state() {
        let temp = tempfile::tempdir().unwrap();
        let workspace = temp.path();
        assert!(Command::new("git")
            .args(["init", "-q"])
            .current_dir(workspace)
            .status()
            .unwrap()
            .success());
        fs::write(workspace.join("shared.txt"), "plan A\n").unwrap();
        fs::write(workspace.join("accepted-untracked.txt"), "accepted\n").unwrap();
        let baseline = capture_git_tree(workspace.to_str().unwrap()).unwrap();

        fs::write(workspace.join("shared.txt"), "plan A\nplan B\n").unwrap();
        fs::write(workspace.join("plan-b.txt"), "new\n").unwrap();
        let result = tool_get_git_diff(
            workspace.to_string_lossy().into_owned(),
            None,
            Some(baseline),
        );

        assert!(result.success);
        let result = result.result.unwrap();
        let files = result["changedFiles"].as_array().unwrap();
        assert_eq!(files.len(), 2);
        assert!(files.iter().any(|file| file == "plan-b.txt"));
        assert!(files.iter().any(|file| file == "shared.txt"));
        let diff = result["diff"].as_str().unwrap();
        assert!(diff.contains("+plan B"));
        assert!(!diff.contains("accepted-untracked"));
    }

    #[test]
    fn clone_urls_are_limited_to_github_https() {
        assert!(is_github_https_clone_url(
            "https://github.com/owner/repository.git"
        ));
        assert!(is_github_https_clone_url(
            "https://github.com/owner/repository"
        ));
        assert!(!is_github_https_clone_url(
            "https://example.com/owner/repository.git"
        ));
        assert!(!is_github_https_clone_url(
            "git@github.com:owner/repository.git"
        ));
        assert!(!is_github_https_clone_url(
            "https://github.com/owner/repository.git/extra"
        ));
    }

    #[test]
    fn clone_reuses_only_the_matching_existing_repository() {
        let temp = tempfile::tempdir().unwrap();
        let repository = temp.path().join("repository");
        assert!(Command::new("git")
            .args(["init", repository.to_str().unwrap()])
            .output()
            .unwrap()
            .status
            .success());
        assert!(Command::new("git")
            .args([
                "-C",
                repository.to_str().unwrap(),
                "remote",
                "add",
                "origin",
                "https://github.com/owner/repository.git",
            ])
            .output()
            .unwrap()
            .status
            .success());

        let matching = git_clone_repo(
            "https://github.com/owner/repository.git".to_string(),
            temp.path().to_string_lossy().into_owned(),
            "repository".to_string(),
        );
        assert!(matching.success);

        let different = git_clone_repo(
            "https://github.com/other/repository.git".to_string(),
            temp.path().to_string_lossy().into_owned(),
            "repository".to_string(),
        );
        assert!(!different.success);
        assert!(different
            .error
            .unwrap()
            .contains("different Git repository"));
    }
}
