import type {
  ClarificationRecord,
  EvidenceItem,
  EvidenceRequest,
  GoalDefinition,
  GoalQuestion,
  GoalReport,
  GoalReportExport,
  GoalVersion,
  NormalizedValidationResult,
  ReviewResult,
} from "@conduit/cgs/legacy";
import { GoalReportExportSchema, GoalReportSchema } from "@conduit/cgs/legacy";
import type { GoalRunState } from "@conduit/shared";

const MAX_TEXT = 8_000;
const MAX_ITEMS = 500;
const REDACTED = "[REDACTED]";

export interface ReportBuilderInput {
  run: GoalRunState;
  goal?: GoalDefinition | null;
  questions?: GoalQuestion[];
  versions?: GoalVersion[];
  reviews?: ReviewResult[];
  evidenceRequests?: EvidenceRequest[];
  evidence?: EvidenceItem[];
  error?: string;
  generatedAt?: string;
}

export class ReportBuilder {
  build(input: ReportBuilderInput): GoalReport {
    const goal = input.goal ?? legacyGoal(input.run);
    const generatedAt = input.generatedAt ?? input.run.finishedAt ?? new Date().toISOString();
    const reviews = uniqueById([
      ...(input.reviews ?? []),
      ...input.run.iterations.flatMap((iteration) => [
        ...(iteration.generalReview ? [iteration.generalReview] : []),
        ...(iteration.specialistReviews ?? []),
      ]),
    ]).sort((a, b) => a.reviewedAt.localeCompare(b.reviewedAt));
    const evidence = uniqueById([
      ...(input.evidence ?? []),
      ...input.run.iterations.flatMap((iteration) => iteration.evidence ?? []),
    ]);
    const requests = uniqueById([
      ...reviews.flatMap((review) => review.evidenceRequests),
      ...input.run.iterations.flatMap((iteration) => iteration.evidenceRequests ?? []),
      ...(input.evidenceRequests ?? []),
    ]);
    const latestReviews = latestByReviewer(reviews);
    const general = latestReviews.get("general");
    const freshEvidenceIds = new Set(evidence.filter((item) => item.freshness.status === "fresh").map((item) => item.id));
    const staleEvidenceIds = new Set(evidence.filter((item) => item.freshness.status === "stale").map((item) => item.id));
    const generalEvidenceIds = unique([
      ...(input.run.iterations.at(-1)?.reviewRouting?.evidenceIds ?? []),
      ...(general?.evidenceRequests.flatMap((request) => request.evidenceIds) ?? []),
    ]).filter((id) => freshEvidenceIds.has(id));
    const unresolvedRequests = requests.filter((request) => request.required && request.status !== "collected");
    const currentFindings = [...latestReviews.values()].flatMap((review) => review.findings);
    const unresolvedFindings = currentFindings.filter((finding) => ["medium", "high", "critical"].includes(finding.severity));
    const terminal = finalStatus(input.run.status);
    const requiredReviewerIds = input.run.iterations.at(-1)?.reviewRouting?.requiredReviewers ?? [];
    const requiredReviewsPassed = requiredReviewerIds.every((id) => approved(latestReviews.get(id)?.status));
    const achieved = terminal === "achieved"
      && approved(general?.status)
      && requiredReviewsPassed
      && unresolvedRequests.length === 0
      && !unresolvedFindings.some((finding) => finding.severity === "critical");
    const files = collectFiles(input.run);
    const validationResults = normalizeValidation(input.run);

    const report = GoalReportSchema.parse({
      schemaVersion: 1,
      id: `report-${input.run.id}`,
      runId: input.run.id,
      goal,
      overview: {
        finalStatus: terminal,
        conduitDesktopVersion: input.run.conduitDesktopVersion,
        conduitRuntimeVersion: input.run.conduitRuntimeVersion,
        cgsVersion: input.run.cgsVersion,
        startedAt: input.run.startedAt,
        finishedAt: input.run.finishedAt ?? generatedAt,
        implementationModelId: input.run.codingModelId,
        reviewerModelIds: [input.run.judgeModelId],
        totalIterations: input.run.iteration,
        runtimeMs: Math.max(0, Date.parse(input.run.finishedAt ?? generatedAt) - Date.parse(input.run.startedAt)),
        ...(input.run.estimatedCost !== undefined ? { estimatedCost: input.run.estimatedCost } : {}),
        ...(input.run.tokenUsage ? { tokenUsage: input.run.tokenUsage } : {}),
      },
      clarifications: clarificationHistory(goal, input.questions ?? [], input.versions ?? []),
      implementation: {
        summary: implementationSummary(input.run, input.error),
        filesAdded: files.added,
        filesChanged: files.changed,
        filesDeleted: files.deleted,
        decisions: unique([
          ...goal.answers.map((answer) => `${answer.questionId}: ${formatValue(answer.value)}`),
          ...(input.versions ?? []).map((version) => `Goal v${version.version}: ${version.changeSummary}`),
        ]),
        commands: unique([
          ...input.run.iterations.flatMap((iteration) => iteration.toolCalls
            .filter((call) => call.name === "run_command" && typeof call.arguments.command === "string")
            .map((call) => call.arguments.command as string)),
          ...validationResults.map((result) => result.command),
          ...evidence.flatMap((item) => item.command ? [item.command] : []),
        ]),
      },
      criteria: goal.successCriteria.map((criterion) => {
        const findings = currentFindings.filter((finding) => finding.criterionId === criterion.id);
        const evidenceIds = goal.successCriteria.length === 1
          ? unique([...generalEvidenceIds, ...evidence.filter((item) => item.freshness.status === "fresh").map((item) => item.id)])
          : generalEvidenceIds;
        const limitations: string[] = [];
        if (evidenceIds.length === 0) limitations.push("No recorded evidence is linked directly to this criterion.");
        if (staleEvidenceIds.size > 0) limitations.push(`${staleEvidenceIds.size} evidence item${staleEvidenceIds.size === 1 ? " is" : "s are"} stale and excluded.`);
        const severe = findings.some((finding) => ["high", "critical"].includes(finding.severity));
        const medium = findings.some((finding) => finding.severity === "medium");
        const status = severe || general?.status === "changes_requested"
          ? "failed"
          : general?.status === "blocked" || general?.status === "needs_evidence" || unresolvedRequests.length > 0
            ? "blocked"
            : medium || (approved(general?.status) && evidenceIds.length === 0)
              ? "warning"
              : approved(general?.status)
                ? "passed"
                : "not_verified";
        return {
          criterionId: criterion.id,
          status,
          summary: general?.summary ?? "No general-review conclusion was recorded.",
          evidenceIds,
          reviewFindingIds: findings.map((finding) => finding.id),
          limitations,
        };
      }),
      validationResults,
      reviews,
      evidence,
      finalDecision: {
        achieved,
        summary: finalDecisionSummary(terminal, achieved, general, input.error),
        requiredReviewsPassed,
        unresolvedFindingIds: unresolvedFindings.map((finding) => finding.id),
        unresolvedEvidenceRequestIds: unresolvedRequests.map((request) => request.id),
        warnings: unique([
          ...currentFindings.filter((finding) => ["info", "low"].includes(finding.severity)).map((finding) => finding.title),
          ...[...latestReviews.values()].filter((review) => review.status === "approved_with_warnings").map((review) => review.summary),
          ...evidence.filter((item) => item.freshness.status === "stale").map((item) => `${item.title}: ${item.freshness.staleReason}`),
        ]),
        followUps: unique([
          ...unresolvedFindings.map((finding) => finding.remediation ?? finding.description),
          ...unresolvedRequests.map((request) => request.description),
        ]),
      },
      generatedAt,
    });
    return redactReport(report);
  }
}

export function reportToMarkdown(report: GoalReport): string {
  const safe = exportSafeReport(GoalReportSchema.parse(report));
  const lines = [
    "---",
    `conduitReport: ${safe.id}`,
    `schemaVersion: ${safe.schemaVersion}`,
    "format: markdown",
    `exportedAt: ${safe.generatedAt}`,
    "redacted: true",
    "---",
    "",
    `# ${safe.goal.title}`,
    "",
    `> Conduit report schema v${safe.schemaVersion} · ${safe.overview.finalStatus.replaceAll("_", " ")}`,
    "",
    "## Overview",
    "",
    `- Run: \`${safe.runId}\``,
    `- Started: ${safe.overview.startedAt}`,
    `- Finished: ${safe.overview.finishedAt}`,
    `- Runtime: ${safe.overview.runtimeMs} ms`,
    `- Implementation model: \`${safe.overview.implementationModelId}\``,
    `- Reviewer models: ${safe.overview.reviewerModelIds.map((id) => `\`${id}\``).join(", ") || "None"}`,
    `- Iterations: ${safe.overview.totalIterations}`,
    ...(safe.overview.tokenUsage ? [`- Tokens: ${safe.overview.tokenUsage.totalTokens} total (${safe.overview.tokenUsage.promptTokens} prompt, ${safe.overview.tokenUsage.completionTokens} completion)`] : []),
    ...(safe.overview.estimatedCost !== undefined ? [`- Estimated cost: $${safe.overview.estimatedCost.toFixed(6)}`] : []),
    "",
    "## Goal Definition",
    "",
    safe.goal.description,
    "",
    `Original request: ${safe.goal.originalRequest}`,
    "",
    ...list("Success criteria", safe.goal.successCriteria.map((item) => item.description)),
    ...list("Constraints", safe.goal.constraints.map((item) => item.description)),
    ...list("Deliverables", safe.goal.deliverables.map((item) => item.description)),
    ...list("Assumptions", safe.goal.assumptions.map((item) => `${item.description}${item.confirmed ? " (confirmed)" : ""}`)),
    "## Clarification History",
    "",
    ...(safe.clarifications.length ? safe.clarifications.flatMap((item) => [
      `- **${item.question.title}:** ${formatValue(item.answer.value)} (${item.answer.answeredBy}, goal v${item.resultingGoalVersion})`,
    ]) : ["No clarification questions were recorded."]),
    "",
    "## Implementation Summary",
    "",
    safe.implementation.summary,
    "",
    ...list("Files added", safe.implementation.filesAdded),
    ...list("Files changed", safe.implementation.filesChanged),
    ...list("Files deleted", safe.implementation.filesDeleted),
    ...list("Recorded decisions", safe.implementation.decisions),
    ...list("Commands", safe.implementation.commands.map((command) => `\`${command}\``)),
    "## Success Criteria",
    "",
    ...safe.criteria.flatMap((criterion) => {
      const definition = safe.goal.successCriteria.find((item) => item.id === criterion.criterionId);
      return [
        `### ${statusMark(criterion.status)} ${definition?.description ?? criterion.criterionId}`,
        "",
        criterion.summary,
        "",
        `Evidence: ${criterion.evidenceIds.length ? criterion.evidenceIds.map((id) => `\`${id}\``).join(", ") : "None linked"}`,
        ...(criterion.limitations.map((limitation) => `- Limitation: ${limitation}`)),
        "",
      ];
    }),
    "## Validation and Evidence",
    "",
    ...(safe.validationResults.length ? safe.validationResults.map((item) => `- ${item.passed ? "✓" : "✗"} \`${item.command}\` (exit ${item.exitCode}) — ${item.summary}`) : ["No normalized validation results were recorded."]),
    ...safe.evidence.map((item) => `- ${item.freshness.status === "fresh" ? "✓" : "⚠"} **${item.title}** — ${item.summary}${item.contentLocation ? ` ([artifact](${item.contentLocation}))` : ""}`),
    "",
    "## Reviewer Results",
    "",
    ...(safe.reviews.length ? safe.reviews.flatMap((review) => [
      `### ${review.reviewerId} — ${review.status.replaceAll("_", " ")}`,
      "",
      `${review.summary} (${Math.round(review.confidence * 100)}% confidence)`,
      ...review.findings.map((finding) => `- ${finding.severity.toUpperCase()}: ${finding.title} — ${finding.description}`),
      ...review.evidenceRequests.map((request) => `- Evidence ${request.status}: ${request.description}`),
      "",
    ]) : ["No reviewer results were recorded.", ""]),
    "## Final Decision",
    "",
    safe.finalDecision.summary,
    "",
    `Required reviews passed: ${safe.finalDecision.requiredReviewsPassed ? "yes" : "no"}`,
    ...list("Warnings", safe.finalDecision.warnings),
    ...list("Suggested follow-up", safe.finalDecision.followUps),
  ];
  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;
}

export function reportToJSON(report: GoalReport, exportedAt = report.generatedAt): GoalReportExport {
  const safe = exportSafeReport(GoalReportSchema.parse(report));
  return GoalReportExportSchema.parse({
    metadata: { reportId: safe.id, reportSchemaVersion: safe.schemaVersion, format: "json", exportedAt, redacted: true },
    report: safe,
  });
}

export function redactReport(report: GoalReport): GoalReport {
  return GoalReportSchema.parse(redactValue(structuredClone(report)));
}

function exportSafeReport(report: GoalReport): GoalReport {
  const safe = redactReport(report);
  const bounded = {
    ...safe,
    clarifications: safe.clarifications.slice(-100),
    validationResults: safe.validationResults.slice(-200).map((item) => ({ ...item, summary: boundedExport(item.summary) })),
    evidence: safe.evidence.slice(-100).map((item) => ({ ...item, summary: boundedExport(item.summary) })),
    reviews: safe.reviews.slice(-30).map((review) => ({
      ...review,
      summary: boundedExport(review.summary),
      findings: review.findings.slice(-10).map((finding) => ({ ...finding, description: boundedExport(finding.description), ...(finding.remediation ? { remediation: boundedExport(finding.remediation) } : {}) })),
      evidenceRequests: review.evidenceRequests.slice(-10).map((request) => ({ ...request, description: boundedExport(request.description) })),
    })),
    finalDecision: {
      ...safe.finalDecision,
      warnings: safe.finalDecision.warnings.slice(-100).map(boundedExport),
      followUps: safe.finalDecision.followUps.slice(-100).map(boundedExport),
    },
  };
  return GoalReportSchema.parse(bounded);
}

function clarificationHistory(goal: GoalDefinition, questions: GoalQuestion[], versions: GoalVersion[]): ClarificationRecord[] {
  const questionById = new Map(questions.map((question) => [question.id, question]));
  return goal.answers.flatMap((answer) => {
    const question = questionById.get(answer.questionId);
    if (!question) return [];
    const resulting = versions.find((version) => version.definition.answers.some((candidate) => candidate.questionId === answer.questionId && candidate.answeredAt === answer.answeredAt));
    return [{ question, answer, resultingGoalVersion: resulting?.version ?? goal.version }];
  });
}

function collectFiles(run: GoalRunState): { added: string[]; changed: string[]; deleted: string[] } {
  const changes = run.iterations.flatMap((iteration) => iteration.fileChanges ?? iteration.changedFiles.map((path) => ({ path, status: "modified" as const })));
  const latest = new Map(changes.map((change) => [change.path, change.status]));
  return {
    added: [...latest].filter(([, status]) => status === "added").map(([path]) => path).sort(),
    changed: [...latest].filter(([, status]) => status === "modified" || status === "renamed").map(([path]) => path).sort(),
    deleted: [...latest].filter(([, status]) => status === "deleted").map(([path]) => path).sort(),
  };
}

function normalizeValidation(run: GoalRunState): NormalizedValidationResult[] {
  return run.iterations.flatMap((iteration, iterationIndex) => iteration.validationResults.map((result, index) => ({
    id: `validation-${iterationIndex + 1}-${index + 1}`,
    type: validationType(result.command),
    command: result.command,
    passed: result.passed,
    exitCode: result.exitCode,
    durationMs: 0,
    summary: bounded([result.stdout, result.stderr].filter(Boolean).join("\n") || `${result.command} exited with code ${result.exitCode}.`),
    collectedAt: run.finishedAt ?? run.startedAt,
  })));
}

function implementationSummary(run: GoalRunState, error?: string): string {
  const summaries = run.iterations.flatMap((iteration) => iteration.agentMessages.filter((message) => message.role === "assistant").map((message) => message.content));
  if (summaries.length > 0) return bounded(summaries.at(-1) ?? summaries[0] ?? "Implementation activity was recorded.");
  if (error) return bounded(`The run stopped before a complete implementation summary was produced: ${error}`);
  return "The run did not record an implementation summary.";
}

function finalDecisionSummary(status: GoalReport["overview"]["finalStatus"], achieved: boolean, general: ReviewResult | undefined, error?: string): string {
  if (achieved) return general?.summary ?? "The goal completed and all mandatory approval gates passed.";
  if (status === "achieved") return "The run recorded completion, but the persisted report data does not satisfy every mandatory approval gate.";
  if (error) return `The goal was not achieved: ${bounded(error)}`;
  if (status === "cancelled") return "The run was cancelled before the goal could be approved as complete.";
  return general?.summary ?? "The run stopped without approval of the goal.";
}

function finalStatus(status: GoalRunState["status"]): GoalReport["overview"]["finalStatus"] {
  if (status === "completed") return "achieved";
  if (status === "cancelled") return "cancelled";
  if (status === "failed") return "failed";
  if (status === "iteration_limit_reached") return "blocked";
  return "not_achieved";
}

function legacyGoal(run: GoalRunState): GoalDefinition {
  return {
    schemaVersion: 1,
    id: `legacy-${run.id}`,
    originalRequest: run.goal,
    title: run.goal.slice(0, 120),
    description: run.goal,
    successCriteria: [{ id: "legacy-request", description: run.goal, required: true }],
    constraints: [],
    deliverables: [{ id: "legacy-implementation", type: "implementation", description: "Implement the requested goal", required: true }],
    assumptions: [],
    answers: [],
    status: "approved",
    version: 1,
    createdAt: run.startedAt,
    updatedAt: run.startedAt,
  };
}

function latestByReviewer(reviews: ReviewResult[]): Map<string, ReviewResult> {
  const latest = new Map<string, ReviewResult>();
  for (const review of reviews) latest.set(review.reviewerId, review);
  return latest;
}

function uniqueById<T extends { id: string }>(items: T[]): T[] {
  const values = new Map<string, T>();
  for (const item of items) values.set(item.id, item);
  return [...values.values()];
}

function approved(status: ReviewResult["status"] | undefined): boolean { return status === "approved" || status === "approved_with_warnings"; }
function unique(values: string[]): string[] { return [...new Set(values.filter(Boolean))].slice(0, MAX_ITEMS); }
function bounded(value: string): string { return value.length <= MAX_TEXT ? value : `${value.slice(0, MAX_TEXT - 16)}\n… [truncated]`; }
function boundedExport(value: string): string { return value.length <= 1_000 ? value : `${value.slice(0, 984)}\n… [truncated]`; }
function validationType(command: string): NormalizedValidationResult["type"] {
  if (/\btest\b|pytest|cargo test|go test/.test(command)) return "test";
  if (/\bbuild\b/.test(command)) return "build";
  if (/\blint\b|clippy/.test(command)) return "lint";
  if (/typecheck|tsc\b|cargo check/.test(command)) return "typecheck";
  if (/bench/.test(command)) return "benchmark";
  if (/coverage|cov\b/.test(command)) return "coverage";
  return "command";
}
function formatValue(value: unknown): string { return typeof value === "string" ? value : JSON.stringify(value); }
function statusMark(status: GoalReport["criteria"][number]["status"]): string { return status === "passed" ? "✓" : status === "warning" ? "⚠" : status === "not_verified" ? "?" : "✗"; }
function list(title: string, values: string[]): string[] { return [`### ${title}`, "", ...(values.length ? values.map((value) => `- ${value}`) : ["None recorded."]), ""]; }

function redactValue(value: unknown): unknown {
  if (typeof value === "string") return bounded(redactString(value));
  if (Array.isArray(value)) return value.slice(0, MAX_ITEMS).map(redactValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactValue(item)]));
  return value;
}

function redactString(value: string): string {
  return value
    .replace(/\b(?:gh[opusr]_[A-Za-z0-9_]{16,}|sk-[A-Za-z0-9_-]{16,})\b/g, REDACTED)
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, `$1${REDACTED}`)
    .replace(/\b((?:[A-Za-z][A-Za-z0-9_-]*)?(?:api[_-]?key|token|secret|password)[A-Za-z0-9_-]*)\s*([:=])\s*([^\s,;]+)/gi, `$1$2${REDACTED}`)
    .replace(/(https?:\/\/[^\s/:@]+:)[^\s/@]+@/gi, `$1${REDACTED}@`)
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, REDACTED);
}
