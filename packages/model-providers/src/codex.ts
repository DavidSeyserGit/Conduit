import type { ModelDescriptor, ModelRequest, ModelResponse, ModelStreamEvent, ModelReasoningLevel } from "@conduit/shared";
import type { ModelProvider } from "./provider.js";

const CODEX_REQUEST_TIMEOUT_MS = 20 * 60 * 1000;

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

  async createResponse(request: ModelRequest): Promise<ModelResponse> {
    if (typeof window === "undefined") {
      throw new Error("Codex responses require the local desktop backend");
    }

    const response = await fetch("/api/codex/response", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspace: request.workspacePath,
        modelId: request.modelId,
        reasoningEffort: request.reasoningEffort,
        messages: request.messages,
        structuredOutput: request.structuredOutput,
        temperature: request.temperature,
        maxTokens: request.maxTokens,
      }),
      signal: combineWithTimeout(request.signal, CODEX_REQUEST_TIMEOUT_MS),
    });
    const body = await response.json().catch(() => ({})) as {
      result?: ModelResponse;
      error?: string;
    };
    if (!response.ok || !body.result) {
      throw new Error(body.error || `Codex request failed (${response.status})`);
    }
    return body.result;
  }

  async streamResponse(_request: ModelRequest, _onEvent: (event: ModelStreamEvent) => void): Promise<ModelResponse> {
    throw new Error("Codex runs through the backend coding agent in Goal mode");
  }
}

function combineWithTimeout(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}
