# CGS lifecycle

```text
draft goal
  -> clarification requested
  -> answer batches recorded
  -> revised goal awaiting approval
  -> exact revision approved
  -> run planning and implementation
  -> general review
  -> specialist review
  -> evidence collection
  -> revision/re-review when blocked
  -> completion decision
  -> canonical report
```

The runtime owns domain transitions and emits UI-neutral events containing CGS
artifacts or snapshots. A client renders questions, permissions, progress,
reviews, evidence, and reports. Only the client decides how those objects look.

Any implementation change following review conservatively makes test, build,
lint, and code-dependent approval evidence stale. Stale evidence remains
auditable but cannot support completion until recollected or revalidated.
Cancellation and failure also lead to a report when enough run state exists.
