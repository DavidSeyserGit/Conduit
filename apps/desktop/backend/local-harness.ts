import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type {
  ModelDescriptor,
  ModelMessage,
  ToolCallRequest,
  CommandPermissionMode,
} from "@conduit/shared";

export const LOCAL_HARNESS_TIMEOUT_MS = 20 * 60 * 1000;
const LOCAL_HARNESS_OUTPUT_LIMIT = 20 * 1024 * 1024;

export interface StructuredOutputContract {
  name: string;
  schema: Record<string, unknown>;
}

export interface LocalHarnessRun {
  summary: string;
  toolCalls: HarnessToolCall[];
}

export interface HarnessToolCall extends ToolCallRequest {
  status: "running" | "completed";
  startedAt: string;
  completedAt?: string;
  result?: unknown;
}

export type KiloRunRole = "judge" | "worker";

export interface WorkerPromptInput {
  goal: string;
  iteration: number;
  maxIterations: number;
  previousPlan?: unknown;
  judgeFeedback?: string[];
}

/**
 * ModelProvider requests always carry Conduit's canonical `provider/runtime-id`.
 * Backends strip exactly one provider namespace before invoking a CLI/API.
 */
export function toRuntimeModelId(providerId: string, modelId: string): string {
  const prefix = `${providerId}/`;
  if (!modelId.startsWith(prefix) || modelId.length === prefix.length) {
    throw new Error(`Invalid ${providerId} model ID: ${modelId}`);
  }
  return modelId.slice(prefix.length);
}

/**
 * Kilo's own runtime IDs start with `kilo/`, so canonical IDs normally look
 * like `kilo/kilo/<model>`. Legacy persisted IDs used the native ID directly;
 * accept both shapes during migration.
 */
export function toKiloRuntimeModelId(modelId: string): string {
  if (modelId.startsWith("kilo/kilo/")) {
    return toRuntimeModelId("kilo", modelId);
  }
  if (modelId.startsWith("kilo/") && modelId.length > "kilo/".length) {
    return modelId;
  }
  throw new Error(`Invalid Kilo model ID: ${modelId}`);
}

export function toCanonicalKiloModelId(runtimeModelId: string): string {
  if (!runtimeModelId.startsWith("kilo/") || runtimeModelId.length === "kilo/".length) {
    throw new Error(`Invalid Kilo runtime model ID: ${runtimeModelId}`);
  }
  return `kilo/${runtimeModelId}`;
}

export function buildJudgePrompt(
  messages: ModelMessage[],
  structuredOutput?: StructuredOutputContract,
): string {
  const transcript = messages
    .map((message) => `## ${message.role}\n${message.content}`)
    .join("\n\n");
  const outputInstruction = structuredOutput
    ? [
        "Return only valid JSON without Markdown fences or commentary.",
        `The JSON must match this ${structuredOutput.name} schema exactly:`,
        JSON.stringify(structuredOutput.schema),
      ].join("\n")
    : "Return a concise response to the conversation.";

  return [
    "Act on the conversation below as a read-only planning or review judge.",
    "Do not inspect or modify the workspace and do not call tools. Use only the supplied conversation.",
    outputInstruction,
    "",
    transcript,
  ].join("\n");
}

export function buildWorkerPrompt(input: WorkerPromptInput): string {
  return [
    "Work directly on this repository and complete the goal using your coding tools.",
    "Preserve pre-existing workspace changes from earlier goals. Do not treat a dirty worktree as part of the current goal; Conduit scopes review evidence to this run.",
    "",
    `Goal: ${input.goal}`,
    `Iteration: ${input.iteration} of ${input.maxIterations}`,
    input.previousPlan ? `Previous plan:\n${JSON.stringify(input.previousPlan)}` : "",
    input.judgeFeedback?.length
      ? `Required judge fixes — address every item and validate them:\n${input.judgeFeedback.map((feedback, index) => `${index + 1}. ${feedback}`).join("\n")}`
      : "",
    "At the end, briefly summarize verified work completed.",
  ].filter(Boolean).join("\n");
}

export function buildKiloArgs(
  root: string,
  runtimeModelId: string,
  prompt: string,
  role: KiloRunRole,
): string[] {
  const roleArgs = role === "judge"
    ? ["--agent", "ask"]
    : ["--agent", "code"];
  return [
    "run",
    "--format", "json",
    "--dir", root,
    "--model", runtimeModelId,
    "--pure",
    ...roleArgs,
    prompt,
  ];
}

export function buildKiloSecurityConfig(
  role: KiloRunRole,
  permissionMode: CommandPermissionMode = "auto_approve_safe",
): string {
  if (!["ask_every_time", "auto_approve_safe", "auto_approve_all"].includes(permissionMode)) {
    throw new Error("Invalid command permission mode");
  }
  const bash = permissionMode === "ask_every_time"
    ? "deny"
    : permissionMode === "auto_approve_all"
      ? "allow"
      : {
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
        };
  const permission = role === "judge" ? "deny" : {
    "*": "deny",
    read: { "*": "allow", "*.env": "deny", "*.env.*": "deny" },
    glob: "allow",
    grep: "allow",
    edit: { "*": "allow", "*.env": "deny", "*.env.*": "deny" },
    write: { "*": "allow", "*.env": "deny", "*.env.*": "deny" },
    apply_patch: "allow",
    bash,
    external_directory: "deny",
    task: "deny",
    agent_manager: "deny",
    webfetch: "deny",
    websearch: "deny",
    skill: "deny",
    question: "deny",
  };
  const config: Record<string, unknown> = {
    permission,
    formatter: false,
    lsp: false,
    snapshot: true,
    agent: { [role === "judge" ? "ask" : "code"]: { permission } },
  };
  if (process.platform !== "win32") {
    config.sandbox = {
      enabled: true,
      network: "deny",
      allowed_hosts: [],
      writable_paths: [],
    };
  }
  return JSON.stringify(config);
}

export function buildCodexJudgeArgs(input: {
  root: string;
  runtimeModelId: string;
  prompt: string;
  outputFile: string;
  schemaFile?: string;
  reasoningEffort?: string;
}): string[] {
  const reasoningArgs = input.reasoningEffort
    ? ["-c", `model_reasoning_effort=${JSON.stringify(input.reasoningEffort)}`]
    : [];
  const schemaArgs = input.schemaFile ? ["--output-schema", input.schemaFile] : [];
  return [
    "exec",
    "-c", "approval_policy=\"never\"",
    "-c", "web_search=\"disabled\"",
    ...reasoningArgs,
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--skip-git-repo-check",
    "--sandbox", "read-only",
    "-C", input.root,
    "-m", input.runtimeModelId,
    ...schemaArgs,
    "-o", input.outputFile,
    input.prompt,
  ];
}

export function buildCodexWorkerArgs(input: {
  root: string;
  runtimeModelId: string;
  prompt: string;
  outputFile: string;
  reasoningEffort?: string;
}): string[] {
  const reasoningArgs = input.reasoningEffort
    ? ["-c", `model_reasoning_effort=${JSON.stringify(input.reasoningEffort)}`]
    : [];
  return [
    "exec",
    "-c", "approval_policy=\"never\"",
    "-c", "sandbox_workspace_write.network_access=false",
    "-c", "web_search=\"disabled\"",
    ...reasoningArgs,
    "--json",
    "--ephemeral",
    "--ignore-user-config",
    "--sandbox", "workspace-write",
    "--color", "never",
    "--skip-git-repo-check",
    "-C", input.root,
    "-m", input.runtimeModelId,
    "-o", input.outputFile,
    input.prompt,
  ];
}

export function parseKiloModelCatalog(output: string): ModelDescriptor[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((runtimeId) => runtimeId.startsWith("kilo/") && runtimeId.length > "kilo/".length)
    .map((runtimeId) => {
      const name = runtimeId.split("/").at(-1)?.replace(/[-_]/g, " ") || runtimeId;
      return {
        id: toCanonicalKiloModelId(runtimeId),
        provider: "kilo",
        displayName: name.replace(/\b\w/g, (letter) => letter.toUpperCase()),
        supportsTools: true,
        supportsStructuredOutput: false,
        supportsReasoning: true,
        supportsAsk: true,
        supportsGoal: true,
        supportsJudge: true,
      };
    });
}

export function tryParseStructuredOutput(content: string): unknown | undefined {
  const trimmed = content.trim();
  if (!trimmed) return undefined;

  try {
    return JSON.parse(trimmed);
  } catch {
    // Some models still wrap otherwise-valid JSON in prose or Markdown.
  }

  for (let start = 0; start < content.length; start += 1) {
    if (content[start] !== "{") continue;
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let cursor = start; cursor < content.length; cursor += 1) {
      const character = content[cursor];
      if (quoted) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === "\"") quoted = false;
        continue;
      }
      if (character === "\"") quoted = true;
      else if (character === "{") depth += 1;
      else if (character === "}") {
        depth -= 1;
        if (depth === 0) {
          try {
            return JSON.parse(content.slice(start, cursor + 1));
          } catch {
            break;
          }
        }
      }
    }
  }
  return undefined;
}

export class KiloEventCollector {
  private summary = "";
  private readonly toolCalls = new Map<string, HarnessToolCall>();

  constructor(
    private readonly onStatus: (message: string) => void,
    private readonly onTool: (toolCall: HarnessToolCall) => void,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly createId: () => string = randomUUID,
  ) {}

  consume(line: string): void {
    if (!line.trim()) return;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    const part = isRecord(event.part) ? event.part : event;
    if (event.type === "step_start") this.onStatus("Kilo started a step…");
    if (event.type === "step_finish") this.onStatus("Kilo finished a step");
    if (event.type === "text" || part.type === "text") {
      const text = stringValue(event.text) || stringValue(part.text);
      if (text) this.summary += text;
    }

    const isToolEvent = event.type === "tool_use"
      || event.type === "tool_call"
      || event.type === "tool_result"
      || part.type === "tool";
    if (!isToolEvent) return;

    const state = isRecord(part.state) ? part.state : undefined;
    const id = stringValue(event.callID)
      || stringValue(event.toolCallId)
      || stringValue(part.callID)
      || stringValue(part.id)
      || this.createId();
    const existing = this.toolCalls.get(id);
    const toolCall: HarnessToolCall = existing || {
      id,
      name: stringValue(event.tool)
        || stringValue(event.toolName)
        || stringValue(part.tool)
        || stringValue(part.name)
        || "tool",
      arguments: recordValue(event.input)
        || recordValue(event.arguments)
        || (state ? recordValue(state.input) : undefined)
        || recordValue(part.input)
        || {},
      status: "running",
      startedAt: this.now(),
    };
    if (state?.status === "completed" || event.type === "tool_result") {
      toolCall.status = "completed";
      toolCall.result = state?.output ?? event.result;
      toolCall.completedAt = this.now();
    }
    this.toolCalls.set(id, toolCall);
    this.onTool(toolCall);
  }

  result(): LocalHarnessRun {
    return { summary: this.summary, toolCalls: Array.from(this.toolCalls.values()) };
  }
}

export function runCodexProcess(
  args: string[],
  cwd: string,
  signal: AbortSignal,
  timeoutMs = LOCAL_HARNESS_TIMEOUT_MS,
  exec: typeof execFile = execFile,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = exec(
      "codex",
      args,
      {
        cwd,
        encoding: "utf8",
        maxBuffer: 20 * 1024 * 1024,
        timeout: timeoutMs,
        signal,
      },
      (error, stdout, stderr) => {
        if (error) {
          const message = String(stderr || "").trim() || error.message;
          reject(new Error(message));
          return;
        }
        resolve({ stdout: String(stdout), stderr: String(stderr) });
      },
    );
    // Codex reads piped stdin as additional prompt input. An explicit EOF is
    // therefore a process invariant, not an HTTP concern.
    child.stdin?.end();
  });
}

export async function runKiloProcess(
  root: string,
  runtimeModelId: string,
  prompt: string,
  signal: AbortSignal,
  onStatus: (message: string) => void,
  onTool: (toolCall: HarnessToolCall) => void,
  role: KiloRunRole,
  permissionMode: CommandPermissionMode = "auto_approve_safe",
  timeoutMs = LOCAL_HARNESS_TIMEOUT_MS,
  spawnProcess: typeof spawn = spawn,
): Promise<LocalHarnessRun> {
  const child = spawnProcess("kilo", buildKiloArgs(root, runtimeModelId, prompt, role), {
    cwd: root,
    env: {
      ...process.env,
      KILO_CONFIG_CONTENT: buildKiloSecurityConfig(role, permissionMode),
      KILO_DISABLE_EXTERNAL_SKILLS: "true",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const collector = new KiloEventCollector(onStatus, onTool);
  let buffer = "";
  let stderr = "";
  let timedOut = false;
  let outputOverflow = false;
  let outputBytes = 0;
  let terminating = false;
  let forceKill: ReturnType<typeof setTimeout> | undefined;

  const terminate = () => {
    if (terminating) return;
    terminating = true;
    child.kill("SIGTERM");
    forceKill = setTimeout(() => child.kill("SIGKILL"), 5_000);
    forceKill.unref?.();
  };

  child.stdout.on("data", (chunk) => {
    outputBytes += Buffer.byteLength(chunk);
    if (outputBytes > LOCAL_HARNESS_OUTPUT_LIMIT) {
      outputOverflow = true;
      terminate();
      return;
    }
    buffer += String(chunk);
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";
    for (const line of lines) collector.consume(line);
  });
  child.stderr.on("data", (chunk) => {
    outputBytes += Buffer.byteLength(chunk);
    if (outputBytes > LOCAL_HARNESS_OUTPUT_LIMIT) {
      outputOverflow = true;
      terminate();
      return;
    }
    stderr += String(chunk);
  });
  const abortChild = () => terminate();
  const timeout = setTimeout(() => {
    timedOut = true;
    terminate();
  }, timeoutMs);
  timeout.unref?.();
  signal.addEventListener("abort", abortChild, { once: true });
  try {
    const code = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (exitCode) => resolve(exitCode ?? 1));
    });
    if (buffer.trim()) collector.consume(buffer);
    if (signal.aborted) throw new Error("Kilo run was cancelled before completion");
    if (timedOut) throw new Error(`Kilo run timed out after ${timeoutMs}ms`);
    if (outputOverflow) throw new Error("Kilo output exceeded 20 MiB");
    if (code !== 0) throw new Error(stderr.trim() || `Kilo exited with code ${code}`);
    return collector.result();
  } finally {
    clearTimeout(timeout);
    clearTimeout(forceKill);
    signal.removeEventListener("abort", abortChild);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}
