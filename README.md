# Conduit

Minimal desktop coding chatbot focused on explicit agent loops with independently selectable models.

> Choose a coding model, choose a judge, and let them work toward a goal through a visible loop.

## Features

- **Ask mode** — Repository-aware read-only chat (read files, search, explain code)
- **Goal mode** — Coding agent loop with independent judge model
- **OpenRouter, Codex, and Kilo integration** — Cloud and locally authenticated coding harnesses
- **Workspace tools** — File read/write, search, git diff, command execution
- **Visible execution timeline** — See every tool call, judge decision, and iteration
- **Command safety** — Configurable approval for shell commands

## Quick Start

### Prerequisites

- Node.js 20+
- pnpm 11 (the exact version is declared in `package.json`)
- Rust (for Tauri desktop builds)

### Install

```bash
pnpm install
```

### Development

```bash
# Web UI only (Vite dev server)
pnpm --filter @conduit/desktop dev

# Full Tauri desktop app
pnpm --filter @conduit/desktop tauri:dev
```

### Build

```bash
pnpm build
pnpm --filter @conduit/desktop tauri:build
```

### Verify

```bash
pnpm verify
```

See [docs/testing.md](docs/testing.md) for the provider contract matrix and the
real Codex/Kilo judge and isolated-worker smoke tests.

See [docs/releasing.md](docs/releasing.md) for GitHub CI/CD, version tags, and
cross-platform Tauri installer releases.

## Configuration

1. Open Conduit and click the settings icon
2. Enter your [OpenRouter API key](https://openrouter.ai/keys)
3. Create a GitHub OAuth App, enable **Device Flow**, and start Conduit with its client ID:

   ```bash
   GITHUB_CLIENT_ID=your_client_id VITE_GITHUB_CLIENT_ID=your_client_id pnpm --filter @conduit/desktop tauri:dev
   ```

   For the browser preview, use `VITE_GITHUB_CLIENT_ID=your_client_id pnpm --filter @conduit/desktop dev`.

4. Click **+** beside Projects, connect GitHub, and authorize the app
5. Choose a repository and clone destination
6. Choose coding and judge models, then switch to **Goal** mode

GitHub access tokens are stored in the operating system keychain. The selected
repository is cloned locally and the agent runs against that local checkout.

To use your ChatGPT/Codex subscription for coding, install the Codex CLI and
run `codex login`. Conduit runs the locally authenticated Codex CLI in Goal
mode; select **Codex (ChatGPT subscription)** as the coding model.

## Architecture

```
conduit/
├── apps/desktop/          # Tauri + React desktop app
├── packages/
│   ├── agent-runtime/     # Goal loop, coding agent, judge
│   ├── model-providers/   # OpenRouter, Codex, Kilo, OpenAI-compatible, ACP
│   ├── tools/             # File, search, command tools + safety
│   └── shared/            # Types, schemas, events
└── docs/                  # Architecture documentation
```

See [docs/architecture.md](docs/architecture.md) for details.

## Goal Loop

```
Goal → Inspect → Plan → Implement → Validate → Judge
                                                  ↓
                              Approved? ── Yes ──→ Complete
                                  │
                                  No
                                  ↓
                           Return feedback → Next iteration
```

## License

MIT
