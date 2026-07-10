import type {
  GoalRunEvent,
  ModelMessage,
  StoredToolCall,
  AgentPlan,
  TokenUsage,
  ValidationResult,
} from "@loopkit/shared";
import type { ToolExecutor, ToolExecutorContext } from "@loopkit/tools";
import type { ModelProvider } from "@loopkit/model-providers";
import { getToolDefinitions } from "@loopkit/tools";
import {
  CODING_AGENT_SYSTEM_PROMPT,
  buildCodingAgentPrompt,
} from "./prompts.js";
import {
  addToolCall,
  completeToolCall,
  parsePlanFromContent,
} from "./state.js";

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
}

export interface CodingAgentResult {
  plan?: AgentPlan;
  changedFiles: string[];
  validationResults: ValidationResult[];
  agentSummary: string;
  toolCalls: StoredToolCall[];
  messages: ModelMessage[];
  tokenUsage?: TokenUsage;
}

export class CodingAgent {
  async run(config: CodingAgentConfig): Promise<CodingAgentResult> {
    if (typeof window !== "undefined") {
      const response = await fetch("/api/agent/pi-iteration", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspace: config.workspacePath,
          goal: config.goal,
          modelId: config.modelId,
          apiKey: config.modelApiKey,
          previousPlan: config.previousPlan,
          judgeFeedback: config.judgeFeedback,
          iteration: config.iteration,
          maxIterations: config.maxIterations,
        }),
      });
      const body = await response.text();
      if (!body) throw new Error(`Pi backend returned an empty response (${response.status})`);
      const result = JSON.parse(body) as { result?: CodingAgentResult; events?: GoalRunEvent[]; error?: string };
      if (!response.ok || !result.result) throw new Error(result.error || `Pi backend failed (${response.status})`);
      for (const event of result.events ?? []) config.emit(event);
      return result.result;
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

      const response = await config.provider.createResponse({
        modelId: config.modelId,
        messages,
        tools,
        temperature: 0.2,
        maxTokens: 16384,
      });

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

    return {
      plan,
      changedFiles: Array.from(changedFiles),
      validationResults,
      agentSummary,
      toolCalls,
      messages,
      tokenUsage: totalUsage,
    };
  }
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
  };
}
