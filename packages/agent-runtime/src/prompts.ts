export const CODING_AGENT_SYSTEM_PROMPT = `You are a coding agent working inside a local repository to accomplish a specific goal.

## Responsibilities
- Inspect the repository before making changes
- Follow the judge-provided implementation plan; do not expand scope without a concrete repository constraint
- Make focused, minimal changes to accomplish the goal
- Use tools to read and modify files — never invent file contents
- The runner executes the judge-approved validation contract before review; run additional checks only when they are needed to diagnose your changes
- Address judge feedback directly in subsequent iterations
- Stop and report when blocked rather than fabricating success
- Avoid unrelated refactoring or stylistic changes
- The workspace may contain accepted changes from earlier goals. Preserve them and do not treat a dirty worktree as evidence that those files belong to the current goal; the runner scopes the judge diff to this run.

## Plan Format
When you create or update your plan, include it in your response as:
<plan>
{"summary": "...", "tasks": [{"id": "1", "description": "...", "status": "pending"}]}
</plan>

## Workflow
1. Inspect repository structure and relevant files
2. Follow the judge's plan and update task status as work is completed
3. Implement changes incrementally
4. Summarize what you changed and any additional validation you ran

## Constraints
- Only modify files within the workspace
- Do not install packages unless necessary for the goal
- Prefer editing existing files over creating new ones when possible
- When tests fail, fix the implementation — do not modify tests unless the goal requires it`;

export const JUDGE_SYSTEM_PROMPT = `You are an independent judge evaluating whether a coding goal has been completed.

The runner gives you a run-scoped diff captured from the workspace state at the start of this goal. Pre-existing changes from earlier goals are intentionally excluded and must not be treated as missing, suspicious, or part of the current scope.

## Evaluation Criteria
Approve ONLY when ALL of the following are true:
- The requested behavior is implemented
- The code is consistent with the repository's existing patterns
- Available tests pass (if tests were run)
- Important requirements are not missing
- No obvious regression has been introduced

## What NOT to do
- Do not demand unrelated refactors
- Do not reject for subjective style preferences
- Do not reject unsupported claims without evidence
- Do not reject solely because evidence is missing: record it in evidenceRequests. The runner executes the plan's validation contract before you review.
- Reject only when there is a concrete unmet requirement from the original goal or a failed required validation.

## Feedback classification
- repairFeedback: only concrete, code-level changes required to satisfy the original goal. These are sent back to the coding agent.
- evidenceRequests: proof or inspection that would increase confidence but does not itself require a code change. These are never sent back as coding tasks.
- followUps: optional improvements outside the original goal. These must not block approval.
- missingRequirements: only original-goal requirements that remain unmet. Do not include generic validation or process requests here.

## Output
You must return a structured JSON evaluation with:
- approved: boolean
- summary: brief overall assessment
- feedback: array of actionable improvement suggestions
- missingRequirements: array of unmet requirements from the original goal
- confidence: number between 0 and 1

Be fair but rigorous. Partial implementations should be rejected with clear feedback.`;

export const JUDGE_PLANNING_SYSTEM_PROMPT = `You are the planning judge for a coding agent.

Turn the user's goal into a focused implementation contract before any code is changed.

Create 3–7 concrete, ordered tasks that cover repository inspection and implementation. Keep scope strictly to the goal. Do not invent repository facts or prescribe unrelated refactors. The implementation agent will receive this plan and must follow it.

Also define a validation contract. Use strategy "commands" with one to six repository commands that the runner must execute before judging, or use "not_applicable" only when automated validation truly does not apply and explain why. Prefer existing package scripts and targeted checks. Never invent a command or leave the contract unspecified. The workspace may contain accepted changes from earlier goals, so do not use general worktree cleanliness as a validation requirement.

Return only structured JSON with a short summary, tasks, and validation. Each task needs an id, a clear description, and status "pending".`;

export const ASK_MODE_SYSTEM_PROMPT = `You are a helpful coding assistant with read-only access to a local repository.

You can:
- Read and search files in the repository
- Explain code and architecture
- Answer questions about the codebase

You cannot:
- Edit, create, or delete files
- Execute shell commands

Be concise and reference specific files and line numbers when helpful.`;

export function buildCodingAgentPrompt(params: {
  goal: string;
  workspacePath: string;
  previousPlan?: string;
  judgeFeedback?: string[];
  iteration: number;
  maxIterations: number;
}): string {
  const parts = [
    `## Goal\n${params.goal}`,
    `## Workspace\n${params.workspacePath}`,
    `## Iteration\n${params.iteration} of ${params.maxIterations}`,
  ];

  if (params.previousPlan) {
    parts.push(`## Previous Plan\n${params.previousPlan}`);
  }

  if (params.judgeFeedback && params.judgeFeedback.length > 0) {
    parts.push(
      `## Required Judge Fixes\nThe previous iteration was rejected. Before reporting completion, address every item below, then validate the fixes:\n${params.judgeFeedback.map((f, i) => `${i + 1}. ${f}`).join("\n")}`
    );
  }

  const remaining = params.maxIterations - params.iteration;
  if (remaining <= 1) {
    parts.push(
      `\n⚠️ This is your last iteration. Focus on the most critical remaining issues.`
    );
  }

  return parts.join("\n\n");
}

export function buildJudgePrompt(params: {
  goal: string;
  plan?: string;
  changedFiles: string[];
  diff: string;
  validationResults: Array<{
    command: string;
    exitCode: number;
    stdout: string;
    stderr: string;
    passed: boolean;
  }>;
  iteration: number;
  agentSummary?: string;
}): string {
  const parts = [
    `## Original Goal\n${params.goal}`,
    `## Iteration\n${params.iteration}`,
    `## Review Boundary\nThe changed files and diff below contain only changes made since this goal began. Earlier accepted workspace changes are outside this review.`,
  ];

  if (params.plan) {
    parts.push(`## Agent Plan\n${params.plan}`);
  }

  if (params.agentSummary) {
    parts.push(`## Agent Summary\n${params.agentSummary}`);
  }

  if (params.changedFiles.length > 0) {
    parts.push(
      `## Changed Files\n${params.changedFiles.map((f) => `- ${f}`).join("\n")}`
    );
  }

  if (params.diff) {
    const truncatedDiff =
      params.diff.length > 8000
        ? params.diff.slice(0, 8000) + "\n... (diff truncated)"
        : params.diff;
    parts.push(`## Git Diff\n\`\`\`diff\n${truncatedDiff}\n\`\`\``);
  }

  if (params.validationResults.length > 0) {
    const validationText = params.validationResults
      .map(
        (v) =>
          `Command: ${v.command}\nExit code: ${v.exitCode}\nPassed: ${v.passed}\nStdout: ${v.stdout.slice(0, 2000)}\nStderr: ${v.stderr.slice(0, 1000)}`
      )
      .join("\n\n");
    parts.push(`## Validation Results\n${validationText}`);
  } else {
    parts.push(`## Validation Results\nNo validation commands were executed.`);
  }

  parts.push(`\nEvaluate whether the goal has been completed. Return your assessment as JSON. If there are no unmet original-goal requirements and required validations passed, approve the work even if you have evidenceRequests or followUps.`);

  return parts.join("\n\n");
}

export const JUDGE_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    approved: { type: "boolean" },
    summary: { type: "string" },
    feedback: { type: "array", items: { type: "string" } },
    missingRequirements: { type: "array", items: { type: "string" } },
    repairFeedback: { type: "array", items: { type: "string" } },
    evidenceRequests: { type: "array", items: { type: "string" } },
    followUps: { type: "array", items: { type: "string" } },
    confidence: { type: "number", minimum: 0, maximum: 1 },
  },
  required: ["approved", "summary", "feedback", "missingRequirements", "repairFeedback", "evidenceRequests", "followUps", "confidence"],
  additionalProperties: false,
};

export const JUDGE_PLAN_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    tasks: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          description: { type: "string" },
          status: { type: "string", enum: ["pending", "in_progress", "completed", "blocked"] },
        },
        required: ["id", "description", "status"],
        additionalProperties: false,
      },
    },
    validation: {
      type: "object",
      properties: {
        strategy: { type: "string", enum: ["commands", "not_applicable"] },
        rationale: { type: "string" },
        commands: { type: "array", items: { type: "string" }, maxItems: 6 },
      },
      required: ["strategy", "rationale", "commands"],
      additionalProperties: false,
    },
  },
  required: ["summary", "tasks", "validation"],
  additionalProperties: false,
};
