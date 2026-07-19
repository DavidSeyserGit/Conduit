import assert from "node:assert/strict";
import { test } from "node:test";
import { legacyEvidenceToCgs, legacyGoalToCgs, cgsGoalToLegacyRuntimeInput, legacyReportToCgs, legacyReviewToCgs } from "./legacy-cgs-migration.ts";
import { ReportBuilder } from "./report-builder.ts";

test("legacy goal migration preserves request, text, criteria, status, and revision without inventing evidence", () => {
  const migrated = legacyGoalToCgs({ schemaVersion: 1, id: "goal_1", originalRequest: "Fix it", title: "Fix bug", description: "Fix the broken flow", successCriteria: [{ id: "c1", description: "Flow works", required: true }], constraints: [], deliverables: [{ id: "d1", type: "implementation", description: "Fix", required: true }], assumptions: [], answers: [], status: "approved", version: 3, createdAt: "2026-07-19T10:00:00Z", updatedAt: "2026-07-19T10:01:00Z" });
  assert.equal(migrated.originalRequest, "Fix it");
  assert.equal(migrated.revision, 3);
  assert.equal(migrated.metadata?.migratedFrom, "conduit-legacy-goal");
  assert.equal("evidence" in migrated, false);
  assert.equal(cgsGoalToLegacyRuntimeInput(migrated).version, 3);
});

test("legacy reviewer and evidence records cross a validated CGS request/result boundary", () => {
  const goal = { schemaVersion: 1 as const, id: "goal_1", originalRequest: "Fix it", title: "Fix bug", description: "Fix the broken flow", successCriteria: [{ id: "c1", description: "Flow works", required: true }], constraints: [], deliverables: [{ id: "d1", type: "implementation" as const, description: "Fix", required: true }], assumptions: [], answers: [], status: "approved" as const, version: 1, createdAt: "2026-07-19T10:00:00Z", updatedAt: "2026-07-19T10:01:00Z" };
  const converted = legacyReviewToCgs("run_1", goal, { id: "review_1", reviewerId: "testing", status: "needs_evidence", confidence: 0.8, summary: "Need tests", findings: [], evidenceRequests: [{ id: "request_1", reviewerId: "testing", type: "test", description: "Run tests", required: true, suggestedCommand: "pnpm test", status: "pending", evidenceIds: [], requestedAt: "2026-07-19T10:02:00Z" }], reviewedAt: "2026-07-19T10:02:00Z" });
  assert.equal(converted.request.kind, "review-request");
  assert.equal(converted.result.status, "insufficient_evidence");
  const evidence = legacyEvidenceToCgs("run_1", goal.id, { id: "evidence_1", type: "test", title: "Tests", summary: "Passed", command: "pnpm test", exitCode: 0, collectedBy: "runtime", collectedAt: "2026-07-19T10:03:00Z", trusted: true, freshness: { status: "fresh" } }, "request_1");
  assert.equal(evidence.type, "test_result");
});

test("parity reports convert to the canonical CGS report without export-specific markup", () => {
  const legacy = new ReportBuilder().build({ run: { id: "run_1", goal: "Fix it", workspacePath: "/repo", status: "completed", codingModelId: "worker", judgeModelId: "reviewer", iteration: 0, maxIterations: 1, iterations: [], startedAt: "2026-07-19T10:00:00Z", finishedAt: "2026-07-19T10:01:00Z" }, goal: { schemaVersion: 1, id: "goal_1", originalRequest: "Fix it", title: "Fix bug", description: "Fix the broken flow", successCriteria: [{ id: "c1", description: "Flow works", required: true }], constraints: [], deliverables: [{ id: "d1", type: "implementation", description: "Fix", required: true }], assumptions: [], answers: [], status: "approved", version: 1, createdAt: "2026-07-19T10:00:00Z", updatedAt: "2026-07-19T10:01:00Z" } });
  const cgs = legacyReportToCgs(legacy);
  assert.equal(cgs.kind, "report");
  assert.equal(cgs.goalSnapshot.id, "goal_1");
  assert.equal("markdown" in cgs, false);
});
