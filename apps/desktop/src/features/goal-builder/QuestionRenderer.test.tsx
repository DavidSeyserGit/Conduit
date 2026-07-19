import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { GoalQuestion } from "@conduit/cgs/legacy";
import { QuestionRenderer } from "./QuestionRenderer.tsx";
import { validateQuestionAnswer } from "./question-utils.ts";
import { legacyQuestionBatchesToCgs } from "@conduit/runtime";

const base = { title: "Choose behavior", required: true, sourceReason: "Product intent is ambiguous" };
const questions: GoalQuestion[] = [
  { ...base, id: "single", type: "single_select", options: [{ id: "one", label: "One", recommended: true }, { id: "two", label: "Two" }], defaultValue: "one", allowCustomAnswer: true },
  { ...base, id: "multiple", type: "multi_select", options: [{ id: "tests", label: "Tests" }, { id: "docs", label: "Docs" }], defaultValue: ["tests"] },
  { ...base, id: "confirmation", type: "confirmation", defaultValue: true },
  { ...base, id: "text", type: "text", defaultValue: "Context" },
  { ...base, id: "repository", type: "repository_reference", options: [{ id: "src/auth.ts", label: "src/auth.ts" }, { id: "src/session.ts", label: "src/session.ts" }] },
  { ...base, id: "constraints", type: "constraint_editor", defaultValue: [{ id: "constraint-1", description: "Preserve behavior", source: "user" }] },
  { ...base, id: "criteria", type: "success_criteria_editor", defaultValue: [{ id: "criterion-1", description: "Behavior works", required: true }] },
];
const cgsQuestions = legacyQuestionBatchesToCgs("goal-test", [{ id: "batch-test", title: "Test", position: 0, questions }], "2026-07-19T10:00:00Z")[0]!.questions;

test("every structured question renders as native, labelled controls", () => {
  for (const question of cgsQuestions) {
    const value = "defaultValue" in question ? question.defaultValue : undefined;
    const html = renderToStaticMarkup(React.createElement(QuestionRenderer, { question, value, onChange: () => undefined }));
    assert.match(html, new RegExp(`data-question-type="${question.type}"`));
    assert.match(html, /Choose behavior/);
    assert.doesNotMatch(html, /dangerouslySetInnerHTML/);
  }
  assert.match(renderToStaticMarkup(React.createElement(QuestionRenderer, { question: cgsQuestions[0]!, value: "one", onChange: () => undefined })), /type="radio"/);
  assert.match(renderToStaticMarkup(React.createElement(QuestionRenderer, { question: cgsQuestions[1]!, value: ["tests"], onChange: () => undefined })), /type="checkbox"/);
  assert.match(renderToStaticMarkup(React.createElement(QuestionRenderer, { question: cgsQuestions[3]!, value: "Context", onChange: () => undefined })), /textarea/);
});

test("model text is escaped and never interpreted as generated UI", () => {
  const question = { ...cgsQuestions[3]!, prompt: "<script>alert('unsafe')</script>" };
  const html = renderToStaticMarkup(React.createElement(QuestionRenderer, { question, value: "", onChange: () => undefined }));
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
});

test("question validation covers defaults, optional skips, custom answers, and editors", () => {
  assert.equal(validateQuestionAnswer(questions[0]!, "one"), null);
  assert.equal(validateQuestionAnswer(questions[0]!, "custom choice"), null);
  assert.equal(validateQuestionAnswer(questions[1]!, []), "Choose at least one option.");
  assert.equal(validateQuestionAnswer(questions[2]!, false), null);
  assert.equal(validateQuestionAnswer(questions[3]!, ""), "Enter an answer.");
  assert.equal(validateQuestionAnswer({ ...questions[3]!, required: false } as GoalQuestion, null), null);
  assert.equal(validateQuestionAnswer(questions[5]!, [{ id: "bad" }] as never), "Review the constraints.");
  assert.equal(validateQuestionAnswer(questions[6]!, [{ id: "criterion", description: "Works", required: true }]), null);
});

test("Goal Builder surfaces follow dark mode and the configured Goal accent", () => {
  const css = readFileSync(new URL("../../index.css", import.meta.url), "utf8");
  const builder = readFileSync(new URL("./GoalBuilder.tsx", import.meta.url), "utf8");
  const questions = readFileSync(new URL("./QuestionRenderer.tsx", import.meta.url), "utf8");
  const preview = readFileSync(new URL("./GoalPreview.tsx", import.meta.url), "utf8");

  assert.match(builder, /overflow-y-auto bg-gray-50/);
  assert.doesNotMatch(builder, /bg-\[#fbfbfc\]/);
  assert.match(builder, /getModeColor\(settings, "goal"\)/);
  assert.match(builder, /"--goal-accent": goalColor/);
  assert.doesNotMatch(`${builder}\n${questions}\n${preview}`, /indigo-/);
  assert.match(css, /\.goal-accent-selected/);
  assert.match(css, /\.dark \.goal-accent-selected/);
  assert.match(css, /\.dark \.from-gray-50/);
  assert.match(css, /\.dark \.to-white/);
  assert.match(css, /\.dark \.focus\\:bg-white:focus/);
});
