import type {
  GoalRunConfig,
  GoalRunResult,
  GoalRunState,
  GoalRunEvent,
  ModelCostBreakdown,
} from "@conduit/shared";
import type { ProviderRegistry } from "@conduit/model-providers";
import type { ToolExecutor, ToolExecutorContext } from "@conduit/tools";
import { findProviderForModel } from "@conduit/model-providers";
import { CodingAgent } from "./coding-agent.js";
import { Judge } from "./judge.js";
import {
  createInitialGoalState,
  createIteration,
  addAgentMessage,
  accumulateTokenUsage,
} from "./state.js";
import { computeLoopMetrics } from "./metrics.js";
import { estimateCost } from "./state.js";

export type GoalRunEventHandler = (event: GoalRunEvent) => void;

export class GoalLoopRunner {
  private cancelled = false;
  private abortController: AbortController | null = null;
  private pendingApprovals = new Map<string, (approved: boolean) => void>();

  constructor(private registry: ProviderRegistry) {}

  cancel(): void {
    this.cancelled = true;
    this.abortController?.abort();
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

    const codingAgent = new CodingAgent();
    const judge = new Judge(
      judgeProviderInfo.provider,
      config.judgeModelId,
      state.workspacePath,
      config.judgeReasoningEffort,
      emit,
      this.abortController.signal,
    );

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
        iteration.changedFiles = agentResult.changedFiles;
        iteration.validationResults = agentResult.validationResults;

        if (agentResult.agentSummary) {
          addAgentMessage(iteration, "assistant", agentResult.agentSummary);
        }

        if (
          !agentResult.agentSummary.trim() &&
          agentResult.toolCalls.length === 0 &&
          agentResult.changedFiles.length === 0
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

        const judgeReview = await judge.review({
          goal: state.goal,
          plan: state.plan,
          changedFiles: agentResult.changedFiles,
          validationResults: agentResult.validationResults,
          iteration: state.iteration,
          agentSummary: agentResult.agentSummary,
          workspacePath: state.workspacePath,
          getDiff: () => toolExecutor.execute("get_git_diff", {}, "goal"),
        });
        const judgeResult = judgeReview.result;
        state.tokenUsage = accumulateTokenUsage(state.tokenUsage, judgeReview.tokenUsage);
        state.judgeTokenUsage = accumulateTokenUsage(state.judgeTokenUsage, judgeReview.tokenUsage);
        state.judgeCost = updateCost(
          config.judgeModelId,
          state.judgeTokenUsage,
          config.judgeInputPrice,
          config.judgeOutputPrice
        );
        state.estimatedCost = (state.codingCost?.totalCost || 0) + (state.judgeCost?.totalCost || 0);

        iteration.judgeResult = judgeResult;
        state.iterations.push(iteration);

        if (judgeResult.approved) {
          state.status = "completed";
          state.finishedAt = new Date().toISOString();
          const finalState = finalizeState(state);
          const result: GoalRunResult = { status: "completed", state: finalState };
          emit({ type: "run_completed", result });
          return result;
        }

        state.lastJudgeFeedback = [
          ...judgeResult.feedback,
          ...judgeResult.missingRequirements.map((r) => `Missing: ${r}`),
        ];
        emit({
          type: "agent_status",
          message: `Judge rejected iteration ${state.iteration}; sending ${state.lastJudgeFeedback.length} required fix${state.lastJudgeFeedback.length === 1 ? "" : "es"} to the coding agent…`,
        });
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
