import { z } from "zod";
import {
  CGS_VERSION, CgsVersionSchema, IdSchema, JsonValueSchema, NonEmptyStringSchema,
  PermissionPathPatternSchema, RepositoryPathSchema, TimestampSchema,
} from "./common.js";

const envelope = <K extends string>(kind: K) => ({
  cgsVersion: CgsVersionSchema,
  kind: z.literal(kind),
  id: IdSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema.optional(),
});
const portableObject = <T extends z.ZodRawShape>(shape: T) => z.object(shape).passthrough();
const artifactObject = <T extends z.ZodRawShape>(shape: T) => portableObject(shape).superRefine((value, ctx) => {
  const timestamps = value as unknown as { createdAt?: unknown; updatedAt?: unknown };
  if (typeof timestamps.createdAt === "string" && typeof timestamps.updatedAt === "string" && Date.parse(timestamps.updatedAt) < Date.parse(timestamps.createdAt)) {
    ctx.addIssue({ code: "custom", message: "updatedAt cannot precede createdAt", path: ["updatedAt"] });
  }
});
const uniqueIds = (items: Array<{ id: string }>, ctx: z.RefinementCtx, path: string) => {
  const seen = new Set<string>();
  items.forEach((item, index) => {
    if (seen.has(item.id)) ctx.addIssue({ code: "custom", message: `${path} IDs must be unique`, path: [path, index, "id"] });
    seen.add(item.id);
  });
};

export const VerificationHintSchema = portableObject({
  type: z.enum(["command", "test", "build", "lint", "review", "user_confirmation", "other"]),
  description: NonEmptyStringSchema,
  command: NonEmptyStringSchema.optional(),
});
export const SuccessCriterionSchema = portableObject({
  id: IdSchema, description: NonEmptyStringSchema, priority: z.enum(["required", "preferred"]),
  verification: z.array(VerificationHintSchema).optional(),
  status: z.enum(["unverified", "passed", "failed", "blocked"]).optional(),
});
export const GoalConstraintSchema = portableObject({
  id: IdSchema, description: NonEmptyStringSchema,
  category: z.enum(["technical", "security", "compatibility", "performance", "scope", "process", "other"]).optional(),
  required: z.boolean(),
});
export const DeliverableSchema = portableObject({
  id: IdSchema, description: NonEmptyStringSchema,
  type: z.enum(["code", "test", "documentation", "configuration", "migration", "report", "other"]).optional(),
  repositoryPath: RepositoryPathSchema.optional(), required: z.boolean(),
});
export const AssumptionSchema = portableObject({ id: IdSchema, description: NonEmptyStringSchema, confirmed: z.boolean().optional() });
export const GoalPermissionsSchema = portableObject({
  allowFileReads: z.boolean(), allowFileWrites: z.boolean(), allowCommandExecution: z.boolean(),
  allowNetworkAccess: z.boolean(), allowDependencyChanges: z.boolean(), allowGitOperations: z.boolean(),
  allowedPaths: z.array(PermissionPathPatternSchema).optional(), deniedPaths: z.array(PermissionPathPatternSchema).optional(),
  allowedCommands: z.array(NonEmptyStringSchema).optional(),
});
export const ClarificationReferenceSchema = portableObject({
  questionBatchId: IdSchema, answerBatchId: IdSchema.optional(), required: z.boolean().default(true),
});
export const ReviewerRequirementSchema = portableObject({
  reviewerId: NonEmptyStringSchema, required: z.boolean(), configuration: z.record(JsonValueSchema).optional(), reason: NonEmptyStringSchema.optional(),
});
export const ReviewPipelineSpecificationSchema = portableObject({
  generalReviewer: ReviewerRequirementSchema, specialistReviewers: z.array(ReviewerRequirementSchema),
  routingMode: z.enum(["automatic", "explicit", "hybrid"]), completionPolicy: z.literal("all_required_approve"),
});
export const RepositoryContextReferenceSchema = portableObject({
  repositoryId: IdSchema.optional(), uri: NonEmptyStringSchema.optional(), revision: NonEmptyStringSchema.optional(),
});

export const GoalSpecificationSchema = artifactObject({
  ...envelope("goal"), title: NonEmptyStringSchema, description: NonEmptyStringSchema,
  originalRequest: NonEmptyStringSchema.optional(), successCriteria: z.array(SuccessCriterionSchema),
  constraints: z.array(GoalConstraintSchema), deliverables: z.array(DeliverableSchema), assumptions: z.array(AssumptionSchema),
  permissions: GoalPermissionsSchema, clarificationHistory: z.array(ClarificationReferenceSchema),
  reviewPipeline: ReviewPipelineSpecificationSchema, repository: RepositoryContextReferenceSchema.optional(),
  metadata: z.record(JsonValueSchema).optional(),
  status: z.enum(["draft", "awaiting_clarification", "awaiting_approval", "approved", "in_progress", "completed", "failed", "cancelled"]),
  revision: z.number().int().positive(),
}).superRefine((goal, ctx) => {
  uniqueIds(goal.successCriteria, ctx, "successCriteria"); uniqueIds(goal.constraints, ctx, "constraints"); uniqueIds(goal.deliverables, ctx, "deliverables"); uniqueIds(goal.assumptions, ctx, "assumptions");
  if (["approved", "in_progress", "completed"].includes(goal.status) && !goal.successCriteria.some((item) => item.priority === "required")) {
    ctx.addIssue({ code: "custom", message: "Approved goals require at least one required success criterion", path: ["successCriteria"] });
  }
  if (["approved", "in_progress", "completed"].includes(goal.status) && goal.clarificationHistory.some((item) => item.required && !item.answerBatchId)) {
    ctx.addIssue({ code: "custom", message: "Approved goals cannot contain unanswered required clarifications", path: ["clarificationHistory"] });
  }
});

export const RepositoryReferenceSchema = portableObject({ path: RepositoryPathSchema, lineStart: z.number().int().positive().optional(), lineEnd: z.number().int().positive().optional() });
export const QuestionOptionSchema = portableObject({ id: IdSchema, label: NonEmptyStringSchema, description: NonEmptyStringSchema.optional(), value: JsonValueSchema });
export const GoalQuestionSchema = portableObject({
  id: IdSchema, goalId: IdSchema, prompt: NonEmptyStringSchema, rationale: NonEmptyStringSchema.optional(), required: z.boolean(),
  type: z.enum(["single_select", "multi_select", "confirmation", "free_text", "repository_reference", "constraint_editor", "success_criterion_editor"]),
  options: z.array(QuestionOptionSchema).optional(), defaultValue: JsonValueSchema.optional(), repositoryReferences: z.array(RepositoryReferenceSchema).optional(),
}).superRefine((question, ctx) => {
  if (["single_select", "multi_select"].includes(question.type) && (question.options?.length ?? 0) < 2) ctx.addIssue({ code: "custom", message: "Select questions require at least two options", path: ["options"] });
  if (question.type === "confirmation" && question.options !== undefined) ctx.addIssue({ code: "custom", message: "Confirmation questions cannot define options", path: ["options"] });
  if (question.options) uniqueIds(question.options, ctx, "options");
});
export const QuestionBatchSchema = artifactObject({
  ...envelope("question-batch"), goalId: IdSchema, questions: z.array(GoalQuestionSchema).min(1), sequence: z.number().int().nonnegative(),
  reason: z.enum(["goal_clarification", "runtime_decision", "review_blocker"]),
}).superRefine((batch, ctx) => uniqueIds(batch.questions, ctx, "questions"));
export const GoalAnswerSchema = portableObject({ questionId: IdSchema, value: JsonValueSchema, answeredAt: TimestampSchema, answeredBy: z.literal("user") });
export const AnswerBatchSchema = artifactObject({ ...envelope("answer-batch"), goalId: IdSchema, questionBatchId: IdSchema, answers: z.array(GoalAnswerSchema) });

export const ChangedFileReferenceSchema = portableObject({ path: RepositoryPathSchema, status: z.enum(["added", "modified", "deleted", "renamed"]), previousPath: RepositoryPathSchema.optional() });
export const EvidenceReferenceSchema = portableObject({ evidenceArtifactId: IdSchema, description: NonEmptyStringSchema.optional() });
export const ReviewRequestSchema = artifactObject({
  ...envelope("review-request"), runId: IdSchema, goalId: IdSchema, reviewerId: NonEmptyStringSchema, goalRevision: z.number().int().positive(),
  changedFiles: z.array(ChangedFileReferenceSchema), availableEvidence: z.array(EvidenceReferenceSchema), previousResultId: IdSchema.optional(), requestedAt: TimestampSchema,
});
export const CriterionReviewResultSchema = portableObject({
  criterionId: IdSchema, status: z.enum(["passed", "failed", "blocked", "not_applicable"]), explanation: NonEmptyStringSchema, evidenceReferences: z.array(IdSchema).optional(),
});
export const ReviewFindingSchema = portableObject({
  id: IdSchema, severity: z.enum(["info", "warning", "error", "critical"]), title: NonEmptyStringSchema, description: NonEmptyStringSchema,
  filePath: RepositoryPathSchema.optional(), lineStart: z.number().int().positive().optional(), lineEnd: z.number().int().positive().optional(),
  relatedCriterionIds: z.array(IdSchema).optional(), evidenceReferences: z.array(IdSchema).optional(), remediation: NonEmptyStringSchema.optional(), blocksCompletion: z.boolean(),
}).superRefine((finding, ctx) => {
  if ((finding.lineStart || finding.lineEnd) && !finding.filePath) ctx.addIssue({ code: "custom", message: "Line locations require filePath", path: ["filePath"] });
  if (finding.lineEnd && (!finding.lineStart || finding.lineEnd < finding.lineStart)) ctx.addIssue({ code: "custom", message: "lineEnd must follow lineStart", path: ["lineEnd"] });
});
export const EvidenceRequestReferenceSchema = portableObject({ evidenceRequestId: IdSchema });
export const ReviewResultSchema = artifactObject({
  ...envelope("review-result"), runId: IdSchema, goalId: IdSchema, reviewerId: NonEmptyStringSchema, reviewRequestId: IdSchema,
  status: z.enum(["approved", "changes_requested", "blocked", "insufficient_evidence", "error"]), summary: NonEmptyStringSchema,
  confidence: z.number().min(0).max(1).optional(), criterionResults: z.array(CriterionReviewResultSchema), findings: z.array(ReviewFindingSchema),
  evidenceRequests: z.array(EvidenceRequestReferenceSchema), reviewedAt: TimestampSchema,
}).superRefine((result, ctx) => {
  uniqueIds(result.findings, ctx, "findings");
  if (result.status === "approved" && result.findings.some((finding) => finding.blocksCompletion)) ctx.addIssue({ code: "custom", message: "Approved reviews cannot contain blocking findings", path: ["findings"] });
});

export const CommandEvidenceSpecificationSchema = portableObject({ command: NonEmptyStringSchema, workingDirectory: RepositoryPathSchema.optional(), timeoutMs: z.number().int().positive().optional() });
export const EvidenceRequestSchema = artifactObject({
  ...envelope("evidence-request"), runId: IdSchema, goalId: IdSchema, requestedByReviewerId: NonEmptyStringSchema,
  type: z.enum(["command", "test", "build", "lint", "benchmark", "coverage", "file_excerpt", "dependency_analysis", "git_diff", "user_confirmation"]),
  description: NonEmptyStringSchema, required: z.boolean(), command: CommandEvidenceSpecificationSchema.optional(), fileReference: RepositoryReferenceSchema.optional(),
  status: z.enum(["requested", "awaiting_permission", "running", "completed", "failed", "denied"]),
}).superRefine((request, ctx) => {
  if (["command", "test", "build", "lint", "benchmark", "coverage"].includes(request.type) && !request.command) ctx.addIssue({ code: "custom", message: "Command-based evidence requires a command specification", path: ["command"] });
  if (request.type === "file_excerpt" && !request.fileReference) ctx.addIssue({ code: "custom", message: "File excerpts require a file reference", path: ["fileReference"] });
});
export const RepositoryStateReferenceSchema = portableObject({ gitCommit: NonEmptyStringSchema.optional(), gitTreeHash: NonEmptyStringSchema.optional(), workingTreeHash: NonEmptyStringSchema.optional(), capturedAt: TimestampSchema });
export const ExternalArtifactReferenceSchema = portableObject({ uri: NonEmptyStringSchema, mediaType: NonEmptyStringSchema, sha256: z.string().regex(/^[a-f0-9]{64}$/i).optional(), sizeBytes: z.number().int().nonnegative().optional() });
export const EvidenceArtifactSchema = artifactObject({
  ...envelope("evidence-artifact"), runId: IdSchema, goalId: IdSchema, requestId: IdSchema.optional(), source: NonEmptyStringSchema.optional(),
  type: z.enum(["command_result", "test_result", "build_result", "lint_result", "benchmark_result", "coverage_result", "file_excerpt", "dependency_report", "git_diff", "user_answer"]),
  status: z.enum(["success", "failure", "partial", "unavailable"]), summary: NonEmptyStringSchema, payload: JsonValueSchema,
  externalArtifact: ExternalArtifactReferenceSchema.optional(), repositoryState: RepositoryStateReferenceSchema.optional(), stale: z.boolean().optional(), producedAt: TimestampSchema,
}).superRefine((artifact, ctx) => {
  if (!artifact.requestId && !artifact.source) ctx.addIssue({ code: "custom", message: "Evidence must describe its origin", path: ["requestId"] });
  if (artifact.type === "command_result" && (typeof artifact.payload !== "object" || artifact.payload === null || Array.isArray(artifact.payload) || typeof artifact.payload.exitCode !== "number")) ctx.addIssue({ code: "custom", message: "Command results must retain a numeric exitCode", path: ["payload", "exitCode"] });
});

export const ImplementationAttemptReferenceSchema = portableObject({ id: IdSchema, sequence: z.number().int().positive(), startedAt: TimestampSchema, completedAt: TimestampSchema.optional(), changedFiles: z.array(RepositoryPathSchema).optional() });
export const RunFailureSchema = portableObject({ code: NonEmptyStringSchema, message: NonEmptyStringSchema, retryable: z.boolean().optional() });
export const ConduitRunSchema = artifactObject({
  ...envelope("run"), goalId: IdSchema, goalRevision: z.number().int().positive(),
  conduitDesktopVersion: NonEmptyStringSchema.optional(), conduitRuntimeVersion: NonEmptyStringSchema,
  status: z.enum(["created", "analyzing_goal", "awaiting_goal_answers", "awaiting_goal_approval", "planning", "implementing", "general_review", "specialist_review", "collecting_evidence", "awaiting_user_input", "revising", "reporting", "completed", "failed", "cancelled"]),
  activeStage: NonEmptyStringSchema.optional(), implementationAttempts: z.array(ImplementationAttemptReferenceSchema), reviewResultIds: z.array(IdSchema), evidenceArtifactIds: z.array(IdSchema),
  startedAt: TimestampSchema.optional(), completedAt: TimestampSchema.optional(), failure: RunFailureSchema.optional(),
});

export const ClarificationSummarySchema = portableObject({ decisions: z.array(NonEmptyStringSchema), questionBatchIds: z.array(IdSchema), answerBatchIds: z.array(IdSchema) });
export const ImplementationSummarySchema = portableObject({ summary: NonEmptyStringSchema, filesAdded: z.array(RepositoryPathSchema), filesChanged: z.array(RepositoryPathSchema), filesDeleted: z.array(RepositoryPathSchema), attempts: z.number().int().nonnegative() });
export const ValidationSummarySchema = portableObject({ passed: z.boolean(), summary: NonEmptyStringSchema, evidenceArtifactIds: z.array(IdSchema) });
export const ReviewerSummarySchema = portableObject({ reviewerId: NonEmptyStringSchema, status: z.enum(["approved", "changes_requested", "blocked", "insufficient_evidence", "error"]), summary: NonEmptyStringSchema, reviewResultId: IdSchema });
export const EvidenceSummarySchema = portableObject({ summary: NonEmptyStringSchema, artifactIds: z.array(IdSchema), staleArtifactIds: z.array(IdSchema) });
export const KnownRiskSchema = portableObject({ id: IdSchema, description: NonEmptyStringSchema, severity: z.enum(["low", "medium", "high", "critical"]) });
export const SuggestedFollowUpSchema = portableObject({ id: IdSchema, description: NonEmptyStringSchema, priority: z.enum(["optional", "recommended", "required"]) });
export const GoalReportSchema = artifactObject({
  ...envelope("report"), runId: IdSchema, goalId: IdSchema, goalRevision: z.number().int().positive(),
  decision: z.enum(["completed", "completed_with_warnings", "not_completed", "blocked"]), summary: NonEmptyStringSchema,
  goalSnapshot: GoalSpecificationSchema, clarificationSummary: ClarificationSummarySchema, implementationSummary: ImplementationSummarySchema,
  validationSummary: ValidationSummarySchema, reviewerSummaries: z.array(ReviewerSummarySchema), evidenceSummary: EvidenceSummarySchema,
  knownRisks: z.array(KnownRiskSchema), suggestedFollowUps: z.array(SuggestedFollowUpSchema), generatedAt: TimestampSchema,
}).superRefine((report, ctx) => {
  if (report.goalSnapshot.id !== report.goalId || report.goalSnapshot.revision !== report.goalRevision) ctx.addIssue({ code: "custom", message: "Report goal snapshot must match goalId and goalRevision", path: ["goalSnapshot"] });
});

export type CgsArtifactValue =
  | z.infer<typeof GoalSpecificationSchema> | z.infer<typeof QuestionBatchSchema> | z.infer<typeof AnswerBatchSchema>
  | z.infer<typeof ReviewRequestSchema> | z.infer<typeof ReviewResultSchema> | z.infer<typeof EvidenceRequestSchema>
  | z.infer<typeof EvidenceArtifactSchema> | z.infer<typeof ConduitRunSchema> | z.infer<typeof GoalReportSchema>;
export const CgsArtifactUnionSchema: z.ZodType<CgsArtifactValue> = z.union([
  GoalSpecificationSchema, QuestionBatchSchema, AnswerBatchSchema, ReviewRequestSchema, ReviewResultSchema,
  EvidenceRequestSchema, EvidenceArtifactSchema, ConduitRunSchema, GoalReportSchema,
]) as z.ZodType<CgsArtifactValue>;

export type GoalSpecification = z.infer<typeof GoalSpecificationSchema>;
export type VerificationHint = z.infer<typeof VerificationHintSchema>; export type SuccessCriterion = z.infer<typeof SuccessCriterionSchema>;
export type GoalConstraint = z.infer<typeof GoalConstraintSchema>; export type Deliverable = z.infer<typeof DeliverableSchema>; export type Assumption = z.infer<typeof AssumptionSchema>;
export type GoalPermissions = z.infer<typeof GoalPermissionsSchema>; export type ClarificationReference = z.infer<typeof ClarificationReferenceSchema>; export type ReviewPipelineSpecification = z.infer<typeof ReviewPipelineSpecificationSchema>; export type ReviewerRequirement = z.infer<typeof ReviewerRequirementSchema>;
export type GoalQuestion = z.infer<typeof GoalQuestionSchema>; export type QuestionOption = z.infer<typeof QuestionOptionSchema>; export type QuestionBatch = z.infer<typeof QuestionBatchSchema>; export type GoalAnswer = z.infer<typeof GoalAnswerSchema>; export type AnswerBatch = z.infer<typeof AnswerBatchSchema>;
export type ReviewRequest = z.infer<typeof ReviewRequestSchema>; export type ReviewResult = z.infer<typeof ReviewResultSchema>; export type ReviewFinding = z.infer<typeof ReviewFindingSchema>; export type CriterionReviewResult = z.infer<typeof CriterionReviewResultSchema>;
export type EvidenceRequest = z.infer<typeof EvidenceRequestSchema>; export type EvidenceArtifact = z.infer<typeof EvidenceArtifactSchema>; export type RepositoryStateReference = z.infer<typeof RepositoryStateReferenceSchema>; export type ExternalArtifactReference = z.infer<typeof ExternalArtifactReferenceSchema>;
export type ConduitRun = z.infer<typeof ConduitRunSchema>; export type GoalReport = z.infer<typeof GoalReportSchema>;
export const createCgsId = (prefix: string): string => `${prefix}_${globalThis.crypto.randomUUID()}`;
export const cgsVersionFields = () => ({ cgsVersion: CGS_VERSION });
