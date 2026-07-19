import assert from "node:assert/strict";
import { test } from "node:test";
import { CGS_VERSION, parseGoalSpecification, type ReviewerRequirement } from "@conduit/cgs";
import { CgsReviewerRegistry, type Reviewer } from "./reviewer.ts";

const at = "2026-07-19T10:00:00Z";
const requirement: ReviewerRequirement = { reviewerId: "conduit.testing", required: true };
const goal = parseGoalSpecification({ cgsVersion: CGS_VERSION, kind: "goal", id: "goal_1", createdAt: at, title: "Test", description: "Test it", successCriteria: [{ id: "criterion_1", description: "It works", priority: "required" }], constraints: [], deliverables: [], assumptions: [], permissions: { allowFileReads: true, allowFileWrites: false, allowCommandExecution: false, allowNetworkAccess: false, allowDependencyChanges: false, allowGitOperations: false }, clarificationHistory: [], reviewPipeline: { generalReviewer: { reviewerId: "conduit.general", required: true }, specialistReviewers: [requirement], routingMode: "explicit", completionPolicy: "all_required_approve" }, status: "approved", revision: 1 });

test("one CGS reviewer contract validates built-in results against request and goal", async () => {
  const reviewer: Reviewer = { id: requirement.reviewerId, version: "0.4.0-rc.1", async review(request) { return { cgsVersion: CGS_VERSION, kind: "review-result", id: "result_1", createdAt: at, runId: request.runId, goalId: request.goalId, reviewerId: request.reviewerId, reviewRequestId: request.id, status: "approved", summary: "Covered.", criterionResults: [{ criterionId: "criterion_1", status: "passed", explanation: "Test evidence covers it." }], findings: [], evidenceRequests: [], reviewedAt: at }; } };
  const registry = new CgsReviewerRegistry().register(reviewer);
  const result = await registry.review({ cgsVersion: CGS_VERSION, kind: "review-request", id: "request_1", createdAt: at, runId: "run_1", goalId: goal.id, reviewerId: reviewer.id, goalRevision: 1, changedFiles: [], availableEvidence: [], requestedAt: at }, { goal, availableEvidence: [] });
  assert.equal(result.status, "approved");
});
