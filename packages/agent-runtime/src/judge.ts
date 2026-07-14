import type {
  GoalRunEvent,
  JudgeResult,
  ModelMessage,
  ValidationResult,
  AgentPlan,
  TokenUsage,
} from "@loopkit/shared";
import { JudgeResultSchema } from "@loopkit/shared";
import type { ModelProvider } from "@loopkit/model-providers";
import type { ToolCallResult } from "@loopkit/tools";
import {
  JUDGE_SYSTEM_PROMPT,
  buildJudgePrompt,
  JUDGE_OUTPUT_SCHEMA,
} from "./prompts.js";

export interface JudgeContext {
  goal: string;
  plan?: AgentPlan;
  changedFiles: string[];
  validationResults: ValidationResult[];
  iteration: number;
  agentSummary?: string;
  workspacePath: string;
  getDiff: () => Promise<ToolCallResult>;
}

export interface JudgeReviewResult {
  result: JudgeResult;
  tokenUsage?: TokenUsage;
}

export class Judge {
  constructor(
    private provider: ModelProvider,
    private modelId: string,
    private emit: (event: GoalRunEvent) => void
  ) {}

  async review(ctx: JudgeContext): Promise<JudgeReviewResult> {
    this.emit({ type: "judge_started", iteration: ctx.iteration });

    const diffResult = await ctx.getDiff();
    const diff =
      diffResult.success && diffResult.result
        ? (diffResult.result as { diff: string }).diff
        : "";
    const prompt = buildJudgePrompt({
      goal: ctx.goal,
      plan: ctx.plan ? JSON.stringify(ctx.plan, null, 2) : undefined,
      changedFiles: ctx.changedFiles,
      diff,
      validationResults: ctx.validationResults,
      iteration: ctx.iteration,
      agentSummary: ctx.agentSummary,
    });

    const messages: ModelMessage[] = [
      { role: "system", content: JUDGE_SYSTEM_PROMPT },
      { role: "user", content: prompt },
    ];

    let result: JudgeResult;
    let tokenUsage: TokenUsage | undefined;

    try {
      const response = await this.provider.createResponse({
        modelId: this.modelId,
        messages,
        structuredOutput: {
          name: "judge_evaluation",
          schema: JUDGE_OUTPUT_SCHEMA,
        },
        temperature: 0.1,
        maxTokens: 4096,
      });

      tokenUsage = response.usage;

      result = this.parseJudgeResponse(response.structuredOutput ?? response.content);
    } catch (firstError) {
      // Retry once with repair prompt
      try {
        const repairMessages: ModelMessage[] = [
          ...messages,
          {
            role: "assistant",
            content: firstError instanceof Error ? firstError.message : String(firstError),
          },
          {
            role: "user",
            content:
              "Your previous response could not be parsed. Please return ONLY valid JSON matching the required schema.",
          },
        ];

        const retryResponse = await this.provider.createResponse({
          modelId: this.modelId,
          messages: repairMessages,
          structuredOutput: {
            name: "judge_evaluation",
            schema: JUDGE_OUTPUT_SCHEMA,
          },
          temperature: 0.1,
          maxTokens: 4096,
        });

        tokenUsage = addUsage(tokenUsage, retryResponse.usage);

        result = this.parseJudgeResponse(
          retryResponse.structuredOutput ?? retryResponse.content
        );
      } catch {
        result = {
          approved: false,
          summary: "Judge evaluation failed due to a parsing error.",
          feedback: [
            `Raw judge error: ${firstError instanceof Error ? firstError.message : String(firstError)}`,
          ],
          missingRequirements: ["Unable to evaluate — judge response was malformed"],
          confidence: 0,
        };
      }
    }

    this.emit({ type: "judge_completed", result });
    return { result, tokenUsage };
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
