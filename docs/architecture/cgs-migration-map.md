# CGS migration map

This inventory records the pre-CGS Conduit 0.3 domain surface and its Conduit
Goal Specification (CGS) 0.1 destination for the Conduit 0.4 release candidate.
It is a migration record, not a second domain specification.

## Existing boundaries

Before this change, `@conduit/shared/src/goal-contracts.ts` owned application
domain schemas as well as shared provider and tool contracts. The headless loop
already lived in `packages/agent-runtime`, while Desktop supplied persistence,
provider selection, permission UX, and rendering. The Rust/Tauri persistence
adapter stored JSON for goals, versions, questions, answers, reviews, evidence,
and reports. Browser persistence mirrored that shape in local storage.

The dependency direction was mostly sound:

```text
Desktop -> agent-runtime -> model-providers/tools -> shared
Desktop ------------------------------------------> shared
```

There was no import from runtime into Desktop, but the portable domain was not
independently versioned and runtime events and domain artifacts were mixed with
provider/tool types in `@conduit/shared`. No circular package dependency was
found. The CGS boundary changes the intended direction to:

```text
Desktop -> @conduit/runtime -> @conduit/cgs
                 |-> model-providers/tools/shared infrastructure
```

`@conduit/cgs` has no internal package dependency.

## Type and field mapping

| Current contract | CGS 0.1 contract | Field classification and migration action |
| --- | --- | --- |
| `GoalDefinition` | `GoalSpecification` | Goal text, criteria, constraints, deliverables, assumptions, status, and revision are CGS. `originalRequest` is retained as a portable optional field. `schemaVersion` becomes `cgsVersion` plus `kind`. Embedded `answers` move to `AnswerBatch`. Default permissions and review pipeline are explicit during legacy migration. |
| `SuccessCriterion.required` | `SuccessCriterion.priority` | CGS; `true` maps to `required`, `false` to `preferred`. `verificationHint` becomes a verification hint object. |
| `Constraint.source` | `GoalConstraint.category` | Source provenance from user/repository/policy/generated is runtime history; only semantically relevant category is CGS. Legacy policy maps to `process`; unknown historical category maps to `other`. |
| `Deliverable.type` | `Deliverable.type` | CGS; implementation maps to code and unit/integration tests map to test. Benchmark is recorded as `other` in 0.1. |
| `GoalQuestionBatch` | `QuestionBatch` | CGS. Desktop-only title is dropped. Position maps to sequence. Question title maps to prompt and source reason maps to rationale. Semantic editor types are retained. |
| `GoalAnswer` embedded in goal | `GoalAnswer` inside `AnswerBatch` | CGS and separately persisted/audited. Legacy `default` answers are migration provenance and become explicit user decisions only when the original user answer exists. |
| `GoalVersion` | goal revision snapshots | Persistence-only wrapper. `GoalSpecification.revision` is CGS; author and change summary remain repository audit metadata. |
| `GoalAnalystOutput` / `GoalAmbiguity` | `GoalSpecification` plus `QuestionBatch` | Model/runtime-only response. It is validated and translated at the runtime boundary; raw model JSON is never a Desktop input. |
| `ReviewInput` | `ReviewRequest` | CGS request contains stable run, goal, revision, changed-file, and evidence references. Repository excerpts and provider prompt text are runtime-only execution context. |
| `ReviewResult` | `ReviewResult` | CGS. Legacy warning/not-applicable statuses are normalized into result status plus findings/criterion results. Supersession remains runtime history via request/result references. |
| `ReviewFinding` | `ReviewFinding` | CGS. Severity is normalized; related criteria and evidence become arrays; blocking behavior is explicit. |
| `ReviewRoutingDecision` | `ReviewPipelineSpecification` plus runtime routing state | Required reviewer IDs and policy are CGS. A model's transient routing rationale/confidence is runtime state and report material, not goal identity. |
| `EvidenceRequest` | `EvidenceRequest` | CGS. Suggested command becomes a command specification. Permission decisions and attempts are runtime/persistence execution state. Reviewers only create requests. |
| `EvidenceItem` | `EvidenceArtifact` | CGS. Workspace/absolute paths are removed. Large content is an external artifact reference. Trust/freshness are represented by origin, repository state, and stale status. |
| `GoalRunState` | `ConduitRun` | Run stage, goal revision, attempts, review/evidence references, timestamps, and failures are CGS. Provider model IDs, token/cost metrics, raw messages, tool calls, process state, and absolute workspace path are runtime-only. |
| `GoalDrivenRunRecord` | `ConduitRun` persistence projection | Database/indexing shape. `formatVersion`, normalized row IDs, and local workspace path are persistence/desktop concerns. |
| `GoalRunEvent` / `GoalWorkflowEvent` | `RuntimeEvent` | Runtime-only event stream whose payloads are CGS artifacts/snapshots. Legacy UI-neutral progress messages remain compatibility events until Desktop uses the public runtime handle. |
| `GoalReport` | `GoalReport` | Canonical CGS report. Model IDs, cost, and token usage are optional runtime metadata rather than the report's core decision. Markdown and JSON wrappers become pure exporters. |
| `GoalArtifactMetadata` | `ExternalArtifactReference` | Persistence-only ID/path bookkeeping maps to portable URI, media type, digest, and size. Absolute artifact roots remain Desktop/Tauri state. |
| `GoalPersistenceRepository` | CGS repository ports | Runtime boundary. Database schema, row IDs, paths, cleanup policy, and local migration details remain persistence-only. |
| `Judge`, `JudgeResult`, judge presets | Reviewer API and CGS review artifacts | Deprecated terminology. Provider/model selection remains Desktop/runtime configuration; approval, findings, and evidence requests become reviewer outputs. |

## Behavior retained

- Focused goal analysis, batched questions, recommended defaults, answer
  revision, goal editing/regeneration, and exact-revision approval.
- Planning, implementation loops, run-scoped git baselines, validation,
  general review, specialist routing, evidence collection, conservative stale
  evidence handling, repair iterations, cancellation, and permission prompts.
- Browser and Tauri persistence, interrupted-run restoration, report viewing,
  Markdown/JSON export, redaction, bounded artifact storage, and legacy run
  import.
- Provider selection, Codex/Kilo/OpenRouter/ACP/Kimi adapters, token/cost
  accounting, and Desktop visual state remain outside CGS.

## Migration boundary

`legacyGoalToCgs` performs an explicit, loss-aware conversion tagged with
`migratedFrom: conduit-legacy-goal` and migration version `0.4.0-cgs-1`.
It preserves the original request and goal text and never invents historical
evidence. `cgsGoalToLegacyRuntimeInput` is limited to executing migrated goals
through the parity path while persisted 0.3 records remain supported.
