import type {
  GoalRunState,
  GoalRunConfig,
  GoalIteration,
  StoredMessage,
  StoredToolCall,
  AgentPlan,
  TokenUsage,
} from "@conduit/shared";

export function createInitialGoalState(config: GoalRunConfig): GoalRunState {
  return {
    id: config.runId ?? crypto.randomUUID(),
    conduitDesktopVersion: config.conduitDesktopVersion,
    conduitRuntimeVersion: config.conduitRuntimeVersion,
    cgsVersion: config.cgsVersion,
    goal: config.goal,
    workspacePath: config.workspacePath,
    status: "idle",
    codingModelId: config.codingModelId,
    codingReasoningEffort: config.codingReasoningEffort,
    judgeModelId: config.judgeModelId,
    judgeReasoningEffort: config.judgeReasoningEffort,
    iteration: 0,
    maxIterations: config.maxIterations,
    iterations: [],
    startedAt: new Date().toISOString(),
  };
}

export function createIteration(number: number): GoalIteration {
  return {
    number,
    agentMessages: [],
    toolCalls: [],
    changedFiles: [],
    validationResults: [],
  };
}

export function addAgentMessage(
  iteration: GoalIteration,
  role: StoredMessage["role"],
  content: string
): StoredMessage {
  const message: StoredMessage = {
    id: crypto.randomUUID(),
    role,
    content,
    timestamp: new Date().toISOString(),
  };
  iteration.agentMessages.push(message);
  return message;
}

export function addToolCall(
  iteration: GoalIteration,
  name: string,
  args: Record<string, unknown>
): StoredToolCall {
  const toolCall: StoredToolCall = {
    id: crypto.randomUUID(),
    name,
    arguments: args,
    status: "running",
    startedAt: new Date().toISOString(),
  };
  iteration.toolCalls.push(toolCall);
  return toolCall;
}

export function completeToolCall(
  toolCall: StoredToolCall,
  result?: unknown,
  error?: string
): void {
  toolCall.completedAt = new Date().toISOString();
  toolCall.status = error ? "failed" : "completed";
  toolCall.result = result;
  toolCall.error = error;
}

export function parsePlanFromContent(content: string): AgentPlan | undefined {
  const planMatch = content.match(/<plan>\s*([\s\S]*?)\s*<\/plan>/);
  if (!planMatch) return undefined;

  try {
    const plan = JSON.parse(planMatch[1]) as AgentPlan;
    if (plan.summary && Array.isArray(plan.tasks)) {
      return plan;
    }
  } catch {
    // invalid plan JSON
  }

  return undefined;
}

export function accumulateTokenUsage(
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

export function estimateCost(
  tokenUsage: TokenUsage | undefined,
  inputPrice?: number,
  outputPrice?: number
): number | undefined {
  if (!tokenUsage || (!inputPrice && !outputPrice)) return undefined;

  const inputCost = inputPrice
    ? (tokenUsage.promptTokens / 1_000_000) * inputPrice
    : 0;
  const outputCost = outputPrice
    ? (tokenUsage.completionTokens / 1_000_000) * outputPrice
    : 0;

  return inputCost + outputCost;
}
