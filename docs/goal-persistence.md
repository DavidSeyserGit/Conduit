# Goal-run persistence

Conduit 0.3 stores goal-driven workflow data in an application-owned SQLite
database. The desktop UI and agent runtime use the typed
`GoalPersistenceRepository` port from `@conduit/shared`; only the Tauri adapter
can invoke the native repository commands. Raw SQL is not exposed to the webview.

## Storage layout

Tauri resolves the operating-system application data directory for
`dev.conduit.desktop`. Conduit creates:

- `goals.sqlite3` for queryable goal, run, review, evidence, and report records;
- `goal-artifacts/` for large command output and logs referenced by database
  metadata.

SQLite foreign keys are enabled on every connection. Migrations run in a
transaction and advance `PRAGMA user_version` only after the complete migration
succeeds. A database created by a newer Conduit version is rejected instead of
being partially interpreted. Startup integrity or migration failures are
returned through `goal_storage_status` and shown in the desktop application.

## Persisted records

The first schema version contains `goals`, `goal_versions`, `goal_questions`,
`goal_answers`, `goal_runs`, `run_events`, `review_results`, `review_findings`,
`evidence_requests`, `evidence_items`, `reports`, and `artifacts`.

Complex domain values are stored as schema-validated JSON while identifiers,
versions, statuses, timestamps, ordering, and relationships remain queryable.
Run events receive a transactionally allocated sequence number and are written
incrementally. Restoring a run returns its goal history, decisions, ordered
events, reviews, findings, evidence, and report as one typed snapshot.

Active structured runs persist their explicit workflow phase. On restart the
runtime restores the latest goal version and phase, preserves completed work,
and continues without duplicating already-recorded transitions or answers.
Evidence freshness is persisted so a restart cannot turn stale validation into
an approval. Terminal reports remain available in run history.

## v0.2 compatibility

On the first packaged-app launch with this storage version, the desktop adapter
reads the existing `loopkit-app` Zustand value from webview local storage. It
collects current and historical runs across sessions, deduplicates them by run
ID, validates each record with `CompatiblePersistedRunSchema`, and imports each
run and its events transactionally. Existing local-storage data is never deleted.

The `conduit-goal-storage-migrated-v1` marker is written only after all eligible
records have been processed. Invalid JSON or a native write failure leaves the
marker unset so the migration can be retried. Records that do not match the v0.2
contract remain in local storage and produce a visible warning.

## Artifact safety and cleanup

Artifact writes are atomic and scoped to an existing run. Metadata records the
relative path, content type, byte size, SHA-256 digest, and timestamp. Reads
reject absolute paths, parent components, symlink escapes, and digest mismatch.
Full output is loaded only when explicitly requested; evidence and prompts can
refer to the artifact ID instead.

At startup, unreferenced artifact files older than 24 hours are removed. The
grace period prevents cleanup from racing a write that has not yet committed its
metadata. Referenced artifacts are never removed by orphan cleanup.
