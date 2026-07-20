import { z } from "zod";

const GoalRunStatusSchema = z.enum([
  "idle",
  "running",
  "waiting_for_approval",
  "completed",
  "blocked",
  "cancelled",
  "failed",
  "iteration_limit_reached",
]);

const IdSchema = z.string().min(1);
const NonEmptyStringSchema = z.string().trim().min(1);
const TimestampSchema = z.string().datetime({ offset: true });

export const GoalContractVersionSchema = z.literal(1);

export const SuccessCriterionSchema = z.object({
  id: IdSchema,
  description: NonEmptyStringSchema,
  required: z.boolean(),
  verificationHint: NonEmptyStringSchema.optional(),
}).strict();

export const ConstraintSourceSchema = z.enum(["user", "repository", "policy", "generated"]);

export const ConstraintSchema = z.object({
  id: IdSchema,
  description: NonEmptyStringSchema,
  source: ConstraintSourceSchema,
}).strict();

export const DeliverableTypeSchema = z.enum([
  "implementation",
  "unit_tests",
  "integration_tests",
  "documentation",
  "migration",
  "benchmark",
  "other",
]);

export const DeliverableSchema = z.object({
  id: IdSchema,
  type: DeliverableTypeSchema,
  description: NonEmptyStringSchema,
  required: z.boolean(),
}).strict();

export const AssumptionSchema = z.object({
  id: IdSchema,
  description: NonEmptyStringSchema,
  confirmed: z.boolean(),
}).strict();

export const GoalQuestionOptionSchema = z.object({
  id: IdSchema,
  label: NonEmptyStringSchema,
  description: NonEmptyStringSchema.optional(),
  recommended: z.boolean().optional(),
}).strict();

const GoalQuestionBaseShape = {
  id: IdSchema,
  title: NonEmptyStringSchema,
  description: NonEmptyStringSchema.optional(),
  required: z.boolean(),
  sourceReason: NonEmptyStringSchema.optional(),
};

const GoalQuestionOptionsSchema = z.array(GoalQuestionOptionSchema).min(2).superRefine((options, ctx) => {
  const ids = new Set<string>();
  for (const [index, option] of options.entries()) {
    if (ids.has(option.id)) {
      ctx.addIssue({ code: "custom", message: "Question option IDs must be unique", path: [index, "id"] });
    }
    ids.add(option.id);
  }
});

export const SingleSelectQuestionSchema = z.object({
  ...GoalQuestionBaseShape,
  type: z.literal("single_select"),
  options: GoalQuestionOptionsSchema,
  defaultValue: IdSchema.optional(),
  allowCustomAnswer: z.boolean().optional(),
}).strict().superRefine((question, ctx) => {
  if (question.defaultValue && !question.options.some((option) => option.id === question.defaultValue)) {
    ctx.addIssue({ code: "custom", message: "Default value must reference an available option", path: ["defaultValue"] });
  }
});

export const MultiSelectQuestionSchema = z.object({
  ...GoalQuestionBaseShape,
  type: z.literal("multi_select"),
  options: GoalQuestionOptionsSchema,
  defaultValue: z.array(IdSchema).optional(),
  allowCustomAnswer: z.boolean().optional(),
}).strict().superRefine((question, ctx) => {
  const optionIds = new Set(question.options.map((option) => option.id));
  for (const [index, value] of (question.defaultValue ?? []).entries()) {
    if (!optionIds.has(value)) {
      ctx.addIssue({ code: "custom", message: "Default value must reference an available option", path: ["defaultValue", index] });
    }
  }
});

export const ConfirmationQuestionSchema = z.object({
  ...GoalQuestionBaseShape,
  type: z.literal("confirmation"),
  defaultValue: z.boolean().optional(),
}).strict();

export const TextQuestionSchema = z.object({
  ...GoalQuestionBaseShape,
  type: z.literal("text"),
  defaultValue: z.string().optional(),
}).strict();

export const RepositoryReferenceQuestionSchema = z.object({
  ...GoalQuestionBaseShape,
  type: z.literal("repository_reference"),
  options: GoalQuestionOptionsSchema,
  defaultValue: IdSchema.optional(),
  allowCustomAnswer: z.boolean().optional(),
}).strict().superRefine((question, ctx) => {
  if (question.defaultValue && !question.options.some((option) => option.id === question.defaultValue)) {
    ctx.addIssue({ code: "custom", message: "Default value must reference an available repository option", path: ["defaultValue"] });
  }
});

export const ConstraintEditorQuestionSchema = z.object({
  ...GoalQuestionBaseShape,
  type: z.literal("constraint_editor"),
  defaultValue: z.array(ConstraintSchema).optional(),
}).strict();

export const SuccessCriteriaEditorQuestionSchema = z.object({
  ...GoalQuestionBaseShape,
  type: z.literal("success_criteria_editor"),
  defaultValue: z.array(SuccessCriterionSchema).optional(),
}).strict();

export const GoalQuestionSchema = z.union([
  SingleSelectQuestionSchema,
  MultiSelectQuestionSchema,
  ConfirmationQuestionSchema,
  TextQuestionSchema,
  RepositoryReferenceQuestionSchema,
  ConstraintEditorQuestionSchema,
  SuccessCriteriaEditorQuestionSchema,
]);

export const GoalQuestionBatchSchema = z.object({
  id: IdSchema,
  title: NonEmptyStringSchema,
  position: z.number().int().nonnegative(),
  questions: z.array(GoalQuestionSchema).min(1).max(5),
}).strict();

export const GoalAnswerValueSchema = z.union([
  z.string(),
  z.boolean(),
  z.array(z.string()),
  z.array(ConstraintSchema),
  z.array(SuccessCriterionSchema),
  z.null(),
]);

export const GoalAnswerSchema = z.object({
  questionId: IdSchema,
  value: GoalAnswerValueSchema,
  answeredBy: z.enum(["user", "default"]),
  answeredAt: TimestampSchema,
}).strict();

export const GoalStatusSchema = z.enum([
  "draft",
  "awaiting_answers",
  "awaiting_approval",
  "approved",
  "running",
  "completed",
  "failed",
  "cancelled",
]);

export const GoalDefinitionSchema = z.object({
  schemaVersion: GoalContractVersionSchema,
  id: IdSchema,
  originalRequest: NonEmptyStringSchema,
  title: NonEmptyStringSchema,
  description: NonEmptyStringSchema,
  successCriteria: z.array(SuccessCriterionSchema).min(1),
  constraints: z.array(ConstraintSchema),
  deliverables: z.array(DeliverableSchema).min(1),
  assumptions: z.array(AssumptionSchema),
  answers: z.array(GoalAnswerSchema),
  status: GoalStatusSchema,
  version: z.number().int().positive(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
}).strict().superRefine((goal, ctx) => {
  if (Date.parse(goal.updatedAt) < Date.parse(goal.createdAt)) {
    ctx.addIssue({ code: "custom", message: "updatedAt cannot precede createdAt", path: ["updatedAt"] });
  }
});

export const GoalVersionSchema = z.object({
  goalId: IdSchema,
  version: z.number().int().positive(),
  definition: GoalDefinitionSchema,
  changeSummary: NonEmptyStringSchema,
  createdAt: TimestampSchema,
  createdBy: z.enum(["user", "goal_analyst", "runtime"]),
}).strict().superRefine((record, ctx) => {
  if (record.definition.id !== record.goalId) {
    ctx.addIssue({ code: "custom", message: "Goal version must reference the embedded goal", path: ["goalId"] });
  }
  if (record.definition.version !== record.version) {
    ctx.addIssue({ code: "custom", message: "Goal version number must match the embedded goal", path: ["version"] });
  }
});

export const GoalAmbiguitySchema = z.object({
  id: IdSchema,
  description: NonEmptyStringSchema,
  userDecisionRequired: z.boolean(),
  repositoryFacts: z.array(NonEmptyStringSchema),
}).strict();

export const GoalAnalystOutputSchema = z.object({
  decisionSummary: NonEmptyStringSchema,
  ambiguities: z.array(GoalAmbiguitySchema),
  questionBatches: z.array(GoalQuestionBatchSchema),
  proposedTitle: NonEmptyStringSchema,
  proposedDescription: NonEmptyStringSchema,
  proposedSuccessCriteria: z.array(SuccessCriterionSchema).min(1),
  proposedConstraints: z.array(ConstraintSchema),
  proposedDeliverables: z.array(DeliverableSchema).min(1),
  proposedAssumptions: z.array(AssumptionSchema),
}).strict().superRefine((analysis, ctx) => {
  const questionIds = new Set<string>();
  const batchIds = new Set<string>();
  for (const [batchIndex, batch] of analysis.questionBatches.entries()) {
    if (batchIds.has(batch.id)) {
      ctx.addIssue({ code: "custom", message: "Question batch IDs must be unique", path: ["questionBatches", batchIndex, "id"] });
    }
    batchIds.add(batch.id);
    for (const [questionIndex, question] of batch.questions.entries()) {
      if (questionIds.has(question.id)) {
        ctx.addIssue({
          code: "custom",
          message: "Question IDs must be unique across batches",
          path: ["questionBatches", batchIndex, "questions", questionIndex, "id"],
        });
      }
      questionIds.add(question.id);
    }
  }
});

export const EvidenceTypeSchema = z.enum([
  "command",
  "test",
  "build",
  "lint",
  "typecheck",
  "benchmark",
  "coverage",
  "file",
  "search",
  "diff",
  "dependency",
  "static_analysis",
  "user_answer",
]);

export const EvidenceFreshnessSchema = z.object({
  status: z.enum(["fresh", "stale"]),
  scopeFingerprint: NonEmptyStringSchema.optional(),
  staleReason: NonEmptyStringSchema.optional(),
  invalidatedAt: TimestampSchema.optional(),
}).strict().superRefine((freshness, ctx) => {
  if (freshness.status === "stale" && !freshness.staleReason) {
    ctx.addIssue({ code: "custom", message: "Stale evidence requires a reason", path: ["staleReason"] });
  }
  if (freshness.status === "fresh" && (freshness.staleReason || freshness.invalidatedAt)) {
    ctx.addIssue({ code: "custom", message: "Fresh evidence cannot include invalidation metadata" });
  }
});

export const EvidenceItemSchema = z.object({
  id: IdSchema,
  type: EvidenceTypeSchema,
  title: NonEmptyStringSchema,
  summary: NonEmptyStringSchema,
  command: NonEmptyStringSchema.optional(),
  exitCode: z.number().int().optional(),
  durationMs: z.number().nonnegative().optional(),
  workspacePath: NonEmptyStringSchema.optional(),
  filePath: NonEmptyStringSchema.optional(),
  contentLocation: NonEmptyStringSchema.optional(),
  artifactId: IdSchema.optional(),
  collectedBy: IdSchema,
  collectedAt: TimestampSchema,
  trusted: z.boolean(),
  executionOutcome: z.enum(["passed", "failed", "blocked_environment", "skipped"]).optional(),
  limitation: NonEmptyStringSchema.optional(),
  freshness: EvidenceFreshnessSchema,
}).strict();

export const EvidenceRequestStatusSchema = z.enum([
  "pending",
  "approved",
  "collected",
  "blocked_environment",
  "failed",
  "rejected",
  "stale",
]);

export const EvidenceRequestSchema = z.object({
  id: IdSchema,
  reviewerId: IdSchema,
  type: EvidenceTypeSchema,
  description: NonEmptyStringSchema,
  required: z.boolean(),
  suggestedCommand: NonEmptyStringSchema.optional(),
  expectedOutcome: NonEmptyStringSchema.optional(),
  status: EvidenceRequestStatusSchema,
  permissionDecision: z.enum(["pending", "not_required", "approved", "rejected"]).optional(),
  attempts: z.number().int().nonnegative().optional(),
  lastAttemptAt: TimestampSchema.optional(),
  evidenceIds: z.array(IdSchema).default([]),
  requestedAt: TimestampSchema,
  resolvedAt: TimestampSchema.optional(),
}).strict();

export const NormalizedValidationResultSchema = z.object({
  id: IdSchema,
  type: z.enum(["test", "build", "lint", "typecheck", "benchmark", "coverage", "static_analysis", "command"]),
  command: NonEmptyStringSchema,
  passed: z.boolean(),
  outcome: z.enum(["passed", "failed", "blocked_environment", "skipped"]).optional(),
  limitation: NonEmptyStringSchema.optional(),
  exitCode: z.number().int(),
  durationMs: z.number().nonnegative(),
  summary: NonEmptyStringSchema,
  artifactId: IdSchema.optional(),
  collectedAt: TimestampSchema,
}).strict();

export const RepositoryFileReferenceSchema = z.object({
  path: NonEmptyStringSchema,
  reason: NonEmptyStringSchema,
  contentLocation: NonEmptyStringSchema.optional(),
}).strict();

export const RepositoryContextSchema = z.object({
  workspacePath: NonEmptyStringSchema,
  summary: NonEmptyStringSchema,
  languages: z.array(NonEmptyStringSchema),
  frameworks: z.array(NonEmptyStringSchema),
  packageManager: NonEmptyStringSchema.optional(),
  testFrameworks: z.array(NonEmptyStringSchema),
  instructions: z.array(RepositoryFileReferenceSchema),
  relevantFiles: z.array(RepositoryFileReferenceSchema),
  preparedAt: TimestampSchema,
}).strict();

export const RepositoryChangeSchema = z.object({
  path: NonEmptyStringSchema,
  status: z.enum(["added", "modified", "deleted", "renamed"]),
  previousPath: NonEmptyStringSchema.optional(),
  additions: z.number().int().nonnegative().optional(),
  deletions: z.number().int().nonnegative().optional(),
}).strict();

export const RepositoryDiffSchema = z.object({
  baseRevision: NonEmptyStringSchema.optional(),
  patchArtifactId: IdSchema.optional(),
  changes: z.array(RepositoryChangeSchema),
  collectedAt: TimestampSchema,
}).strict();

export const ReviewerDefinitionSchema = z.object({
  id: IdSchema,
  name: NonEmptyStringSchema,
  description: NonEmptyStringSchema,
  responsibility: NonEmptyStringSchema,
}).strict();

export const ReviewStatusSchema = z.enum([
  "approved",
  "approved_with_warnings",
  "changes_requested",
  "blocked",
  "needs_evidence",
  "not_applicable",
]);

export const ReviewSeveritySchema = z.enum(["info", "low", "medium", "high", "critical"]);

export const ReviewFindingSchema = z.object({
  id: IdSchema,
  severity: ReviewSeveritySchema,
  title: NonEmptyStringSchema,
  description: NonEmptyStringSchema,
  filePath: NonEmptyStringSchema.optional(),
  lineStart: z.number().int().positive().optional(),
  lineEnd: z.number().int().positive().optional(),
  criterionId: IdSchema.optional(),
  remediation: NonEmptyStringSchema.optional(),
}).strict().superRefine((finding, ctx) => {
  if ((finding.lineStart || finding.lineEnd) && !finding.filePath) {
    ctx.addIssue({ code: "custom", message: "Line locations require a filePath", path: ["filePath"] });
  }
  if (finding.lineEnd && !finding.lineStart) {
    ctx.addIssue({ code: "custom", message: "lineEnd requires lineStart", path: ["lineEnd"] });
  }
  if (finding.lineStart && finding.lineEnd && finding.lineEnd < finding.lineStart) {
    ctx.addIssue({ code: "custom", message: "lineEnd cannot precede lineStart", path: ["lineEnd"] });
  }
});

export const ReviewResultSchema = z.object({
  id: IdSchema,
  reviewerId: IdSchema,
  status: ReviewStatusSchema,
  confidence: z.number().min(0).max(1),
  summary: NonEmptyStringSchema,
  findings: z.array(ReviewFindingSchema),
  evidenceRequests: z.array(EvidenceRequestSchema),
  reviewedAt: TimestampSchema,
  supersedesReviewId: IdSchema.optional(),
}).strict().superRefine((review, ctx) => {
  const findingIds = new Set<string>();
  for (const [index, finding] of review.findings.entries()) {
    if (findingIds.has(finding.id)) {
      ctx.addIssue({ code: "custom", message: "Finding IDs must be unique within a review", path: ["findings", index, "id"] });
    }
    findingIds.add(finding.id);
  }
});

export const ReviewInputSchema = z.object({
  goal: GoalDefinitionSchema,
  repositoryContext: RepositoryContextSchema,
  diff: RepositoryDiffSchema,
  validationResults: z.array(NormalizedValidationResultSchema),
  availableEvidence: z.array(EvidenceItemSchema),
  previousReview: ReviewResultSchema.optional(),
}).strict();

export const ReviewRoutingDecisionSchema = z.object({
  goalStatus: z.enum(["incomplete", "implemented", "blocked", "needs_evidence"]),
  confidence: z.number().min(0).max(1),
  requiredReviewers: z.array(IdSchema),
  optionalReviewers: z.array(IdSchema),
  decisionSummary: NonEmptyStringSchema,
  evidenceIds: z.array(IdSchema),
  decidedAt: TimestampSchema,
}).strict();

export const CriterionReportSchema = z.object({
  criterionId: IdSchema,
  status: z.enum(["passed", "warning", "failed", "blocked", "not_verified"]),
  summary: NonEmptyStringSchema,
  evidenceIds: z.array(IdSchema),
  reviewFindingIds: z.array(IdSchema),
  limitations: z.array(NonEmptyStringSchema),
}).strict();

export const ClarificationRecordSchema = z.object({
  question: GoalQuestionSchema,
  answer: GoalAnswerSchema,
  resultingGoalVersion: z.number().int().positive(),
}).strict();

export const ReportOverviewSchema = z.object({
  finalStatus: z.enum(["achieved", "not_achieved", "failed", "cancelled", "blocked"]),
  conduitDesktopVersion: NonEmptyStringSchema.optional(),
  conduitRuntimeVersion: NonEmptyStringSchema.optional(),
  cgsVersion: NonEmptyStringSchema.optional(),
  startedAt: TimestampSchema,
  finishedAt: TimestampSchema,
  implementationModelId: IdSchema,
  reviewerModelIds: z.array(IdSchema),
  totalIterations: z.number().int().nonnegative(),
  runtimeMs: z.number().nonnegative(),
  estimatedCost: z.number().nonnegative().optional(),
  tokenUsage: z.object({
    promptTokens: z.number().int().nonnegative(),
    completionTokens: z.number().int().nonnegative(),
    totalTokens: z.number().int().nonnegative(),
    cacheReadTokens: z.number().int().nonnegative().optional(),
    cacheWriteTokens: z.number().int().nonnegative().optional(),
  }).strict().optional(),
}).strict();

export const ImplementationSummarySchema = z.object({
  summary: NonEmptyStringSchema,
  filesAdded: z.array(NonEmptyStringSchema),
  filesChanged: z.array(NonEmptyStringSchema),
  filesDeleted: z.array(NonEmptyStringSchema),
  decisions: z.array(NonEmptyStringSchema),
  commands: z.array(NonEmptyStringSchema),
}).strict();

export const FinalDecisionSchema = z.object({
  achieved: z.boolean(),
  summary: NonEmptyStringSchema,
  requiredReviewsPassed: z.boolean(),
  unresolvedFindingIds: z.array(IdSchema),
  unresolvedEvidenceRequestIds: z.array(IdSchema),
  warnings: z.array(NonEmptyStringSchema),
  followUps: z.array(NonEmptyStringSchema),
}).strict();

export const GoalReportSchema = z.object({
  schemaVersion: GoalContractVersionSchema,
  id: IdSchema,
  runId: IdSchema,
  goal: GoalDefinitionSchema,
  overview: ReportOverviewSchema,
  clarifications: z.array(ClarificationRecordSchema),
  implementation: ImplementationSummarySchema,
  criteria: z.array(CriterionReportSchema),
  validationResults: z.array(NormalizedValidationResultSchema),
  reviews: z.array(ReviewResultSchema),
  evidence: z.array(EvidenceItemSchema),
  finalDecision: FinalDecisionSchema,
  generatedAt: TimestampSchema,
}).strict();

export const ReportExportMetadataSchema = z.object({
  reportId: IdSchema,
  reportSchemaVersion: GoalContractVersionSchema,
  format: z.enum(["markdown", "json"]),
  exportedAt: TimestampSchema,
  redacted: z.boolean(),
}).strict();

export const GoalReportExportSchema = z.object({
  metadata: ReportExportMetadataSchema,
  report: GoalReportSchema,
}).strict();

export const GoalWorkflowPhaseSchema = z.enum([
  "analyzing_goal",
  "awaiting_goal_answers",
  "building_goal",
  "awaiting_goal_approval",
  "planning",
  "implementing",
  "validating",
  "general_review",
  "routing_reviews",
  "specialist_review",
  "collecting_evidence",
  "awaiting_user_input",
  "revising",
  "reporting",
  "completed",
  "failed",
  "cancelled",
]);

const WorkflowEventBaseShape = {
  id: IdSchema,
  runId: IdSchema,
  occurredAt: TimestampSchema,
};

export const GoalWorkflowEventSchema = z.discriminatedUnion("type", [
  z.object({ ...WorkflowEventBaseShape, type: z.literal("workflow_state_transitioned"), from: GoalWorkflowPhaseSchema.nullable(), to: GoalWorkflowPhaseSchema, summary: NonEmptyStringSchema }).strict(),
  z.object({ ...WorkflowEventBaseShape, type: z.literal("goal_version_created"), goalId: IdSchema, version: z.number().int().positive() }).strict(),
  z.object({ ...WorkflowEventBaseShape, type: z.literal("question_batch_requested"), batchId: IdSchema }).strict(),
  z.object({ ...WorkflowEventBaseShape, type: z.literal("answer_recorded"), questionId: IdSchema }).strict(),
  z.object({ ...WorkflowEventBaseShape, type: z.literal("goal_approved"), goalId: IdSchema, version: z.number().int().positive() }).strict(),
  z.object({ ...WorkflowEventBaseShape, type: z.literal("review_routed"), requiredReviewerIds: z.array(IdSchema), optionalReviewerIds: z.array(IdSchema) }).strict(),
  z.object({ ...WorkflowEventBaseShape, type: z.literal("review_completed"), reviewId: IdSchema, reviewerId: IdSchema, status: ReviewStatusSchema }).strict(),
  z.object({ ...WorkflowEventBaseShape, type: z.literal("evidence_requested"), requestId: IdSchema, reviewerId: IdSchema }).strict(),
  z.object({ ...WorkflowEventBaseShape, type: z.literal("evidence_collected"), evidenceId: IdSchema, requestId: IdSchema.optional() }).strict(),
  z.object({ ...WorkflowEventBaseShape, type: z.literal("report_created"), reportId: IdSchema }).strict(),
]);

export const GoalDrivenRunRecordSchema = z.object({
  formatVersion: z.literal(1),
  conduitDesktopVersion: NonEmptyStringSchema.optional(),
  conduitRuntimeVersion: NonEmptyStringSchema.optional(),
  cgsVersion: NonEmptyStringSchema.optional(),
  id: IdSchema,
  goalId: IdSchema,
  activeGoalVersion: z.number().int().positive(),
  workflowPhase: GoalWorkflowPhaseSchema,
  workspacePath: NonEmptyStringSchema,
  startedAt: TimestampSchema,
  updatedAt: TimestampSchema,
  finishedAt: TimestampSchema.optional(),
}).strict().superRefine((run, ctx) => {
  if (Date.parse(run.updatedAt) < Date.parse(run.startedAt)) {
    ctx.addIssue({ code: "custom", message: "updatedAt cannot precede startedAt", path: ["updatedAt"] });
  }
  if (run.finishedAt && Date.parse(run.finishedAt) < Date.parse(run.startedAt)) {
    ctx.addIssue({ code: "custom", message: "finishedAt cannot precede startedAt", path: ["finishedAt"] });
  }
});

/**
 * Compatibility boundary for v0.2 run records. It is intentionally isolated
 * from the strict v0.3 contracts so later migrations can identify legacy data.
 */
export const LegacyGoalRunStateSchema = z.object({
  id: IdSchema,
  goal: NonEmptyStringSchema,
  workspacePath: NonEmptyStringSchema,
  status: GoalRunStatusSchema,
  codingModelId: IdSchema,
  judgeModelId: IdSchema,
  iteration: z.number().int().nonnegative(),
  maxIterations: z.number().int().positive(),
  iterations: z.array(z.unknown()),
  startedAt: TimestampSchema,
  finishedAt: TimestampSchema.optional(),
}).passthrough().superRefine((run, ctx) => {
  if ("formatVersion" in run) {
    ctx.addIssue({ code: "custom", message: "Versioned run records cannot be parsed as legacy", path: ["formatVersion"] });
  }
});

export const CompatiblePersistedRunSchema = z.union([
  GoalDrivenRunRecordSchema,
  LegacyGoalRunStateSchema,
]);

export type SuccessCriterion = z.infer<typeof SuccessCriterionSchema>;
export type Constraint = z.infer<typeof ConstraintSchema>;
export type Deliverable = z.infer<typeof DeliverableSchema>;
export type Assumption = z.infer<typeof AssumptionSchema>;
export type GoalQuestionOption = z.infer<typeof GoalQuestionOptionSchema>;
export type GoalQuestion = z.infer<typeof GoalQuestionSchema>;
export type GoalQuestionBatch = z.infer<typeof GoalQuestionBatchSchema>;
export type GoalAnswerValue = z.infer<typeof GoalAnswerValueSchema>;
export type GoalAnswer = z.infer<typeof GoalAnswerSchema>;
export type GoalStatus = z.infer<typeof GoalStatusSchema>;
export type GoalDefinition = z.infer<typeof GoalDefinitionSchema>;
export type GoalVersion = z.infer<typeof GoalVersionSchema>;
export type GoalAmbiguity = z.infer<typeof GoalAmbiguitySchema>;
export type GoalAnalystOutput = z.infer<typeof GoalAnalystOutputSchema>;
export type EvidenceType = z.infer<typeof EvidenceTypeSchema>;
export type EvidenceFreshness = z.infer<typeof EvidenceFreshnessSchema>;
export type EvidenceItem = z.infer<typeof EvidenceItemSchema>;
export type EvidenceRequestStatus = z.infer<typeof EvidenceRequestStatusSchema>;
export type EvidenceRequest = z.infer<typeof EvidenceRequestSchema>;
export type NormalizedValidationResult = z.infer<typeof NormalizedValidationResultSchema>;
export type RepositoryFileReference = z.infer<typeof RepositoryFileReferenceSchema>;
export type RepositoryContext = z.infer<typeof RepositoryContextSchema>;
export type RepositoryChange = z.infer<typeof RepositoryChangeSchema>;
export type RepositoryDiff = z.infer<typeof RepositoryDiffSchema>;
export type ReviewerDefinition = z.infer<typeof ReviewerDefinitionSchema>;
export type ReviewStatus = z.infer<typeof ReviewStatusSchema>;
export type ReviewSeverity = z.infer<typeof ReviewSeveritySchema>;
export type ReviewFinding = z.infer<typeof ReviewFindingSchema>;
export type ReviewInput = z.infer<typeof ReviewInputSchema>;
export type ReviewResult = z.infer<typeof ReviewResultSchema>;
export type ReviewRoutingDecision = z.infer<typeof ReviewRoutingDecisionSchema>;
export type CriterionReport = z.infer<typeof CriterionReportSchema>;
export type ClarificationRecord = z.infer<typeof ClarificationRecordSchema>;
export type ReportOverview = z.infer<typeof ReportOverviewSchema>;
export type ImplementationSummary = z.infer<typeof ImplementationSummarySchema>;
export type FinalDecision = z.infer<typeof FinalDecisionSchema>;
export type GoalReport = z.infer<typeof GoalReportSchema>;
export type ReportExportMetadata = z.infer<typeof ReportExportMetadataSchema>;
export type GoalReportExport = z.infer<typeof GoalReportExportSchema>;
export type GoalWorkflowPhase = z.infer<typeof GoalWorkflowPhaseSchema>;
export type GoalWorkflowEvent = z.infer<typeof GoalWorkflowEventSchema>;
export type GoalDrivenRunRecord = z.infer<typeof GoalDrivenRunRecordSchema>;
export type CompatiblePersistedRun = z.infer<typeof CompatiblePersistedRunSchema>;
