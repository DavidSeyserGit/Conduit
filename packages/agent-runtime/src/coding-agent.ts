import type {
  GoalRunEvent,
  ModelMessage,
  StoredToolCall,
  AgentPlan,
  TokenUsage,
  ValidationResult,
  CommandPermissionMode,
} from "@conduit/shared";
import type { ToolExecutor, ToolExecutorContext } from "@conduit/tools";
import type { ModelProvider } from "@conduit/model-providers";
import { getToolDefinitions } from "@conduit/tools";
import {
  CODING_AGENT_SYSTEM_PROMPT,
  buildCodingAgentPrompt,
} from "./prompts.js";
import {
  addToolCall,
  completeToolCall,
  parsePlanFromContent,
} from "./state.js";
import { retryModelOperation } from "./model-operation.js";

const MAX_TOOL_ROUNDS = 30;

export interface CodingAgentConfig {
  goal: string;
  workspacePath: string;
  modelId: string;
  provider: ModelProvider;
  toolExecutor: ToolExecutor;
  toolContext?: ToolExecutorContext;
  previousPlan?: AgentPlan;
  judgeFeedback?: string[];
  iteration: number;
  maxIterations: number;
  emit: (event: GoalRunEvent) => void;
  signal?: AbortSignal;
  modelApiKey?: string;
  inputPrice?: number;
  outputPrice?: number;
  supportsReasoning?: boolean;
  codingReasoningEffort?: string;
  permissionMode?: CommandPermissionMode;
}

export interface CodingAgentResult {
  plan?: AgentPlan;
  changedFiles: string[];
  validationResults: ValidationResult[];
  agentSummary: string;
  toolCalls: StoredToolCall[];
  messages: ModelMessage[];
  tokenUsage?: TokenUsage;
  estimatedCost?: number;
}

export class CodingAgent {
  async run(config: CodingAgentConfig): Promise<CodingAgentResult> {
    if (config.provider.runCodingIteration) {
      return retryModelOperation(
        (signal) => config.provider.runCodingIteration!({
          goal: config.goal,
          workspacePath: config.workspacePath,
          modelId: config.modelId,
          previousPlan: config.previousPlan,
          judgeFeedback: config.judgeFeedback,
          iteration: config.iteration,
          maxIterations: config.maxIterations,
          reasoningEffort: config.codingReasoningEffort,
          permissionMode: config.permissionMode,
          signal,
        }, config.emit),
        {
          label: "Coding agent",
          signal: config.signal,
          onRetry: ({ attempt, maxAttempts, reason }) => config.emit({
            type: "agent_status",
            message: `Coding agent request did not finish (${reason}); retrying attempt ${attempt}/${maxAttempts} against the current workspace…`,
          }),
        },
      );
    }

    const toolCalls: StoredToolCall[] = [];
    const changedFiles = new Set<string>();
    const validationResults: ValidationResult[] = [];
    let totalUsage: TokenUsage | undefined;
    let plan = config.previousPlan;

    const tools = getToolDefinitions("goal");
    const userPrompt = buildCodingAgentPrompt({
      goal: config.goal,
      workspacePath: config.workspacePath,
      previousPlan: config.previousPlan
        ? JSON.stringify(config.previousPlan, null, 2)
        : undefined,
      judgeFeedback: config.judgeFeedback,
      iteration: config.iteration,
      maxIterations: config.maxIterations,
    });

    const messages: ModelMessage[] = [
      { role: "system", content: CODING_AGENT_SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ];

    let agentSummary = "";
    let toolRounds = 0;

    while (toolRounds < MAX_TOOL_ROUNDS) {
      if (config.signal?.aborted) break;
      toolRounds++;

      const response = await retryModelOperation(
        (signal) => config.provider.createResponse({
          modelId: config.modelId,
          workspacePath: config.workspacePath,
          signal,
          messages,
          tools,
          temperature: 0.2,
          maxTokens: 16384,
        }),
        {
          label: "Coding agent",
          signal: config.signal,
          onRetry: ({ attempt, maxAttempts, reason }) => config.emit({
            type: "agent_status",
            message: `Coding model request did not finish (${reason}); retrying attempt ${attempt}/${maxAttempts}…`,
          }),
        },
      );

      totalUsage = accumulateUsage(totalUsage, response.usage);

      if (response.content) {
        agentSummary = response.content;
        config.emit({
          type: "agent_message",
          content: response.content,
          messageId: crypto.randomUUID(),
        });

        const parsedPlan = parsePlanFromContent(response.content);
        if (parsedPlan) {
          plan = parsedPlan;
          config.emit({ type: "plan_updated", plan: parsedPlan });
        }
      }

      if (!response.toolCalls || response.toolCalls.length === 0) {
        break;
      }

      messages.push({
        role: "assistant",
        content: response.content,
        toolCalls: response.toolCalls,
      });

      for (const tc of response.toolCalls) {
        const stored = addToolCall(
          { number: config.iteration, agentMessages: [], toolCalls, changedFiles: [], validationResults: [] },
          tc.name,
          tc.arguments
        );
        config.emit({ type: "tool_started", toolCall: stored });

        const result = await config.toolExecutor.execute(tc.name, tc.arguments, "goal");
        completeToolCall(stored, result.result, result.error);
        config.emit({ type: "tool_completed", toolCall: stored });

        if (tc.name !== "run_command" && result.success && "path" in tc.arguments) {
          const filePath = tc.arguments.path as string;
          changedFiles.add(filePath);
          config.emit({ type: "file_changed", path: filePath });
        }

        if (tc.name === "run_command" && result.success && result.result) {
          const cmdResult = result.result as {
            command: string;
            exitCode: number;
            stdout: string;
            stderr: string;
          };
          const validation: ValidationResult = {
            command: cmdResult.command,
            exitCode: cmdResult.exitCode,
            stdout: cmdResult.stdout,
            stderr: cmdResult.stderr,
            passed: cmdResult.exitCode === 0,
          };
          validationResults.push(validation);
          config.emit({ type: "validation_completed", result: validation });
        }

        messages.push({
          role: "tool",
          content: JSON.stringify(result.success ? result.result : { error: result.error }),
          toolCallId: tc.id,
        });
      }
    }

    const estimatedCost = estimateUsageCost(totalUsage, config.inputPrice, config.outputPrice);
    return {
      plan,
      changedFiles: Array.from(changedFiles),
      validationResults,
      agentSummary,
      toolCalls,
      messages,
      tokenUsage: totalUsage,
      estimatedCost,
    };
  }
}

function estimateUsageCost(usage: TokenUsage | undefined, inputPrice?: number, outputPrice?: number): number | undefined {
  if (!usage || (inputPrice === undefined && outputPrice === undefined)) return undefined;
  return (usage.promptTokens / 1_000_000) * (inputPrice ?? 0) + (usage.completionTokens / 1_000_000) * (outputPrice ?? 0);
}

function accumulateUsage(
  current: TokenUsage | undefined,
  addition: TokenUsage | undefined
): TokenUsage | undefined {
  if (!addition) return current;
  if (!current) return { ...addition };
  return {
    promptTokens: current.promptTokens + addition.promptTokens,
    completionTokens: current.completionTokens + addition.completionTokens,
    totalTokens: current.totalTokens + addition.totalTokens,
    cacheReadTokens: (current.cacheReadTokens || 0) + (addition.cacheReadTokens || 0),
    cacheWriteTokens: (current.cacheWriteTokens || 0) + (addition.cacheWriteTokens || 0),
  };
}
