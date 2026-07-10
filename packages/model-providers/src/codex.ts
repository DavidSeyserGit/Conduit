import type { ModelDescriptor, ModelRequest, ModelResponse, ModelStreamEvent } from "@loopkit/shared";
import type { ModelProvider } from "./provider.js";

export class CodexProvider implements ModelProvider {
  readonly id = "codex";
  readonly name = "Codex (ChatGPT subscription)";

  async listModels(): Promise<ModelDescriptor[]> {
    return [{
      id: "codex/subscription",
      provider: "codex",
      displayName: "Codex (ChatGPT subscription)",
      supportsTools: true,
      supportsStructuredOutput: false,
    }];
  }

  async createResponse(_request: ModelRequest): Promise<ModelResponse> {
    throw new Error("Codex runs through the backend coding agent in Goal mode");
  }

  async streamResponse(_request: ModelRequest, _onEvent: (event: ModelStreamEvent) => void): Promise<ModelResponse> {
    throw new Error("Codex runs through the backend coding agent in Goal mode");
  }
}
