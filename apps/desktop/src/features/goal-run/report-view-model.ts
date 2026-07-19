import type { ClarificationRecord, GoalReport, ReviewResult } from "@conduit/cgs/legacy";

export type ReportViewId = "summary" | "goal" | "changes" | "evidence" | "reviews";

export interface ReviewGroup {
  reviewerId: string;
  latest: ReviewResult;
  history: ReviewResult[];
}

export function humanize(value: string): string {
  return value
    .replaceAll("_", " ")
    .split(" ")
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

export function formatDuration(runtimeMs: number): string {
  const totalSeconds = Math.max(0, Math.round(runtimeMs / 1_000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return [hours ? `${hours}h` : "", minutes ? `${minutes}m` : "", seconds && !hours ? `${seconds}s` : ""]
    .filter(Boolean)
    .join(" ");
}

export function formatClarificationAnswer(record: ClarificationRecord): string {
  const value = record.answer.value;
  const options = "options" in record.question ? record.question.options ?? [] : [];
  const optionLabel = (candidate: unknown) => {
    const match = typeof candidate === "string" ? options.find((option) => option.id === candidate) : undefined;
    return match?.label ?? String(candidate);
  };
  if (Array.isArray(value)) return value.map(optionLabel).join(", ");
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "string" || typeof value === "number") return optionLabel(value);
  return JSON.stringify(value);
}

export function groupReportReviews(reviews: ReviewResult[]): ReviewGroup[] {
  const groups = new Map<string, Array<{ review: ReviewResult; index: number }>>();
  reviews.forEach((review, index) => groups.set(review.reviewerId, [...(groups.get(review.reviewerId) ?? []), { review, index }]));
  return [...groups.entries()]
    .map(([reviewerId, entries]) => {
      const ordered = [...entries].sort((left, right) => {
        const time = Date.parse(left.review.reviewedAt) - Date.parse(right.review.reviewedAt);
        return time || left.index - right.index;
      });
      return { reviewerId, latest: ordered.at(-1)!.review, history: ordered.slice(0, -1).map((entry) => entry.review).reverse() };
    })
    .sort((left, right) => {
      if (left.reviewerId === "general") return -1;
      if (right.reviewerId === "general") return 1;
      const leftNotApplicable = left.latest.status === "not_applicable";
      const rightNotApplicable = right.latest.status === "not_applicable";
      if (leftNotApplicable !== rightNotApplicable) return leftNotApplicable ? 1 : -1;
      return left.reviewerId.localeCompare(right.reviewerId);
    });
}

export function reportStats(report: GoalReport) {
  const reviewGroups = groupReportReviews(report.reviews);
  const passedCriteria = report.criteria.filter((criterion) => criterion.status === "passed").length;
  const freshEvidence = report.evidence.filter((item) => item.freshness.status === "fresh").length;
  const approvedReviews = reviewGroups.filter((group) => ["approved", "approved_with_warnings", "not_applicable"].includes(group.latest.status)).length;
  const attentionCount = report.finalDecision.warnings.length
    + report.finalDecision.unresolvedFindingIds.length
    + report.finalDecision.unresolvedEvidenceRequestIds.length
    + report.finalDecision.followUps.length;
  return {
    reviewGroups,
    passedCriteria,
    freshEvidence,
    approvedReviews,
    attentionCount,
  };
}

export function implementationPreview(summary: string, limit = 360): string {
  const normalized = summary
    .replaceAll("**", "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit).replace(/\s+\S*$/, "")}…`;
}
