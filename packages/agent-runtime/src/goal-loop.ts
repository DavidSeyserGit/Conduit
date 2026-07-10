import type {
  GoalRunConfig,
  GoalRunResult,
  GoalRunState,
  GoalRunEvent,
} from "@loopkit/shared";
import type { ProviderRegistry } from "@loopkit/model-providers";
import type { ToolExecutor, ToolExecutorContext } from "@loopkit/tools";
import { findProviderForModel } from "@loopkit/model-providers";
import { CodingAgent } from "./coding-agent.js";
import { Judge } from "./judge.js";
import {
  createInitialGoalState,
  createIteration,
  addAgentMessage,
  accumulateTokenUsage,
} from "./state.js";

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

    let state = createInitialGoalState(config);
    state.status = "running";

    const emit = (event: GoalRunEvent) => {
      onEvent(event);
      state = applyEventToState(state, event);
    };

    emit({ type: "run_started", runId: state.id });

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
      emit({ type: "run_failed", error });
      return { status: "failed", state: { ...state, status: "failed" }, error };
    }

    if (!judgeProviderInfo) {
      const error = `No provider found for judge model: ${config.judgeModelId}`;
      emit({ type: "run_failed", error });
      return { status: "failed", state: { ...state, status: "failed" }, error };
    }

    const codingAgent = new CodingAgent();
    const judge = new Judge(
      judgeProviderInfo.provider,
      config.judgeModelId,
      emit
    );

    while (state.iteration < config.maxIterations) {
      if (this.cancelled) {
        state.status = "cancelled";
        state.finishedAt = new Date().toISOString();
        const result: GoalRunResult = { status: "cancelled", state };
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
        });

        state.plan = agentResult.plan ?? state.plan;
        iteration.toolCalls = agentResult.toolCalls;
        iteration.changedFiles = agentResult.changedFiles;
        iteration.validationResults = agentResult.validationResults;

        if (agentResult.agentSummary) {
          addAgentMessage(iteration, "assistant", agentResult.agentSummary);
        }

        state.tokenUsage = accumulateTokenUsage(
          state.tokenUsage,
          agentResult.tokenUsage
        );

        const judgeResult = await judge.review({
          goal: state.goal,
          plan: state.plan,
          changedFiles: agentResult.changedFiles,
          validationResults: agentResult.validationResults,
          iteration: state.iteration,
          agentSummary: agentResult.agentSummary,
          workspacePath: state.workspacePath,
          getDiff: () => toolExecutor.execute("get_git_diff", {}, "goal"),
        });

        iteration.judgeResult = judgeResult;
        state.iterations.push(iteration);

        if (judgeResult.approved) {
          state.status = "completed";
          state.finishedAt = new Date().toISOString();
          const result: GoalRunResult = { status: "completed", state };
          emit({ type: "run_completed", result });
          return result;
        }

        state.lastJudgeFeedback = [
          ...judgeResult.feedback,
          ...judgeResult.missingRequirements.map((r) => `Missing: ${r}`),
        ];
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        state.status = "failed";
        state.finishedAt = new Date().toISOString();
        state.iterations.push(iteration);
        emit({ type: "run_failed", error });
        return { status: "failed", state, error };
      }
    }

    state.status = "iteration_limit_reached";
    state.finishedAt = new Date().toISOString();
    const result: GoalRunResult = {
      status: "iteration_limit_reached",
      state,
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
      return { ...state, plan: event.plan };
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
