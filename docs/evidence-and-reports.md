# Reviews, evidence, and reports

The general reviewer first checks the approved goal's criteria, constraints, and
deliverables. Once functionally implemented, it routes the change to the narrow
specialists justified by risk, changed files, and project policy. Running every
reviewer for every change is intentionally avoided.

## Evidence lifecycle

Reviewers may propose typed evidence requests but cannot execute commands.
`EvidenceCoordinator` validates workspace and permission policy, reuses suitable
fresh evidence, invokes approved tools, stores bounded summaries and artifact
references, then sends the result back to affected reviewers.

Execution evidence includes commands, tests, builds, lint, type checks,
benchmarks, coverage, dependency/static analysis, file/search excerpts, diffs,
and recorded user answers. Each item records provenance, collection time, trust,
and freshness. Source changes invalidate execution evidence; dependency or
configuration changes invalidate their broader dependent evidence; documentation
changes preserve unrelated test evidence. The policy is conservative.

## Approval aggregation

Completion requires:

- general-review approval of goal completion;
- approval or approval-with-warnings from every required specialist;
- no unresolved required evidence request;
- no open critical finding; and
- all project and organization policies satisfied.

Changes requested return structured remediation to the coding agent. After a
revision, validation and affected reviews rerun against fresh evidence. Warnings
are never silently converted to success; they remain visible in the report.

## Report contract

Every completed or stopped run records its goal, original request, criteria,
constraints, deliverables, assumptions, clarification history, implementation
summary, changed files, commands, validation, evidence, reviews, findings,
decision, runtime, and iterations. Markdown and JSON exports are derived from
the same persisted report shown in the app.

Reports contain concise reviewer decision summaries and evidence references.
They do not request, store, or expose private chain-of-thought. Large command
output is stored once as an integrity-checked artifact and loaded only when the
user asks to inspect it.

## Current local limitations

- Goal runs and artifacts are local to one desktop installation; there is no
  cloud sync or team dashboard.
- Screenshot/UI artifact collection is not part of the automated 0.3.1 gate.
- GitHub PR comments, HTML, and PDF report export are future integrations.
- Authenticated Codex and Kilo smoke tests require locally installed, logged-in
  CLIs and therefore remain an opt-in local release check.
