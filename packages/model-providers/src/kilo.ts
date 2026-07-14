import type {
  ModelDescriptor,
  ModelRequest,
  ModelResponse,
  ModelStreamEvent,
} from "@loopkit/shared";
import { LocalHarnessProvider } from "./provider.js";

const KILO_REQUEST_TIMEOUT_MS = 20 * 60 * 1000;

interface KiloModelPayload {
  id?: string;
  providerID?: string;
  name?: string;
  limit?: { context?: number; output?: number };
  cost?: { input?: number; output?: number };
  capabilities?: { toolcall?: boolean; reasoning?: boolean };
}

/** Kilo Code's local CLI harness. Authentication and model configuration stay in Kilo. */
export class KiloProvider extends LocalHarnessProvider {
  readonly id = "kilo";
  readonly name = "Kilo Code";
  readonly capabilities = {
    supportsAsk: true,
    supportsGoal: true,
    supportsJudge: true,
    streamsToolEvents: true,
  } as const;

  async listModels(): Promise<ModelDescriptor[]> {
    if (typeof window === "undefined") {
      return [fallbackModel()];
    }

    const response = await fetch("/api/kilo/models", {
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      const message = await response.text();
      throw new Error(message || `Kilo model discovery failed (${response.status})`);
    }
    return (await response.json()) as ModelDescriptor[];
  }

  async streamResponse(
    request: ModelRequest,
    onEvent: (event: ModelStreamEvent) => void
  ): Promise<ModelResponse> {
    if (typeof window === "undefined") {
      throw new Error("Kilo Ask mode is only available through the desktop backend");
    }
    if (!request.workspacePath) throw new Error("Kilo Ask requires a workspace");

    const response = await fetch("/api/agent/kilo-chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspace: request.workspacePath,
        modelId: request.modelId,
        messages: request.messages,
      }),
      signal: AbortSignal.timeout(KILO_REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error((await response.text()) || `Kilo Ask failed (${response.status})`);
    if (!response.body) throw new Error("Kilo Ask returned no response body");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let result: ModelResponse | undefined;
    let lastEvent = "the Kilo stream started";
    while (true) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`Kilo stream interrupted after ${lastEvent}: ${reason}`);
      }
      const { done, value } = chunk;
      buffer += decoder.decode(value, { stream: !done });
      const lines = buffer.split("\n");
      buffer = done ? "" : lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const packet = JSON.parse(line) as { event?: ModelStreamEvent; result?: ModelResponse; error?: string };
        if (packet.event) {
          onEvent(packet.event);
          lastEvent = packet.event.type === "content_delta" ? "a content update" : `event ${packet.event.type}`;
        }
        if (packet.error) throw new Error(packet.error);
        if (packet.result) result = packet.result;
      }
      if (done) break;
    }
    if (!result) throw new Error("Kilo Ask returned no result");
    return result;
  }
}

export function parseKiloModels(output: string): ModelDescriptor[] {
  const models: ModelDescriptor[] = [];
  const lines = output.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const header = lines[index]?.trim();
    if (!header || !/^[A-Za-z0-9_.~/-]+\/.+/.test(header)) continue;

    const jsonLines: string[] = [];
    let depth = 0;
    let started = false;
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const line = lines[cursor] ?? "";
      if (!started && !line.trim().startsWith("{")) continue;
      started = true;
      jsonLines.push(line);
      depth += countBraces(line, "{") - countBraces(line, "}");
      if (started && depth === 0) {
        index = cursor;
        break;
      }
    }

    if (!jsonLines.length) continue;
    try {
      const payload = JSON.parse(jsonLines.join("\n")) as KiloModelPayload;
      if (payload.providerID && !payload.providerID.startsWith("kilo")) continue;
      // Prefix with LoopKit's provider namespace while retaining the exact
      // Kilo runtime model ID after the first slash.
      const id = header.startsWith("kilo/") ? header : `kilo/${header}`;
      models.push({
        id,
        provider: "kilo",
        displayName: payload.name || header,
        contextLength: payload.limit?.context,
        supportsTools: payload.capabilities?.toolcall !== false,
        supportsStructuredOutput: false,
        supportsReasoning: payload.capabilities?.reasoning ?? false,
        supportsAsk: true,
        supportsGoal: true,
        supportsJudge: true,
        inputPrice: payload.cost?.input,
        outputPrice: payload.cost?.output,
      });
    } catch {
      // Ignore non-model output so a single malformed line cannot hide the catalog.
    }
  }

  return models.length ? dedupeModels(models) : [fallbackModel()];
}

function countBraces(value: string, brace: "{" | "}"): number {
  return value.split(brace).length - 1;
}

function dedupeModels(models: ModelDescriptor[]): ModelDescriptor[] {
  return Array.from(new Map(models.map((model) => [model.id, model])).values());
}

function fallbackModel(): ModelDescriptor {
  return {
    id: "kilo/kilo-auto/free",
    provider: "kilo",
    displayName: "Kilo Auto (Free)",
    supportsTools: true,
    supportsStructuredOutput: false,
    supportsReasoning: true,
    supportsAsk: true,
    supportsGoal: true,
    supportsJudge: true,
  };
}
