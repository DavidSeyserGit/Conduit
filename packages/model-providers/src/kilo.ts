import type {
  ModelDescriptor,
  ModelRequest,
  ModelResponse,
  ModelStreamEvent,
} from "@conduit/shared";
import { LocalHarnessProvider } from "./provider.js";
import type { CodingIterationRequest, CodingIterationResult } from "./provider.js";
import { HttpLocalHarnessTransport, type LocalHarnessTransport } from "./local-transport.js";

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

  constructor(private readonly transport: LocalHarnessTransport = new HttpLocalHarnessTransport()) {
    super();
  }

  async listModels(): Promise<ModelDescriptor[]> {
    return await this.transport.listModels("kilo") as ModelDescriptor[];
  }

  async createResponse(request: ModelRequest): Promise<ModelResponse> {
    return this.streamResponse(request, () => {});
  }

  async streamResponse(
    request: ModelRequest,
    onEvent: (event: ModelStreamEvent) => void
  ): Promise<ModelResponse> {
    if (!request.workspacePath) throw new Error("Kilo Ask requires a workspace");
    return this.transport.createResponse("kilo", request, onEvent);
  }

  async runCodingIteration(
    request: CodingIterationRequest,
    onEvent: (event: import("@conduit/shared").GoalRunEvent) => void,
  ): Promise<CodingIterationResult> {
    return this.transport.runCodingIteration("kilo", request, onEvent);
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
      // Kilo runtime IDs already start with `kilo/`; add Conduit's provider
      // namespace as a separate segment so routing never has to guess.
      const runtimeId = header.startsWith("kilo/") ? header : `kilo/${header}`;
      const id = `kilo/${runtimeId}`;
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
    id: "kilo/kilo/kilo-auto/free",
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
