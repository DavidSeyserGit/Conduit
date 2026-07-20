import type {
  GoalRunEvent,
  JudgeResult,
  ModelMessage,
  ValidationResult,
  AgentPlan,
  TokenUsage,
} from "@conduit/shared";
import { AgentPlanSchema, JudgeResultSchema } from "@conduit/shared";
import type { ModelProvider } from "@conduit/model-providers";
import {
  JUDGE_SYSTEM_PROMPT,
  JUDGE_PLANNING_SYSTEM_PROMPT,
  buildJudgePrompt,
  JUDGE_OUTPUT_SCHEMA,
  JUDGE_PLAN_OUTPUT_SCHEMA,
} from "./prompts.js";
import { retryModelOperation } from "./model-operation.js";

export interface JudgeContext {
  goal: string;
  plan?: AgentPlan;
  changedFiles: string[];
  validationResults: ValidationResult[];
  iteration: number;
  agentSummary?: string;
  workspacePath: string;
  diff: string;
}

export interface JudgeReviewResult {
  result: JudgeResult;
  tokenUsage?: TokenUsage;
}

export interface JudgePlanResult {
  plan: AgentPlan;
  tokenUsage?: TokenUsage;
}

export class Judge {
  constructor(
    private provider: ModelProvider,
    private modelId: string,
    private workspacePath: string,
    private reasoningEffort: string | undefined,
    private emit: (event: GoalRunEvent) => void,
    private signal?: AbortSignal,
  ) {}

  async review(ctx: JudgeContext): Promise<JudgeReviewResult> {
    this.emit({ type: "judge_started", iteration: ctx.iteration });

    const prompt = buildJudgePrompt({
      goal: ctx.goal,
      plan: ctx.plan ? JSON.stringify(ctx.plan, null, 2) : undefined,
      changedFiles: ctx.changedFiles,
      diff: ctx.diff,
      validationResults: ctx.validationResults,
      iteration: ctx.iteration,
      agentSummary: ctx.agentSummary,
    });

    const messages: ModelMessage[] = [
      { role: "system", content: JUDGE_SYSTEM_PROMPT },
      { role: "user", content: prompt },
    ];

    const response = await this.createResponseWithLiveness({
      modelId: this.modelId,
      messages,
      structuredOutput: {
        name: "judge_evaluation",
        schema: JUDGE_OUTPUT_SCHEMA,
      },
      workspacePath: this.workspacePath,
      reasoningEffort: this.reasoningEffort,
      temperature: 0.1,
      maxTokens: 4096,
    }, "judging");
    let tokenUsage = response.usage;
    let result: JudgeResult;
    try {
      result = this.parseJudgeResponse(response.structuredOutput ?? response.content);
      result = this.normalizeEvidenceOnlyRejection(result, ctx.validationResults);
    } catch (firstError) {
      const repairMessages: ModelMessage[] = [
        ...messages,
        {
          role: "assistant",
          content: firstError instanceof Error ? firstError.message : String(firstError),
        },
        {
          role: "user",
          content: "Your previous response could not be parsed. Please return ONLY valid JSON matching the required schema.",
        },
      ];
      const retryResponse = await this.createResponseWithLiveness({
        modelId: this.modelId,
        messages: repairMessages,
        structuredOutput: {
          name: "judge_evaluation",
          schema: JUDGE_OUTPUT_SCHEMA,
        },
        workspacePath: this.workspacePath,
        reasoningEffort: this.reasoningEffort,
        temperature: 0.1,
        maxTokens: 4096,
      }, "judging");
      tokenUsage = addUsage(tokenUsage, retryResponse.usage);
      try {
        result = this.normalizeEvidenceOnlyRejection(this.parseJudgeResponse(
          retryResponse.structuredOutput ?? retryResponse.content
        ), ctx.validationResults);
      } catch {
        result = {
          approved: false,
          summary: "Judge evaluation failed due to a parsing error.",
          feedback: [
            `Raw judge error: ${firstError instanceof Error ? firstError.message : String(firstError)}`,
          ],
          missingRequirements: ["Unable to evaluate — judge response was malformed"],
          repairFeedback: ["Restore a valid judge evaluation response before continuing."],
          evidenceRequests: [],
          followUps: [],
          confidence: 0,
        };
      }
    }

    this.emit({ type: "judge_completed", result });
    return { result, tokenUsage };
  }

  async createImplementationPlan(goal: string): Promise<JudgePlanResult> {
    const response = await this.createResponseWithLiveness({
      modelId: this.modelId,
      messages: [
        { role: "system", content: JUDGE_PLANNING_SYSTEM_PROMPT },
        { role: "user", content: `## Goal\n${goal}\n\nWrite the implementation plan now.` },
      ],
      structuredOutput: { name: "implementation_plan", schema: JUDGE_PLAN_OUTPUT_SCHEMA },
      workspacePath: this.workspacePath,
      reasoningEffort: this.reasoningEffort,
      temperature: 0.1,
      maxTokens: 2048,
    }, "planning");
    const raw = response.structuredOutput ?? response.content;
    const parsed = typeof raw === "string" ? JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] || raw) : raw;
    return { plan: AgentPlanSchema.parse(parsed), tokenUsage: response.usage };
  }

  private async createResponseWithLiveness(
    request: Parameters<ModelProvider["createResponse"]>[0],
    phase: "planning" | "judging",
  ) {
    const startedAt = new Date().toISOString();
    const emitHeartbeat = () => this.emit({
      type: "agent_heartbeat",
      provider: this.provider.name,
      at: new Date().toISOString(),
      startedAt,
      phase,
      source: "network",
      detail: phase === "planning" ? "Judge plan request remains open" : "Judge request remains open",
    });
    emitHeartbeat();
    const timer = setInterval(emitHeartbeat, 10_000);
    try {
      return await retryModelOperation(
        (signal) => this.provider.createResponse({ ...request, signal }),
        {
          label: phase === "planning" ? "Planning reviewer" : "Judge reviewer",
          signal: this.signal,
          onRetry: ({ attempt, maxAttempts, reason }) => this.emit({
            type: "agent_status",
            message: `${phase === "planning" ? "Planning reviewer" : "Judge reviewer"} request did not finish (${reason}); retrying attempt ${attempt}/${maxAttempts}…`,
          }),
        },
      );
    } finally {
      clearInterval(timer);
    }
  }

  private parseJudgeResponse(raw: unknown): JudgeResult {
    if (typeof raw === "string") {
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        raw = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error("No JSON found in judge response");
      }
    }

    const parsed = JudgeResultSchema.parse(raw);
    return parsed;
  }

  private normalizeEvidenceOnlyRejection(
    result: JudgeResult,
    validationResults: ValidationResult[],
  ): JudgeResult {
    if (result.approved) return result;
    const repairFeedback = Array.from(new Set([
      ...result.repairFeedback,
      ...result.missingRequirements,
    ]));
    const failedCommands = validationResults.filter((validation) => !validation.passed).map((validation) => validation.command);
    if (failedCommands.length > 0 && repairFeedback.length === 0) {
      repairFeedback.push(`Make required validation pass: ${failedCommands.join(", ")}`);
    }
    if (repairFeedback.length > 0) return { ...result, repairFeedback };

    return {
      ...result,
      approved: true,
      feedback: [],
      followUps: Array.from(new Set([...result.followUps, ...result.feedback])),
      summary: `${result.summary} No unmet original-goal requirement was identified.`,
    };
  }
}

function addUsage(current: TokenUsage | undefined, addition: TokenUsage | undefined): TokenUsage | undefined {
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
