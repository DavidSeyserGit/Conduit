<p align="center">
  <img src="apps/desktop/public/conduit-wordmark.png" alt="Conduit" width="420" />
</p>

Local desktop application for goal-driven software engineering with independently selectable models.

> Start with a rough request. Conduit turns it into an explicit goal, implements it, routes independent reviews, gathers evidence, and explains why the work passed or failed.

## Features

- **Ask mode** — Repository-aware read-only chat (read files, search, explain code)
- **Goal mode** — Repository-grounded questions, approval-gated goals, implementation, routed specialist reviews, and evidence-backed completion
- **OpenRouter, Codex, and Kilo integration** — Cloud and locally authenticated coding harnesses
- **Workspace tools** — File read/write, search, git diff, command execution
- **Persistent workflow and reports** — Resume goal decisions after restart and export the final report as Markdown or JSON
- **Visible execution timeline** — See lifecycle transitions, tool calls, review decisions, evidence, and iterations
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

# Deterministic offline walkthrough of the five 0.3 release scenarios
pnpm demo:goals
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
6. Choose coding and reviewer models, then switch to **Goal** mode
7. Describe the outcome, answer only the product questions Conduit cannot infer,
   review the generated goal, and approve it before implementation begins

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
│   ├── agent-runtime/     # Goal definition, implementation, review, evidence, reports
│   ├── model-providers/   # OpenRouter, Codex, Kilo, OpenAI-compatible, ACP
│   ├── tools/             # File, search, command tools + safety
│   └── shared/            # Types, schemas, events
└── docs/                  # Architecture documentation
```

See [docs/architecture.md](docs/architecture.md) for details.

## Goal Loop

```
Request → Inspect → Questions → Approve goal → Plan → Implement → Validate
                                                            ↓
                                        General review → Route specialists
                                                            ↓
                                  Evidence / revisions ↔ Reviewers → Report
```

## License

MIT
