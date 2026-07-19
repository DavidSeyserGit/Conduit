import assert from "node:assert/strict";
import { test } from "node:test";
import {
  GoalReportExportSchema,
  GoalReportSchema,
  type EvidenceItem,
  type GoalDefinition,
  type ReviewResult,
} from "@conduit/cgs/legacy";
import type { GoalRunState } from "@conduit/shared";
import { createInitialGoalState, createIteration } from "./state.ts";
import { ReportBuilder, reportToJSON, reportToMarkdown } from "./report-builder.ts";

const startedAt = "2026-07-18T10:00:00.000Z";
const finishedAt = "2026-07-18T10:01:00.000Z";
const goal: GoalDefinition = {
  schemaVersion: 1,
  id: "goal-1",
  originalRequest: "Add a safer login",
  title: "Add safer login",
  description: "Add the requested login behavior.",
  successCriteria: [
    { id: "login", description: "Users can sign in", required: true },
    { id: "regression", description: "Existing sign-in still works", required: true },
  ],
  constraints: [{ id: "constraint", description: "Keep existing providers", source: "user" }],
  deliverables: [{ id: "implementation", type: "implementation", description: "Login implementation", required: true }],
  assumptions: [{ id: "assumption", description: "OAuth remains enabled", confirmed: true }],
  answers: [{ questionId: "linking", value: "confirm", answeredBy: "user", answeredAt: startedAt }],
  status: "approved",
  version: 2,
  createdAt: startedAt,
  updatedAt: startedAt,
};

function run(status: GoalRunState["status"] = "completed"): GoalRunState {
  const state = createInitialGoalState({
    goal: goal.originalRequest,
    structuredGoal: goal,
    approvedGoalVersion: 2,
    workspacePath: "/repo",
    codingModelId: "coding/model",
    judgeModelId: "judge/model",
    maxIterations: 2,
  });
  const iteration = createIteration(1);
  iteration.agentMessages.push({ id: "message-1", role: "assistant", content: "Implemented login without exposing password=super-secret", timestamp: finishedAt });
  iteration.fileChanges = [
    { path: "src/new.ts", status: "added" },
    { path: "src/changed.ts", status: "modified" },
    { path: "src/old.ts", status: "deleted" },
  ];
  iteration.changedFiles = iteration.fileChanges.map((change) => change.path);
  iteration.validationResults = [{ command: "pnpm test", exitCode: 0, stdout: "28 passed", stderr: "", passed: true }];
  iteration.generalReview = review("general", "approved");
  iteration.reviewRouting = {
    goalStatus: "implemented",
    confidence: 0.95,
    requiredReviewers: ["testing"],
    optionalReviewers: [],
    decisionSummary: "Implemented",
    evidenceIds: ["evidence-1"],
    decidedAt: finishedAt,
  };
  iteration.specialistReviews = [review("testing", "approved")];
  iteration.evidence = [evidence("evidence-1", "fresh")];
  return {
    ...state,
    status,
    iteration: 1,
    iterations: [iteration],
    startedAt,
    finishedAt,
    tokenUsage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    estimatedCost: 0.01,
  };
}

test("ReportBuilder deterministically links persisted goal, changes, validation, reviews, and evidence", () => {
  const report = new ReportBuilder().build({
    run: run(),
    goal,
    questions: [{
      id: "linking",
      type: "single_select",
      title: "How should linking work?",
      required: true,
      options: [{ id: "confirm", label: "Require confirmation" }, { id: "automatic", label: "Link automatically" }],
    }],
    versions: [{ goalId: goal.id, version: 2, definition: goal, changeSummary: "Answer recorded", createdAt: startedAt, createdBy: "user" }],
  });

  assert.equal(report.overview.finalStatus, "achieved");
  assert.equal(report.overview.runtimeMs, 60_000);
  assert.equal(report.overview.tokenUsage?.totalTokens, 15);
  assert.deepEqual(report.implementation.filesAdded, ["src/new.ts"]);
  assert.deepEqual(report.implementation.filesChanged, ["src/changed.ts"]);
  assert.deepEqual(report.implementation.filesDeleted, ["src/old.ts"]);
  assert.deepEqual(report.implementation.commands, ["pnpm test"]);
  assert.match(report.implementation.decisions.join(" "), /Goal v2: Answer recorded/);
  assert.equal(report.clarifications[0]?.resultingGoalVersion, 2);
  assert.deepEqual(report.criteria.map((criterion) => criterion.status), ["passed", "passed"]);
  assert.deepEqual(report.criteria[0]?.evidenceIds, ["evidence-1"]);
  assert.equal(report.finalDecision.achieved, true);
  assert.equal(report.finalDecision.requiredReviewsPassed, true);
  assert.doesNotMatch(report.implementation.summary, /super-secret/);
  GoalReportSchema.parse(report);
});

test("ReportBuilder preserves review rounds, warnings, stale evidence, and blocking requests", () => {
  const state = run("failed");
  const first = review("testing", "needs_evidence");
  const request = {
    id: "coverage-request", reviewerId: "testing", type: "coverage" as const, description: "Collect coverage", required: true,
    status: "failed" as const, evidenceIds: [], requestedAt: startedAt, resolvedAt: finishedAt,
  };
  first.evidenceRequests = [request];
  const second = review("testing", "approved_with_warnings", [{
    id: "weak-edge", severity: "low" as const, title: "One edge case remains", description: "An optional edge case is not covered.",
  }]);
  second.supersedesReviewId = first.id;
  state.iterations[0]!.specialistReviews = [second];
  state.iterations[0]!.evidence = [evidence("stale-evidence", "stale")];

  const report = new ReportBuilder().build({ run: state, goal, reviews: [first, second], evidenceRequests: [request] });

  assert.equal(report.reviews.length, 3);
  assert.equal(report.overview.finalStatus, "failed");
  assert.deepEqual(report.finalDecision.unresolvedEvidenceRequestIds, ["coverage-request"]);
  assert.match(report.finalDecision.warnings.join(" "), /edge case|stale/i);
  assert.equal(report.finalDecision.achieved, false);
});

test("ReportBuilder creates schema-valid partial reports for every terminal status", () => {
  const cases: Array<[GoalRunState["status"], string]> = [
    ["completed", "achieved"],
    ["failed", "failed"],
    ["cancelled", "cancelled"],
    ["iteration_limit_reached", "blocked"],
  ];
  for (const [status, expected] of cases) {
    const state = run(status);
    if (status !== "completed") {
      state.iterations[0]!.generalReview = undefined;
      state.iterations[0]!.specialistReviews = [];
    }
    const report = new ReportBuilder().build({ run: state, goal, error: status === "failed" ? "Provider stopped" : undefined });
    assert.equal(report.overview.finalStatus, expected);
    GoalReportSchema.parse(report);
  }
});

test("Markdown and JSON exports are bounded, redacted, versioned, and valid", () => {
  const state = run();
  state.iterations[0]!.agentMessages[0]!.content = `AWS_SECRET_ACCESS_KEY=abc123 ${"x".repeat(10_000)}`;
  const report = new ReportBuilder().build({ run: state, goal });
  const markdown = reportToMarkdown(report);
  const json = reportToJSON(report, finishedAt);

  assert.match(markdown, /schema v1/);
  assert.match(markdown, /Tokens: 15 total/);
  assert.match(markdown, /\[REDACTED\]/);
  assert.doesNotMatch(markdown, /abc123/);
  assert.ok(markdown.length < 50_000);
  assert.equal(json.metadata.redacted, true);
  assert.equal(json.metadata.exportedAt, finishedAt);
  GoalReportExportSchema.parse(json);
});

function review(reviewerId: string, status: ReviewResult["status"], findings: ReviewResult["findings"] = []): ReviewResult {
  return {
    id: `${reviewerId}-${status}-${crypto.randomUUID()}`,
    reviewerId,
    status,
    confidence: 0.9,
    summary: `${reviewerId} concluded ${status}`,
    findings,
    evidenceRequests: [],
    reviewedAt: finishedAt,
  };
}

function evidence(id: string, freshness: "fresh" | "stale"): EvidenceItem {
  return {
    id,
    type: "test",
    title: "Test evidence",
    summary: "Tests passed",
    command: "pnpm test",
    exitCode: 0,
    collectedBy: "runtime",
    collectedAt: finishedAt,
    trusted: true,
    freshness: freshness === "fresh"
      ? { status: "fresh", scopeFingerprint: id }
      : { status: "stale", scopeFingerprint: id, staleReason: "Source changed", invalidatedAt: finishedAt },
  };
}
