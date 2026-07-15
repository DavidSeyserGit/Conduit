import type {
  ModelDescriptor,
  ModelRequest,
  ModelResponse,
  ModelStreamEvent,
} from "@conduit/shared";
import { ProviderError } from "@conduit/shared";
import type { ModelProvider } from "./provider.js";

export interface OpenAICompatibleConfig {
  baseUrl: string;
  apiKey: string;
  providerId?: string;
  providerName?: string;
  models?: ModelDescriptor[];
}

export class OpenAICompatibleProvider implements ModelProvider {
  readonly id: string;
  readonly name: string;

  constructor(private config: OpenAICompatibleConfig) {
    this.id = config.providerId ?? "openai-compatible";
    this.name = config.providerName ?? "OpenAI Compatible";
  }

  async listModels(): Promise<ModelDescriptor[]> {
    if (this.config.models) return this.config.models;

    try {
      const response = await this.fetch(`${this.config.baseUrl}/models`);
      const data = (await response.json()) as {
        data: Array<{ id: string; owned_by?: string }>;
      };

      return data.data.map((m) => ({
        id: `${this.id}/${m.id}`,
        provider: this.id,
        displayName: m.id,
        supportsTools: true,
        supportsStructuredOutput: true,
      }));
    } catch {
      return [];
    }
  }

  async createResponse(request: ModelRequest): Promise<ModelResponse> {
    const modelId = request.modelId.startsWith(`${this.id}/`)
      ? request.modelId.slice(this.id.length + 1)
      : request.modelId;

    const response = await this.fetch(
      `${this.config.baseUrl}/chat/completions`,
      {
        method: "POST",
        body: JSON.stringify({
          model: modelId,
          messages: request.messages,
          tools: request.tools?.map((t) => ({
            type: "function",
            function: t,
          })),
          temperature: request.temperature ?? 0.2,
          max_tokens: request.maxTokens ?? 8192,
        }),
        signal: request.signal,
      }
    );

    const data = await response.json();
    const choice = data.choices?.[0];
    const message = choice?.message;

    return {
      content: message?.content ?? "",
      toolCalls: message?.tool_calls?.map(
        (tc: { id: string; function: { name: string; arguments: string } }) => ({
          id: tc.id,
          name: tc.function.name,
          arguments: JSON.parse(tc.function.arguments || "{}"),
        })
      ),
      usage: data.usage
        ? {
            promptTokens: data.usage.prompt_tokens,
            completionTokens: data.usage.completion_tokens,
            totalTokens: data.usage.total_tokens,
          }
        : undefined,
      finishReason: choice?.finish_reason,
    };
  }

  async streamResponse(
    request: ModelRequest,
    onEvent: (event: ModelStreamEvent) => void
  ): Promise<ModelResponse> {
    const result = await this.createResponse(request);
    if (result.content) {
      onEvent({ type: "content_delta", content: result.content });
    }
    onEvent({ type: "done", usage: result.usage });
    return result;
  }

  private async fetch(url: string, init?: RequestInit): Promise<Response> {
    const response = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        "Content-Type": "application/json",
        ...init?.headers,
      },
    });

    if (!response.ok) {
      throw new ProviderError(
        `API error: ${response.status}`,
        response.status === 429
      );
    }

    return response;
  }
}
