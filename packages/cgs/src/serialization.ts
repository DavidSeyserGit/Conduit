import { CgsArtifactUnionSchema, type GoalReport } from "./artifacts.js";

export function serializeCgsArtifact(input: unknown): string {
  return JSON.stringify(CgsArtifactUnionSchema.parse(input), null, 2);
}

export function deserializeCgsArtifact(input: string): ReturnType<typeof CgsArtifactUnionSchema.parse> {
  let parsed: unknown;
  try { parsed = JSON.parse(input); } catch { throw new Error("CGS artifact is not valid JSON"); }
  return CgsArtifactUnionSchema.parse(parsed);
}

export const renderReportJson = (report: GoalReport): string => JSON.stringify(report, null, 2);
export function renderReportMarkdown(report: GoalReport): string {
  return [
    `# ${report.goalSnapshot.title}`, "", report.summary, "", `Decision: ${report.decision}`, `Goal revision: ${report.goalRevision}`,
    "", "## Implementation", "", report.implementationSummary.summary,
    "", "## Validation", "", report.validationSummary.summary,
    "", "## Reviews", "", ...report.reviewerSummaries.map((review) => `- ${review.reviewerId}: ${review.status} — ${review.summary}`),
    "", "## Evidence", "", report.evidenceSummary.summary,
  ].join("\n");
}
