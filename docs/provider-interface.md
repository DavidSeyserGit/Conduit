# Provider Interface

Conduit uses a provider-agnostic model interface so the loop runtime does not depend directly on OpenRouter or any specific API.

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
  runCodingIteration?(
    request: CodingIterationRequest,
    onEvent: (event: GoalRunEvent) => void
  ): Promise<CodingIterationResult>;
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
  modelId: string;        // canonical provider/runtime-id
  workspacePath?: string;
  reasoningEffort?: string;
  signal?: AbortSignal;   // propagated from Goal/Ask cancellation
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

Models are identified by a canonical `provider/runtime-id` prefix (for example,
`openrouter/anthropic/claude-sonnet-4` or `codex/gpt-5.6-sol`). Providers receive
the canonical ID and own translation to their runtime format. Routing never sends
an unknown namespace to a fallback provider.

Kilo's native runtime IDs already start with `kilo/`. Conduit keeps both namespaces
explicit, so native `kilo/kilo-auto/free` is represented canonically as
`kilo/kilo/kilo-auto/free`.

## Provider Implementations

### OpenRouter

- Fetches model catalog from `https://openrouter.ai/api/v1/models`
- Caches metadata for 1 hour
- Supports tool calls and structured JSON output
- Streams via SSE
- Reports token usage from API response

Configuration: API key via app settings.

### Codex

- Uses the locally authenticated Codex CLI through an injected local-harness transport
- Uses schema-bound, read-only commands for judges
- Uses an explicit `workspace-write` sandbox for Goal workers; bypass flags are forbidden and sandbox escalations fail closed
- Supports packaged Tauri IPC and browser-development HTTP without provider branching
- Supports request-scoped cancellation, process-tree cleanup, timeouts, bounded output, and explicit stdin EOF

### Kilo Code

- Discovers the locally configured Kilo model catalog
- Uses `ask --pure` for read-only judge/Ask work
- Uses `code --pure` with a Conduit-injected, fail-closed permission policy for Goal workers
- Maps Conduit's command-permission mode into Kilo's `bash` permission and denies external directories, network tools, subagents, and sensitive-file edits
- Enables Kilo's OS sandbox with command network denial on macOS/Linux
- Parses Kilo JSON events and propagates cancellation, timeout, output-limit, and CLI stderr failures

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
- Conduit's native judge evaluates the workspace changes
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
6. Propagate `request.signal` to network or child-process cancellation
7. Add provider-client, command-policy, error, and live smoke coverage described
   in [Testing](./testing.md)
