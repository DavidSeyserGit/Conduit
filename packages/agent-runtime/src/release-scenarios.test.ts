import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type {
  EvidenceItem,
  EvidenceRequest,
  CommandPermissionMode,
  GoalAnswer,
  GoalDefinition,
  GoalDrivenRunRecord,
  GoalPersistenceRepository,
  GoalQuestion,
  GoalReport,
  GoalRunEvent,
  GoalRunSnapshot,
  GoalRunState,
  GoalVersion,
  GoalWorkflowEvent,
  ModelRequest,
  ModelResponse,
  ReviewResult,
} from "@conduit/shared";
import type { ModelProvider } from "@conduit/model-providers";
import { DefaultProviderRegistry } from "@conduit/model-providers";
import type { ToolExecutor } from "@conduit/tools";
import { GoalDefinitionRuntime } from "./goal-definition-runtime.ts";
import { GoalLoopRunner } from "./goal-loop.ts";

interface ScenarioFixture {
  id: string;
  request: string;
  changedFiles: string[];
  expectedReviewers?: string[];
  expectedReviewer?: string;
  expectedEvidence?: string;
  expectedDecision?: string;
  expectedIterations?: number;
  expectedOutcome: string;
}

const fixtures = JSON.parse(readFileSync(new URL("../../../fixtures/goal-driven/scenarios.json", import.meta.url), "utf8")) as ScenarioFixture[];
const fixture = (id: string) => fixtures.find((item) => item.id === id)!;
const at = "2026-07-18T12:00:00.000Z";

test("release fixture repositories are small, offline, and cover all five required scenarios", () => {
  assert.equal(fixtures.length, 5);
  for (const item of fixtures) {
    const source = readFileSync(new URL(`../../../fixtures/goal-driven/${item.id}/${item.changedFiles[0]}`, import.meta.url), "utf8");
    assert.ok(source.length > 0 && source.length < 1_000);
    assert.doesNotMatch(source, /https?:\/\//);
  }
});

test("scenario 1: dark mode completes through UI, accessibility, testing, and code-quality review", async () => {
  const result = await runScenario(fixture("dark-mode"));
  assert.equal(result.result.status, "completed");
  assert.deepEqual(new Set(result.result.state.iterations[0]?.reviewRouting?.requiredReviewers), new Set(fixture("dark-mode").expectedReviewers));
  assert.equal(result.result.report?.finalDecision.achieved, true);
  assertWorkflowOrder(result.persistence.events, ["planning", "implementing", "validating", "general_review", "routing_reviews", "specialist_review", "reporting", "completed"]);
});

test("scenario 2: GitHub authentication collects requested security evidence before approval", async () => {
  const result = await runScenario(fixture("github-auth"));
  const iteration = result.result.state.iterations[0]!;
  assert.equal(result.result.status, "completed");
  assert.deepEqual(new Set(iteration.reviewRouting?.requiredReviewers), new Set(fixture("github-auth").expectedReviewers));
  assert.ok(iteration.evidence?.some((item) => item.type === "test" && item.freshness.status === "fresh"));
  assert.equal(result.tools.commandRuns, 1);
  assert.ok(result.result.report?.criteria[0]?.evidenceIds.length);
  assertWorkflowOrder(result.persistence.events, ["collecting_evidence", "general_review", "routing_reviews", "specialist_review", "reporting", "completed"]);
});

test("scenario 3: an execution decision survives restart, resumes, and appears in the report", async () => {
  const item = fixture("execution-question");
  const persistence = new MemoryPersistence();
  const goal = makeGoal(item);
  await seedApprovedRun(persistence, goal, "implementing");
  const question: GoalQuestion = {
    id: "account-linking",
    type: "single_select",
    title: "How should an existing account be linked?",
    required: true,
    sourceReason: "Account ownership is a product decision that cannot be inferred safely",
    options: [{ id: "confirm", label: "Require explicit confirmation", recommended: true }, { id: "reject", label: "Reject the login" }],
    defaultValue: "confirm",
  };
  const runtime = definitionRuntime(persistence);
  await runtime.requestExecutionQuestion(`run-${item.id}`, question);
  const paused = (await persistence.restoreRun(`run-${item.id}`))?.run;
  assert.equal(paused && "workflowPhase" in paused ? paused.workflowPhase : null, "awaiting_user_input");

  const restarted = definitionRuntime(persistence);
  const revisedGoal = await restarted.answerExecutionQuestion(`run-${item.id}`, question.id, "confirm");
  assert.equal(revisedGoal.version, 2);
  assert.equal(revisedGoal.status, "approved");

  const result = await runScenario(item, { persistence, goal: revisedGoal });
  assert.equal(result.result.status, "completed");
  assert.equal(result.result.report?.clarifications[0]?.question.id, question.id);
  assert.equal(result.result.report?.clarifications[0]?.answer.value, "confirm");
  assert.match(result.result.report?.implementation.decisions.join(" ") ?? "", /account-linking: confirm/);
});

test("scenario 4: a serious security finding forces revision, stale evidence rerun, and affected re-review", async () => {
  const result = await runScenario(fixture("failed-security-review"));
  assert.equal(result.result.status, "completed");
  assert.equal(result.result.state.iteration, fixture("failed-security-review").expectedIterations, JSON.stringify({
    routing: result.result.state.iterations.map((iteration) => iteration.reviewRouting?.requiredReviewers),
    reviews: result.result.state.iterations.map((iteration) => iteration.specialistReviews?.map((review) => [review.reviewerId, review.status])),
    securityReviewCalls: result.runtime.securityReviewCalls,
  }));
  assert.equal(result.runtime.securityReviewCalls >= 3, true);
  assert.equal(result.tools.commandRuns, 2);
  assert.ok(result.result.state.iterations[1]?.evidence?.some((item) => item.freshness.status === "fresh"));
  assert.ok(result.result.report?.reviews.some((review) => review.reviewerId === "security" && review.status === "changes_requested"));
  assertWorkflowOrder(result.persistence.events, ["specialist_review", "revising", "implementing", "validating", "general_review", "specialist_review", "reporting", "completed"]);
});

test("scenario 5: a performance claim requires approved benchmark evidence and records it in the report", async () => {
  const events: GoalRunEvent[] = [];
  let runner!: GoalLoopRunner;
  const result = await runScenario(fixture("performance-evidence"), {
    permissionMode: "ask_every_time",
    onRunner: (value) => { runner = value; },
    onEvent: (event) => {
      events.push(event);
      if (event.type === "approval_required") runner.approveCommand(event.requestId);
    },
  });
  assert.equal(result.result.status, "completed");
  assert.ok(result.result.state.iterations[0]?.evidence?.some((item) => item.type === "benchmark"));
  assert.ok(events.some((event) => event.type === "approval_required"));
  assert.ok(result.result.report?.evidence.some((item) => item.type === "benchmark"));
  assert.equal(result.result.report?.finalDecision.achieved, true);
});

test("release scenarios reject stale approval, preserve warnings, and keep legacy Ask/run records restorable", async () => {
  const persistence = new MemoryPersistence();
  const legacy: GoalRunState = {
    id: "legacy-run", goal: "Explain the repository", workspacePath: "/legacy", status: "completed",
    codingModelId: "ask/model", judgeModelId: "judge/model", iteration: 1, maxIterations: 1, iterations: [], startedAt: at, finishedAt: at,
  };
  await persistence.importLegacyRun(legacy, []);
  assert.deepEqual((await persistence.restoreRun(legacy.id))?.run, legacy);
});

async function runScenario(
  scenario: ScenarioFixture,
  options: {
    persistence?: MemoryPersistence;
    goal?: GoalDefinition;
    permissionMode?: CommandPermissionMode;
    onRunner?: (runner: GoalLoopRunner) => void;
    onEvent?: (event: GoalRunEvent) => void;
  } = {},
) {
  const goal = options.goal ?? makeGoal(scenario);
  const persistence = options.persistence ?? new MemoryPersistence();
  if (!(await persistence.restoreRun(`run-${scenario.id}`))) await seedApprovedRun(persistence, goal, "planning");
  const runtime = { codingIterations: 0, securityReviewCalls: 0 };
  const tools = scenarioTools(scenario, runtime);
  const registry = new DefaultProviderRegistry();
  registry.register(codingProvider(runtime));
  registry.register(judgeProvider(scenario, runtime));
  const runner = new GoalLoopRunner(registry, persistence);
  options.onRunner?.(runner);
  const result = await runner.run({
    goal: scenario.request,
    runId: `run-${scenario.id}`,
    structuredGoal: goal,
    approvedGoalVersion: goal.version,
    workspacePath: fixturePath(scenario.id),
    codingModelId: "fixture-coding/model",
    judgeModelId: "fixture-judge/model",
    maxIterations: 3,
    commandPermissionMode: options.permissionMode ?? "auto_approve_safe",
  }, tools.executor, {}, options.onEvent ?? (() => {}));
  return { result, persistence, runtime, tools };
}

function codingProvider(runtime: { codingIterations: number }): ModelProvider {
  return {
    id: "fixture-coding", name: "Fixture coding agent", listModels: async () => [],
    createResponse: async () => ({ content: "" }), streamResponse: async () => ({ content: "" }),
    async runCodingIteration(request) {
      runtime.codingIterations += 1;
      return {
        changedFiles: [], validationResults: [], toolCalls: [], messages: [],
        agentSummary: request.judgeFeedback?.length
          ? `Applied reviewer remediation: ${request.judgeFeedback.join("; ")}`
          : "Implemented the approved fixture goal.",
      };
    },
  };
}

function judgeProvider(scenario: ScenarioFixture, runtime: { codingIterations: number; securityReviewCalls: number }): ModelProvider {
  return provider("fixture-judge", async (request) => {
    const name = request.structuredOutput?.name;
    if (name === "implementation_plan") return response({
      summary: `Implement ${scenario.id}`,
      tasks: [{ id: "implement", description: scenario.request, status: "pending" }],
      validation: scenario.id === "dark-mode"
        ? { strategy: "commands", rationale: "The UI fixture has a deterministic test.", commands: ["pnpm test"] }
        : { strategy: "not_applicable", rationale: "Specialist evidence requests own targeted validation.", commands: [] },
    });
    if (name === "general_review") return response({
      goalStatus: "implemented", confidence: 0.96, summary: "The approved fixture behavior is implemented.",
      findings: [], evidenceRequests: [], requiredReviewers: [], optionalReviewers: [], evidenceIds: freshEvidenceIds(request),
    });
    const reviewerId = name?.replace("review_", "") ?? "unknown";
    const prompt = request.messages.at(-1)?.content ?? "";
    if (scenario.id === "github-auth" && reviewerId === "security" && !hasFreshEvidence(prompt, "test")) {
      return response(needsEvidence("security", "auth-integration", "test", "Run authentication integration tests.", "pnpm test"));
    }
    if (scenario.id === "failed-security-review" && reviewerId === "testing" && !hasFreshEvidence(prompt, "test")) {
      return response(needsEvidence("testing", "security-regression", "test", "Run the security regression tests.", "pnpm test"));
    }
    if (scenario.id === "failed-security-review" && reviewerId === "testing") {
      return response(approvedWithEvidenceRequest("testing", "security-regression", "test", "Run the security regression tests.", "pnpm test"));
    }
    if (scenario.id === "failed-security-review" && reviewerId === "security") {
      runtime.securityReviewCalls += 1;
      if (runtime.codingIterations === 1) return response({
        status: "changes_requested", confidence: 0.99, summary: "The session cookie is insecure.",
        findings: [{ id: "secure-cookie", severity: "critical", title: "Session cookie lacks secure flags", description: "The cookie can cross an insecure transport.", filePath: "src/session.ts", lineStart: 1, lineEnd: 1, criterionId: "criterion", remediation: "Set secure, httpOnly, and sameSite flags." }],
        evidenceRequests: [],
      });
    }
    if (scenario.id === "performance-evidence" && reviewerId === "performance" && !hasFreshEvidence(prompt, "benchmark")) {
      return response(needsEvidence("performance", "search-benchmark", "benchmark", "Run the deterministic search benchmark.", "pnpm bench"));
    }
    return response({ status: "approved", confidence: 0.97, summary: `${reviewerId} approved the fixture.`, findings: [], evidenceRequests: [] });
  });
}

function scenarioTools(scenario: ScenarioFixture, runtime: { codingIterations: number }) {
  let commandRuns = 0;
  const executor: ToolExecutor = {
    async execute(name, args) {
      if (name === "capture_git_snapshot") return { success: true, result: { tree: "a".repeat(40) } };
      if (name === "get_git_diff") return {
        success: true,
        result: {
          diff: `+ fixture implementation ${runtime.codingIterations}`,
          changedFiles: scenario.changedFiles,
          changes: scenario.changedFiles.map((path) => ({ path, status: "modified" })),
        },
      };
      if (name === "run_command") {
        commandRuns += 1;
        const command = String(args.command ?? "");
        return { success: true, result: { command, exitCode: 0, stdout: command.includes("bench") ? "benchmark: 4.2 ms" : "tests passed", stderr: "", durationMs: 5 } };
      }
      return { success: false, error: `Unexpected fixture tool: ${name}` };
    },
  };
  return { executor, get commandRuns() { return commandRuns; } };
}

function makeGoal(scenario: ScenarioFixture): GoalDefinition {
  const auth = scenario.id.includes("auth") || scenario.id.includes("security") || scenario.id === "execution-question";
  return {
    schemaVersion: 1, id: `goal-${scenario.id}`, originalRequest: scenario.request, title: scenario.request,
    description: scenario.request,
    successCriteria: [{ id: "criterion", description: `The ${scenario.id} fixture satisfies its approved behavior`, required: true }],
    constraints: [{ id: "offline", description: "Use deterministic offline fixture providers", source: "policy" }],
    deliverables: [
      { id: "implementation", type: "implementation", description: "Fixture implementation", required: true },
      { id: "tests", type: scenario.id === "performance-evidence" ? "benchmark" : "unit_tests", description: auth ? "Security regression evidence" : "Automated regression evidence", required: true },
    ],
    assumptions: [], answers: [], status: "approved", version: 1, createdAt: at, updatedAt: at,
  };
}

async function seedApprovedRun(persistence: MemoryPersistence, goal: GoalDefinition, phase: GoalDrivenRunRecord["workflowPhase"]) {
  await persistence.saveGoal(goal);
  await persistence.saveGoalVersion({ goalId: goal.id, version: goal.version, definition: goal, changeSummary: "Fixture goal approved", createdAt: at, createdBy: "user" });
  await persistence.saveRun({ formatVersion: 1, id: `run-${goal.id.replace("goal-", "")}`, goalId: goal.id, activeGoalVersion: goal.version, workflowPhase: phase, workspacePath: fixturePath(goal.id.replace("goal-", "")), startedAt: at, updatedAt: at });
  await persistence.appendEvent({ id: `event-${goal.id}`, runId: `run-${goal.id.replace("goal-", "")}`, occurredAt: at, type: "workflow_state_transitioned", from: "awaiting_goal_approval", to: phase, summary: "Fixture run seeded" });
}

function definitionRuntime(persistence: GoalPersistenceRepository) {
  return new GoalDefinitionRuntime(provider("fixture-definition", async () => { throw new Error("The fixture question flow must not call a model"); }), "fixture-definition/model", { execute: async () => ({ success: false, error: "not used" }) }, persistence, { now: () => new Date(at), createId: (prefix) => `${prefix}-${Math.random().toString(36).slice(2)}` });
}

function provider(id: string, createResponse: (request: ModelRequest) => Promise<ModelResponse>): ModelProvider {
  return { id, name: id, listModels: async () => [], createResponse, streamResponse: async () => ({ content: "" }) };
}
function response(structuredOutput: unknown): ModelResponse { return { content: "", structuredOutput }; }
function needsEvidence(reviewerId: string, id: string, type: "test" | "benchmark", description: string, command: string) {
  return { status: "needs_evidence", confidence: 0.85, summary: `${reviewerId} needs recorded evidence.`, findings: [], evidenceRequests: [{ id, type, description, required: true, suggestedCommand: command, expectedOutcome: "The deterministic command passes." }] };
}
function approvedWithEvidenceRequest(reviewerId: string, id: string, type: "test" | "benchmark", description: string, command: string) {
  return { status: "approved", confidence: 0.97, summary: `${reviewerId} approved the recorded evidence.`, findings: [], evidenceRequests: [{ id, type, description, required: true, suggestedCommand: command, expectedOutcome: "The deterministic command passes." }] };
}
function hasFreshEvidence(prompt: string, type: string): boolean { return prompt.includes(`"type": "${type}"`) && prompt.includes('"status": "fresh"'); }
function freshEvidenceIds(request: ModelRequest): string[] { return [...(request.messages.at(-1)?.content.matchAll(/"id": "(evidence-[^"]+)"/g) ?? [])].map((match) => match[1]!); }
function fixturePath(id: string): string { return fileURLToPath(new URL(`../../../fixtures/goal-driven/${id}`, import.meta.url)); }
function assertWorkflowOrder(events: GoalWorkflowEvent[], expected: string[]) {
  const phases = events.filter((event) => event.type === "workflow_state_transitioned").map((event) => event.to);
  let cursor = 0;
  for (const phase of phases) if (phase === expected[cursor]) cursor += 1;
  assert.equal(cursor, expected.length, `Expected ordered phases ${expected.join(" → ")}; received ${phases.join(" → ")}`);
}

class MemoryPersistence implements GoalPersistenceRepository {
  goals = new Map<string, GoalDefinition>();
  versions = new Map<string, GoalVersion[]>();
  questions = new Map<string, GoalQuestion[]>();
  answers = new Map<string, GoalAnswer[]>();
  runs = new Map<string, GoalDrivenRunRecord | GoalRunState>();
  events: GoalWorkflowEvent[] = [];
  reviews = new Map<string, ReviewResult[]>();
  requests = new Map<string, EvidenceRequest[]>();
  evidence = new Map<string, EvidenceItem[]>();
  reports = new Map<string, GoalReport>();
  artifacts = new Map<string, { runId: string; content: string; contentType: string; createdAt: string }>();
  async status() { return { available: true, schemaVersion: 1 }; }
  async saveGoal(goal: GoalDefinition) { this.goals.set(goal.id, structuredClone(goal)); }
  async saveGoalVersion(version: GoalVersion) { this.versions.set(version.goalId, [...(this.versions.get(version.goalId) ?? []).filter((item) => item.version !== version.version), structuredClone(version)].sort((a, b) => a.version - b.version)); }
  async replaceQuestions(goalId: string, goalVersion: number, questions: GoalQuestion[]) { this.questions.set(`${goalId}:${goalVersion}`, structuredClone(questions)); }
  async saveAnswer(goalId: string, answer: GoalAnswer) { this.answers.set(goalId, [...(this.answers.get(goalId) ?? []), structuredClone(answer)]); }
  async saveRun(run: GoalDrivenRunRecord) { this.runs.set(run.id, structuredClone(run)); }
  async appendEvent(event: GoalWorkflowEvent) { this.events.push(structuredClone(event)); return this.events.length; }
  async saveReview(runId: string, review: ReviewResult) { this.reviews.set(runId, [...(this.reviews.get(runId) ?? []).filter((item) => item.id !== review.id), structuredClone(review)]); }
  async saveEvidenceRequest(runId: string, request: EvidenceRequest) { this.requests.set(runId, [...(this.requests.get(runId) ?? []).filter((item) => item.id !== request.id), structuredClone(request)]); }
  async saveEvidence(runId: string, evidence: EvidenceItem) { this.evidence.set(runId, [...(this.evidence.get(runId) ?? []).filter((item) => item.id !== evidence.id), structuredClone(evidence)]); }
  async saveReport(report: GoalReport) { this.reports.set(report.runId, structuredClone(report)); }
  async deleteRun(runId: string) { this.runs.delete(runId); }
  async deleteGoal(goalId: string) { this.goals.delete(goalId); }
  async importLegacyRun(run: GoalRunState, events: GoalRunEvent[]) { this.runs.set(run.id, structuredClone(run)); void events; }
  async getGoal(id: string) { return structuredClone(this.goals.get(id) ?? null); }
  async restoreRun(runId: string): Promise<GoalRunSnapshot | null> {
    const run = this.runs.get(runId);
    if (!run) return null;
    const goalId = "goalId" in run ? run.goalId : undefined;
    const reviews = this.reviews.get(runId) ?? [];
    return structuredClone({
      run, goal: goalId ? this.goals.get(goalId) ?? null : null, versions: goalId ? this.versions.get(goalId) ?? [] : [],
      questions: goalId ? [...this.questions].filter(([key]) => key.startsWith(`${goalId}:`)).flatMap(([, value]) => value) : [],
      answers: goalId ? this.answers.get(goalId) ?? [] : [], events: this.events.filter((event) => event.runId === runId),
      reviews, findings: reviews.flatMap((review) => review.findings), evidenceRequests: this.requests.get(runId) ?? [], evidence: this.evidence.get(runId) ?? [], report: this.reports.get(runId) ?? null,
    });
  }
  async listRuns(phases?: string[]) { return [...this.runs.values()].filter((run) => !phases || !("workflowPhase" in run) || phases.includes(run.workflowPhase)); }
  async writeArtifact(runId: string, content: string, contentType = "text/plain") { const id = `artifact-${this.artifacts.size + 1}`; this.artifacts.set(id, { runId, content, contentType, createdAt: at }); return { id, runId, relativePath: id, sha256: "fixture", size: content.length, contentType, createdAt: at }; }
  async readArtifact(artifactId: string) { const artifact = this.artifacts.get(artifactId); if (!artifact) throw new Error("Missing fixture artifact"); return { metadata: { id: artifactId, runId: artifact.runId, relativePath: artifactId, sha256: "fixture", size: artifact.content.length, contentType: artifact.contentType, createdAt: artifact.createdAt }, content: artifact.content }; }
  async cleanupArtifacts() { return 0; }
}
