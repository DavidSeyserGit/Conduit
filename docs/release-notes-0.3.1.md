# Conduit 0.3.1

Conduit 0.3.1 completes the first hardened goal-driven workflow release.

## Highlights

- Turn rough requests into repository-grounded, versioned goals through focused
  native questions and an explicit approval gate.
- Pause implementation for structured product decisions and resume after an
  application restart.
- Verify completion with a general reviewer and risk-based specialist routing.
- Collect permission-aware test, build, benchmark, and analysis evidence;
  invalidate it conservatively after relevant changes.
- Persist the complete run and produce linked in-app reports with Markdown and
  JSON export.
- Make long-running lifecycle stages visible and cancellable, with bounded local
  provider processes and explicit failure states.

## Verification

`pnpm demo:goals` runs five small offline scenarios covering a UI change,
security-sensitive authentication, an execution-time question, revision after a
critical security finding, and a permission-gated performance benchmark. The
normal `pnpm verify`, Rust tests, and packaged Tauri compilation remain required
before tagging.

## Known limitations

Run history is local, screenshot evidence is not automated, authenticated local
harness smoke tests are opt-in, and external report publishing is not included.
