import type { ModelDescriptor, ModelRequest, ModelResponse, ModelStreamEvent, ModelReasoningLevel } from "@conduit/shared";
import type { ModelProvider } from "./provider.js";
import type { CodingIterationRequest, CodingIterationResult } from "./provider.js";
import { HttpLocalHarnessTransport, type LocalHarnessTransport } from "./local-transport.js";

interface CodexModel {
  slug: string;
  display_name: string;
  default_reasoning_level?: string;
  supported_reasoning_levels?: ModelReasoningLevel[];
}

export class CodexProvider implements ModelProvider {
  readonly id = "codex";
  readonly name = "Codex (ChatGPT subscription)";

  constructor(private readonly transport: LocalHarnessTransport = new HttpLocalHarnessTransport()) {}

  async listModels(): Promise<ModelDescriptor[]> {
    return (await this.transport.listModels("codex") as CodexModel[]).map((model) => ({
        id: `codex/${model.slug}`,
        provider: "codex",
        displayName: model.display_name,
        supportsTools: true,
        supportsStructuredOutput: false,
        supportsReasoning: Boolean(model.supported_reasoning_levels?.length),
        defaultReasoningLevel: model.default_reasoning_level,
        supportedReasoningLevels: model.supported_reasoning_levels,
      }));
  }

  async createResponse(request: ModelRequest): Promise<ModelResponse> {
    return this.transport.createResponse("codex", request, () => {});
  }

  async streamResponse(request: ModelRequest, onEvent: (event: ModelStreamEvent) => void): Promise<ModelResponse> {
    const result = await this.transport.createResponse("codex", request, onEvent);
    if (result.content) onEvent({ type: "content_delta", content: result.content });
    return result;
  }

  async runCodingIteration(
    request: CodingIterationRequest,
    onEvent: (event: import("@conduit/shared").GoalRunEvent) => void,
  ): Promise<CodingIterationResult> {
    return this.transport.runCodingIteration("codex", request, onEvent);
  }
}
