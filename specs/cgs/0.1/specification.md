# Conduit Goal Specification 0.1

## Purpose

CGS is Conduit's application-independent goal and verification format. It lets
users, clients, runtimes, implementation agents, reviewers, evidence collectors,
and report generators exchange the same validated artifacts without importing
Desktop behavior.

CGS 0.1 defines goals, question and answer batches, review requests and results,
evidence requests and artifacts, run snapshots, and final reports. It does not
define transport, authentication, provider APIs, accounts, billing, plugin
installation, marketplaces, UI layout, or arbitrary code execution.

## Common envelope

Every top-level artifact has `cgsVersion: "0.1.0"`, a discriminating `kind`, a
stable non-empty string `id`, and an RFC 3339 `createdAt` timestamp. `updatedAt`
is optional and cannot precede creation. IDs are application-independent; a
database row number is not an artifact ID. UUID-backed prefixed IDs are the
reference implementation default, but consumers must treat IDs as opaque.

The artifact kinds are `goal`, `question-batch`, `answer-batch`,
`review-request`, `review-result`, `evidence-request`, `evidence-artifact`,
`run`, and `report`.

## Artifact rules

- A goal describes success criteria, constraints, deliverables, assumptions,
  permissions, clarification references, its reviewer pipeline, state, and a
  positive revision. Approval requires at least one required criterion and all
  required clarification references to point to an answer batch.
- A question describes semantic intent through one of seven question types.
  Select questions require at least two options. Answers are separate artifacts
  and are validated against the exact batch.
- A review request fixes the run, goal revision, reviewer, changed files, and
  available evidence. A result references that request, records criterion
  outcomes and findings, and may request more evidence. Approval and blocking
  findings are mutually exclusive.
- Reviewers never execute commands. They emit evidence requests. The runtime
  permission/tool boundary produces evidence artifacts with explicit origin.
  Command evidence retains its exit status. Repository-dependent evidence may
  carry commit, tree, and working-tree hashes.
- A run is a portable domain snapshot. Provider credentials, raw messages,
  process handles, absolute workspace paths, and Desktop view state are absent.
- A report is the one canonical completion record. Markdown, HTML, JSON, and
  PDF are renderings, not separate report domains.

Repository paths use normalized, relative POSIX syntax. Absolute paths,
backslashes, NUL bytes, empty segments, and `.`/`..` traversal segments are
invalid. Logical artifact URIs may identify large output stored elsewhere.

The normative executable validation is the `@conduit/cgs` package. Checked-in
JSON Schemas provide language-neutral structural contracts.
