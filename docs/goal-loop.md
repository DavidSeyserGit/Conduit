# Goal Loop

The goal loop is Conduit's core mechanism: a coding agent implements changes, then an independent judge evaluates the result.

## Pseudocode

```typescript
async function runGoalLoop(config: GoalRunConfig): Promise<GoalRunResult> {
  let state = createInitialGoalState(config);

  while (state.iteration < config.maxIterations) {
    state.iteration += 1;

    const agentResult = await codingAgent.run({
      goal: state.goal,
      workspace: state.workspace,
      previousPlan: state.plan,
      judgeFeedback: state.lastJudgeFeedback,
      tools: state.allowedTools,
    });

    state = applyAgentResult(state, agentResult);

    const judgeResult = await judge.review({
      goal: state.goal,
      plan: state.plan,
      changes: state.changes,
      validationResults: state.validationResults,
      workspaceSummary: state.workspaceSummary,
    });

    state = applyJudgeResult(state, judgeResult);

    if (judgeResult.approved) {
      return { status: "completed", state };
    }

    if (state.cancelled) {
      return { status: "cancelled", state };
    }
  }

  return { status: "iteration_limit_reached", state };
}
```

## Termination Conditions

A goal run ends when:

| Condition | Status |
|-----------|--------|
| Judge approves | `completed` |
| User cancels | `cancelled` |
| Max iterations reached | `iteration_limit_reached` |
| Provider error | `failed` |
| Workspace unavailable | `failed` |

Default max iterations: **3** (configurable up to **10**).

## Coding Agent

The coding agent receives:

- The goal
- Repository context via tools
- Previous plan (if any)
- Judge feedback from prior iterations
- Remaining iteration budget

It maintains a structured plan:

```typescript
interface AgentPlan {
  summary: string;
  tasks: AgentTask[];
}
```

The agent runs a tool-call loop (up to 30 rounds per iteration) using:

- `list_files`, `search_files`, `read_file` — inspection
- `write_file`, `replace_in_file`, `create_file`, `delete_file` — editing
- `run_command` — validation (tests, type checks)
- `get_git_diff` — change tracking

## Judge

The judge is a separate model call with **no tool access**. It receives:

- Original goal
- Agent plan
- Changed files list
- Git unified diff
- Validation results (test output)
- Agent summary

It returns structured output:

```typescript
interface JudgeResult {
  approved: boolean;
  summary: string;
  feedback: string[];
  missingRequirements: string[];
  confidence: number;  // 0-1
}
```

The judge approves only when:

- Requested behavior is implemented
- Code is consistent with the repository
- Tests pass (when run)
- No important requirements are missing
- No obvious regressions

## Events

The runtime emits events for UI consumption:

```typescript
type GoalRunEvent =
  | { type: "run_started"; runId: string }
  | { type: "iteration_started"; iteration: number }
  | { type: "agent_message"; content: string }
  | { type: "tool_started"; toolCall: StoredToolCall }
  | { type: "tool_completed"; toolCall: StoredToolCall }
  | { type: "file_changed"; path: string }
  | { type: "judge_started"; iteration: number }
  | { type: "judge_completed"; result: JudgeResult }
  | { type: "approval_required"; command: string }
  | { type: "run_completed"; result: GoalRunResult }
  | { type: "run_failed"; error: string };
```

## Error Handling

- **Malformed judge output**: Retry once with repair prompt; show raw response on second failure
- **Context overflow**: Summarize older tool history, retain goal/plan/feedback/diff
- **Command timeout**: 120s default; report timeout in validation results
- **Provider errors**: Surface to user; mark run as failed if unrecoverable
