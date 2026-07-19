import {
  CGS_VERSION, ConduitRunSchema, GoalReportSchema, GoalSpecificationSchema, QuestionBatchSchema, ReviewResultSchema as CgsReviewResultSchema, type ConduitRun, type GoalSpecification, type QuestionBatch,
  type GoalReport as CgsGoalReport,
  type EvidenceArtifact as CgsEvidenceArtifact, type EvidenceRequest as CgsEvidenceRequest,
  type ReviewRequest as CgsReviewRequest, type ReviewResult as CgsReviewResult,
} from "@conduit/cgs";
import type { EvidenceItem, EvidenceRequest, GoalDefinition, GoalDrivenRunRecord, GoalQuestionBatch, GoalReport as LegacyGoalReport, ReviewResult } from "@conduit/cgs/legacy";
import type { GoalRunState } from "@conduit/shared";

export const LEGACY_CGS_MIGRATION_VERSION = "0.4.0-cgs-1" as const;

/** Explicit, loss-aware migration for persisted Conduit 0.3 goal definitions. */
export function legacyGoalToCgs(legacy: GoalDefinition): GoalSpecification {
  const status: GoalSpecification["status"] = legacy.status === "awaiting_answers" ? "awaiting_clarification"
    : legacy.status === "running" ? "in_progress" : legacy.status;
  return GoalSpecificationSchema.parse({
    cgsVersion: CGS_VERSION,
    kind: "goal",
    id: legacy.id,
    createdAt: legacy.createdAt,
    updatedAt: legacy.updatedAt,
    title: legacy.title,
    description: legacy.description,
    originalRequest: legacy.originalRequest,
    successCriteria: legacy.successCriteria.map((criterion) => ({
      id: criterion.id,
      description: criterion.description,
      priority: criterion.required ? "required" : "preferred",
      ...(criterion.verificationHint ? { verification: [{ type: "other" as const, description: criterion.verificationHint }] } : {}),
    })),
    constraints: legacy.constraints.map((constraint) => ({
      id: constraint.id,
      description: constraint.description,
      category: constraint.source === "policy" ? "process" : "other",
      required: true,
    })),
    deliverables: legacy.deliverables.map((deliverable) => ({
      id: deliverable.id,
      description: deliverable.description,
      type: legacyDeliverableType(deliverable.type),
      required: deliverable.required,
    })),
    assumptions: legacy.assumptions,
    permissions: {
      allowFileReads: true,
      allowFileWrites: true,
      allowCommandExecution: true,
      allowNetworkAccess: false,
      allowDependencyChanges: false,
      allowGitOperations: false,
    },
    clarificationHistory: legacy.answers.map((answer) => ({
      questionBatchId: `legacy-question-${answer.questionId}`,
      answerBatchId: `legacy-answer-${answer.questionId}`,
      required: true,
    })),
    reviewPipeline: {
      generalReviewer: { reviewerId: "conduit.general", required: true },
      specialistReviewers: [],
      routingMode: "hybrid",
      completionPolicy: "all_required_approve",
    },
    metadata: {
      migratedFrom: "conduit-legacy-goal",
      migrationVersion: LEGACY_CGS_MIGRATION_VERSION,
      legacySchemaVersion: legacy.schemaVersion,
    },
    status,
    revision: legacy.version,
  });
}

/** Compatibility input for the legacy implementation loop; remove with the loop's 0.3 storage reader. */
export function cgsGoalToLegacyRuntimeInput(goal: GoalSpecification): GoalDefinition {
  return {
    schemaVersion: 1,
    id: goal.id,
    originalRequest: goal.originalRequest ?? goal.description,
    title: goal.title,
    description: goal.description,
    successCriteria: goal.successCriteria.map((criterion) => ({
      id: criterion.id,
      description: criterion.description,
      required: criterion.priority === "required",
      ...(criterion.verification?.[0]?.description ? { verificationHint: criterion.verification[0].description } : {}),
    })),
    constraints: goal.constraints.map((constraint) => ({ id: constraint.id, description: constraint.description, source: "user" as const })),
    deliverables: goal.deliverables.map((deliverable) => ({ id: deliverable.id, description: deliverable.description, type: cgsDeliverableType(deliverable.type), required: deliverable.required })),
    assumptions: goal.assumptions.map((assumption) => ({ id: assumption.id, description: assumption.description, confirmed: assumption.confirmed ?? false })),
    answers: [],
    status: goal.status === "awaiting_clarification" ? "awaiting_answers" : goal.status === "in_progress" ? "running" : goal.status,
    version: goal.revision,
    createdAt: goal.createdAt,
    updatedAt: goal.updatedAt ?? goal.createdAt,
  };
}

export function legacyQuestionBatchesToCgs(goalId: string, batches: GoalQuestionBatch[], createdAt: string): QuestionBatch[] {
  return batches.map((batch) => QuestionBatchSchema.parse({
    cgsVersion: CGS_VERSION,
    kind: "question-batch",
    id: batch.id,
    createdAt,
    goalId,
    sequence: batch.position,
    reason: "goal_clarification",
    questions: batch.questions.map((question) => ({
      id: question.id,
      goalId,
      prompt: question.title,
      rationale: question.description ?? question.sourceReason,
      required: question.required,
      type: question.type === "text" ? "free_text" : question.type === "success_criteria_editor" ? "success_criterion_editor" : question.type,
      ...("options" in question ? { options: question.options.map((option) => ({ id: option.id, label: option.label, description: option.description, value: option.id })) } : {}),
      ...("defaultValue" in question && question.defaultValue !== undefined ? { defaultValue: question.defaultValue } : {}),
    })),
  }));
}

export function legacyRunRecordToCgs(run: GoalDrivenRunRecord): ConduitRun {
  const terminal = ["completed", "failed", "cancelled"].includes(run.workflowPhase);
  return ConduitRunSchema.parse({
    cgsVersion: CGS_VERSION,
    kind: "run",
    id: run.id,
    createdAt: run.startedAt,
    updatedAt: run.updatedAt,
    goalId: run.goalId,
    goalRevision: run.activeGoalVersion,
    conduitDesktopVersion: run.conduitDesktopVersion,
    conduitRuntimeVersion: run.conduitRuntimeVersion ?? "0.4.0-rc.1",
    status: canonicalRunStatus(run.workflowPhase),
    activeStage: terminal ? undefined : run.workflowPhase,
    implementationAttempts: [],
    reviewResultIds: [],
    evidenceArtifactIds: [],
    startedAt: run.startedAt,
    completedAt: run.finishedAt,
    ...(run.workflowPhase === "failed" ? { failure: { code: "legacy_runtime_failed", message: "The compatibility runtime reported failure." } } : {}),
  });
}

export function legacyReviewToCgs(runId: string, goal: GoalDefinition, review: ReviewResult, changedFiles: string[] = []): { request: CgsReviewRequest; result: CgsReviewResult; evidenceRequests: CgsEvidenceRequest[] } {
  const canonicalGoal = legacyGoalToCgs(goal);
  const requestedAt = review.reviewedAt;
  const request: CgsReviewRequest = {
    cgsVersion: CGS_VERSION, kind: "review-request", id: `review-request-${review.id}`, createdAt: requestedAt,
    runId, goalId: goal.id, reviewerId: reviewerId(review.reviewerId), goalRevision: goal.version,
    changedFiles: changedFiles.map((path) => ({ path, status: "modified" })), availableEvidence: [], requestedAt,
  };
  const evidenceRequests = review.evidenceRequests.map((item) => legacyEvidenceRequestToCgs(runId, goal.id, item));
  const status = canonicalReviewStatus(review.status);
  const findings = review.findings.map((finding) => ({
    id: finding.id,
    severity: finding.severity === "critical" ? "critical" as const : finding.severity === "high" ? "error" as const : finding.severity === "medium" ? "warning" as const : "info" as const,
    title: finding.title,
    description: finding.description,
    filePath: finding.filePath,
    lineStart: finding.lineStart,
    lineEnd: finding.lineEnd,
    relatedCriterionIds: finding.criterionId ? [finding.criterionId] : undefined,
    remediation: finding.remediation,
    blocksCompletion: !["approved", "approved_with_warnings", "not_applicable"].includes(review.status) && ["high", "critical"].includes(finding.severity),
  }));
  const result = CgsReviewResultSchema.parse({
    cgsVersion: CGS_VERSION, kind: "review-result", id: review.id, createdAt: review.reviewedAt,
    runId, goalId: goal.id, reviewerId: request.reviewerId, reviewRequestId: request.id, status,
    summary: review.summary, confidence: review.confidence,
    criterionResults: canonicalGoal.successCriteria.map((criterion) => {
      const related = findings.filter((finding) => finding.relatedCriterionIds?.includes(criterion.id));
      return { criterionId: criterion.id, status: related.some((finding) => finding.blocksCompletion) ? "failed" : status === "approved" ? "passed" : "blocked", explanation: related.map((finding) => finding.description).join(" ") || review.summary };
    }),
    findings, evidenceRequests: evidenceRequests.map((item) => ({ evidenceRequestId: item.id })), reviewedAt: review.reviewedAt,
  });
  return { request, result, evidenceRequests };
}

export function legacyEvidenceRequestToCgs(runId: string, goalId: string, request: EvidenceRequest): CgsEvidenceRequest {
  const type = canonicalEvidenceRequestType(request.type);
  const commandBased = ["command", "test", "build", "lint", "benchmark", "coverage"].includes(type);
  return {
    cgsVersion: CGS_VERSION, kind: "evidence-request", id: request.id, createdAt: request.requestedAt, updatedAt: request.resolvedAt,
    runId, goalId, requestedByReviewerId: reviewerId(request.reviewerId), type, description: request.description, required: request.required,
    ...(commandBased ? { command: { command: request.suggestedCommand ?? `conduit:${request.type}` } } : {}),
    ...(type === "file_excerpt" ? { fileReference: { path: "unknown" } } : {}),
    status: request.status === "pending" ? "requested" : request.status === "approved" ? "running" : request.status === "collected" ? "completed" : request.status === "rejected" ? "denied" : "failed",
  };
}

export function legacyEvidenceToCgs(runId: string, goalId: string, evidence: EvidenceItem, requestId?: string): CgsEvidenceArtifact {
  return {
    cgsVersion: CGS_VERSION, kind: "evidence-artifact", id: evidence.id, createdAt: evidence.collectedAt,
    runId, goalId, requestId, source: evidence.collectedBy, type: canonicalEvidenceArtifactType(evidence.type),
    status: evidence.exitCode !== undefined && evidence.exitCode !== 0 ? "failure" : evidence.trusted ? "success" : "partial",
    summary: evidence.summary,
    payload: { ...(evidence.command ? { command: evidence.command } : {}), ...(evidence.exitCode !== undefined ? { exitCode: evidence.exitCode } : {}), ...(evidence.durationMs !== undefined ? { durationMs: evidence.durationMs } : {}), title: evidence.title },
    ...(evidence.contentLocation ? { externalArtifact: { uri: evidence.contentLocation, mediaType: "text/plain" } } : {}),
    ...(evidence.freshness.scopeFingerprint ? { repositoryState: { workingTreeHash: evidence.freshness.scopeFingerprint, capturedAt: evidence.collectedAt } } : {}),
    stale: evidence.freshness.status === "stale", producedAt: evidence.collectedAt,
  };
}

function canonicalEvidenceRequestType(type: EvidenceRequest["type"]): CgsEvidenceRequest["type"] {
  if (type === "file" || type === "search") return "file_excerpt";
  if (type === "diff") return "git_diff";
  if (type === "dependency") return "dependency_analysis";
  if (type === "user_answer") return "user_confirmation";
  if (type === "typecheck" || type === "static_analysis") return "command";
  return type;
}

function canonicalEvidenceArtifactType(type: EvidenceItem["type"]): CgsEvidenceArtifact["type"] {
  if (type === "test") return "test_result"; if (type === "build") return "build_result"; if (type === "lint") return "lint_result";
  if (type === "benchmark") return "benchmark_result"; if (type === "coverage") return "coverage_result"; if (type === "file" || type === "search") return "file_excerpt";
  if (type === "dependency") return "dependency_report"; if (type === "diff") return "git_diff"; if (type === "user_answer") return "user_answer";
  return "command_result";
}

function canonicalRunStatus(phase: GoalDrivenRunRecord["workflowPhase"]): ConduitRun["status"] {
  if (phase === "building_goal") return "analyzing_goal";
  if (phase === "validating") return "implementing";
  if (phase === "routing_reviews") return "general_review";
  return phase;
}

/** Converts the parity report into the one canonical portable report model. */
export function legacyReportToCgs(report: LegacyGoalReport, run?: Pick<GoalRunState, "conduitDesktopVersion" | "conduitRuntimeVersion" | "cgsVersion">): CgsGoalReport {
  const goalSnapshot = legacyGoalToCgs(report.goal);
  const warningCount = report.finalDecision.warnings.length + report.finalDecision.unresolvedFindingIds.length;
  const decision: CgsGoalReport["decision"] = report.finalDecision.achieved
    ? warningCount ? "completed_with_warnings" : "completed"
    : report.overview.finalStatus === "blocked" ? "blocked" : "not_completed";
  const canonicalGoal = GoalSpecificationSchema.parse({
    ...goalSnapshot,
    status: report.finalDecision.achieved ? "completed" : goalSnapshot.status,
    metadata: {
      ...(goalSnapshot.metadata ?? {}),
      conduitDesktopVersion: run?.conduitDesktopVersion ?? report.overview.conduitDesktopVersion ?? "legacy",
      conduitRuntimeVersion: run?.conduitRuntimeVersion ?? report.overview.conduitRuntimeVersion ?? "legacy",
      cgsVersion: run?.cgsVersion ?? report.overview.cgsVersion ?? CGS_VERSION,
    },
  });
  return GoalReportSchema.parse({
    cgsVersion: CGS_VERSION,
    kind: "report",
    id: report.id,
    createdAt: report.generatedAt,
    runId: report.runId,
    goalId: canonicalGoal.id,
    goalRevision: canonicalGoal.revision,
    decision,
    summary: report.finalDecision.summary,
    goalSnapshot: canonicalGoal,
    clarificationSummary: {
      decisions: report.clarifications.map((record) => `${record.question.title}: ${JSON.stringify(record.answer.value)}`),
      questionBatchIds: report.clarifications.map((record) => `legacy-question-${record.question.id}`),
      answerBatchIds: report.clarifications.map((record) => `legacy-answer-${record.question.id}`),
    },
    implementationSummary: {
      summary: report.implementation.summary,
      filesAdded: report.implementation.filesAdded,
      filesChanged: report.implementation.filesChanged,
      filesDeleted: report.implementation.filesDeleted,
      attempts: report.overview.totalIterations,
    },
    validationSummary: {
      passed: report.validationResults.every((result) => result.passed),
      summary: report.validationResults.length ? `${report.validationResults.filter((result) => result.passed).length}/${report.validationResults.length} validation commands passed.` : "No automated validation was recorded.",
      evidenceArtifactIds: report.validationResults.flatMap((result) => result.artifactId ? [result.artifactId] : []),
    },
    reviewerSummaries: report.reviews.map((review) => ({
      reviewerId: reviewerId(review.reviewerId),
      status: canonicalReviewStatus(review.status),
      summary: review.summary,
      reviewResultId: review.id,
    })),
    evidenceSummary: {
      summary: `${report.evidence.filter((item) => item.freshness.status === "fresh").length} current evidence artifacts; ${report.evidence.filter((item) => item.freshness.status === "stale").length} stale.`,
      artifactIds: report.evidence.map((item) => item.id),
      staleArtifactIds: report.evidence.filter((item) => item.freshness.status === "stale").map((item) => item.id),
    },
    knownRisks: report.finalDecision.warnings.map((description, index) => ({ id: `risk-${index + 1}`, description, severity: "medium" })),
    suggestedFollowUps: report.finalDecision.followUps.map((description, index) => ({ id: `follow-up-${index + 1}`, description, priority: "recommended" })),
    generatedAt: report.generatedAt,
  });
}

const reviewerId = (id: string): string => id.startsWith("conduit.") ? id : `conduit.${id.replaceAll("_", "-")}`;
function canonicalReviewStatus(status: LegacyGoalReport["reviews"][number]["status"]): CgsGoalReport["reviewerSummaries"][number]["status"] {
  if (status === "approved" || status === "approved_with_warnings" || status === "not_applicable") return "approved";
  if (status === "needs_evidence") return "insufficient_evidence";
  return status;
}

function legacyDeliverableType(type: GoalDefinition["deliverables"][number]["type"]): GoalSpecification["deliverables"][number]["type"] {
  if (type === "unit_tests" || type === "integration_tests") return "test";
  if (type === "implementation") return "code";
  if (type === "benchmark") return "other";
  return type;
}

function cgsDeliverableType(type: GoalSpecification["deliverables"][number]["type"]): GoalDefinition["deliverables"][number]["type"] {
  if (type === "code" || type === "configuration") return "implementation";
  if (type === "test") return "unit_tests";
  if (type === "report") return "other";
  return type ?? "other";
}
