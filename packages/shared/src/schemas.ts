import { z } from "zod";

// ─── Model Provider ───────────────────────────────────────────────────────────

export const ModelDescriptorSchema = z.object({
  id: z.string(),
  provider: z.string(),
  displayName: z.string(),
  contextLength: z.number().optional(),
  supportsTools: z.boolean(),
  supportsStructuredOutput: z.boolean(),
  supportsReasoning: z.boolean().optional(),
  inputPrice: z.number().optional(),
  outputPrice: z.number().optional(),
});

export type ModelDescriptor = z.infer<typeof ModelDescriptorSchema>;

export interface ModelMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string;
  toolCalls?: ToolCallRequest[];
}

export interface ToolCallRequest {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ModelRequest {
  modelId: string;
  messages: ModelMessage[];
  tools?: ToolDefinition[];
  structuredOutput?: { schema: Record<string, unknown>; name: string };
  temperature?: number;
  maxTokens?: number;
}

export interface ModelResponse {
  content: string;
  toolCalls?: ToolCallRequest[];
  structuredOutput?: unknown;
  usage?: TokenUsage;
  finishReason?: string;
}

export interface ModelStreamEvent {
  type: "content_delta" | "tool_call_delta" | "done" | "error";
  content?: string;
  toolCall?: Partial<ToolCallRequest>;
  error?: string;
  usage?: TokenUsage;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface ModelCostBreakdown {
  modelId: string;
  inputCost: number;
  outputCost: number;
  cacheReadCost?: number;
  cacheWriteCost?: number;
  totalCost: number;
}

export interface SessionUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalCost: number;
}

// ─── Agent Plan ───────────────────────────────────────────────────────────────

export const AgentTaskStatusSchema = z.enum([
  "pending",
  "in_progress",
  "completed",
  "blocked",
]);

export const AgentTaskSchema = z.object({
  id: z.string(),
  description: z.string(),
  status: AgentTaskStatusSchema,
});

export const AgentPlanSchema = z.object({
  summary: z.string(),
  tasks: z.array(AgentTaskSchema),
});

export type AgentTask = z.infer<typeof AgentTaskSchema>;
export type AgentPlan = z.infer<typeof AgentPlanSchema>;

// ─── Judge ────────────────────────────────────────────────────────────────────

export const JudgeResultSchema = z.object({
  approved: z.boolean(),
  summary: z.string(),
  feedback: z.array(z.string()),
  missingRequirements: z.array(z.string()),
  confidence: z.number().min(0).max(1),
});

export type JudgeResult = z.infer<typeof JudgeResultSchema>;

// ─── Goal Run State ───────────────────────────────────────────────────────────

export const GoalRunStatusSchema = z.enum([
  "idle",
  "running",
  "waiting_for_approval",
  "completed",
  "cancelled",
  "failed",
  "iteration_limit_reached",
]);

export type GoalRunStatus = z.infer<typeof GoalRunStatusSchema>;

export interface StoredMessage {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  timestamp: string;
  toolCallId?: string;
}

export interface StoredToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  result?: unknown;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  startedAt: string;
  completedAt?: string;
  error?: string;
}

export interface ValidationResult {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  passed: boolean;
}

export interface GoalIteration {
  number: number;
  agentMessages: StoredMessage[];
  toolCalls: StoredToolCall[];
  changedFiles: string[];
  validationResults: ValidationResult[];
  judgeResult?: JudgeResult;
}

export interface IterationMetrics {
  iteration: number;
  toolCallCount: number;
  durationMs: number;
  confidence: number;
  approved: boolean;
  changedFiles: number;
  validationPassed: boolean;
}

export interface LoopMetrics {
  totalIterations: number;
  totalToolCalls: number;
  totalDurationMs: number;
  averageConfidence: number;
  confidenceTrend: number[];
  iterationsToComplete: number;
  successRate: number;
  perIteration: IterationMetrics[];
}

export interface GoalRunState {
  id: string;
  goal: string;
  workspacePath: string;
  status: GoalRunStatus;
  codingModelId: string;
  judgeModelId: string;
  iteration: number;
  maxIterations: number;
  plan?: AgentPlan;
  iterations: GoalIteration[];
  startedAt: string;
  finishedAt?: string;
  tokenUsage?: TokenUsage;
  codingTokenUsage?: TokenUsage;
  judgeTokenUsage?: TokenUsage;
  codingCost?: ModelCostBreakdown;
  judgeCost?: ModelCostBreakdown;
  estimatedCost?: number;
  lastJudgeFeedback?: string[];
  metrics?: LoopMetrics;
}

export interface JudgePreset {
  id: string;
  name: string;
  description: string;
  codingModelPattern: string;
  judgeModelPattern: string;
  recommended: boolean;
}

export interface ExportedRun {
  version: string;
  exportedAt: string;
  run: GoalRunState;
  events: GoalRunEvent[];
  metadata: {
    codingModelId: string;
    judgeModelId: string;
    totalIterations: number;
    totalDurationMs: number;
  };
}

export interface GoalRunConfig {
  goal: string;
  workspacePath: string;
  codingModelId: string;
  judgeModelId: string;
  maxIterations: number;
  maxCost?: number;
  modelApiKey?: string;
  resumeState?: GoalRunState;
  codingInputPrice?: number;
  codingOutputPrice?: number;
  judgeInputPrice?: number;
  judgeOutputPrice?: number;
  codingSupportsReasoning?: boolean;
}

export interface GoalRunResult {
  status: "completed" | "cancelled" | "iteration_limit_reached" | "failed";
  state: GoalRunState;
  error?: string;
}

// ─── Events ───────────────────────────────────────────────────────────────────

export type GoalRunEvent =
  | { type: "run_started"; runId: string }
  | { type: "iteration_started"; iteration: number }
  | { type: "agent_status"; message: string }
  | { type: "agent_message"; content: string; messageId: string }
  | { type: "plan_updated"; plan: AgentPlan }
  | { type: "tool_started"; toolCall: StoredToolCall }
  | { type: "tool_completed"; toolCall: StoredToolCall }
  | { type: "file_changed"; path: string }
  | { type: "validation_completed"; result: ValidationResult }
  | { type: "judge_started"; iteration: number }
  | { type: "judge_completed"; result: JudgeResult }
  | { type: "approval_required"; command: string; requestId: string }
  | { type: "run_completed"; result: GoalRunResult }
  | { type: "run_failed"; error: string };

// ─── Chat / Ask Mode ──────────────────────────────────────────────────────────

export type ChatMode = "ask" | "goal";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: string;
  isStreaming?: boolean;
}

export interface SessionState {
  id: string;
  workspacePath: string;
  mode: ChatMode;
  codingModelId: string;
  judgeModelId: string;
  maxIterations: number;
  messages: ChatMessage[];
  currentRun?: GoalRunState;
  createdAt: string;
  updatedAt: string;
}

// ─── Settings ─────────────────────────────────────────────────────────────────

export type CommandPermissionMode =
  | "ask_every_time"
  | "auto_approve_safe"
  | "auto_approve_all";

export interface AppSettings {
  openRouterApiKey?: string;
  inputGlowColor: string;
  commandPermissionMode: CommandPermissionMode;
  defaultCodingModelId?: string;
  defaultJudgeModelId?: string;
  defaultMaxIterations: number;
  acpAgents?: AcpAgentConfig[];
}

export interface AcpAgentConfig {
  id: string;
  name: string;
  command: string;
  args?: string[];
  experimental?: boolean;
}

// ─── Errors ───────────────────────────────────────────────────────────────────

export class LoopKitError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly recoverable = false
  ) {
    super(message);
    this.name = "LoopKitError";
  }
}

export class WorkspaceError extends LoopKitError {
  constructor(message: string) {
    super(message, "WORKSPACE_ERROR", false);
    this.name = "WorkspaceError";
  }
}

export class ProviderError extends LoopKitError {
  constructor(message: string, recoverable = true) {
    super(message, "PROVIDER_ERROR", recoverable);
    this.name = "ProviderError";
  }
}

export class ToolError extends LoopKitError {
  constructor(message: string) {
    super(message, "TOOL_ERROR", true);
    this.name = "ToolError";
  }
}
