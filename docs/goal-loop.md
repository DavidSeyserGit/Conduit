# Goal-driven workflow

Goal mode converts a rough request into an approved engineering contract and
then completes it only when the required reviewers accept sufficient evidence.
The UI renders persisted runtime events; it does not drive the state machine.

## Lifecycle

```text
analyzing_goal → awaiting_goal_answers → building_goal
      ↓
awaiting_goal_approval → planning → implementing → validating
      ↓
general_review → routing_reviews → specialist_review
      ├─ needs evidence → collecting_evidence ─┐
      ├─ needs a decision → awaiting_user_input│
      └─ changes requested → revising ─────────┘
      ↓
reporting → completed | failed | cancelled
```

Repository inspection answers technical facts such as language, framework,
scripts, and conventions. The Goal Analyst asks only for intent, permissions,
trade-offs, or requirements that cannot safely be inferred. Its schema-bound
output is parsed strictly and repaired once when malformed. Implementation is
blocked until the user approves the generated goal.

Questions asked during implementation use the same native schema. A required
decision pauses the run, persists the question and current goal version, and
resumes with a new approved goal version after an answer—even after restarting
the application.

## Implementation and review

Each iteration plans, runs the coding agent, records the diff and validation,
and asks the general reviewer whether the goal criteria and deliverables are
implemented. The general reviewer then routes only applicable specialists.
Available reviewer roles include security, testing, code quality, architecture,
performance, documentation, UI, accessibility, API, migration, and dependency.

Review results are structured as `approved`, `approved_with_warnings`,
`changes_requested`, `blocked`, `needs_evidence`, or `not_applicable`. Findings
carry severity, optional source locations and criterion IDs, and remediation.
Critical findings and unresolved required evidence always prevent completion.
Warnings remain visible in the report.

When a reviewer requests evidence, the runtime—not the reviewer—validates the
request and executes it through Conduit's permission-aware tool layer. Evidence
can be reused by multiple reviewers. Relevant source, configuration, dependency,
or documentation changes conservatively mark prior evidence stale. Only affected
reviews are rerun when possible.

## Completion and termination

A goal completes only when the general reviewer confirms implementation, every
required specialist approves (warnings are allowed), required evidence is
fresh, no critical finding remains open, and policy gates pass. Otherwise the
coding agent receives structured findings for another iteration.

| Condition | Status |
|---|---|
| All mandatory reviews pass | `completed` |
| User cancels | `cancelled` |
| Iteration budget is exhausted | `iteration_limit_reached` |
| Provider, persistence, or workspace failure | `failed` |

Cancellation propagates to network requests, tool execution, and local process
trees. Reporting is an atomic terminal persistence step. Provider timeouts,
malformed structured output after one repair, and unrecoverable storage errors
become explicit failures rather than an indefinitely animated loading state.

## Persistence and reporting

Every workflow transition emits a sequenced `workflow_state_transitioned` event.
Question/answer history, goal versions, reviews, findings, evidence metadata,
and the report are written incrementally to SQLite. Large logs live in
integrity-checked artifact files. A restored run continues from its persisted
boundary without duplicating completed work.

The final report links success criteria to validation and evidence, records
user decisions and reviewer results, and is available in-app or as Markdown and
JSON. Decision summaries are concise: private model chain-of-thought is neither
requested nor stored.

See [Goal definition runtime](goal-definition-runtime.md), [Evidence and
reports](evidence-and-reports.md), and [Goal-run persistence](goal-persistence.md)
for the detailed contracts.
