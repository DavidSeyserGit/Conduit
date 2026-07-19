import assert from "node:assert/strict";
import { test } from "node:test";
import { CGS_VERSION, type GoalReport } from "@conduit/cgs";
import { DefaultConduitRuntime, type RuntimeDependencies } from "./runtime.ts";

const now = "2026-07-19T10:00:00Z";
const dependencies: RuntimeDependencies = {
  now: () => new Date(now), id: (prefix) => `${prefix}_1`,
  async analyzeGoal(goal) { return { goal: { ...goal, status: "awaiting_clarification", updatedAt: now }, questionBatches: [{ cgsVersion: CGS_VERSION, kind: "question-batch", id: "batch_1", createdAt: now, goalId: goal.id, sequence: 1, reason: "goal_clarification", questions: [{ id: "q_1", goalId: goal.id, prompt: "Include tests?", required: true, type: "confirmation" }] }] }; },
  async applyAnswers(goal, _batch, answers) { return { ...goal, revision: 2, status: "awaiting_approval", updatedAt: now, clarificationHistory: [{ questionBatchId: answers.questionBatchId, answerBatchId: answers.id, required: true }], successCriteria: [{ id: "criterion_1", description: "The requested behavior is tested", priority: "required" }], deliverables: [{ id: "deliverable_1", description: "Implementation and tests", type: "code", required: true }] }; },
  async execute(goal, run): Promise<GoalReport> { return { cgsVersion: CGS_VERSION, kind: "report", id: "report_1", createdAt: now, runId: run.id, goalId: goal.id, goalRevision: goal.revision, decision: "completed", summary: "Goal completed.", goalSnapshot: goal, clarificationSummary: { decisions: ["Tests required"], questionBatchIds: ["batch_1"], answerBatchIds: ["answers_1"] }, implementationSummary: { summary: "Implemented.", filesAdded: [], filesChanged: ["src/feature.ts"], filesDeleted: [], attempts: 1 }, validationSummary: { passed: true, summary: "Tests passed.", evidenceArtifactIds: [] }, reviewerSummaries: [], evidenceSummary: { summary: "No additional evidence.", artifactIds: [], staleArtifactIds: [] }, knownRisks: [], suggestedFollowUps: [], generatedAt: now }; },
};

test("headless CGS workflow clarifies, approves, executes, and reports without Desktop", async () => {
  const runtime = new DefaultConduitRuntime(dependencies);
  const draft = await runtime.createGoal({ request: "Add the requested feature" });
  const analyzed = await runtime.analyzeGoal(draft, { workspacePath: "/repo", summary: "Fixture", languages: ["TypeScript"], frameworks: [], testFrameworks: [], instructions: [], relevantFiles: [], preparedAt: now });
  const revised = await runtime.applyAnswers(analyzed.goal, { cgsVersion: CGS_VERSION, kind: "answer-batch", id: "answers_1", createdAt: now, goalId: draft.id, questionBatchId: "batch_1", answers: [{ questionId: "q_1", value: true, answeredAt: now, answeredBy: "user" }] });
  const approved = await runtime.approveGoal(revised);
  const handle = await runtime.startRun(approved, { conduitDesktopVersion: "0.4.0-rc.1" });
  const events: string[] = [];
  handle.subscribe((event) => events.push(event.type));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal((await handle.getSnapshot()).status, "completed");
  assert.equal(events.includes("report.generated"), true);
});
