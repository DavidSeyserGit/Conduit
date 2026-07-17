import type {
  GoalRunEvent,
  ModelDescriptor,
  ModelRequest,
  ModelResponse,
  ModelStreamEvent,
} from "@conduit/shared";
import type { CodingIterationRequest, CodingIterationResult } from "./provider.js";

const LOCAL_REQUEST_TIMEOUT_MS = 20 * 60 * 1000;

export interface LocalHarnessTransport {
  listModels(providerId: "codex" | "kilo" | "kimi"): Promise<unknown[]>;
  createResponse(
    providerId: "codex" | "kilo" | "kimi",
    request: ModelRequest,
    onEvent: (event: ModelStreamEvent) => void,
  ): Promise<ModelResponse>;
  runCodingIteration(
    providerId: "codex" | "kilo" | "kimi",
    request: CodingIterationRequest,
    onEvent: (event: GoalRunEvent) => void,
  ): Promise<CodingIterationResult>;
}

/** Browser-development adapter. Production Tauri injects an IPC transport. */
export class HttpLocalHarnessTransport implements LocalHarnessTransport {
  async listModels(providerId: "codex" | "kilo" | "kimi"): Promise<unknown[]> {
    const response = await fetch(`/api/${providerId}/models`, {
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      const message = await response.text();
      throw new Error(message || `${providerId} model discovery failed (${response.status})`);
    }
    return await response.json() as unknown[];
  }

  async createResponse(
    providerId: "codex" | "kilo" | "kimi",
    request: ModelRequest,
    onEvent: (event: ModelStreamEvent) => void,
  ): Promise<ModelResponse> {
    const endpoint = providerId === "codex" ? "/api/codex/response" : "/api/agent/kilo-chat";
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(serializableModelRequest(request)),
      signal: combineWithTimeout(request.signal, LOCAL_REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      const error = await response.text();
      throw new Error(parseErrorBody(error) || `${providerId} request failed (${response.status})`);
    }

    if (providerId === "codex") {
      const body = await response.json().catch(() => ({})) as { result?: ModelResponse; error?: string };
      if (!body.result) throw new Error(body.error || "Codex backend returned no result");
      return body.result;
    }
    return readNdjsonResult<ModelResponse, ModelStreamEvent>(response, onEvent, "Kilo Ask");
  }

  async runCodingIteration(
    _providerId: "codex" | "kilo" | "kimi",
    request: CodingIterationRequest,
    onEvent: (event: GoalRunEvent) => void,
  ): Promise<CodingIterationResult> {
    const response = await fetch("/api/agent/pi-iteration", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspace: request.workspacePath,
        goal: request.goal,
        modelId: request.modelId,
        previousPlan: request.previousPlan,
        judgeFeedback: request.judgeFeedback,
        iteration: request.iteration,
        maxIterations: request.maxIterations,
        codingReasoningEffort: request.reasoningEffort,
        permissionMode: request.permissionMode,
      }),
      signal: combineWithTimeout(request.signal, LOCAL_REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      const error = await response.text();
      throw new Error(parseErrorBody(error) || `Local coding backend failed (${response.status})`);
    }
    return readNdjsonResult<CodingIterationResult, GoalRunEvent>(response, onEvent, "Local coding agent");
  }
}

export function serializableModelRequest(request: ModelRequest): Record<string, unknown> {
  return {
    workspace: request.workspacePath,
    workspacePath: request.workspacePath,
    modelId: request.modelId,
    reasoningEffort: request.reasoningEffort,
    messages: request.messages,
    structuredOutput: request.structuredOutput,
    temperature: request.temperature,
    maxTokens: request.maxTokens,
  };
}

async function readNdjsonResult<TResult, TEvent>(
  response: Response,
  onEvent: (event: TEvent) => void,
  label: string,
): Promise<TResult> {
  if (!response.body) throw new Error(`${label} returned no response body`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result: TResult | undefined;
  let lastEvent = `${label} stream started`;

  while (true) {
    let chunk: ReadableStreamReadResult<Uint8Array>;
    try {
      chunk = await reader.read();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`${label} stream interrupted after ${lastEvent}: ${reason}`);
    }
    const { done, value } = chunk;
    buffer += decoder.decode(value, { stream: !done });
    const lines = buffer.split("\n");
    buffer = done ? "" : lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const packet = JSON.parse(line) as { event?: TEvent; result?: TResult; error?: string };
      if (packet.event) {
        onEvent(packet.event);
        lastEvent = "the latest event";
      }
      if (packet.error) throw new Error(packet.error);
      if (packet.result) result = packet.result;
    }
    if (done) break;
  }
  if (!result) throw new Error(`${label} returned no result`);
  return result;
}

function parseErrorBody(body: string): string {
  if (!body.trim()) return "";
  try {
    const parsed = JSON.parse(body) as { error?: string };
    return parsed.error || body;
  } catch {
    return body;
  }
}

function combineWithTimeout(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export function asModelDescriptors(models: unknown[]): ModelDescriptor[] {
  return models as ModelDescriptor[];
}
