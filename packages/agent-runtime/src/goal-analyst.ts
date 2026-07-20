import type {
  ModelMessage,
  ModelResponse,
  TokenUsage,
} from "@conduit/shared";
import type { GoalAnalystOutput, GoalAnswer, RepositoryContext } from "@conduit/cgs/legacy";
import { GoalAnalystOutputSchema } from "@conduit/cgs/legacy";
import type { ModelProvider } from "@conduit/model-providers";
import type { RepositoryExcerpt } from "./repository-context.js";
import { DEFAULT_MODEL_ATTEMPT_TIMEOUT_MS, retryModelOperation } from "./model-operation.js";

export interface GoalAnalysisRequest {
  initialRequest: string;
  repositoryContext: RepositoryContext;
  excerpts: RepositoryExcerpt[];
  previousAnswers?: GoalAnswer[];
  policies?: string[];
  signal?: AbortSignal;
}

/** @deprecated Provider response used by the 0.3 compatibility path. */
export interface LegacyGoalAnalysisResult {
  analysis: GoalAnalystOutput;
  tokenUsage?: TokenUsage;
  repaired: boolean;
}

export const GOAL_ANALYST_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: [
    "decisionSummary", "ambiguities", "questionBatches", "proposedTitle", "proposedDescription",
    "proposedSuccessCriteria", "proposedConstraints", "proposedDeliverables", "proposedAssumptions",
  ],
  properties: {
    decisionSummary: { type: "string", minLength: 1 },
    ambiguities: { type: "array", items: { type: "object", additionalProperties: false, required: ["id", "description", "userDecisionRequired", "repositoryFacts"], properties: { id: { type: "string" }, description: { type: "string" }, userDecisionRequired: { type: "boolean" }, repositoryFacts: { type: "array", items: { type: "string" } } } } },
    questionBatches: { type: "array", items: questionBatchJsonSchema() },
    proposedTitle: { type: "string", minLength: 1 },
    proposedDescription: { type: "string", minLength: 1 },
    proposedSuccessCriteria: { type: "array", minItems: 1, items: criterionJsonSchema() },
    proposedConstraints: { type: "array", items: constraintJsonSchema() },
    proposedDeliverables: { type: "array", minItems: 1, items: deliverableJsonSchema() },
    proposedAssumptions: { type: "array", items: assumptionJsonSchema() },
  },
};

export class GoalAnalyst {
  constructor(
    private provider: ModelProvider,
    private modelId: string,
    private reasoningEffort?: string,
    private timeoutMs = DEFAULT_MODEL_ATTEMPT_TIMEOUT_MS,
    private onRetry?: (attempt: number, maxAttempts: number, reason: string) => void,
  ) {}

  async analyze(request: GoalAnalysisRequest): Promise<LegacyGoalAnalysisResult> {
    const messages = this.messages(request);
    let usage: TokenUsage | undefined;
    let firstError: unknown;
    for (let repairAttempt = 0; repairAttempt < 2; repairAttempt += 1) {
      let response: ModelResponse;
      try {
        response = await retryModelOperation(
          (signal) => this.provider.createResponse({
            modelId: this.modelId,
            messages: repairAttempt === 0 ? messages : [
              ...messages,
              { role: "assistant", content: firstError instanceof Error ? firstError.message : String(firstError) },
              { role: "user", content: "Return corrected JSON only. It must exactly match the supplied schema; do not add fields." },
            ],
            structuredOutput: { name: "goal_analysis", schema: GOAL_ANALYST_OUTPUT_SCHEMA },
            workspacePath: request.repositoryContext.workspacePath,
            reasoningEffort: this.reasoningEffort,
            temperature: 0.1,
            maxTokens: 4096,
            signal,
          }),
          {
            label: "Goal Analyst",
            signal: request.signal,
            timeoutMs: this.timeoutMs,
            onRetry: ({ attempt, maxAttempts, reason }) => this.onRetry?.(attempt, maxAttempts, reason),
          },
        );
      } catch (error) {
        if (request.signal?.aborted) throw new Error("Goal analysis cancelled");
        throw new Error(`Goal Analyst request failed: ${conciseProviderError(error)}`);
      }
      try {
        usage = addUsage(usage, response.usage);
        const parsed = GoalAnalystOutputSchema.parse(removeNullObjectProperties(
          parseStructured(response.structuredOutput ?? response.content),
        ));
        this.rejectInspectableQuestions(parsed, request.repositoryContext);
        return { analysis: parsed, tokenUsage: usage, repaired: repairAttempt === 1 };
      } catch (error) {
        if (request.signal?.aborted) throw new Error("Goal analysis cancelled");
        firstError = error;
      }
    }
    throw new Error(`Goal Analyst returned malformed structured output after one repair: ${firstError instanceof Error ? firstError.message : String(firstError)}`);
  }

  private messages(request: GoalAnalysisRequest): ModelMessage[] {
    const excerptText = request.excerpts.map((excerpt) =>
      `### ${excerpt.path}\nReason: ${excerpt.reason}\n\n${excerpt.content}`
    ).join("\n\n");
    return [
      {
        role: "system",
        content: `You are Conduit's Goal Analyst. Convert a rough request into a precise engineering contract.
Repository facts have already been inspected. Never ask the user for a language, framework, package manager, test framework, repository structure, relevant file, existing script, or other fact available in the supplied context. Ask only about intent, permissions, trade-offs, and genuinely ambiguous requirements. Use zero questions when the request is already clear. Batch two to five related questions where possible. All questions must use the native schema; never emit UI code. Keep decision summaries concise and do not reveal private reasoning. Preserve IDs supplied in previous answers when concepts remain unchanged.`,
      },
      {
        role: "user",
        content: `## Initial request\n${request.initialRequest}\n\n## Repository context\n${JSON.stringify(request.repositoryContext, null, 2)}\n\n## Relevant excerpts\n${excerptText || "No excerpts were available."}\n\n## Policies\n${(request.policies ?? []).join("\n") || "No additional policies."}\n\n## Previous answers\n${JSON.stringify(request.previousAnswers ?? [], null, 2)}\n\nReturn the structured goal analysis.`,
      },
    ];
  }

  private rejectInspectableQuestions(analysis: GoalAnalystOutput, context: RepositoryContext): void {
    const forbidden = /\b(which|what) (?:programming )?language\b|\b(which|what) framework (?:does|is)\b|\b(which|what) package manager\b|\b(which|what) test framework\b|\bwhere (?:is|are)\b|\bwhich file\b|\brepository structure\b/i;
    for (const batch of analysis.questionBatches) {
      for (const question of batch.questions) {
        if (forbidden.test(`${question.title} ${question.description ?? ""}`)) {
          throw new Error(`Question ${question.id} asks for a repository fact that must be inspected`);
        }
      }
    }
    if (context.languages.length === 0 && analysis.questionBatches.some((batch) => batch.questions.some((question) => /language/i.test(question.title)))) {
      throw new Error("The analyst may not delegate missing repository inspection to the user");
    }
  }
}

function parseStructured(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  return JSON.parse(fenced ?? raw.match(/\{[\s\S]*\}/)?.[0] ?? raw);
}

function removeNullObjectProperties(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(removeNullObjectProperties);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, child]) => child !== null)
      .map(([key, child]) => [key, removeNullObjectProperties(child)]),
  );
}

function conciseProviderError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const apiMessages = [...message.matchAll(/"message"\s*:\s*"((?:\\.|[^"\\])*)"/g)];
  const encoded = apiMessages.at(-1)?.[1];
  if (encoded) {
    try {
      return JSON.parse(`"${encoded}"`) as string;
    } catch {
      return encoded;
    }
  }
  const lines = message.split("\n").map((line) => line.trim()).filter(Boolean);
  const concise = lines.at(-1) ?? "Unknown provider error";
  return concise.length > 1_000 ? `${concise.slice(0, 997)}...` : concise;
}

function addUsage(current: TokenUsage | undefined, next: TokenUsage | undefined): TokenUsage | undefined {
  if (!current) return next;
  if (!next) return current;
  return {
    promptTokens: current.promptTokens + next.promptTokens,
    completionTokens: current.completionTokens + next.completionTokens,
    totalTokens: current.totalTokens + next.totalTokens,
    cacheReadTokens: (current.cacheReadTokens ?? 0) + (next.cacheReadTokens ?? 0),
    cacheWriteTokens: (current.cacheWriteTokens ?? 0) + (next.cacheWriteTokens ?? 0),
  };
}

function nullable(schema: Record<string, unknown>) { return { anyOf: [schema, { type: "null" }] }; }
function criterionJsonSchema() {
  return strictObject({
    id: { type: "string", minLength: 1 },
    description: { type: "string", minLength: 1 },
    required: { type: "boolean" },
    verificationHint: nullable({ type: "string", minLength: 1 }),
  });
}
function constraintJsonSchema() {
  return strictObject({
    id: { type: "string", minLength: 1 },
    description: { type: "string", minLength: 1 },
    source: { type: "string", enum: ["user", "repository", "policy", "generated"] },
  });
}
function deliverableJsonSchema() {
  return strictObject({
    id: { type: "string", minLength: 1 },
    type: { type: "string", enum: ["implementation", "unit_tests", "integration_tests", "documentation", "migration", "benchmark", "other"] },
    description: { type: "string", minLength: 1 },
    required: { type: "boolean" },
  });
}
function assumptionJsonSchema() {
  return strictObject({
    id: { type: "string", minLength: 1 },
    description: { type: "string", minLength: 1 },
    confirmed: { type: "boolean" },
  });
}
function optionJsonSchema() {
  return strictObject({
    id: { type: "string", minLength: 1 },
    label: { type: "string", minLength: 1 },
    description: nullable({ type: "string", minLength: 1 }),
    recommended: nullable({ type: "boolean" }),
  });
}
function questionJsonSchema() {
  const base = {
    id: { type: "string", minLength: 1 },
    title: { type: "string", minLength: 1 },
    description: nullable({ type: "string", minLength: 1 }),
    required: { type: "boolean" },
    sourceReason: nullable({ type: "string", minLength: 1 }),
  };
  const options = { type: "array", minItems: 1, items: optionJsonSchema() };
  return {
    anyOf: [
      strictObject({ ...base, type: { type: "string", enum: ["single_select"] }, options, defaultValue: nullable({ type: "string", minLength: 1 }), allowCustomAnswer: nullable({ type: "boolean" }) }),
      strictObject({ ...base, type: { type: "string", enum: ["multi_select"] }, options, defaultValue: nullable({ type: "array", items: { type: "string", minLength: 1 } }), allowCustomAnswer: nullable({ type: "boolean" }) }),
      strictObject({ ...base, type: { type: "string", enum: ["confirmation"] }, defaultValue: nullable({ type: "boolean" }) }),
      strictObject({ ...base, type: { type: "string", enum: ["text"] }, defaultValue: nullable({ type: "string" }) }),
      strictObject({ ...base, type: { type: "string", enum: ["repository_reference"] }, options, defaultValue: nullable({ type: "string", minLength: 1 }), allowCustomAnswer: nullable({ type: "boolean" }) }),
      strictObject({ ...base, type: { type: "string", enum: ["constraint_editor"] }, defaultValue: nullable({ type: "array", items: constraintJsonSchema() }) }),
      strictObject({ ...base, type: { type: "string", enum: ["success_criteria_editor"] }, defaultValue: nullable({ type: "array", items: criterionJsonSchema() }) }),
    ],
  };
}
function questionBatchJsonSchema() { return { type: "object", additionalProperties: false, required: ["id", "title", "position", "questions"], properties: { id: { type: "string" }, title: { type: "string" }, position: { type: "integer", minimum: 0 }, questions: { type: "array", minItems: 1, maxItems: 5, items: questionJsonSchema() } } }; }

function strictObject(properties: Record<string, unknown>) {
  return {
    type: "object",
    additionalProperties: false,
    required: Object.keys(properties),
    properties,
  };
}
