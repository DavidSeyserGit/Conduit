import type { z } from "zod";
import type { ValidationResult } from "./common.js";
import {
  AnswerBatchSchema, ConduitRunSchema, EvidenceArtifactSchema, EvidenceRequestSchema, GoalReportSchema,
  GoalSpecificationSchema, QuestionBatchSchema, ReviewRequestSchema, ReviewResultSchema,
  type AnswerBatch, type ConduitRun, type EvidenceArtifact, type EvidenceRequest, type GoalQuestion,
  type GoalReport, type GoalSpecification, type QuestionBatch, type ReviewRequest, type ReviewResult,
} from "./artifacts.js";

const parse = <S extends z.ZodTypeAny>(schema: S, input: unknown): z.output<S> => schema.parse(input) as z.output<S>;
const validate = <S extends z.ZodTypeAny>(schema: S, input: unknown): ValidationResult<z.output<S>> => {
  const result = schema.safeParse(input);
  if (result.success) return { valid: true, value: result.data, errors: [] };
  return { valid: false, errors: result.error.issues.map((issue) => ({ path: issue.path, code: issue.code, message: issue.message })) };
};

export const parseGoalSpecification = (input: unknown): GoalSpecification => parse(GoalSpecificationSchema, input);
export const parseQuestionBatch = (input: unknown): QuestionBatch => parse(QuestionBatchSchema, input);
export const parseAnswerBatch = (input: unknown): AnswerBatch => parse(AnswerBatchSchema, input);
export const parseReviewRequest = (input: unknown): ReviewRequest => parse(ReviewRequestSchema, input);
export const parseReviewResult = (input: unknown): ReviewResult => parse(ReviewResultSchema, input);
export const parseEvidenceRequest = (input: unknown): EvidenceRequest => parse(EvidenceRequestSchema, input);
export const parseEvidenceArtifact = (input: unknown): EvidenceArtifact => parse(EvidenceArtifactSchema, input);
export const parseConduitRun = (input: unknown): ConduitRun => parse(ConduitRunSchema, input);
export const parseGoalReport = (input: unknown): GoalReport => parse(GoalReportSchema, input);

export const validateGoalSpecification = (input: unknown) => validate(GoalSpecificationSchema, input);
export const validateQuestionBatch = (input: unknown) => validate(QuestionBatchSchema, input);
export const validateAnswerBatch = (input: unknown) => validate(AnswerBatchSchema, input);
export const validateReviewResult = (input: unknown) => validate(ReviewResultSchema, input);
export const validateEvidenceArtifact = (input: unknown) => validate(EvidenceArtifactSchema, input);
export const validateConduitRun = (input: unknown) => validate(ConduitRunSchema, input);
export const validateGoalReport = (input: unknown) => validate(GoalReportSchema, input);

export function validateAnswersForBatch(batch: QuestionBatch, answers: AnswerBatch): ValidationResult<AnswerBatch> {
  const errors: Array<{ path: Array<string | number>; code: string; message: string }> = [];
  if (answers.questionBatchId !== batch.id || answers.goalId !== batch.goalId) errors.push({ path: [], code: "custom", message: "Answer batch must reference its question batch and goal" });
  const byId = new Map(answers.answers.map((answer) => [answer.questionId, answer]));
  batch.questions.forEach((question, index) => {
    const answer = byId.get(question.id);
    if (question.required && !answer) errors.push({ path: ["answers"], code: "custom", message: `Required question ${question.id} is unanswered` });
    if (answer && !answerMatchesQuestion(question, answer.value)) errors.push({ path: ["answers", index, "value"], code: "custom", message: `Answer does not match question type ${question.type}` });
  });
  for (const answer of answers.answers) if (!batch.questions.some((question) => question.id === answer.questionId)) errors.push({ path: ["answers"], code: "custom", message: `Unknown question ${answer.questionId}` });
  return errors.length ? { valid: false, errors } : { valid: true, value: answers, errors: [] };
}

function answerMatchesQuestion(question: GoalQuestion, value: unknown): boolean {
  if (question.type === "confirmation") return typeof value === "boolean";
  if (["free_text", "repository_reference"].includes(question.type)) return typeof value === "string";
  if (question.type === "single_select") return question.options?.some((option) => deepEqual(option.value, value)) ?? false;
  if (question.type === "multi_select") return Array.isArray(value) && value.every((item) => question.options?.some((option) => deepEqual(option.value, item)));
  return Array.isArray(value);
}
const deepEqual = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);

export function validateReviewAgainstRequest(result: ReviewResult, request: ReviewRequest, goal: GoalSpecification): ValidationResult<ReviewResult> {
  const errors: Array<{ path: Array<string | number>; code: string; message: string }> = [];
  if (result.reviewRequestId !== request.id || result.runId !== request.runId || result.goalId !== request.goalId || result.reviewerId !== request.reviewerId) errors.push({ path: [], code: "custom", message: "Review result does not match its request" });
  const criteria = new Set(goal.successCriteria.map((criterion) => criterion.id));
  for (const [index, criterion] of result.criterionResults.entries()) if (!criteria.has(criterion.criterionId)) errors.push({ path: ["criterionResults", index, "criterionId"], code: "custom", message: "Criterion result references an unknown goal criterion" });
  return errors.length ? { valid: false, errors } : { valid: true, value: result, errors: [] };
}
