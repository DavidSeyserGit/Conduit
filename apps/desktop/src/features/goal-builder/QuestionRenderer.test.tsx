import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { GoalQuestion } from "@conduit/shared";
import { QuestionRenderer } from "./QuestionRenderer.tsx";
import { validateQuestionAnswer } from "./question-utils.ts";

const base = { title: "Choose behavior", required: true, sourceReason: "Product intent is ambiguous" };
const questions: GoalQuestion[] = [
  { ...base, id: "single", type: "single_select", options: [{ id: "one", label: "One", recommended: true }], defaultValue: "one", allowCustomAnswer: true },
  { ...base, id: "multiple", type: "multi_select", options: [{ id: "tests", label: "Tests" }], defaultValue: ["tests"] },
  { ...base, id: "confirmation", type: "confirmation", defaultValue: true },
  { ...base, id: "text", type: "text", defaultValue: "Context" },
  { ...base, id: "repository", type: "repository_reference", options: [{ id: "src/auth.ts", label: "src/auth.ts" }] },
  { ...base, id: "constraints", type: "constraint_editor", defaultValue: [{ id: "constraint-1", description: "Preserve behavior", source: "user" }] },
  { ...base, id: "criteria", type: "success_criteria_editor", defaultValue: [{ id: "criterion-1", description: "Behavior works", required: true }] },
];

test("every structured question renders as native, labelled controls", () => {
  for (const question of questions) {
    const value = "defaultValue" in question ? question.defaultValue : undefined;
    const html = renderToStaticMarkup(React.createElement(QuestionRenderer, { question, value, onChange: () => undefined }));
    assert.match(html, new RegExp(`data-question-type="${question.type}"`));
    assert.match(html, /Choose behavior/);
    assert.doesNotMatch(html, /dangerouslySetInnerHTML/);
  }
  assert.match(renderToStaticMarkup(React.createElement(QuestionRenderer, { question: questions[0]!, value: "one", onChange: () => undefined })), /type="radio"/);
  assert.match(renderToStaticMarkup(React.createElement(QuestionRenderer, { question: questions[1]!, value: ["tests"], onChange: () => undefined })), /type="checkbox"/);
  assert.match(renderToStaticMarkup(React.createElement(QuestionRenderer, { question: questions[3]!, value: "Context", onChange: () => undefined })), /textarea/);
});

test("model text is escaped and never interpreted as generated UI", () => {
  const question = { ...questions[3]!, title: "<script>alert('unsafe')</script>" } as GoalQuestion;
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
