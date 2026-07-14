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
// A coding iteration may include several model/tool turns. Keep this longer
// than the backend command timeout so a healthy long-running agent is not
// mistaken for a dead server by the browser.
const PI_REQUEST_TIMEOUT_MS = 20 * 60 * 1000;

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
    if (typeof window !== "undefined") {
      const controller = new AbortController();
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const armTimeout = () => {
        clearTimeout(timeout);
        timeout = setTimeout(() => controller.abort(), PI_REQUEST_TIMEOUT_MS);
      };
      armTimeout();
      const abortRequest = () => controller.abort();
      config.signal?.addEventListener("abort", abortRequest, { once: true });
      try {
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
            inputPrice: config.inputPrice,
            outputPrice: config.outputPrice,
            supportsReasoning: config.supportsReasoning,
          }),
          signal: controller.signal,
        });
        if (!response.ok) {
          const error = await response.text();
          throw new Error(error || `Pi backend failed (${response.status})`);
        }

        if (response.headers.get("content-type")?.includes("application/x-ndjson") && response.body) {
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          let result: CodingAgentResult | undefined;
          let lastStatus = "the agent stream started";
          while (true) {
            let chunk: ReadableStreamReadResult<Uint8Array>;
            try {
              chunk = await reader.read();
            } catch (error) {
              const reason = error instanceof Error ? error.message : String(error);
              throw new Error(`Agent stream interrupted after ${lastStatus}: ${reason}`);
            }
            const { done, value } = chunk;
            armTimeout();
            buffer += decoder.decode(value, { stream: !done });
            for (const line of buffer.split("\n").slice(0, done ? undefined : -1)) {
              if (!line.trim()) continue;
              const packet = JSON.parse(line) as { event?: GoalRunEvent; result?: CodingAgentResult; error?: string };
              if (packet.event) {
                config.emit(packet.event);
                if (packet.event.type === "agent_status") lastStatus = `status “${packet.event.message}”`;
                if (packet.event.type === "tool_started") lastStatus = `tool “${packet.event.toolCall.name}” started`;
              }
              if (packet.error) throw new Error(packet.error);
              if (packet.result) result = packet.result;
            }
            buffer = done ? "" : buffer.split("\n").at(-1) ?? "";
            if (done) break;
          }
          if (!result) throw new Error("Pi backend returned no result");
        return result;
        }

        const body = await response.text();
        if (!body) throw new Error(`Pi backend returned an empty response (${response.status})`);
        const result = JSON.parse(body) as { result?: CodingAgentResult; events?: GoalRunEvent[]; error?: string };
        if (!result.result) throw new Error(result.error || `Pi backend failed (${response.status})`);
        for (const event of result.events ?? []) config.emit(event);
        return result.result;
      } catch (error) {
        if (controller.signal.aborted && !config.signal?.aborted) {
          throw new Error("Coding agent timed out after 20 minutes. Check the model/API connection and try again.");
        }
        if (error instanceof TypeError && /fetch|network|load failed/i.test(error.message)) {
          throw new Error("Could not reach the LoopKit agent backend. Check that the Vite/Tauri server is running and try again.");
        }
        throw error;
      } finally {
        clearTimeout(timeout);
        config.signal?.removeEventListener("abort", abortRequest);
      }
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
