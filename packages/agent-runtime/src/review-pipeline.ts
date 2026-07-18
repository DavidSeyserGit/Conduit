import type {
  EvidenceRequest,
  ModelMessage,
  ReviewFinding,
  ReviewInput,
  ReviewResult,
  ReviewRoutingDecision,
  ReviewStatus,
  ReviewerDefinition,
  TokenUsage,
} from "@conduit/shared";
import {
  ReviewInputSchema,
  ReviewResultSchema,
  ReviewRoutingDecisionSchema,
} from "@conduit/shared";
import type { ModelProvider as Provider } from "@conduit/model-providers";

export type ReviewerId =
  | "security"
  | "testing"
  | "code_quality"
  | "architecture"
  | "performance"
  | "documentation"
  | "ui"
  | "accessibility"
  | "api"
  | "migration"
  | "dependency";

export interface RoutedReviewInput extends ReviewInput {
  /** Run-scoped patch. Kept outside the persisted diff metadata contract. */
  patch: string;
  policies?: string[];
}

export interface ReviewerExecution {
  result: ReviewResult;
  tokenUsage?: TokenUsage;
}

export interface Reviewer {
  readonly definition: ReviewerDefinition;
  review(input: RoutedReviewInput, signal?: AbortSignal): Promise<ReviewerExecution>;
}

export interface GeneralReviewExecution extends ReviewerExecution {
  routing: ReviewRoutingDecision;
}

export interface ReviewPipelineResult {
  generalReview: ReviewResult;
  routing: ReviewRoutingDecision;
  specialistReviews: ReviewResult[];
  approved: boolean;
  feedback: string[];
  unresolvedEvidenceRequests: EvidenceRequest[];
  warnings: ReviewFinding[];
  findingLifecycle: FindingLifecycleRecord[];
  tokenUsage?: TokenUsage;
}

export interface FindingLifecycleRecord {
  findingId: string;
  reviewerId: string;
  disposition: "open" | "resolved" | "superseded";
  round: number;
}

export interface FinalReviewDecision {
  approved: boolean;
  reason: string;
  unresolvedEvidenceRequests: EvidenceRequest[];
  warnings: ReviewFinding[];
}

export const REVIEWER_DEFINITIONS: Record<ReviewerId, ReviewerDefinition> = {
  security: definition("security", "Security Reviewer", "Authentication, authorization, unsafe execution, secret exposure, injection, and dependency risk."),
  testing: definition("testing", "Testing Reviewer", "Coverage of new behavior, regressions, edge cases, assertions, and executed validation."),
  code_quality: definition("code_quality", "Code Quality Reviewer", "Maintainability, clarity, duplication, complexity, naming, and repository conventions."),
  architecture: definition("architecture", "Architecture Reviewer", "Module boundaries, dependency direction, coupling, responsibilities, and long-term structure."),
  performance: definition("performance", "Performance Reviewer", "Complexity, repeated I/O, blocking work, allocations, query behavior, and benchmark claims."),
  documentation: definition("documentation", "Documentation Reviewer", "Public behavior, setup, configuration, migration notes, and implementation consistency."),
  ui: definition("ui", "UI Reviewer", "Visual behavior, interaction states, responsiveness, theme consistency, and product requirements."),
  accessibility: definition("accessibility", "Accessibility Reviewer", "Keyboard access, semantics, focus, contrast, motion, labels, and assistive technology behavior."),
  api: definition("api", "API Reviewer", "Public API compatibility, contracts, error behavior, and client impact."),
  migration: definition("migration", "Migration Reviewer", "Migration safety, rollback behavior, compatibility, ordering, and data integrity."),
  dependency: definition("dependency", "Dependency Reviewer", "New dependency necessity, provenance, maintenance, license, and supply-chain risk."),
};

export class ReviewerRegistry {
  private reviewers = new Map<string, Reviewer>();

  register(reviewer: Reviewer): this {
    if (this.reviewers.has(reviewer.definition.id)) {
      throw new Error(`Reviewer already registered: ${reviewer.definition.id}`);
    }
    this.reviewers.set(reviewer.definition.id, reviewer);
    return this;
  }

  get(id: string): Reviewer | undefined {
    return this.reviewers.get(id);
  }

  ids(): string[] {
    return [...this.reviewers.keys()];
  }
}

export class GeneralReviewer {
  constructor(
    private provider: Provider,
    private modelId: string,
    private workspacePath: string,
    private reasoningEffort?: string,
    private timeoutMs = 3 * 60 * 1_000,
    private heartbeat?: (startedAt: string) => void,
  ) {}

  async review(input: RoutedReviewInput, availableReviewerIds: string[], signal?: AbortSignal): Promise<GeneralReviewExecution> {
    validateReviewInput(input);
    const messages: ModelMessage[] = [
      {
        role: "system",
        content: `You are Conduit's General Reviewer. Verify functional completion against every success criterion, constraint, and required deliverable. Do not perform deep specialist review. Route only to relevant reviewers from the supplied registry. Return concise structured findings and evidence requests; never reveal private reasoning. Missing evidence must produce needs_evidence, not approval. Concrete unmet goal requirements must produce incomplete.`,
      },
      {
        role: "user",
        content: reviewPrompt(input, `Available specialist reviewers: ${availableReviewerIds.join(", ")}.`),
      },
    ];
    const execution = await requestStructured(
      this.provider,
      this.modelId,
      this.workspacePath,
      this.reasoningEffort,
      messages,
      "general_review",
      GENERAL_REVIEW_OUTPUT_SCHEMA,
      signal,
      this.timeoutMs,
      this.heartbeat,
    );
    const raw = parseGeneralOutput(execution.output);
    const deterministic = routeReviewers(input);
    const known = new Set(availableReviewerIds);
    const requiredReviewers = unique([
      ...deterministic.requiredReviewers,
      ...raw.requiredReviewers.filter((id) => known.has(id)),
    ]);
    const optionalReviewers = unique([
      ...deterministic.optionalReviewers,
      ...raw.optionalReviewers.filter((id) => known.has(id)),
    ]).filter((id) => !requiredReviewers.includes(id));
    const now = new Date().toISOString();
    const routing = ReviewRoutingDecisionSchema.parse({
      goalStatus: raw.goalStatus,
      confidence: raw.confidence,
      requiredReviewers,
      optionalReviewers,
      decisionSummary: raw.summary,
      evidenceIds: raw.evidenceIds,
      decidedAt: now,
    });
    const result = normalizeReviewResult("general", generalStatus(raw.goalStatus), raw, now, input.previousReview);
    return { result, routing, tokenUsage: execution.tokenUsage };
  }
}

export class ModelSpecialistReviewer implements Reviewer {
  constructor(
    readonly definition: ReviewerDefinition,
    private provider: Provider,
    private modelId: string,
    private workspacePath: string,
    private reasoningEffort?: string,
    private timeoutMs = 3 * 60 * 1_000,
    private heartbeat?: (startedAt: string) => void,
  ) {}

  async review(input: RoutedReviewInput, signal?: AbortSignal): Promise<ReviewerExecution> {
    validateReviewInput(input);
    const messages: ModelMessage[] = [
      {
        role: "system",
        content: `You are Conduit's ${this.definition.name}. Your only responsibility is: ${this.definition.responsibility}\nStay narrow and independent. Review only the supplied run-scoped diff against the approved goal. Never execute or propose direct tool calls. You may only request evidence through the structured evidenceRequests field. Return no private reasoning. Use not_applicable only with a concrete summary explaining why. When a previous result is supplied, preserve the ID of any finding or evidence request that remains materially unchanged.`,
      },
      { role: "user", content: reviewPrompt(input) },
    ];
    const execution = await requestStructured(
      this.provider,
      this.modelId,
      this.workspacePath,
      this.reasoningEffort,
      messages,
      `review_${this.definition.id}`,
      SPECIALIST_REVIEW_OUTPUT_SCHEMA,
      signal,
      this.timeoutMs,
      this.heartbeat,
    );
    const raw = parseSpecialistOutput(execution.output);
    return {
      result: normalizeReviewResult(this.definition.id, raw.status, raw, new Date().toISOString(), input.previousReview),
      tokenUsage: execution.tokenUsage,
    };
  }
}

export class ReviewPipeline {
  constructor(
    private generalReviewer: GeneralReviewer,
    private registry: ReviewerRegistry,
    private maxSpecialistReviews = 8,
  ) {}

  async run(
    input: RoutedReviewInput,
    options: {
      signal?: AbortSignal;
      previousReviews?: ReviewResult[];
      previousChangedFiles?: string[];
      round?: number;
      onGeneralStarted?: () => void;
      onGeneralCompleted?: (review: ReviewResult, routing: ReviewRoutingDecision) => void;
      onSpecialistStarted?: (reviewerId: string) => void;
      onSpecialistCompleted?: (review: ReviewResult) => void;
    } = {},
  ): Promise<ReviewPipelineResult> {
    const previousGeneral = options.previousReviews?.find((review) => review.reviewerId === "general");
    options.onGeneralStarted?.();
    const general = await this.generalReviewer.review(
      { ...input, ...(previousGeneral ? { previousReview: previousGeneral } : {}) },
      this.registry.ids(),
      options.signal,
    );
    options.onGeneralCompleted?.(general.result, general.routing);
    let usage = general.tokenUsage;
    if (general.routing.goalStatus !== "implemented" || !isApproved(general.result.status)) {
      const decision = aggregateFinalApproval(general.result, general.routing.requiredReviewers, []);
      return pipelineResult(general, [], decision, options.previousReviews ?? [], options.round ?? 1, usage);
    }

    const previous = new Map((options.previousReviews ?? []).map((review) => [review.reviewerId, review]));
    const routedIds = unique([...general.routing.requiredReviewers, ...general.routing.optionalReviewers]);
    const affected = selectReviewersForRerun(
      routedIds,
      input.diff.changes.map((change) => change.path),
      options.previousChangedFiles,
      previous,
    ).slice(0, this.maxSpecialistReviews);
    const specialistReviews: ReviewResult[] = [];
    for (const reviewerId of affected) {
      if (options.signal?.aborted) throw new Error("Review pipeline cancelled");
      const reviewer = this.registry.get(reviewerId);
      if (!reviewer) {
        if (general.routing.requiredReviewers.includes(reviewerId)) {
          specialistReviews.push(unavailableReview(reviewerId));
        }
        continue;
      }
      options.onSpecialistStarted?.(reviewerId);
      try {
        const execution = await reviewer.review({ ...input, previousReview: previous.get(reviewerId) }, options.signal);
        usage = addUsage(usage, execution.tokenUsage);
        specialistReviews.push(execution.result);
        options.onSpecialistCompleted?.(execution.result);
      } catch (error) {
        if (options.signal?.aborted) throw error;
        const review = unavailableReview(reviewerId, error);
        specialistReviews.push(review);
        options.onSpecialistCompleted?.(review);
      }
    }

    // Fresh unaffected approvals remain authoritative; failed or evidence-bound
    // reviews are deliberately rerun even when their file domain did not change.
    for (const reviewerId of routedIds) {
      if (specialistReviews.some((review) => review.reviewerId === reviewerId)) continue;
      const review = previous.get(reviewerId);
      if (review) specialistReviews.push(review);
    }
    const decision = aggregateFinalApproval(general.result, general.routing.requiredReviewers, specialistReviews);
    return pipelineResult(general, specialistReviews, decision, options.previousReviews ?? [], options.round ?? 1, usage);
  }
}

export function createDefaultReviewerRegistry(
  provider: Provider,
  modelId: string,
  workspacePath: string,
  reasoningEffort?: string,
  heartbeat?: (reviewerId: string, startedAt: string) => void,
): ReviewerRegistry {
  const registry = new ReviewerRegistry();
  for (const definition of Object.values(REVIEWER_DEFINITIONS)) {
    registry.register(new ModelSpecialistReviewer(
      definition,
      provider,
      modelId,
      workspacePath,
      reasoningEffort,
      undefined,
      (startedAt) => heartbeat?.(definition.id, startedAt),
    ));
  }
  return registry;
}

export function routeReviewers(input: Pick<RoutedReviewInput, "goal" | "repositoryContext" | "diff" | "patch">): Pick<ReviewRoutingDecision, "requiredReviewers" | "optionalReviewers"> {
  const paths = input.diff.changes.map((change) => change.path.toLowerCase());
  const text = [
    input.goal.title,
    input.goal.description,
    ...input.goal.successCriteria.map((criterion) => criterion.description),
    ...input.goal.deliverables.map((deliverable) => `${deliverable.type} ${deliverable.description}`),
    ...input.repositoryContext.frameworks,
    ...paths,
    input.patch.slice(0, 12_000),
  ].join("\n").toLowerCase();
  const required = new Set<ReviewerId>();
  const optional = new Set<ReviewerId>();
  const documentationOnly = paths.length > 0 && paths.every((path) => isDocumentationPath(path));
  const ui = matches(text, /\b(css|scss|style|theme|dark mode|component|react|vue|svelte|frontend|button|dialog|modal|ui|ux)\b/) || paths.some(isUiPath);
  const auth = matches(text, /\b(auth|login|oauth|credential|permission|authorization|secret|token|session)\b/);
  const migration = matches(text, /\b(migration|database schema|alter table|backfill|rollback)\b/) || paths.some((path) => /migrations?\//.test(path));
  const refactor = matches(text, /\b(refactor|architecture|module boundar|dependency direction|restructure)\b/);
  const performance = matches(text, /\b(performance|benchmark|latency|throughput|optimi[sz]|query count|complexity)\b/);
  const dependency = matches(text, /\b(dependency|dependencies|package|lockfile|supply chain)\b/) || paths.some((path) => /(?:^|\/)(?:package\.json|.*lock|cargo\.toml)$/.test(path));
  const api = matches(text, /\b(api|endpoint|public interface|request|response|graphql|rest)\b/);
  const testsRequired = input.goal.deliverables.some((deliverable) => deliverable.required && ["unit_tests", "integration_tests", "benchmark"].includes(deliverable.type));

  if (documentationOnly) {
    required.add("documentation");
    return { requiredReviewers: [...required], optionalReviewers: [] };
  }
  required.add("code_quality");
  if (testsRequired || paths.some(isCodePath)) required.add("testing");
  if (auth) {
    required.add("security");
    required.add("documentation");
  }
  if (ui) {
    required.add("ui");
    required.add("accessibility");
  }
  if (migration) {
    required.add("migration");
    required.add("security");
    required.add("performance");
    required.add("testing");
  }
  if (refactor) required.add("architecture");
  if (performance) {
    required.add("performance");
    required.add("testing");
  }
  if (dependency) {
    required.add("dependency");
    optional.add("security");
  }
  if (api) optional.add("api");
  if (paths.some((path) => isDocumentationPath(path)) && !required.has("documentation")) optional.add("documentation");
  for (const id of required) optional.delete(id);
  return { requiredReviewers: [...required], optionalReviewers: [...optional] };
}

export function aggregateFinalApproval(
  generalReview: ReviewResult,
  requiredReviewerIds: string[],
  specialistReviews: ReviewResult[],
  policiesSatisfied = true,
): FinalReviewDecision {
  const all = [generalReview, ...specialistReviews];
  const unresolvedEvidenceRequests = all.flatMap((review) => review.evidenceRequests)
    .filter((request) => request.required && request.status !== "collected");
  const critical = all.flatMap((review) => review.findings).filter((finding) => finding.severity === "critical");
  const warnings = all.flatMap((review) => review.findings).filter((finding) => ["info", "low"].includes(finding.severity));
  if (!isApproved(generalReview.status)) {
    return { approved: false, reason: "The general reviewer has not approved functional completion.", unresolvedEvidenceRequests, warnings };
  }
  if (!policiesSatisfied) {
    return { approved: false, reason: "Repository or project policies are not satisfied.", unresolvedEvidenceRequests, warnings };
  }
  const byId = new Map(specialistReviews.map((review) => [review.reviewerId, review]));
  const missing = requiredReviewerIds.filter((id) => !byId.has(id));
  if (missing.length > 0) {
    return { approved: false, reason: `Required reviews did not run: ${missing.join(", ")}.`, unresolvedEvidenceRequests, warnings };
  }
  const rejected = requiredReviewerIds.filter((id) => !isApproved(byId.get(id)?.status));
  if (rejected.length > 0) {
    return { approved: false, reason: `Required reviews have not approved: ${rejected.join(", ")}.`, unresolvedEvidenceRequests, warnings };
  }
  if (unresolvedEvidenceRequests.length > 0) {
    return { approved: false, reason: "Required evidence requests remain unresolved.", unresolvedEvidenceRequests, warnings };
  }
  if (critical.length > 0) {
    return { approved: false, reason: "A critical finding remains open.", unresolvedEvidenceRequests, warnings };
  }
  return { approved: true, reason: "Functional completion and every required specialist review are approved.", unresolvedEvidenceRequests, warnings };
}

export function selectReviewersForRerun(
  routedReviewerIds: string[],
  changedFiles: string[],
  previousChangedFiles: string[] | undefined,
  previousReviews: Map<string, ReviewResult>,
): string[] {
  if (!previousChangedFiles) return routedReviewerIds;
  const newlyChanged = changedFiles.filter((path) => !previousChangedFiles.includes(path));
  return routedReviewerIds.filter((id) => {
    const previous = previousReviews.get(id);
    if (!previous || !isApproved(previous.status)) return true;
    if (newlyChanged.length === 0) return false;
    return newlyChanged.some((path) => reviewerOwnsPath(id, path));
  });
}

export function reconcileFindingLifecycle(
  previousReviews: ReviewResult[],
  currentReviews: ReviewResult[],
  round: number,
): FindingLifecycleRecord[] {
  const currentIds = new Set(currentReviews.flatMap((review) => review.findings.map((finding) => finding.id)));
  const records: FindingLifecycleRecord[] = [];
  for (const review of previousReviews) {
    for (const finding of review.findings) {
      records.push({
        findingId: finding.id,
        reviewerId: review.reviewerId,
        disposition: currentIds.has(finding.id) ? "superseded" : "resolved",
        round,
      });
    }
  }
  for (const review of currentReviews) {
    for (const finding of review.findings) {
      records.push({ findingId: finding.id, reviewerId: review.reviewerId, disposition: "open", round });
    }
  }
  return records;
}

function pipelineResult(
  general: GeneralReviewExecution,
  specialists: ReviewResult[],
  decision: FinalReviewDecision,
  previousReviews: ReviewResult[],
  round: number,
  tokenUsage?: TokenUsage,
): ReviewPipelineResult {
  const allCurrent = [general.result, ...specialists];
  return {
    generalReview: general.result,
    routing: general.routing,
    specialistReviews: specialists,
    approved: decision.approved,
    feedback: actionableFeedback(allCurrent),
    unresolvedEvidenceRequests: decision.unresolvedEvidenceRequests,
    warnings: decision.warnings,
    findingLifecycle: reconcileFindingLifecycle(previousReviews, allCurrent, round),
    tokenUsage,
  };
}

function actionableFeedback(reviews: ReviewResult[]): string[] {
  return unique(reviews.flatMap((review) => review.findings
    .filter((finding) => ["medium", "high", "critical"].includes(finding.severity))
    .map((finding) => [
      `[${review.reviewerId}/${finding.severity}] ${finding.title}: ${finding.description}`,
      finding.filePath ? ` (${finding.filePath}${finding.lineStart ? `:${finding.lineStart}` : ""})` : "",
      finding.remediation ? ` Remediation: ${finding.remediation}` : "",
    ].join(""))));
}

function normalizeReviewResult(
  reviewerId: string,
  status: ReviewStatus,
  raw: ReviewDetails,
  reviewedAt: string,
  previousReview?: ReviewResult,
): ReviewResult {
  const findings = raw.findings.map((finding, index) => ({
    id: finding.id || `${reviewerId}-finding-${index + 1}`,
    severity: finding.severity,
    title: finding.title,
    description: finding.description,
    ...(finding.filePath ? { filePath: finding.filePath } : {}),
    ...(finding.lineStart ? { lineStart: finding.lineStart } : {}),
    ...(finding.lineEnd ? { lineEnd: finding.lineEnd } : {}),
    ...(finding.criterionId ? { criterionId: finding.criterionId } : {}),
    ...(finding.remediation ? { remediation: finding.remediation } : {}),
  }));
  const evidenceRequests = raw.evidenceRequests.map((request, index) => ({
    id: request.id || `${reviewerId}-evidence-${index + 1}`,
    reviewerId,
    type: request.type,
    description: request.description,
    required: request.required,
    ...(request.suggestedCommand ? { suggestedCommand: request.suggestedCommand } : {}),
    ...(request.expectedOutcome ? { expectedOutcome: request.expectedOutcome } : {}),
    status: "pending" as const,
    evidenceIds: [],
    requestedAt: reviewedAt,
  }));
  return ReviewResultSchema.parse({
    id: `${reviewerId}-review-${crypto.randomUUID()}`,
    reviewerId,
    status,
    confidence: raw.confidence,
    summary: raw.summary,
    findings,
    evidenceRequests,
    reviewedAt,
    ...(previousReview ? { supersedesReviewId: previousReview.id } : {}),
  });
}

function unavailableReview(reviewerId: string, error?: unknown): ReviewResult {
  const now = new Date().toISOString();
  return ReviewResultSchema.parse({
    id: `${reviewerId}-review-${crypto.randomUUID()}`,
    reviewerId,
    status: "blocked",
    confidence: 0,
    summary: `Reviewer unavailable: ${error instanceof Error ? error.message : error ? String(error) : "not registered"}`,
    findings: [],
    evidenceRequests: [],
    reviewedAt: now,
  });
}

interface ReviewDetails {
  confidence: number;
  summary: string;
  findings: Array<{
    id: string;
    severity: "info" | "low" | "medium" | "high" | "critical";
    title: string;
    description: string;
    filePath: string | null;
    lineStart: number | null;
    lineEnd: number | null;
    criterionId: string | null;
    remediation: string | null;
  }>;
  evidenceRequests: Array<{
    id: string;
    type: EvidenceRequest["type"];
    description: string;
    required: boolean;
    suggestedCommand: string | null;
    expectedOutcome: string | null;
  }>;
}

interface SpecialistOutput extends ReviewDetails {
  status: ReviewStatus;
}

interface GeneralOutput extends ReviewDetails {
  goalStatus: ReviewRoutingDecision["goalStatus"];
  requiredReviewers: string[];
  optionalReviewers: string[];
  evidenceIds: string[];
}

function parseSpecialistOutput(raw: unknown): SpecialistOutput {
  const value = parseStructured(raw) as SpecialistOutput;
  parseReviewDetails(value);
  if (!ReviewResultSchema.shape.status.safeParse(value.status).success) throw new Error("Invalid specialist review status");
  return value;
}

function parseGeneralOutput(raw: unknown): GeneralOutput {
  const value = parseStructured(raw) as GeneralOutput;
  parseReviewDetails(value);
  if (!ReviewRoutingDecisionSchema.shape.goalStatus.safeParse(value.goalStatus).success) throw new Error("Invalid goal review status");
  if (!Array.isArray(value.requiredReviewers) || !Array.isArray(value.optionalReviewers) || !Array.isArray(value.evidenceIds)) throw new Error("Malformed review routing");
  return value;
}

function parseReviewDetails(value: ReviewDetails): void {
  if (!value || typeof value.summary !== "string" || typeof value.confidence !== "number" || !Array.isArray(value.findings) || !Array.isArray(value.evidenceRequests)) {
    throw new Error("Malformed review details");
  }
}

async function requestStructured(
  provider: Provider,
  modelId: string,
  workspacePath: string,
  reasoningEffort: string | undefined,
  messages: ModelMessage[],
  name: string,
  schema: Record<string, unknown>,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  heartbeat?: (startedAt: string) => void,
): Promise<{ output: unknown; tokenUsage?: TokenUsage }> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let usage: TokenUsage | undefined;
  let firstError: unknown;
  const startedAt = new Date().toISOString();
  heartbeat?.(startedAt);
  const heartbeatTimer = heartbeat ? setInterval(() => heartbeat(startedAt), 10_000) : undefined;
  try {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await provider.createResponse({
        modelId,
        workspacePath,
        reasoningEffort,
        messages: attempt === 0 ? messages : [
          ...messages,
          { role: "assistant", content: firstError instanceof Error ? firstError.message : String(firstError) },
          { role: "user", content: "Return corrected JSON only. It must exactly match the supplied schema." },
        ],
        structuredOutput: { name, schema },
        temperature: 0.1,
        maxTokens: 6144,
        signal: combined,
      });
      usage = addUsage(usage, response.usage);
      const output = response.structuredOutput ?? response.content;
      if (name === "general_review") parseGeneralOutput(output);
      else parseSpecialistOutput(output);
      return { output, tokenUsage: usage };
    } catch (error) {
      if (signal?.aborted) throw new Error("Review pipeline cancelled");
      if (timeout.aborted) throw new Error("Reviewer timed out");
      firstError = error;
    }
  }
  throw new Error(`Reviewer returned malformed structured output after one repair: ${firstError instanceof Error ? firstError.message : String(firstError)}`);
  } finally {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
  }
}

function reviewPrompt(input: RoutedReviewInput, extra = ""): string {
  return [
    `## Approved Goal\n${JSON.stringify(input.goal, null, 2)}`,
    `## Repository Context\n${JSON.stringify(input.repositoryContext, null, 2)}`,
    `## Scoped Diff Metadata\n${JSON.stringify(input.diff, null, 2)}`,
    `## Scoped Patch\n${input.patch.slice(0, 24_000) || "No patch content available."}`,
    `## Validation\n${JSON.stringify(input.validationResults, null, 2)}`,
    `## Available Evidence\n${JSON.stringify(input.availableEvidence, null, 2)}`,
    `## Previous Review\n${JSON.stringify(input.previousReview ?? null, null, 2)}`,
    `## Policies\n${(input.policies ?? []).join("\n") || "No additional policies."}`,
    extra,
  ].filter(Boolean).join("\n\n");
}

function generalStatus(status: ReviewRoutingDecision["goalStatus"]): ReviewStatus {
  if (status === "implemented") return "approved";
  if (status === "incomplete") return "changes_requested";
  if (status === "needs_evidence") return "needs_evidence";
  return "blocked";
}

function isApproved(status: ReviewStatus | undefined): boolean {
  return status === "approved" || status === "approved_with_warnings";
}

function definition(id: ReviewerId, name: string, responsibility: string): ReviewerDefinition {
  return { id, name, description: responsibility, responsibility };
}

function reviewerOwnsPath(reviewerId: string, path: string): boolean {
  const value = path.toLowerCase();
  if (reviewerId === "documentation") return isDocumentationPath(value);
  if (reviewerId === "ui" || reviewerId === "accessibility") return isUiPath(value);
  if (reviewerId === "migration") return /migrations?|schema|database/.test(value);
  if (reviewerId === "dependency") return /package\.json|lock|cargo\.toml|requirements/.test(value);
  if (reviewerId === "testing") return isTestPath(value) || isCodePath(value);
  return isCodePath(value);
}

function isUiPath(path: string): boolean {
  return /\.(css|scss|sass|less|tsx|jsx|vue|svelte)$/.test(path) || /(?:^|\/)(components?|ui|views?|pages?)\//.test(path);
}
function isDocumentationPath(path: string): boolean { return /(?:^|\/)(docs?|readme|changelog)|\.(md|mdx|rst)$/.test(path); }
function isTestPath(path: string): boolean { return /(?:^|\/)(tests?|specs?)\/|\.(?:test|spec)\.[^.]+$/.test(path); }
function isCodePath(path: string): boolean { return /\.(?:ts|tsx|js|jsx|rs|py|go|java|kt|rb|swift|c|cc|cpp|h|hpp)$/.test(path); }
function matches(value: string, pattern: RegExp): boolean { return pattern.test(value); }
function unique<T>(values: T[]): T[] { return [...new Set(values)]; }
function parseStructured(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  return JSON.parse(fenced ?? raw.match(/\{[\s\S]*\}/)?.[0] ?? raw);
}
function validateReviewInput(input: RoutedReviewInput): void {
  ReviewInputSchema.parse({
    goal: input.goal,
    repositoryContext: input.repositoryContext,
    diff: input.diff,
    validationResults: input.validationResults,
    availableEvidence: input.availableEvidence,
    ...(input.previousReview ? { previousReview: input.previousReview } : {}),
  });
}
function addUsage(current: TokenUsage | undefined, next: TokenUsage | undefined): TokenUsage | undefined {
  if (!current) return next;
  if (!next) return current;
  return {
    promptTokens: current.promptTokens + next.promptTokens,
    completionTokens: current.completionTokens + next.completionTokens,
    totalTokens: current.totalTokens + next.totalTokens,
    cacheReadTokens: (current.cacheReadTokens ?? 0) + (next.cacheReadTokens ?? 0),
    cacheWriteTokens: (current.cacheWriteTokens ?? 0) + (next.cacheWriteTokens ?? 0),
  };
}

const nullable = (schema: Record<string, unknown>) => ({ anyOf: [schema, { type: "null" }] });
const findingSchema = strictObject({
  id: { type: "string" },
  severity: { type: "string", enum: ["info", "low", "medium", "high", "critical"] },
  title: { type: "string", minLength: 1 },
  description: { type: "string", minLength: 1 },
  filePath: nullable({ type: "string", minLength: 1 }),
  lineStart: nullable({ type: "integer", minimum: 1 }),
  lineEnd: nullable({ type: "integer", minimum: 1 }),
  criterionId: nullable({ type: "string", minLength: 1 }),
  remediation: nullable({ type: "string", minLength: 1 }),
});
const evidenceRequestSchema = strictObject({
  id: { type: "string" },
  type: { type: "string", enum: ["command", "test", "build", "lint", "typecheck", "benchmark", "coverage", "file", "search", "diff", "dependency", "static_analysis", "user_answer"] },
  description: { type: "string", minLength: 1 },
  required: { type: "boolean" },
  suggestedCommand: nullable({ type: "string", minLength: 1 }),
  expectedOutcome: nullable({ type: "string", minLength: 1 }),
});
const specialistProperties = {
  status: { type: "string", enum: ["approved", "approved_with_warnings", "changes_requested", "blocked", "needs_evidence", "not_applicable"] },
  confidence: { type: "number", minimum: 0, maximum: 1 },
  summary: { type: "string", minLength: 1 },
  findings: { type: "array", items: findingSchema },
  evidenceRequests: { type: "array", items: evidenceRequestSchema },
};
export const SPECIALIST_REVIEW_OUTPUT_SCHEMA = strictObject(specialistProperties);
export const GENERAL_REVIEW_OUTPUT_SCHEMA = strictObject({
  goalStatus: { type: "string", enum: ["incomplete", "implemented", "blocked", "needs_evidence"] },
  confidence: specialistProperties.confidence,
  summary: specialistProperties.summary,
  findings: specialistProperties.findings,
  evidenceRequests: specialistProperties.evidenceRequests,
  requiredReviewers: { type: "array", items: { type: "string" } },
  optionalReviewers: { type: "array", items: { type: "string" } },
  evidenceIds: { type: "array", items: { type: "string" } },
});
function strictObject(properties: Record<string, unknown>): Record<string, unknown> {
  return { type: "object", additionalProperties: false, required: Object.keys(properties), properties };
}
