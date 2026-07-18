# Architecture

Goal-run storage and artifact lifecycle are documented in
[Goal-run persistence](./goal-persistence.md).

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
  model-ID translation, event parsing, timeouts, and child-process cleanup in browser development
- **`src-tauri/src/local_harness.rs`** for the equivalent packaged-app process boundary
- **`src/lib/local-harness-transport.ts`** for typed, cancellable Tauri IPC
- **`vite.config.ts`** for development HTTP/NDJSON transport and route composition

## Local Harness Boundaries

Local coding harnesses cross four deliberately separate layers:

1. `GoalLoopRunner`, `Judge`, and `CodingAgent` decide **when** planning,
   implementation, validation, and review happen.
2. `CodexProvider` and `KiloProvider` use the `LocalHarnessTransport` contract.
   They do not know whether HTTP development transport or packaged Tauri IPC is active.
3. `apps/desktop/backend/local-harness.ts` owns development CLI execution, while
   `src-tauri/src/local_harness.rs` owns packaged execution. Both enforce the same
   role, timeout, cancellation, output-limit, and model-ID contracts.
4. HTTP middleware and Tauri commands validate the workspace and carry typed
   status/result events. Provider code never spawns a local process directly.

The following invariants are enforced by tests:

- Model IDs are canonical `provider/runtime-id` values. Kilo's native IDs already
  begin with `kilo/`, so a canonical Kilo ID is `kilo/kilo/<model>`.
- Provider routing never guesses an unknown or legacy namespace.
- Persisted legacy Kilo selections are migrated at the model-catalog boundary.
- Judges receive no tools and use read-only CLI roles.
- Codex workers run with `workspace-write` sandboxing and never use the bypass flag.
- Kilo workers receive an injected, fail-closed permission policy; macOS/Linux
  workers also use Kilo's filesystem sandbox with outbound command network denied.
- Workers report changed files and validation while cancellation terminates their process tree.
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

1. **Workspace isolation** — Rust canonicalizes every existing path component, rejects symlink escapes, and caps file/search inputs.
2. **Command permissions** — Rust independently validates the mode and command policy, uses a native approval dialog, and caps command time/output.
3. **Harness isolation** — Judges are read-only; Codex uses its workspace sandbox; Kilo receives per-run permissions and OS sandbox policy.
4. **Native least privilege** — A restrictive CSP and one explicit Tauri capability expose only high-level commands; shell/store plugins and raw tool commands are not exposed.
5. **Credential storage** — GitHub and OpenRouter secrets use the operating-system keychain in the packaged app.
6. **Process lifecycle** — Local harness work has request-scoped cancellation, process-tree termination, timeouts, and bounded output.
