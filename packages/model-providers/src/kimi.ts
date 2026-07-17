import type {
  ModelDescriptor,
  ModelRequest,
  ModelResponse,
  ModelStreamEvent,
} from "@conduit/shared";
import { LocalHarnessProvider } from "./provider.js";
import type { CodingIterationRequest, CodingIterationResult } from "./provider.js";
import { HttpLocalHarnessTransport, type LocalHarnessTransport } from "./local-transport.js";

/** Moonshot Kimi models via the local kimi CLI (`kimi -p`). Auth stays in the CLI. */
export class KimiProvider extends LocalHarnessProvider {
  readonly id = "kimi";
  readonly name = "Kimi";
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
    return await this.transport.listModels("kimi") as ModelDescriptor[];
  }

  async createResponse(request: ModelRequest): Promise<ModelResponse> {
    return this.streamResponse(request, () => {});
  }

  async streamResponse(
    request: ModelRequest,
    onEvent: (event: ModelStreamEvent) => void
  ): Promise<ModelResponse> {
    if (!request.workspacePath) throw new Error("Kimi Ask requires a workspace");
    return this.transport.createResponse("kimi", request, onEvent);
  }

  async runCodingIteration(
    request: CodingIterationRequest,
    onEvent: (event: import("@conduit/shared").GoalRunEvent) => void,
  ): Promise<CodingIterationResult> {
    return this.transport.runCodingIteration("kimi", request, onEvent);
  }
}
