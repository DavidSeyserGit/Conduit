# Architecture

LoopKit is a monorepo with clear separation between the UI, agent runtime, model providers, and tools.

## Package Boundaries

### `@loopkit/shared`

Shared TypeScript types and Zod schemas used across all packages:

- `GoalRunState`, `GoalIteration`, `JudgeResult`
- `ModelDescriptor`, `ModelRequest`, `ModelResponse`
- `GoalRunEvent` — runtime events for UI decoupling
- Error classes (`LoopKitError`, `WorkspaceError`, etc.)

### `@loopkit/tools`

Repository tool implementations with workspace safety:

- **File tools**: `list_files`, `read_file`, `write_file`, `replace_in_file`, `create_file`, `delete_file`, `get_git_diff`
- **Search tools**: `search_files` with regex and glob support
- **Command tools**: `run_command` with permission modes
- **Safety**: Path normalization, symlink checks, safe command detection

All file operations are restricted to the selected workspace. Paths outside the workspace or protected system directories are rejected.

### `@loopkit/model-providers`

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

### `@loopkit/agent-runtime`

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

## Data Flow

```
User Input
    ↓
App Store (Zustand)
    ↓
GoalLoopRunner / AskChatRunner
    ↓
ModelProvider (OpenRouter)  ←→  Tools (file, search, command)
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
