import type {
  GoalAnalystOutput,
  GoalAnswer,
  ModelMessage,
  RepositoryContext,
  TokenUsage,
} from "@conduit/shared";
import { GoalAnalystOutputSchema } from "@conduit/shared";
import type { ModelProvider } from "@conduit/model-providers";
import type { RepositoryExcerpt } from "./repository-context.js";

export interface GoalAnalysisRequest {
  initialRequest: string;
  repositoryContext: RepositoryContext;
  excerpts: RepositoryExcerpt[];
  previousAnswers?: GoalAnswer[];
  policies?: string[];
  signal?: AbortSignal;
}

export interface GoalAnalysisResult {
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
  ) {}

  async analyze(request: GoalAnalysisRequest): Promise<GoalAnalysisResult> {
    const messages = this.messages(request);
    let usage: TokenUsage | undefined;
    let firstError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await this.provider.createResponse({
          modelId: this.modelId,
          messages: attempt === 0 ? messages : [
            ...messages,
            { role: "assistant", content: firstError instanceof Error ? firstError.message : String(firstError) },
            { role: "user", content: "Return corrected JSON only. It must exactly match the supplied schema; do not add fields." },
          ],
          structuredOutput: { name: "goal_analysis", schema: GOAL_ANALYST_OUTPUT_SCHEMA },
          workspacePath: request.repositoryContext.workspacePath,
          reasoningEffort: this.reasoningEffort,
          temperature: 0.1,
          maxTokens: 6144,
          signal: request.signal,
        });
        usage = addUsage(usage, response.usage);
        const parsed = GoalAnalystOutputSchema.parse(parseStructured(response.structuredOutput ?? response.content));
        this.rejectInspectableQuestions(parsed, request.repositoryContext);
        return { analysis: parsed, tokenUsage: usage, repaired: attempt === 1 };
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

function criterionJsonSchema() { return { type: "object", additionalProperties: false, required: ["id", "description", "required"], properties: { id: { type: "string" }, description: { type: "string" }, required: { type: "boolean" }, verificationHint: { type: "string" } } }; }
function constraintJsonSchema() { return { type: "object", additionalProperties: false, required: ["id", "description", "source"], properties: { id: { type: "string" }, description: { type: "string" }, source: { enum: ["user", "repository", "policy", "generated"] } } }; }
function deliverableJsonSchema() { return { type: "object", additionalProperties: false, required: ["id", "type", "description", "required"], properties: { id: { type: "string" }, type: { enum: ["implementation", "unit_tests", "integration_tests", "documentation", "migration", "benchmark", "other"] }, description: { type: "string" }, required: { type: "boolean" } } }; }
function assumptionJsonSchema() { return { type: "object", additionalProperties: false, required: ["id", "description", "confirmed"], properties: { id: { type: "string" }, description: { type: "string" }, confirmed: { type: "boolean" } } }; }
function optionJsonSchema() { return { type: "object", additionalProperties: false, required: ["id", "label"], properties: { id: { type: "string" }, label: { type: "string" }, description: { type: "string" }, recommended: { type: "boolean" } } }; }
function questionJsonSchema() { return { type: "object", additionalProperties: false, required: ["id", "type", "title", "required"], properties: { id: { type: "string" }, type: { enum: ["single_select", "multi_select", "confirmation", "text", "repository_reference", "constraint_editor", "success_criteria_editor"] }, title: { type: "string" }, description: { type: "string" }, required: { type: "boolean" }, options: { type: "array", items: optionJsonSchema() }, defaultValue: {}, allowCustomAnswer: { type: "boolean" }, sourceReason: { type: "string" } } }; }
function questionBatchJsonSchema() { return { type: "object", additionalProperties: false, required: ["id", "title", "position", "questions"], properties: { id: { type: "string" }, title: { type: "string" }, position: { type: "integer", minimum: 0 }, questions: { type: "array", minItems: 1, maxItems: 5, items: questionJsonSchema() } } }; }
