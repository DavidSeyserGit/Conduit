import type {
  ModelDescriptor,
  ModelMessage,
  ModelRequest,
  ModelResponse,
  ModelStreamEvent,
  ToolCallRequest,
} from "@loopkit/shared";
import { ProviderError } from "@loopkit/shared";
import type { ModelProvider } from "./provider.js";

const OPENROUTER_API = "https://openrouter.ai/api/v1";
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

interface OpenRouterModel {
  id: string;
  name: string;
  context_length?: number;
  pricing?: { prompt?: string; completion?: string };
  top_provider?: { context_length?: number };
  supported_parameters?: string[];
}

export class OpenRouterProvider implements ModelProvider {
  readonly id = "openrouter";
  readonly name = "OpenRouter";

  private modelsCache: { models: ModelDescriptor[]; fetchedAt: number } | null =
    null;

  constructor(private apiKey: string) {}

  updateApiKey(apiKey: string): void {
    this.apiKey = apiKey;
    this.modelsCache = null;
  }

  async listModels(): Promise<ModelDescriptor[]> {
    if (
      this.modelsCache &&
      Date.now() - this.modelsCache.fetchedAt < CACHE_TTL_MS
    ) {
      return this.modelsCache.models;
    }

    const response = await this.fetch(`${OPENROUTER_API}/models`);
    const data = (await response.json()) as { data: OpenRouterModel[] };

    const models: ModelDescriptor[] = data.data.map((m) => ({
      id: `openrouter/${m.id}`,
      provider: "openrouter",
      displayName: m.name,
      contextLength: m.context_length ?? m.top_provider?.context_length,
      supportsTools: m.supported_parameters ? m.supported_parameters.includes("tools") : true,
      supportsStructuredOutput: m.supported_parameters?.includes("response_format") ?? true,
      supportsReasoning: m.supported_parameters?.some((parameter) => parameter === "reasoning" || parameter === "reasoning_effort") ?? false,
      inputPrice: m.pricing?.prompt ? parseFloat(m.pricing.prompt) * 1_000_000 : undefined,
      outputPrice: m.pricing?.completion ? parseFloat(m.pricing.completion) * 1_000_000 : undefined,
    }));

    this.modelsCache = { models, fetchedAt: Date.now() };
    return models;
  }

  async createResponse(request: ModelRequest): Promise<ModelResponse> {
    const modelId = request.modelId.startsWith("openrouter/")
      ? request.modelId.slice("openrouter/".length)
      : request.modelId;

    const body = this.buildRequestBody(modelId, request);

    const response = await this.fetch(`${OPENROUTER_API}/chat/completions`, {
      method: "POST",
      body: JSON.stringify(body),
    });

    const data = await response.json();
    return this.parseResponse(data);
  }

  async streamResponse(
    request: ModelRequest,
    onEvent: (event: ModelStreamEvent) => void
  ): Promise<ModelResponse> {
    const modelId = request.modelId.startsWith("openrouter/")
      ? request.modelId.slice("openrouter/".length)
      : request.modelId;

    const body = { ...this.buildRequestBody(modelId, request), stream: true };

    const response = await this.fetch(`${OPENROUTER_API}/chat/completions`, {
      method: "POST",
      body: JSON.stringify(body),
    });

    if (!response.body) {
      throw new ProviderError("No response body for streaming");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let fullContent = "";
    const toolCalls: Map<number, ToolCallRequest> = new Map();
    let usage: ModelResponse["usage"];

    try {
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6).trim();
          if (data === "[DONE]") continue;

          try {
            const parsed = JSON.parse(data);
            const delta = parsed.choices?.[0]?.delta;

            if (delta?.content) {
              fullContent += delta.content;
              onEvent({ type: "content_delta", content: delta.content });
            }

            if (delta?.tool_calls) {
              for (const tc of delta.tool_calls) {
                const idx = tc.index ?? 0;
                if (!toolCalls.has(idx)) {
                  toolCalls.set(idx, {
                    id: tc.id ?? crypto.randomUUID(),
                    name: tc.function?.name ?? "",
                    arguments: {},
                  });
                }
                const existing = toolCalls.get(idx)!;
                if (tc.function?.name) existing.name = tc.function.name;
                if (tc.function?.arguments) {
                  try {
                    const current = JSON.stringify(existing.arguments);
                    const merged = current === "{}" ? tc.function.arguments : current.slice(0, -1) + "," + tc.function.arguments.slice(1);
                    existing.arguments = JSON.parse(merged);
                  } catch {
                    // accumulate partial JSON
                  }
                }
              }
            }

            if (parsed.usage) {
              const promptDetails = parsed.usage.prompt_tokens_details || {};
              usage = {
                promptTokens: parsed.usage.prompt_tokens ?? 0,
                completionTokens: parsed.usage.completion_tokens ?? 0,
                totalTokens: parsed.usage.total_tokens ?? 0,
                cacheReadTokens: promptDetails.cached_tokens ?? parsed.usage.cache_read_input_tokens ?? 0,
                cacheWriteTokens: parsed.usage.cache_creation_input_tokens ?? 0,
              };
            }
          } catch {
            // skip malformed chunks
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    onEvent({ type: "done", usage });

    return {
      content: fullContent,
      toolCalls: toolCalls.size > 0 ? Array.from(toolCalls.values()) : undefined,
      usage,
      finishReason: "stop",
    };
  }

  private buildRequestBody(
    modelId: string,
    request: ModelRequest
  ): Record<string, unknown> {
    const messages = request.messages.map((m) => this.formatMessage(m));

    const body: Record<string, unknown> = {
      model: modelId,
      messages,
      temperature: request.temperature ?? 0.2,
      max_tokens: request.maxTokens ?? 8192,
    };

    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools.map((t) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      }));
    }

    if (request.structuredOutput) {
      body.response_format = {
        type: "json_schema",
        json_schema: {
          name: request.structuredOutput.name,
          strict: true,
          schema: request.structuredOutput.schema,
        },
      };
    }

    return body;
  }

  private formatMessage(message: ModelMessage): Record<string, unknown> {
    const msg: Record<string, unknown> = {
      role: message.role,
      content: message.content,
    };

    if (message.toolCalls) {
      msg.tool_calls = message.toolCalls.map((tc) => ({
        id: tc.id,
        type: "function",
        function: {
          name: tc.name,
          arguments: JSON.stringify(tc.arguments),
        },
      }));
    }

    if (message.toolCallId) {
      msg.tool_call_id = message.toolCallId;
    }

    return msg;
  }

  private parseResponse(data: Record<string, unknown>): ModelResponse {
    const choice = (data.choices as Array<Record<string, unknown>>)?.[0];
    const message = choice?.message as Record<string, unknown> | undefined;
    const usage = data.usage as (Record<string, any> & { prompt_tokens_details?: Record<string, number> }) | undefined;

    let structuredOutput: unknown;
    const content = (message?.content as string) ?? "";

    if (message?.parsed) {
      structuredOutput = message.parsed;
    } else if (content.startsWith("{")) {
      try {
        structuredOutput = JSON.parse(content);
      } catch {
        // not JSON
      }
    }

    const rawToolCalls = message?.tool_calls as
      | Array<{
          id: string;
          function: { name: string; arguments: string };
        }>
      | undefined;

    return {
      content,
      toolCalls: rawToolCalls?.map((tc) => ({
        id: tc.id,
        name: tc.function.name,
        arguments: JSON.parse(tc.function.arguments || "{}"),
      })),
      structuredOutput,
      usage: usage
        ? {
            promptTokens: usage.prompt_tokens ?? 0,
            completionTokens: usage.completion_tokens ?? 0,
            totalTokens: usage.total_tokens ?? 0,
            cacheReadTokens: usage.prompt_tokens_details?.cached_tokens ?? usage.cache_read_input_tokens ?? 0,
            cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
          }
        : undefined,
      finishReason: choice?.finish_reason as string,
    };
  }

  private async fetch(
    url: string,
    init?: RequestInit
  ): Promise<Response> {
    const request = {
      ...init,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://loopkit.dev",
        "X-Title": "LoopKit",
        "User-Agent": "LoopKit/0.1",
        ...init?.headers,
      },
    };
    let response: Response | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        response = await fetch(url, { ...request, signal: init?.signal ?? AbortSignal.timeout(120_000) });
      } catch (error) {
        if (init?.signal?.aborted) throw error;
        const message = error instanceof Error ? error.message : String(error);
        if (attempt === 2 || !/network|fetch failed|socket|timeout|econnreset/i.test(message)) {
          throw new ProviderError(`OpenRouter network error: ${message}`, true);
        }
        await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
        continue;
      }
      if (![429, 502, 503, 504].includes(response.status) || attempt === 2) break;
      await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
    }
    if (!response) throw new ProviderError("OpenRouter returned no response", true);

    if (!response.ok) {
      let errorMessage = `OpenRouter API error: ${response.status}`;
      try {
        const error = await response.json();
        errorMessage = (error as { error?: { message?: string } }).error?.message ?? errorMessage;
      } catch {
        // use default message
      }
      throw new ProviderError(errorMessage, response.status === 429);
    }

    return response;
  }
}
