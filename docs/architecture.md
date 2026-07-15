# Architecture

Conduit is a monorepo with clear separation between the UI, agent runtime, model providers, and tools.

## Package Boundaries

### `@conduit/shared`

Shared TypeScript types and Zod schemas used across all packages:

- `GoalRunState`, `GoalIteration`, `JudgeResult`
- `ModelDescriptor`, `ModelRequest`, `ModelResponse`
- `GoalRunEvent` — runtime events for UI decoupling
- Error classes (`ConduitError`, `WorkspaceError`, etc.)

### `@conduit/tools`

Repository tool implementations with workspace safety:

- **File tools**: `list_files`, `read_file`, `write_file`, `replace_in_file`, `create_file`, `delete_file`, `get_git_diff`
- **Search tools**: `search_files` with regex and glob support
- **Command tools**: `run_command` with permission modes
- **Safety**: Path normalization, symlink checks, safe command detection

All file operations are restricted to the selected workspace. Paths outside the workspace or protected system directories are rejected.

### `@conduit/model-providers`

Provider-agnostic model interface:

```typescript
interface ModelProvider {
  listModels(): Promise<ModelDescriptor[]>;
  createResponse(request: ModelRequest): Promise<ModelResponse>;
  streamResponse(request, onEvent): Promise<ModelResponse>;
}
```

Implementations:

| Provider | Status | Purpose |
|----------|--------|---------|
| `OpenRouterProvider` | Primary | Model catalog, tool calls, structured output |
| `OpenAICompatibleProvider` | Supported | Any OpenAI-compatible API endpoint |
| `ACPAgentProvider` | Experimental | Agent Client Protocol integration |

### `@conduit/agent-runtime`

The core loop engine:

- **`GoalLoopRunner`** — Orchestrates iterations between coding agent and judge
- **`CodingAgent`** — Tool-call loop for implementation
- **`Judge`** — Independent evaluation with structured output
- **`AskChatRunner`** — Read-only chat for Ask mode

Events are emitted rather than controlling the UI directly, enabling future CLI or web clients.

### `apps/desktop`

Tauri desktop shell with React frontend:

- **Zustand** store for app state with local persistence
- **Tailwind CSS** for styling
- **react-markdown** for message rendering
- **`backend/local-harness.ts`** for Codex/Kilo process policy, command construction,
  model-ID translation, event parsing, timeouts, and child-process cleanup
- **`vite.config.ts`** for HTTP/NDJSON transport and route composition only; it must
  not duplicate provider-specific command or parsing rules

## Local Harness Boundaries

Local coding harnesses cross four deliberately separate layers:

1. `GoalLoopRunner`, `Judge`, and `CodingAgent` decide **when** planning,
   implementation, validation, and review happen.
2. `CodexProvider` and `KiloProvider` translate provider-agnostic model requests
   into desktop HTTP calls. They do not spawn processes.
3. `apps/desktop/backend/local-harness.ts` decides **how** each CLI is invoked.
   Judge roles are read-only; worker roles are autonomous. It also owns process
   timeout, cancellation, stdout parsing, stderr failures, and forced cleanup.
4. Vite middleware validates the workspace and streams status/result packets. It
   does not construct CLI permission flags or parse provider event formats.

The following invariants are enforced by tests:

- Model IDs are canonical `provider/runtime-id` values. Kilo's native IDs already
  begin with `kilo/`, so a canonical Kilo ID is `kilo/kilo/<model>`.
- Provider routing never guesses an unknown or legacy namespace.
- Persisted legacy Kilo selections are migrated at the model-catalog boundary.
- Judges receive no tools and use read-only CLI roles.
- Workers receive coding roles and report changed files and validation.
- Structured output is schema-bound and parsed before entering the Goal loop.
- A Goal cancellation reaches provider fetches and local child processes.
- Codex stdin is closed explicitly so the CLI cannot wait forever for more prompt.

## Data Flow

```
User Input
    ↓
App Store (Zustand)
    ↓
GoalLoopRunner / AskChatRunner
    ↓
    ModelProvider (OpenRouter / Codex / Kilo)  ←→  Tools (file, search, command)
    ↓
GoalRunEvents
    ↓
Execution Timeline (React)
```

## State Persistence

- App settings and model preferences: Zustand persist (localStorage)
- Goal run history: In-memory for MVP (SQLite planned for full persistence)

## Security Model

1. **Workspace isolation** — All file paths normalized and validated against workspace root
2. **Command permissions** — Three modes: ask every time, auto-approve safe, auto-approve all
3. **API key storage** — Local storage via Zustand persist; OS credential store via Tauri plugin (planned)
4. **Judge isolation** — Judge model has no tool access; evaluates only observable artifacts
