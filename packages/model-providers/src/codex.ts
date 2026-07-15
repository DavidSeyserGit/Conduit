import type { ModelDescriptor, ModelRequest, ModelResponse, ModelStreamEvent, ModelReasoningLevel } from "@loopkit/shared";
import type { ModelProvider } from "./provider.js";

interface CodexModel {
  slug: string;
  display_name: string;
  default_reasoning_level?: string;
  supported_reasoning_levels?: ModelReasoningLevel[];
}

export class CodexProvider implements ModelProvider {
  readonly id = "codex";
  readonly name = "Codex (ChatGPT subscription)";

  async listModels(): Promise<ModelDescriptor[]> {
    if (typeof window !== "undefined") {
      const response = await fetch("/api/codex/models");
      if (!response.ok) throw new Error(`Codex model discovery failed (${response.status})`);
      return (await response.json() as CodexModel[]).map((model) => ({
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
    return [{ id: "codex/subscription", provider: "codex", displayName: "Codex (ChatGPT subscription)", supportsTools: true, supportsStructuredOutput: false }];
  }

  async createResponse(_request: ModelRequest): Promise<ModelResponse> {
    throw new Error("Codex runs through the backend coding agent in Goal mode");
  }

  async streamResponse(_request: ModelRequest, _onEvent: (event: ModelStreamEvent) => void): Promise<ModelResponse> {
    throw new Error("Codex runs through the backend coding agent in Goal mode");
  }
}
