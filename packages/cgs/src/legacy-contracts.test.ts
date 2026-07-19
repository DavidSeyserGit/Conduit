import assert from "node:assert/strict";
import test from "node:test";
import {
  CompatiblePersistedRunSchema,
  EvidenceFreshnessSchema,
  EvidenceItemSchema,
  EvidenceRequestSchema,
  GoalDefinitionSchema,
  GoalAnalystOutputSchema,
  GoalQuestionBatchSchema,
  GoalQuestionSchema,
  GoalReportSchema,
  GoalVersionSchema,
  GoalWorkflowEventSchema,
  NormalizedValidationResultSchema,
  RepositoryContextSchema,
  RepositoryDiffSchema,
  ReviewFindingSchema,
  ReviewInputSchema,
  ReviewResultSchema,
  ReviewRoutingDecisionSchema,
  ReviewerDefinitionSchema,
} from "./legacy-contracts.js";

const at = "2026-07-18T08:00:00.000Z";
const later = "2026-07-18T08:01:00.000Z";

const criterion = {
  id: "criterion-1",
  description: "The requested behavior works",
  required: true,
  verificationHint: "Run the focused test",
};

const constraint = {
  id: "constraint-1",
  description: "Preserve existing behavior",
  source: "user" as const,
};

const answer = {
  questionId: "question-1",
  value: true,
  answeredBy: "user" as const,
  answeredAt: at,
};

const goal = {
  schemaVersion: 1 as const,
  id: "goal-1",
  originalRequest: "Add the requested behavior",
  title: "Add behavior",
  description: "Implement the behavior without regressions.",
  successCriteria: [criterion],
  constraints: [constraint],
  deliverables: [{ id: "deliverable-1", type: "implementation" as const, description: "Implementation", required: true }],
  assumptions: [{ id: "assumption-1", description: "Existing API remains stable", confirmed: true }],
  answers: [answer],
  status: "approved" as const,
  version: 1,
  createdAt: at,
  updatedAt: later,
};

const repositoryContext = {
  workspacePath: "/tmp/repository",
  summary: "A TypeScript workspace",
  languages: ["TypeScript"],
  frameworks: ["React"],
  packageManager: "pnpm",
  testFrameworks: ["node:test"],
  instructions: [{ path: "AGENTS.md", reason: "Repository instructions" }],
  relevantFiles: [{ path: "src/index.ts", reason: "Feature entrypoint" }],
  preparedAt: at,
};

const diff = {
  baseRevision: "abc123",
  patchArtifactId: "artifact-diff",
  changes: [{ path: "src/index.ts", status: "modified" as const, additions: 4, deletions: 1 }],
  collectedAt: at,
};

const validation = {
  id: "validation-1",
  type: "test" as const,
  command: "pnpm test",
  passed: true,
  exitCode: 0,
  durationMs: 125,
  summary: "All tests passed",
  artifactId: "artifact-test",
  collectedAt: at,
};

const evidence = {
  id: "evidence-1",
  type: "test" as const,
  title: "Focused test",
  summary: "The regression test passed",
  command: "pnpm test",
  exitCode: 0,
  artifactId: "artifact-test",
  collectedBy: "runtime",
  collectedAt: at,
  trusted: true,
  freshness: { status: "fresh" as const, scopeFingerprint: "tree:abc123" },
};

const evidenceRequest = {
  id: "request-1",
  reviewerId: "testing",
  type: "test" as const,
  description: "Run the focused regression test",
  required: true,
  suggestedCommand: "pnpm test",
  expectedOutcome: "Exit code 0",
  status: "collected" as const,
  evidenceIds: [evidence.id],
  requestedAt: at,
  resolvedAt: later,
};

const finding = {
  id: "finding-1",
  severity: "low" as const,
  title: "Small follow-up",
  description: "A non-blocking improvement remains.",
  filePath: "src/index.ts",
  lineStart: 2,
  lineEnd: 3,
  criterionId: criterion.id,
  remediation: "Consider simplifying this later.",
};

const review = {
  id: "review-1",
  reviewerId: "testing",
  status: "approved_with_warnings" as const,
  confidence: 0.92,
  summary: "Required behavior is covered.",
  findings: [finding],
  evidenceRequests: [evidenceRequest],
  reviewedAt: later,
};

test("structured goal schemas accept a complete versioned goal", () => {
  assert.deepEqual(GoalDefinitionSchema.parse(goal), goal);
  assert.equal(GoalVersionSchema.parse({
    goalId: goal.id,
    version: goal.version,
    definition: goal,
    changeSummary: "Initial approved goal",
    createdAt: later,
    createdBy: "user",
  }).version, 1);
});

test("structured goals reject future versions, unknown fields, and invalid chronology", () => {
  assert.equal(GoalDefinitionSchema.safeParse({ ...goal, schemaVersion: 2 }).success, false);
  assert.equal(GoalDefinitionSchema.safeParse({ ...goal, arbitraryUiCode: "<script />" }).success, false);
  assert.equal(GoalDefinitionSchema.safeParse({ ...goal, createdAt: later, updatedAt: at }).success, false);
  assert.equal(GoalVersionSchema.safeParse({
    goalId: goal.id,
    version: 2,
    definition: goal,
    changeSummary: "Mismatch",
    createdAt: later,
    createdBy: "runtime",
  }).success, false);
});

test("all native question variants parse through one strict question contract", () => {
  const base = { id: "question-1", title: "Choose", required: true, sourceReason: "Intent is ambiguous" };
  const option = { id: "choice-1", label: "Choice", recommended: true };
  const secondOption = { id: "choice-2", label: "Alternative" };
  const questions = [
    { ...base, type: "single_select", options: [option, secondOption], defaultValue: option.id, allowCustomAnswer: true },
    { ...base, id: "question-2", type: "multi_select", options: [option, secondOption], defaultValue: [option.id] },
    { ...base, id: "question-3", type: "confirmation", defaultValue: true },
    { ...base, id: "question-4", type: "text", defaultValue: "Context" },
    { ...base, id: "question-5", type: "repository_reference", options: [option, secondOption], defaultValue: option.id },
    { ...base, id: "question-6", type: "constraint_editor", defaultValue: [constraint] },
    { ...base, id: "question-7", type: "success_criteria_editor", defaultValue: [criterion] },
  ];

  for (const question of questions) assert.equal(GoalQuestionSchema.safeParse(question).success, true);
  assert.equal(GoalQuestionBatchSchema.parse({ id: "batch-1", title: "Required behavior", position: 0, questions: questions.slice(0, 5) }).questions.length, 5);
});

test("question contracts reject arbitrary UI data and invalid defaults", () => {
  const invalidDefault = {
    id: "question-1",
    type: "single_select",
    title: "Choose",
    required: true,
    options: [{ id: "known", label: "Known" }],
    defaultValue: "missing",
  };
  assert.equal(GoalQuestionSchema.safeParse(invalidDefault).success, false);
  assert.equal(GoalQuestionSchema.safeParse({ ...invalidDefault, defaultValue: "known", render: "<button>Unsafe</button>" }).success, false);
  assert.equal(GoalQuestionBatchSchema.safeParse({
    id: "batch-1",
    title: "Too many",
    position: 0,
    questions: Array.from({ length: 6 }, (_, index) => ({ ...invalidDefault, id: `q-${index}`, defaultValue: "known" })),
  }).success, false);
});

test("Goal Analyst output is strict and keeps question identifiers unique across batches", () => {
  const question = { id: "product-choice", type: "confirmation" as const, title: "Enable persistence?", required: true, defaultValue: true };
  const output = {
    decisionSummary: "One product decision remains.",
    ambiguities: [{ id: "persistence", description: "Preference persistence", userDecisionRequired: true, repositoryFacts: ["Settings storage exists"] }],
    questionBatches: [{ id: "behavior", title: "Behavior", position: 0, questions: [question] }],
    proposedTitle: goal.title,
    proposedDescription: goal.description,
    proposedSuccessCriteria: goal.successCriteria,
    proposedConstraints: goal.constraints,
    proposedDeliverables: goal.deliverables,
    proposedAssumptions: goal.assumptions,
  };
  assert.equal(GoalAnalystOutputSchema.safeParse(output).success, true);
  assert.equal(GoalAnalystOutputSchema.safeParse({
    ...output,
    questionBatches: [
      ...output.questionBatches,
      { id: "permissions", title: "Permissions", position: 1, questions: [question] },
    ],
  }).success, false);
  assert.equal(GoalAnalystOutputSchema.safeParse({ ...output, arbitraryUiCode: "<form />" }).success, false);
});

test("repository, validation, evidence, and reviewer contracts compose", () => {
  assert.equal(RepositoryContextSchema.safeParse(repositoryContext).success, true);
  assert.equal(RepositoryDiffSchema.safeParse(diff).success, true);
  assert.equal(NormalizedValidationResultSchema.safeParse(validation).success, true);
  assert.equal(EvidenceItemSchema.safeParse(evidence).success, true);
  assert.equal(EvidenceRequestSchema.safeParse(evidenceRequest).success, true);
  assert.equal(ReviewerDefinitionSchema.safeParse({ id: "testing", name: "Testing", description: "Reviews tests", responsibility: "Test quality" }).success, true);
  assert.equal(ReviewFindingSchema.safeParse(finding).success, true);
  assert.equal(ReviewResultSchema.safeParse(review).success, true);
  assert.equal(ReviewInputSchema.safeParse({ goal, repositoryContext, diff, validationResults: [validation], availableEvidence: [evidence] }).success, true);
  assert.equal(ReviewRoutingDecisionSchema.safeParse({
    goalStatus: "implemented",
    confidence: 0.9,
    requiredReviewers: ["testing"],
    optionalReviewers: ["documentation"],
    decisionSummary: "Implementation changes behavior and tests.",
    evidenceIds: [evidence.id],
    decidedAt: later,
  }).success, true);
});

test("review and evidence invariants reject unsafe or inconsistent data", () => {
  assert.equal(ReviewFindingSchema.safeParse({ ...finding, lineStart: 5, lineEnd: 2 }).success, false);
  assert.equal(ReviewFindingSchema.safeParse({ ...finding, filePath: undefined }).success, false);
  assert.equal(ReviewResultSchema.safeParse({ ...review, confidence: 1.1 }).success, false);
  assert.equal(ReviewResultSchema.safeParse({ ...review, findings: [finding, finding] }).success, false);
  assert.equal(EvidenceFreshnessSchema.safeParse({ status: "stale" }).success, false);
  assert.equal(EvidenceFreshnessSchema.safeParse({ status: "fresh", staleReason: "changed" }).success, false);
  assert.equal(EvidenceRequestSchema.safeParse({ ...evidenceRequest, unexpectedCommandAuthority: true }).success, false);
});

test("workflow events serialize every v0.3 transition and domain reference", () => {
  const events = [
    { id: "event-1", runId: "run-1", occurredAt: at, type: "workflow_state_transitioned", from: null, to: "analyzing_goal", summary: "Started analysis" },
    { id: "event-2", runId: "run-1", occurredAt: at, type: "goal_version_created", goalId: goal.id, version: 1 },
    { id: "event-3", runId: "run-1", occurredAt: at, type: "question_batch_requested", batchId: "batch-1" },
    { id: "event-4", runId: "run-1", occurredAt: at, type: "answer_recorded", questionId: "question-1" },
    { id: "event-5", runId: "run-1", occurredAt: at, type: "goal_approved", goalId: goal.id, version: 1 },
    { id: "event-6", runId: "run-1", occurredAt: at, type: "review_routed", requiredReviewerIds: ["testing"], optionalReviewerIds: [] },
    { id: "event-7", runId: "run-1", occurredAt: at, type: "review_completed", reviewId: review.id, reviewerId: "testing", status: "approved_with_warnings" },
    { id: "event-8", runId: "run-1", occurredAt: at, type: "evidence_requested", requestId: evidenceRequest.id, reviewerId: "testing" },
    { id: "event-9", runId: "run-1", occurredAt: at, type: "evidence_collected", evidenceId: evidence.id, requestId: evidenceRequest.id },
    { id: "event-10", runId: "run-1", occurredAt: at, type: "report_created", reportId: "report-1" },
  ];

  for (const event of events) {
    const parsed = GoalWorkflowEventSchema.parse(JSON.parse(JSON.stringify(event)));
    assert.equal(parsed.type, event.type);
  }
});

test("professional report contract links goals, criteria, reviews, and evidence", () => {
  const report = {
    schemaVersion: 1,
    id: "report-1",
    runId: "run-1",
    goal,
    overview: {
      finalStatus: "achieved",
      startedAt: at,
      finishedAt: later,
      implementationModelId: "codex/model",
      reviewerModelIds: ["openrouter/reviewer"],
      totalIterations: 1,
      runtimeMs: 60_000,
      estimatedCost: 0.1,
    },
    clarifications: [],
    implementation: {
      summary: "Implemented the requested behavior.",
      filesAdded: [],
      filesChanged: ["src/index.ts"],
      filesDeleted: [],
      decisions: ["Preserved the existing API"],
      commands: ["pnpm test"],
    },
    criteria: [{
      criterionId: criterion.id,
      status: "passed",
      summary: "Behavior and regression coverage verified.",
      evidenceIds: [evidence.id],
      reviewFindingIds: [finding.id],
      limitations: [],
    }],
    validationResults: [validation],
    reviews: [review],
    evidence: [evidence],
    finalDecision: {
      achieved: true,
      summary: "All required reviews passed.",
      requiredReviewsPassed: true,
      unresolvedFindingIds: [],
      unresolvedEvidenceRequestIds: [],
      warnings: [finding.title],
      followUps: [],
    },
    generatedAt: later,
  };

  assert.equal(GoalReportSchema.parse(report).criteria[0]?.evidenceIds[0], evidence.id);
  assert.equal(GoalReportSchema.safeParse({ ...report, arbitraryTranscript: "private reasoning" }).success, false);
});

test("persisted-run compatibility accepts v0.2 and strict v0.3 records only", () => {
  const legacy = {
    id: "legacy-run",
    goal: "Legacy request",
    workspacePath: "/tmp/repository",
    status: "completed",
    codingModelId: "codex/model",
    judgeModelId: "openrouter/model",
    iteration: 1,
    maxIterations: 3,
    iterations: [],
    startedAt: at,
    finishedAt: later,
    baselineTree: "abc123",
  };
  const current = {
    formatVersion: 1,
    id: "run-1",
    goalId: goal.id,
    activeGoalVersion: 1,
    workflowPhase: "awaiting_goal_approval",
    workspacePath: "/tmp/repository",
    startedAt: at,
    updatedAt: later,
  };

  assert.equal(CompatiblePersistedRunSchema.safeParse(legacy).success, true);
  assert.equal(CompatiblePersistedRunSchema.safeParse(current).success, true);
  assert.equal(CompatiblePersistedRunSchema.safeParse({ ...current, formatVersion: 2 }).success, false);
  assert.equal(CompatiblePersistedRunSchema.safeParse({ ...legacy, formatVersion: 2 }).success, false);
  assert.equal(CompatiblePersistedRunSchema.safeParse({ ...current, updatedAt: "2026-07-18T07:59:00.000Z" }).success, false);
  assert.equal(CompatiblePersistedRunSchema.safeParse({ ...current, finishedAt: "2026-07-18T07:59:00.000Z" }).success, false);
  assert.equal(CompatiblePersistedRunSchema.safeParse({ ...legacy, status: "future_status" }).success, false);
});
