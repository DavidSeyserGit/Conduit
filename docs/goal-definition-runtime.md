# Goal definition runtime

Conduit 0.3 defines an engineering contract before implementation starts. The runtime is provider-neutral and persists every state transition through `GoalPersistenceRepository`.

## Flow

1. `prepareRepositoryContext` uses only bounded `list_files`, `search_files`, and `read_file` calls in Ask mode. It records instructions and relevant file references and infers inspectable facts such as languages, frameworks, package manager, and test tooling.
2. `GoalAnalyst` sends the request, repository context, bounded excerpts, policies, and previous answers to the selected model. Its result must pass `GoalAnalystOutputSchema`. One schema-repair request is allowed before a clear failure.
3. `GoalDefinitionRuntime` records the original request, analyst proposal, questions, answers, goal versions, and workflow events. Unchanged criteria, constraints, deliverables, and assumptions retain stable identifiers across regeneration.
4. The runtime exposes an `awaiting_goal_approval` preview. Approval is rejected unless it names the exact active version. `GoalLoopRunner` performs the same check before provider lookup, repository baselining, or any implementation tool call.
5. During execution, an approved run can enter `awaiting_user_input` with a native structured question. No provider request remains open while waiting. The persisted question can be answered after restart; a contract-changing answer creates a new approved version before the run returns to its recorded prior execution phase.

## Cancellation and recovery

Analysis and regeneration requests use an abort signal. Cancellation records a terminal workflow state. A waiting run owns no active provider or tool process and is restored entirely from its SQLite snapshot.

The repository context itself is stored as a run artifact so later reports can identify the files that informed goal analysis without placing large excerpts in every database row or model prompt.
