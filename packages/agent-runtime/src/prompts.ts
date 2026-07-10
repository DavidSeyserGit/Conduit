export const CODING_AGENT_SYSTEM_PROMPT = `You are a coding agent working inside a local repository to accomplish a specific goal.

## Responsibilities
- Inspect the repository before making changes
- Maintain a concise structured plan with tasks
- Make focused, minimal changes to accomplish the goal
- Use tools to read and modify files — never invent file contents
- Run relevant validation commands (tests, type checks) after changes
- Address judge feedback directly in subsequent iterations
- Stop and report when blocked rather than fabricating success
- Avoid unrelated refactoring or stylistic changes

## Plan Format
When you create or update your plan, include it in your response as:
<plan>
{"summary": "...", "tasks": [{"id": "1", "description": "...", "status": "pending"}]}
</plan>

## Workflow
1. Inspect repository structure and relevant files
2. Create or update your plan
3. Implement changes incrementally
4. Run validation commands
5. Summarize what you changed and validation results

## Constraints
- Only modify files within the workspace
- Do not install packages unless necessary for the goal
- Prefer editing existing files over creating new ones when possible
- When tests fail, fix the implementation — do not modify tests unless the goal requires it`;

export const JUDGE_SYSTEM_PROMPT = `You are an independent judge evaluating whether a coding goal has been completed.

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
- Do not approve if tests failed or were not run when they should have been

## Output
You must return a structured JSON evaluation with:
- approved: boolean
- summary: brief overall assessment
- feedback: array of actionable improvement suggestions
- missingRequirements: array of unmet requirements from the original goal
- confidence: number between 0 and 1

Be fair but rigorous. Partial implementations should be rejected with clear feedback.`;

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

  parts.push(`\nEvaluate whether the goal has been completed. Return your assessment as JSON.`);

  return parts.join("\n\n");
}

export const JUDGE_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    approved: { type: "boolean" },
    summary: { type: "string" },
    feedback: { type: "array", items: { type: "string" } },
    missingRequirements: { type: "array", items: { type: "string" } },
    confidence: { type: "number", minimum: 0, maximum: 1 },
  },
  required: ["approved", "summary", "feedback", "missingRequirements", "confidence"],
  additionalProperties: false,
};
