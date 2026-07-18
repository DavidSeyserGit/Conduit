import type {
  GoalRunConfig,
  GoalRunResult,
  GoalRunState,
  GoalRunEvent,
  ModelCostBreakdown,
  JudgeResult,
  GoalDefinition,
  GoalPersistenceRepository,
  EvidenceRequest,
  ReviewResult,
  NormalizedValidationResult,
  RepositoryContext,
  RepositoryDiff,
  ValidationResult,
} from "@conduit/shared";
import { GoalDefinitionSchema } from "@conduit/shared";
import type { ProviderRegistry } from "@conduit/model-providers";
import type { ToolExecutor, ToolExecutorContext } from "@conduit/tools";
import { findProviderForModel } from "@conduit/model-providers";
import { CodingAgent } from "./coding-agent.js";
import { Judge } from "./judge.js";
import {
  GeneralReviewer,
  ReviewPipeline,
  createDefaultReviewerRegistry,
  type ReviewPipelineResult,
} from "./review-pipeline.js";
import {
  createInitialGoalState,
  createIteration,
  addAgentMessage,
  accumulateTokenUsage,
} from "./state.js";
import { computeLoopMetrics } from "./metrics.js";
import { estimateCost } from "./state.js";
import { EvidenceCoordinator, invalidateEvidence } from "./evidence-coordinator.js";

export type GoalRunEventHandler = (event: GoalRunEvent) => void;

export class GoalLoopRunner {
  private cancelled = false;
  private abortController: AbortController | null = null;
  private pendingApprovals = new Map<string, (approved: boolean) => void>();

  constructor(
    private registry: ProviderRegistry,
    private persistence?: GoalPersistenceRepository,
  ) {}

  cancel(): void {
    this.cancelled = true;
    this.abortController?.abort();
    for (const resolve of this.pendingApprovals.values()) resolve(false);
    this.pendingApprovals.clear();
  }

  approveCommand(requestId: string): void {
    const resolve = this.pendingApprovals.get(requestId);
    if (resolve) {
      resolve(true);
      this.pendingApprovals.delete(requestId);
    }
  }

  rejectCommand(requestId: string): void {
    const resolve = this.pendingApprovals.get(requestId);
    if (resolve) {
      resolve(false);
      this.pendingApprovals.delete(requestId);
    }
  }

  private requestEvidenceApproval(
    evidenceRequestId: string,
    command: string,
    emit: GoalRunEventHandler,
  ): Promise<boolean> {
    if (this.cancelled) return Promise.resolve(false);
    const requestId = `evidence-${evidenceRequestId}-${crypto.randomUUID()}`;
    return new Promise((resolve) => {
      this.pendingApprovals.set(requestId, resolve);
      emit({ type: "approval_required", command, requestId });
    });
  }

  async run(
    config: GoalRunConfig,
    toolExecutor: ToolExecutor,
    toolContext: ToolExecutorContext,
    onEvent: GoalRunEventHandler
  ): Promise<GoalRunResult> {
    this.cancelled = false;
    this.abortController = new AbortController();

    let state = config.resumeState
      ? structuredClone(config.resumeState)
      : createInitialGoalState(config);
    state.status = "running";
    state.finishedAt = undefined;

    const collectedEvents: GoalRunEvent[] = [];

    const emit = (event: GoalRunEvent) => {
      collectedEvents.push(event);
      onEvent(event);
      state = applyEventToState(state, event);
    };

    const finalizeState = (finalState: GoalRunState): GoalRunState => {
      const metrics = computeLoopMetrics(collectedEvents);
      return { ...finalState, metrics };
    };

    if (config.structuredGoal) {
      const parsedGoal = GoalDefinitionSchema.safeParse(config.structuredGoal);
      const approvedVersion = config.approvedGoalVersion;
      if (
        !parsedGoal.success ||
        parsedGoal.data.status !== "approved" ||
        approvedVersion !== parsedGoal.data.version
      ) {
        const error = "Implementation requires explicit approval of the exact structured goal version";
        const finalState = finalizeState({ ...state, status: "failed", finishedAt: new Date().toISOString() });
        onEvent({ type: "run_failed", error });
        return { status: "failed", state: finalState, error };
      }
      state.goal = formatStructuredGoalContract(parsedGoal.data);
    }

    emit({ type: "run_started", runId: state.id, startedAt: state.startedAt });

    const codingProviderInfo = findProviderForModel(
      this.registry,
      config.codingModelId
    );
    const judgeProviderInfo = findProviderForModel(
      this.registry,
      config.judgeModelId
    );

    if (!codingProviderInfo) {
      const error = `No provider found for coding model: ${config.codingModelId}`;
      const finalState = finalizeState({ ...state, status: "failed" });
      emit({ type: "run_failed", error });
      return { status: "failed", state: finalState, error };
    }

    if (!judgeProviderInfo) {
      const error = `No provider found for judge model: ${config.judgeModelId}`;
      const finalState = finalizeState({ ...state, status: "failed" });
      emit({ type: "run_failed", error });
      return { status: "failed", state: finalState, error };
    }

    if (!state.baselineTree) {
      emit({ type: "agent_status", message: "Capturing this goal's change baseline…" });
      const snapshot = await toolExecutor.execute("capture_git_snapshot", {}, "goal");
      const tree = snapshot.success && snapshot.result
        ? (snapshot.result as { tree?: string }).tree
        : undefined;
      if (!tree) {
        const error = `Could not capture the goal change baseline: ${snapshot.error || "Git snapshot failed"}`;
        const finalState = finalizeState({ ...state, status: "failed", finishedAt: new Date().toISOString() });
        emit({ type: "run_failed", error });
        return { status: "failed", state: finalState, error };
      }
      state.baselineTree = tree;
    }

    const codingAgent = new CodingAgent();
    const judge = new Judge(
      judgeProviderInfo.provider,
      config.judgeModelId,
      state.workspacePath,
      config.judgeReasoningEffort,
      emit,
      this.abortController.signal,
    );
    const reviewPipeline = new ReviewPipeline(
      new GeneralReviewer(
        judgeProviderInfo.provider,
        config.judgeModelId,
        state.workspacePath,
        config.judgeReasoningEffort,
        undefined,
        (startedAt) => emit({
          type: "agent_heartbeat",
          provider: judgeProviderInfo.provider.name,
          at: new Date().toISOString(),
          startedAt,
          phase: "judging",
          source: "network",
          detail: "General reviewer request remains open",
        }),
      ),
      createDefaultReviewerRegistry(
        judgeProviderInfo.provider,
        config.judgeModelId,
        state.workspacePath,
        config.judgeReasoningEffort,
        (reviewerId, startedAt) => emit({
          type: "agent_heartbeat",
          provider: judgeProviderInfo.provider.name,
          at: new Date().toISOString(),
          startedAt,
          phase: "judging",
          source: "network",
          detail: `${reviewerId} reviewer request remains open`,
        }),
      ),
    );
    const evidenceCoordinator = new EvidenceCoordinator(toolExecutor, this.persistence);

    if (!state.plan) {
      try {
        const reasoningLabel = config.judgeReasoningEffort
          ? ` (${config.judgeReasoningEffort.replace(/[-_]/g, " ")} reasoning)`
          : "";
        emit({ type: "agent_status", message: `Judge is writing the implementation plan${reasoningLabel}…` });
        const planning = await judge.createImplementationPlan(state.goal);
        state.plan = planning.plan;
        state.tokenUsage = accumulateTokenUsage(state.tokenUsage, planning.tokenUsage);
        state.judgeTokenUsage = accumulateTokenUsage(state.judgeTokenUsage, planning.tokenUsage);
        state.judgeCost = updateCost(config.judgeModelId, state.judgeTokenUsage, config.judgeInputPrice, config.judgeOutputPrice);
        state.estimatedCost = (state.codingCost?.totalCost || 0) + (state.judgeCost?.totalCost || 0);
        emit({ type: "plan_updated", plan: planning.plan });
        emit({ type: "agent_status", message: "Judge plan ready; starting implementation…" });
      } catch (err) {
        if (this.cancelled || this.abortController?.signal.aborted) {
          state.status = "cancelled";
          state.finishedAt = new Date().toISOString();
          const finalState = finalizeState(state);
          const result: GoalRunResult = { status: "cancelled", state: finalState };
          emit({ type: "run_completed", result });
          return result;
        }
        const error = `Judge could not create an implementation plan: ${err instanceof Error ? err.message : String(err)}`;
        state.status = "failed";
        state.finishedAt = new Date().toISOString();
        const finalState = finalizeState(state);
        emit({ type: "run_failed", error });
        return { status: "failed", state: finalState, error };
      }
    }

    while (state.iteration < config.maxIterations) {
      if (this.cancelled) {
        state.status = "cancelled";
        state.finishedAt = new Date().toISOString();
        const finalState = finalizeState(state);
        const result: GoalRunResult = { status: "cancelled", state: finalState };
        emit({ type: "run_completed", result });
        return result;
      }

      state.iteration += 1;
      const iteration = createIteration(state.iteration);
      emit({ type: "iteration_started", iteration: state.iteration });

      try {
        const agentResult = await codingAgent.run({
          goal: state.goal,
          workspacePath: state.workspacePath,
          modelId: config.codingModelId,
          provider: codingProviderInfo.provider,
          toolExecutor,
          toolContext,
          previousPlan: state.plan,
          judgeFeedback: state.lastJudgeFeedback,
          iteration: state.iteration,
          maxIterations: config.maxIterations,
          emit,
          signal: this.abortController.signal,
          modelApiKey: config.modelApiKey,
          inputPrice: config.codingInputPrice,
          outputPrice: config.codingOutputPrice,
          supportsReasoning: config.codingSupportsReasoning,
          codingReasoningEffort: config.codingReasoningEffort,
          permissionMode: config.commandPermissionMode,
        });

        // The judge owns the implementation contract. Worker plans may only
        // supply a fallback for legacy/resumed runs that have no judge plan.
        state.plan = state.plan ?? agentResult.plan;
        iteration.toolCalls = agentResult.toolCalls;
        const contractValidationResults = await runValidationContract(
          state.plan,
          toolExecutor,
          emit,
        );
        iteration.validationResults = [
          ...agentResult.validationResults,
          ...contractValidationResults,
        ];

        const scopedDiffResult = await toolExecutor.execute(
          "get_git_diff",
          { baselineTree: state.baselineTree },
          "goal",
        );
        if (!scopedDiffResult.success || !scopedDiffResult.result) {
          throw new Error(`Could not calculate this goal's scoped changes: ${scopedDiffResult.error || "Git diff failed"}`);
        }
        const scopedChanges = scopedDiffResult.result as {
          diff?: string;
          changedFiles?: string[];
        };
        iteration.changedFiles = scopedChanges.changedFiles || [];

        if (agentResult.agentSummary) {
          addAgentMessage(iteration, "assistant", agentResult.agentSummary);
        }

        if (
          !agentResult.agentSummary.trim() &&
          agentResult.toolCalls.length === 0 &&
          iteration.changedFiles.length === 0
        ) {
          throw new Error(
            "Coding agent completed without producing a response, tool calls, or changes; the judge was not run."
          );
        }

        state.tokenUsage = accumulateTokenUsage(
          state.tokenUsage,
          agentResult.tokenUsage
        );
        state.codingTokenUsage = accumulateTokenUsage(state.codingTokenUsage, agentResult.tokenUsage);
        state.codingCost = updateCost(
          config.codingModelId,
          state.codingTokenUsage,
          config.codingInputPrice,
          config.codingOutputPrice
        );

        const allValidationResults = [
          ...state.iterations.flatMap((previousIteration) => previousIteration.validationResults),
          ...iteration.validationResults,
        ];
        const previousIteration = state.iterations.at(-1);
        emit({ type: "judge_started", iteration: state.iteration });
        let availableEvidence = invalidateEvidence(
          state.iterations.flatMap((completed) => completed.evidence ?? []),
          iteration.changedFiles,
        );
        for (const stale of availableEvidence.filter((item) => item.freshness.status === "stale")) {
          await this.persistence?.saveEvidence(state.id, stale);
        }
        const reviewInput = {
          goal: config.structuredGoal ?? legacyGoalDefinition(state),
          repositoryContext: runtimeRepositoryContext(state.workspacePath, iteration.changedFiles),
          diff: runtimeRepositoryDiff(state.baselineTree, iteration.changedFiles),
          patch: scopedChanges.diff || "",
          validationResults: normalizeValidationResults(allValidationResults),
          availableEvidence,
        };
        let previousReviews = previousIteration
          ? [
              ...(previousIteration.generalReview ? [previousIteration.generalReview] : []),
              ...(previousIteration.specialistReviews ?? []),
            ]
          : [];
        previousReviews = invalidateReviewEvidence(previousReviews, availableEvidence);
        for (const review of previousReviews) {
          for (const request of review.evidenceRequests.filter((item) => item.status === "stale")) {
            await this.persistence?.saveEvidenceRequest(state.id, request);
          }
        }
        let pipelineResult: ReviewPipelineResult | undefined;
        let reviewTokenUsage: GoalRunState["tokenUsage"];
        for (let evidenceRound = 0; evidenceRound < 3; evidenceRound += 1) {
          pipelineResult = await reviewPipeline.run({ ...reviewInput, availableEvidence }, {
            signal: this.abortController.signal,
            previousReviews,
            previousChangedFiles: evidenceRound === 0 ? previousIteration?.changedFiles : iteration.changedFiles,
            round: state.iteration,
            onGeneralStarted: () => emit({ type: "general_review_started", iteration: state.iteration }),
            onGeneralCompleted: (result, decision) => {
              emit({ type: "general_review_completed", iteration: state.iteration, result });
              emit({ type: "reviews_routed", iteration: state.iteration, decision });
            },
            onSpecialistStarted: (reviewerId) => emit({ type: "specialist_review_started", iteration: state.iteration, reviewerId }),
            onSpecialistCompleted: (result) => emit({ type: "specialist_review_completed", iteration: state.iteration, result }),
          });
          reviewTokenUsage = accumulateTokenUsage(reviewTokenUsage, pipelineResult.tokenUsage);
          await this.persistence?.saveReview(state.id, pipelineResult.generalReview);
          for (const review of pipelineResult.specialistReviews) await this.persistence?.saveReview(state.id, review);
          if (pipelineResult.evidenceRequests.length === 0) break;

          emit({
            type: "evidence_collection_started",
            iteration: state.iteration,
            requestIds: pipelineResult.evidenceRequests.map((request) => request.id),
          });
          const collection = await evidenceCoordinator.collect(pipelineResult.evidenceRequests, {
            runId: state.id,
            goal: reviewInput.goal,
            workspacePath: state.workspacePath,
            permissionMode: config.commandPermissionMode ?? "auto_approve_safe",
            existingEvidence: availableEvidence,
            signal: this.abortController.signal,
            requestApproval: (request, command) => this.requestEvidenceApproval(request.id, command, emit),
            onProgress: (progress) => {
              if (progress.type === "request_updated") {
                emit({ type: "evidence_request_updated", iteration: state.iteration, request: progress.request });
              } else {
                emit({
                  type: "evidence_collected",
                  iteration: state.iteration,
                  requestId: progress.request.id,
                  evidence: progress.evidence,
                  reused: progress.type === "evidence_reused",
                });
              }
            },
          });
          iteration.evidenceRequests = mergeEvidenceRequests(iteration.evidenceRequests ?? [], collection.requests);
          iteration.evidence = collection.evidence;
          availableEvidence = collection.evidence;
          emit({
            type: "evidence_collection_completed",
            iteration: state.iteration,
            requestIds: collection.requests.map((request) => request.id),
            evidenceIds: uniqueValues([...collection.collected, ...collection.reused].map((item) => item.id)),
          });
          previousReviews = applyEvidenceRequestUpdates(
            [pipelineResult.generalReview, ...pipelineResult.specialistReviews],
            collection.requests,
          );
          if (collection.collected.length === 0 && collection.reused.length === 0) break;
        }
        if (!pipelineResult) throw new Error("Review pipeline did not produce a result");
        pipelineResult = { ...pipelineResult, tokenUsage: reviewTokenUsage };
        const judgeResult = compatibilityJudgeResult(pipelineResult);
        state.tokenUsage = accumulateTokenUsage(state.tokenUsage, pipelineResult.tokenUsage);
        state.judgeTokenUsage = accumulateTokenUsage(state.judgeTokenUsage, pipelineResult.tokenUsage);
        state.judgeCost = updateCost(
          config.judgeModelId,
          state.judgeTokenUsage,
          config.judgeInputPrice,
          config.judgeOutputPrice
        );
        state.estimatedCost = (state.codingCost?.totalCost || 0) + (state.judgeCost?.totalCost || 0);

        iteration.judgeResult = judgeResult;
        iteration.generalReview = pipelineResult.generalReview;
        iteration.reviewRouting = pipelineResult.routing;
        iteration.specialistReviews = pipelineResult.specialistReviews;
        state.iterations.push(iteration);
        emit({ type: "judge_completed", result: judgeResult });
        emit({
          type: "review_pipeline_completed",
          iteration: state.iteration,
          approved: pipelineResult.approved,
          requiredReviewerIds: pipelineResult.routing.requiredReviewers,
        });

        if (pipelineResult.approved) {
          state.status = "completed";
          state.finishedAt = new Date().toISOString();
          const finalState = finalizeState(state);
          const result: GoalRunResult = { status: "completed", state: finalState };
          emit({ type: "run_completed", result });
          return result;
        }

        state.lastJudgeFeedback = pipelineResult.feedback;
        if (state.lastJudgeFeedback.length > 0) {
          emit({
            type: "agent_status",
            message: `Judge rejected iteration ${state.iteration}; sending ${state.lastJudgeFeedback.length} required fix${state.lastJudgeFeedback.length === 1 ? "" : "es"} to the coding agent…`,
          });
        } else {
          const error = pipelineResult.unresolvedEvidenceRequests.length > 0
            ? `Review pipeline requires ${pipelineResult.unresolvedEvidenceRequests.length} unresolved evidence item${pipelineResult.unresolvedEvidenceRequests.length === 1 ? "" : "s"}.`
            : "Review pipeline is blocked without a repairable coding finding.";
          state.status = "failed";
          state.finishedAt = new Date().toISOString();
          const finalState = finalizeState(state);
          emit({ type: "run_failed", error });
          return { status: "failed", state: finalState, error };
        }
      } catch (err) {
        if (this.cancelled || this.abortController?.signal.aborted) {
          state.status = "cancelled";
          state.finishedAt = new Date().toISOString();
          state.iterations.push(iteration);
          const finalState = finalizeState(state);
          const result: GoalRunResult = { status: "cancelled", state: finalState };
          emit({ type: "run_completed", result });
          return result;
        }
        const error = err instanceof Error ? err.message : String(err);
        state.status = "failed";
        state.finishedAt = new Date().toISOString();
        state.iterations.push(iteration);
        const finalState = finalizeState(state);
        emit({ type: "run_failed", error });
        return { status: "failed", state: finalState, error };
      }
    }

    state.status = "iteration_limit_reached";
    state.finishedAt = new Date().toISOString();
    const finalState = finalizeState(state);
    const result: GoalRunResult = {
      status: "iteration_limit_reached",
      state: finalState,
    };
    emit({ type: "run_completed", result });
    return result;
  }
}

function formatStructuredGoalContract(goal: import("@conduit/shared").GoalDefinition): string {
  return JSON.stringify({
    title: goal.title,
    description: goal.description,
    successCriteria: goal.successCriteria,
    constraints: goal.constraints,
    deliverables: goal.deliverables,
    assumptions: goal.assumptions,
    answers: goal.answers,
    approvedVersion: goal.version,
  }, null, 2);
}

function legacyGoalDefinition(state: GoalRunState): GoalDefinition {
  return {
    schemaVersion: 1,
    id: `legacy-${state.id}`,
    originalRequest: state.goal,
    title: state.goal.slice(0, 120),
    description: state.goal,
    successCriteria: [{ id: "legacy-request", description: state.goal, required: true }],
    constraints: [],
    deliverables: [{ id: "legacy-implementation", type: "implementation", description: "Implement the requested goal", required: true }],
    assumptions: [],
    answers: [],
    status: "approved",
    version: 1,
    createdAt: state.startedAt,
    updatedAt: state.startedAt,
  };
}

function runtimeRepositoryContext(workspacePath: string, changedFiles: string[]): RepositoryContext {
  return {
    workspacePath,
    summary: `Runtime review context for ${changedFiles.length} run-scoped changed file${changedFiles.length === 1 ? "" : "s"}.`,
    languages: inferChangedFileLanguages(changedFiles),
    frameworks: [],
    testFrameworks: [],
    instructions: [],
    relevantFiles: changedFiles.map((path) => ({ path, reason: "Changed during this goal run" })),
    preparedAt: new Date().toISOString(),
  };
}

function runtimeRepositoryDiff(baseRevision: string | undefined, changedFiles: string[]): RepositoryDiff {
  return {
    ...(baseRevision ? { baseRevision } : {}),
    changes: changedFiles.map((path) => ({ path, status: "modified" as const })),
    collectedAt: new Date().toISOString(),
  };
}

function normalizeValidationResults(results: ValidationResult[]): NormalizedValidationResult[] {
  const collectedAt = new Date().toISOString();
  return results.map((result, index) => ({
    id: `validation-${index + 1}`,
    type: inferValidationType(result.command),
    command: result.command,
    passed: result.passed,
    exitCode: result.exitCode,
    durationMs: 0,
    summary: (result.passed ? result.stdout : result.stderr).trim().slice(0, 1_000)
      || `${result.command} ${result.passed ? "passed" : "failed"} with exit code ${result.exitCode}`,
    collectedAt,
  }));
}

function compatibilityJudgeResult(result: ReviewPipelineResult): JudgeResult {
  const reviews = [result.generalReview, ...result.specialistReviews];
  const findings = reviews.flatMap((review) => review.findings);
  return {
    approved: result.approved,
    summary: result.routing.decisionSummary,
    feedback: findings.map((finding) => finding.title),
    missingRequirements: result.generalReview.findings
      .filter((finding) => ["medium", "high", "critical"].includes(finding.severity))
      .map((finding) => finding.description),
    repairFeedback: result.feedback,
    evidenceRequests: result.unresolvedEvidenceRequests.map((request) => request.description),
    followUps: result.warnings.map((warning) => warning.title),
    confidence: result.generalReview.confidence,
  };
}

function inferValidationType(command: string): NormalizedValidationResult["type"] {
  if (/\b(test|vitest|jest|pytest|cargo test)\b/i.test(command)) return "test";
  if (/\b(lint|clippy)\b/i.test(command)) return "lint";
  if (/\b(typecheck|tsc)\b/i.test(command)) return "typecheck";
  if (/\b(build|bundle)\b/i.test(command)) return "build";
  if (/\b(bench|benchmark)\b/i.test(command)) return "benchmark";
  if (/\bcoverage\b/i.test(command)) return "coverage";
  return "command";
}

function inferChangedFileLanguages(paths: string[]): string[] {
  const languages = new Set<string>();
  for (const path of paths) {
    if (/\.tsx?$/.test(path)) languages.add("TypeScript");
    else if (/\.jsx?$/.test(path)) languages.add("JavaScript");
    else if (/\.rs$/.test(path)) languages.add("Rust");
    else if (/\.py$/.test(path)) languages.add("Python");
    else if (/\.(?:c|cc|cpp|h|hpp)$/.test(path)) languages.add("C/C++");
    else if (/\.go$/.test(path)) languages.add("Go");
  }
  return [...languages];
}

function mergeEvidenceRequests(previous: EvidenceRequest[], current: EvidenceRequest[]): EvidenceRequest[] {
  const merged = new Map(previous.map((request) => [request.id, request]));
  for (const request of current) merged.set(request.id, request);
  return [...merged.values()];
}

function applyEvidenceRequestUpdates(reviews: ReviewResult[], requests: EvidenceRequest[]): ReviewResult[] {
  const updates = new Map(requests.map((request) => [request.id, request]));
  return reviews.map((review) => ({
    ...review,
    evidenceRequests: review.evidenceRequests.map((request) => updates.get(request.id) ?? request),
  }));
}

function invalidateReviewEvidence(reviews: ReviewResult[], evidence: import("@conduit/shared").EvidenceItem[]): ReviewResult[] {
  const staleIds = new Set(evidence.filter((item) => item.freshness.status === "stale").map((item) => item.id));
  if (staleIds.size === 0) return reviews;
  return reviews.map((review) => {
    let invalidated = false;
    const evidenceRequests = review.evidenceRequests.map((request) => {
      if (!request.evidenceIds.some((id) => staleIds.has(id))) return request;
      invalidated = true;
      return { ...request, status: "stale" as const, resolvedAt: undefined };
    });
    return invalidated ? { ...review, status: "needs_evidence" as const, evidenceRequests } : review;
  });
}

function uniqueValues<T>(values: T[]): T[] {
  return [...new Set(values)];
}

async function runValidationContract(
  plan: GoalRunState["plan"],
  toolExecutor: ToolExecutor,
  emit: GoalRunEventHandler,
): Promise<ValidationResult[]> {
  // Resumed runs created before validation contracts were introduced remain
  // reviewable, but all newly planned runs are schema-required to have one.
  if (!plan || !("validation" in plan) || plan.validation.strategy !== "commands") return [];

  emit({ type: "agent_status", message: `Running ${plan.validation.commands.length} planned validation command${plan.validation.commands.length === 1 ? "" : "s"}…` });
  const results: ValidationResult[] = [];
  for (const command of plan.validation.commands) {
    const toolResult = await toolExecutor.execute("run_command", { command }, "goal");
    const commandResult = toolResult.result as Partial<{
      command: string;
      exitCode: number;
      stdout: string;
      stderr: string;
    }> | undefined;
    const validation: ValidationResult = {
      command: commandResult?.command || command,
      exitCode: commandResult?.exitCode ?? 1,
      stdout: commandResult?.stdout || "",
      stderr: commandResult?.stderr || toolResult.error || "Validation command could not be executed",
      passed: toolResult.success && commandResult?.exitCode === 0,
    };
    results.push(validation);
    emit({ type: "validation_completed", result: validation });
  }
  return results;
}

function applyEventToState(
  state: GoalRunState,
  event: GoalRunEvent
): GoalRunState {
  switch (event.type) {
    case "plan_updated":
      return state.plan ? state : { ...state, plan: event.plan };
    default:
      return state;
  }
}

export async function runGoalLoop(
  config: GoalRunConfig,
  registry: ProviderRegistry,
  toolExecutor: ToolExecutor,
  toolContext: ToolExecutorContext,
  onEvent: GoalRunEventHandler
): Promise<GoalRunResult> {
  const runner = new GoalLoopRunner(registry);
  return runner.run(config, toolExecutor, toolContext, onEvent);
}

function updateCost(
  modelId: string,
  usage: { promptTokens: number; completionTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number } | undefined,
  inputPrice?: number,
  outputPrice?: number
): ModelCostBreakdown | undefined {
  if (!usage || (inputPrice === undefined && outputPrice === undefined)) return undefined;
  const inputCost = estimateCost({ ...usage, promptTokens: Math.max(0, usage.promptTokens - (usage.cacheReadTokens || 0)), totalTokens: usage.promptTokens + usage.completionTokens }, inputPrice, undefined) || 0;
  const outputCost = estimateCost({ ...usage, totalTokens: usage.promptTokens + usage.completionTokens }, undefined, outputPrice) || 0;
  const cacheReadCost = estimateCost({ ...usage, promptTokens: usage.cacheReadTokens || 0, completionTokens: 0, totalTokens: usage.cacheReadTokens || 0 }, inputPrice, undefined) || 0;
  const cacheWriteCost = estimateCost({ ...usage, promptTokens: usage.cacheWriteTokens || 0, completionTokens: 0, totalTokens: usage.cacheWriteTokens || 0 }, inputPrice, undefined) || 0;
  return { modelId, inputCost, outputCost, cacheReadCost, cacheWriteCost, totalCost: inputCost + outputCost + cacheReadCost + cacheWriteCost };
}
