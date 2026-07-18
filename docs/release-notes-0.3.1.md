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

## Release acceptance audit

| Contract | Verification |
|---|---|
| Repository-grounded questions and versioned goal approval | Goal Analyst, definition-runtime, schema, and Goal Builder tests |
| No implementation before approval | Runtime approval-gate integration test |
| Execution questions survive restart | Offline execution-question scenario and SQLite restoration tests |
| General and routed specialist review | Routing matrix, pipeline, disagreement, and affected-rerun tests |
| Permission-controlled evidence, reuse, and invalidation | Evidence coordinator tests plus authentication, security-revision, and benchmark scenarios |
| Actionable failed-review feedback and mandatory approval | Repair-loop, critical-finding, evidence-gate, and policy aggregation tests |
| Persistent goals, decisions, events, reviews, evidence, and reports | Browser/native persistence and legacy v0.2 migration tests |
| Interactive report with Markdown and JSON export | Report builder, UI, export, redaction, and native-boundary tests |
| Provider/tool cancellation and cleanup | Analysis, planning, review, evidence, HTTP/Tauri, and local-process cancellation tests |
| Five deterministic end-to-end scenarios | `pnpm demo:goals` |

All phases A–H are merged. The release gate passes without live paid models;
authenticated provider smoke tests remain an optional environment-specific check.

## Known limitations

Run history is local, screenshot evidence is not automated, authenticated local
harness smoke tests are opt-in, and external report publishing is not included.
