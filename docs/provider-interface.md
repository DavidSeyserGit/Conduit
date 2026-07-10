# Provider Interface

LoopKit uses a provider-agnostic model interface so the loop runtime does not depend directly on OpenRouter or any specific API.

## Interface

```typescript
interface ModelProvider {
  readonly id: string;
  readonly name: string;

  listModels(): Promise<ModelDescriptor[]>;
  createResponse(request: ModelRequest): Promise<ModelResponse>;
  streamResponse(
    request: ModelRequest,
    onEvent: (event: ModelStreamEvent) => void
  ): Promise<ModelResponse>;
}
```

## Model Descriptor

```typescript
interface ModelDescriptor {
  id: string;           // e.g. "openrouter/openai/gpt-4o"
  provider: string;       // e.g. "openrouter"
  displayName: string;    // e.g. "GPT-4o"
  contextLength?: number;
  supportsTools: boolean;
  supportsStructuredOutput: boolean;
  inputPrice?: number;    // per million tokens
  outputPrice?: number;
}
```

## Request / Response

```typescript
interface ModelRequest {
  modelId: string;
  messages: ModelMessage[];
  tools?: ToolDefinition[];
  structuredOutput?: { schema: Record<string, unknown>; name: string };
  temperature?: number;
  maxTokens?: number;
}

interface ModelResponse {
  content: string;
  toolCalls?: ToolCallRequest[];
  structuredOutput?: unknown;
  usage?: TokenUsage;
  finishReason?: string;
}
```

## Provider Registry

```typescript
interface ProviderRegistry {
  register(provider: ModelProvider): void;
  get(id: string): ModelProvider | undefined;
  list(): ModelProvider[];
  listAllModels(): Promise<ModelDescriptor[]>;
}
```

Models are identified by `provider/model-id` prefix (e.g. `openrouter/anthropic/claude-sonnet-4`).

## OpenRouter (Primary)

- Fetches model catalog from `https://openrouter.ai/api/v1/models`
- Caches metadata for 1 hour
- Supports tool calls and structured JSON output
- Streams via SSE
- Reports token usage from API response

Configuration: API key via app settings.

## OpenAI Compatible

For any endpoint implementing the OpenAI chat completions API:

```typescript
new OpenAICompatibleProvider({
  baseUrl: "https://api.example.com/v1",
  apiKey: "sk-...",
  providerId: "custom",
  providerName: "Custom Provider",
});
```

## ACP (Experimental)

ACP agents are treated as an alternative coding backend, not a model provider:

- Agent runs its own internal loop and model
- LoopKit's native judge evaluates the workspace changes
- Session management via `AcpSessionManager` (stub in v0.1)

Example configuration:

```
Coding backend: Claude Code through ACP
Judge: Gemini through OpenRouter
```

## Adding a Provider

1. Implement `ModelProvider` interface
2. Register with `DefaultProviderRegistry`
3. Model IDs use `your-provider/model-name` format
4. Support `tools` in requests for coding agent compatibility
5. Support `structuredOutput` for judge evaluations
