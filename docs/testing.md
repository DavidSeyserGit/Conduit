# Testing and Verification

Provider and Goal-mode changes cross UI, runtime, HTTP, and local process
boundaries. A change is not considered verified from a build or a single manual
chat alone.

## Required Commands

```bash
pnpm typecheck
pnpm test
pnpm build
```

Run the complete local gate with:

```bash
pnpm verify
```

The same command runs in `.github/workflows/verify.yml` for every branch push and
pull request. A second CI job builds a real Debian Tauri installer, covering the
Rust backend and native packaging path before a release tag is accepted.
Authenticated Codex/Kilo smoke tests remain the local gate below because they
depend on locally logged-in CLIs.

Tag-driven installer builds and GitHub Releases are documented in
[GitHub CI/CD and Releases](./releasing.md).

`pnpm test` discovers every `*.test.ts` below `apps/`, `packages/`, and `scripts/` while
excluding generated builds and cloned workspaces. The runner uses Node's test
framework through `tsx`, so tests do not depend on Vite or a browser session.

## Local Harness Smoke Tests

Start the desktop development server, ensure the Codex and Kilo CLIs are logged
in, then run:

```bash
pnpm smoke:harnesses
```

This sends a real schema-bound judge request through both CLIs. To exercise a
real coding worker safely, use an isolated temporary Git repository:

```bash
pnpm smoke:harnesses -- --provider kilo --worker kilo
pnpm smoke:harnesses -- --provider codex --worker codex
```

The worker smoke creates and later removes a temporary repository, requests one
targeted README edit, and verifies both the file contents and the backend's
`changedFiles` result. It never points a worker at the Conduit repository.

Environment overrides:

- `CONDUIT_SMOKE_SERVER` — desktop server URL (default `http://[::1]:1420`)
- `CONDUIT_SMOKE_KILO_MODEL` — canonical Kilo model ID
- `CONDUIT_SMOKE_CODEX_MODEL` — canonical Codex model ID

## Contract Matrix

| Boundary | Required coverage |
|---|---|
| Provider routing | Exact namespace match, canonical ID preservation, unknown-ID rejection |
| Catalog persistence | Legacy Kilo migration, capability refresh, selected-model preservation |
| Codex client | Workspace/schema/reasoning forwarding, backend error detail, cancellation |
| Kilo client | Non-streaming judge bridge, NDJSON result/error parsing, workspace requirement, cancellation |
| Judge | Planning schema, review repair, invalid-plan rejection, no tools, workspace and reasoning |
| Goal loop | Plan → code → tools → validation → review, planning failure, cancellation, missing provider |
| Ask mode | Read-only tools, stream assembly, cancellation, no duplicate token usage |
| Coding transport | Fragmented NDJSON, status/error context, interrupted stream, cancellation |
| CLI policy | Read-only judge flags, autonomous worker flags, native model-ID conversion |
| Process lifecycle | Codex stdin EOF, Kilo stdout/stderr, non-zero exit, timeout, abort, forced cleanup |
| Structured output | Raw JSON, fenced/prose JSON, braces inside strings, malformed output |
| Live integration | Codex judge/worker and Kilo judge/worker through desktop HTTP routes |

When a bug is found, first add a test at the narrowest owning boundary, then add
an integration test if the failure required two or more layers to reproduce.
