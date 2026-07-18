import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  GoalAnswer,
  GoalDefinition,
  GoalDrivenRunRecord,
  GoalPersistenceRepository,
  GoalQuestion,
  GoalRunState,
  GoalVersion,
  GoalWorkflowEvent,
  ModelRequest,
  ModelResponse,
} from "@conduit/shared";
import type { ModelProvider } from "@conduit/model-providers";
import type { ToolExecutor } from "@conduit/tools";
import { GoalAnalyst } from "./goal-analyst.ts";
import { GoalDefinitionRuntime } from "./goal-definition-runtime.ts";
import { prepareRepositoryContext } from "./repository-context.ts";

const at = "2026-07-18T12:00:00.000Z";

function analysis(question = true) {
  return {
    decisionSummary: question ? "The persistence choice requires user intent." : "The request and answers define the outcome.",
    ambiguities: question ? [{ id: "ambiguity-persistence", description: "Persistence behavior", userDecisionRequired: true, repositoryFacts: ["React app"] }] : [],
    questionBatches: question ? [{
      id: "behavior",
      title: "Behavior",
      position: 0,
      questions: [{ id: "persist", type: "confirmation", title: "Persist the preference between launches?", required: true, defaultValue: true, sourceReason: "This is a product decision" }],
    }] : [],
    proposedTitle: "Add a dark-mode toggle",
    proposedDescription: "Add a theme toggle using the existing React settings architecture.",
    proposedSuccessCriteria: [{ id: "criterion-toggle", description: "Users can switch themes", required: true, verificationHint: "UI test" }],
    proposedConstraints: [{ id: "constraint-react", description: "Follow the existing React component patterns", source: "repository" }],
    proposedDeliverables: [{ id: "deliverable-implementation", type: "implementation", description: "Theme toggle implementation", required: true }],
    proposedAssumptions: [{ id: "assumption-theme", description: "The existing theme tokens remain authoritative", confirmed: false }],
  };
}

function provider(responses: Array<unknown | ((request: ModelRequest) => Promise<ModelResponse>)>, requests: ModelRequest[] = []): ModelProvider {
  return {
    id: "analyst",
    name: "Analyst",
    listModels: async () => [],
    createResponse: async (request) => {
      requests.push(request);
      const response = responses.shift();
      if (typeof response === "function") return response(request);
      return { content: "", structuredOutput: response };
    },
    streamResponse: async () => ({ content: "" }),
  };
}

function repositoryTools(calls: string[] = []): ToolExecutor {
  return {
    async execute(name, args, mode) {
      calls.push(`${mode}:${name}`);
      if (name === "list_files") return { success: true, result: { entries: [
        { path: "package.json", type: "file" }, { path: "pnpm-lock.yaml", type: "file" },
        { path: "AGENTS.md", type: "file" }, { path: "src/theme.tsx", type: "file" },
        { path: "src/theme.test.ts", type: "file" },
      ] } };
      if (name === "search_files") return { success: true, result: { matches: [{ path: "src/theme.tsx" }] } };
      if (name === "read_file") {
        const path = String(args.path);
        return { success: true, result: { content: path === "package.json" ? '{"packageManager":"pnpm@11","dependencies":{"react":"19"},"scripts":{"test":"node --test"}}' : `content of ${path}` } };
      }
      return { success: false, error: `Unexpected tool ${name}` };
    },
  };
}

class MemoryPersistence implements GoalPersistenceRepository {
  goals = new Map<string, GoalDefinition>();
  versions = new Map<string, GoalVersion[]>();
  questions = new Map<string, GoalQuestion[]>();
  answers = new Map<string, GoalAnswer[]>();
  runs = new Map<string, GoalDrivenRunRecord>();
  events: GoalWorkflowEvent[] = [];
  async status() { return { available: true }; }
  async saveGoal(goal: GoalDefinition) { this.goals.set(goal.id, structuredClone(goal)); }
  async saveGoalVersion(version: GoalVersion) {
    const versions = this.versions.get(version.goalId) ?? [];
    const next = versions.filter((candidate) => candidate.version !== version.version);
    next.push(structuredClone(version));
    this.versions.set(version.goalId, next.sort((a, b) => a.version - b.version));
  }
  async replaceQuestions(goalId: string, goalVersion: number, questions: GoalQuestion[]) { this.questions.set(`${goalId}:${goalVersion}`, structuredClone(questions)); }
  async saveAnswer(goalId: string, answer: GoalAnswer) { this.answers.set(goalId, [...(this.answers.get(goalId) ?? []), structuredClone(answer)]); }
  async saveRun(run: GoalDrivenRunRecord) { this.runs.set(run.id, structuredClone(run)); }
  async appendEvent(event: GoalWorkflowEvent) { this.events.push(structuredClone(event)); return this.events.length; }
  async saveReview() {}
  async saveEvidenceRequest() {}
  async saveEvidence() {}
  async saveReport() {}
  async deleteRun(runId: string) { this.runs.delete(runId); }
  async deleteGoal(goalId: string) { this.goals.delete(goalId); }
  async importLegacyRun(_run: GoalRunState) {}
  async getGoal(id: string) { return this.goals.get(id) ?? null; }
  async restoreRun(runId: string) {
    const run = this.runs.get(runId);
    if (!run) return null;
    const goal = this.goals.get(run.goalId) ?? null;
    return {
      run, goal, versions: this.versions.get(run.goalId) ?? [],
      questions: [...this.questions.entries()].filter(([key]) => key.startsWith(`${run.goalId}:`)).flatMap(([, value]) => value),
      answers: this.answers.get(run.goalId) ?? [], events: this.events.filter((event) => event.runId === runId),
      reviews: [], findings: [], evidenceRequests: [], evidence: [], report: null,
    };
  }
  async listRuns() { return [...this.runs.values()]; }
  async writeArtifact(runId: string, content: string, contentType = "text/plain") { return { id: `artifact-${runId}`, runId, relativePath: "context.json", sha256: "hash", size: content.length, contentType, createdAt: at }; }
  async readArtifact(_artifactId: string): Promise<never> { throw new Error("not used"); }
  async cleanupArtifacts() { return 0; }
}

function runtime(model: ModelProvider, persistence: MemoryPersistence, tools = repositoryTools()) {
  let id = 0;
  return new GoalDefinitionRuntime(model, "analyst/model", tools, persistence, {
    now: () => new Date(at),
    createId: (prefix) => `${prefix}-${++id}`,
  });
}

test("repository preparation inspects technical facts with read-only tools", async () => {
  const calls: string[] = [];
  const prepared = await prepareRepositoryContext("/repo", "Add a dark theme toggle", repositoryTools(calls), () => new Date(at));
  assert.deepEqual(prepared.context.languages, ["TypeScript"]);
  assert.deepEqual(prepared.context.frameworks, ["React"]);
  assert.equal(prepared.context.packageManager, "pnpm");
  assert.ok(prepared.context.instructions.some((file) => file.path === "AGENTS.md"));
  assert.ok(calls.every((call) => call.startsWith("ask:")));
  assert.ok(calls.includes("ask:search_files"));
});

test("Goal Analyst repairs malformed structured output once and then fails clearly", async () => {
  const requests: ModelRequest[] = [];
  const context = (await prepareRepositoryContext("/repo", "Add toggle", repositoryTools(), () => new Date(at))).context;
  const analyst = new GoalAnalyst(provider([{ invalid: true }, "still invalid"], requests), "analyst/model");
  await assert.rejects(() => analyst.analyze({ initialRequest: "Add toggle", repositoryContext: context, excerpts: [] }), /after one repair/);
  assert.equal(requests.length, 2);
  assert.match(requests[1]?.messages.at(-1)?.content ?? "", /corrected JSON only/);
});

test("answers create an auditable version and only the exact preview can be approved", async () => {
  const persistence = new MemoryPersistence();
  const requests: ModelRequest[] = [];
  const revisedAnalysis = analysis(false);
  revisedAnalysis.proposedSuccessCriteria[0]!.id = "criterion-regenerated";
  const goalRuntime = runtime(provider([analysis(true), analysis(false), revisedAnalysis], requests), persistence);
  const started = await goalRuntime.start({ initialRequest: "Add a dark-mode toggle", workspacePath: "/repo" });
  assert.equal(started.run.workflowPhase, "awaiting_goal_answers");
  assert.equal(started.questions[0]?.id, "persist");
  assert.match(requests[0]?.messages[0]?.content ?? "", /Never ask the user for a language/);

  const revised = await goalRuntime.submitAnswers(started.run.id, [{ questionId: "persist", useDefault: true }]);
  assert.equal(revised.goal.version, 3);
  assert.equal(revised.goal.answers[0]?.answeredBy, "default");
  assert.equal(revised.run.workflowPhase, "awaiting_goal_approval");
  assert.equal(persistence.versions.get(revised.goal.id)?.length, 3);
  const editedAnswer = await goalRuntime.reviseAnswer(started.run.id, "persist", false);
  assert.equal(editedAnswer.goal.version, 4);
  assert.equal(editedAnswer.goal.answers[0]?.value, false);
  assert.equal(editedAnswer.goal.successCriteria[0]?.id, "criterion-toggle");
  assert.equal(persistence.versions.get(revised.goal.id)?.length, 4);
  await assert.rejects(() => goalRuntime.approve(started.run.id, 3), /stale/);
  const approved = await goalRuntime.approve(started.run.id, 4);
  assert.equal(approved.status, "approved");
  assert.equal((await goalRuntime.assertApprovedGoal(started.run.id, 4)).version, 4);
});

test("execution questions persist across runtime restart and resume with a new approved contract", async () => {
  const persistence = new MemoryPersistence();
  const first = runtime(provider([analysis(false)]), persistence);
  const started = await first.start({ initialRequest: "Add a dark-mode toggle", workspacePath: "/repo" });
  await first.approve(started.run.id, started.goal.version);
  await first.requestExecutionQuestion(started.run.id, {
    id: "account-linking", type: "single_select", title: "How should existing accounts be linked?", required: true,
    options: [{ id: "confirm", label: "Require confirmation", recommended: true }], defaultValue: "confirm",
    sourceReason: "Account-linking behavior is a product decision that cannot be inferred safely",
  });
  assert.equal((await persistence.restoreRun(started.run.id))?.run.workflowPhase, "awaiting_user_input");

  const restarted = runtime(provider([]), persistence);
  const resumedGoal = await restarted.answerExecutionQuestion(started.run.id, "account-linking", "confirm", {
    constraints: [...started.goal.constraints, { id: "constraint-linking", description: "Require explicit account-linking confirmation", source: "user" }],
  });
  const restored = await persistence.restoreRun(started.run.id);
  assert.equal(restored?.run.workflowPhase, "planning");
  assert.equal(resumedGoal.version, started.goal.version + 1);
  assert.equal(resumedGoal.status, "approved");
  assert.ok(restored?.events.some((event) => event.type === "answer_recorded"));
});

test("editor questions reject malformed values before persistence", async () => {
  const persistence = new MemoryPersistence();
  const first = runtime(provider([analysis(false)]), persistence);
  const started = await first.start({ initialRequest: "Add a dark-mode toggle", workspacePath: "/repo" });
  await first.approve(started.run.id, started.goal.version);
  await first.requestExecutionQuestion(started.run.id, {
    id: "constraints", type: "constraint_editor", title: "Which constraints should apply?", required: true,
    sourceReason: "The product constraint cannot be inferred safely",
  });
  await assert.rejects(
    () => first.answerExecutionQuestion(started.run.id, "constraints", [null] as never),
    /requires constraints/,
  );
  assert.equal(persistence.answers.get(started.goal.id), undefined);
});

test("cancelling repository analysis aborts the provider and persists a cancelled run", async () => {
  const persistence = new MemoryPersistence();
  let providerAborted = false;
  const pendingProvider = provider([async (request: ModelRequest) => new Promise<ModelResponse>((_resolve, reject) => {
    request.signal?.addEventListener("abort", () => {
      providerAborted = true;
      reject(new Error("aborted"));
    }, { once: true });
  })]);
  const goalRuntime = runtime(pendingProvider, persistence);
  const starting = goalRuntime.start({ initialRequest: "Add a dark-mode toggle", workspacePath: "/repo" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  await goalRuntime.cancelActive();
  await assert.rejects(() => starting, /cancelled/);
  assert.equal(providerAborted, true);
  assert.equal(persistence.runs.get("run-2")?.workflowPhase, "cancelled");
});
