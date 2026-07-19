import assert from "node:assert/strict";
import test from "node:test";
import type { ClarificationRecord, GoalReport, ReviewResult } from "@conduit/shared";
import { formatClarificationAnswer, formatDuration, groupReportReviews, implementationPreview, reportStats } from "./report-view-model.ts";

const at = "2026-07-19T08:00:00.000Z";

test("clarification answers use option labels instead of internal IDs", () => {
  const record = {
    question: {
      id: "scope", type: "single_select", title: "Scope", required: true,
      options: [{ id: "mapping_integration", label: "Mapping integration" }],
    },
    answer: { questionId: "scope", value: "mapping_integration", answeredBy: "user", answeredAt: at },
    resultingGoalVersion: 2,
  } satisfies ClarificationRecord;
  assert.equal(formatClarificationAnswer(record), "Mapping integration");
  assert.equal(formatDuration(19_077_000), "5h 17m");
});

test("review groups expose the latest result and keep older rounds as history", () => {
  const reviews = [review("general", "needs_evidence", 1), review("testing", "not_applicable", 1), review("general", "approved", 2)];
  const groups = groupReportReviews(reviews);
  assert.equal(groups[0]?.reviewerId, "general");
  assert.equal(groups[0]?.latest.status, "approved");
  assert.equal(groups[0]?.history[0]?.status, "needs_evidence");
  assert.equal(groups.at(-1)?.reviewerId, "testing");
});

test("summary stats count current reviewer state and outstanding attention", () => {
  const report = {
    criteria: [{ status: "passed" }, { status: "warning" }],
    evidence: [{ freshness: { status: "fresh" } }, { freshness: { status: "stale" } }],
    reviews: [review("general", "approved", 1), review("testing", "approved_with_warnings", 1)],
    finalDecision: { warnings: ["warning"], unresolvedFindingIds: ["finding"], unresolvedEvidenceRequestIds: [], followUps: ["follow up"] },
  } as unknown as GoalReport;
  assert.deepEqual(reportStats(report), {
    reviewGroups: groupReportReviews(report.reviews),
    passedCriteria: 1,
    freshEvidence: 1,
    approvedReviews: 2,
    attentionCount: 3,
  });
  assert.equal(implementationPreview(`**Built** ${"detail ".repeat(100)}`).endsWith("…"), true);
});

function review(reviewerId: string, status: ReviewResult["status"], minute: number): ReviewResult {
  return {
    id: `${reviewerId}-${minute}`,
    reviewerId,
    status,
    confidence: 0.9,
    summary: `${reviewerId} ${status}`,
    findings: [],
    evidenceRequests: [],
    reviewedAt: `2026-07-19T08:${String(minute).padStart(2, "0")}:00.000Z`,
  };
}
