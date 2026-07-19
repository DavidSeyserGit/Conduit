import type { GoalAnswerValue, GoalQuestion } from "@conduit/cgs/legacy";
import { ConstraintSchema, SuccessCriterionSchema } from "@conduit/cgs/legacy";

export function validateQuestionAnswer(question: GoalQuestion, value: GoalAnswerValue | undefined): string | null {
  if (value === undefined || value === null) return question.required ? "This question is required." : null;
  if (question.type === "confirmation") return typeof value === "boolean" ? null : "Choose allow or do not allow.";
  if (question.type === "text") return typeof value === "string" && value.trim() ? null : question.required ? "Enter an answer." : null;
  if (question.type === "single_select" || question.type === "repository_reference") {
    if (typeof value !== "string" || !value.trim()) return "Choose one option.";
    return question.allowCustomAnswer || question.options.some((option) => option.id === value) ? null : "Choose an available option.";
  }
  if (question.type === "multi_select") {
    if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) return "Choose one or more options.";
    if (question.required && value.length === 0) return "Choose at least one option.";
    const known = new Set(question.options.map((option) => option.id));
    return question.allowCustomAnswer || value.every((item) => known.has(item)) ? null : "Remove unknown options.";
  }
  if (question.type === "constraint_editor") {
    if (!Array.isArray(value) || value.some((item) => !ConstraintSchema.safeParse(item).success)) return "Review the constraints.";
    return question.required && value.length === 0 ? "Add at least one constraint." : null;
  }
  if (question.type === "success_criteria_editor") {
    if (!Array.isArray(value) || value.some((item) => !SuccessCriterionSchema.safeParse(item).success)) return "Review the success criteria.";
    return question.required && value.length === 0 ? "Add at least one success criterion." : null;
  }
  return null;
}

export function hasRecommendedDefault(question: GoalQuestion): boolean {
  return "defaultValue" in question && question.defaultValue !== undefined;
}
