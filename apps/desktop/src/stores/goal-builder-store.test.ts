import assert from "node:assert/strict";
import test from "node:test";
import type { GoalQuestionBatch } from "@conduit/shared";

test("batch navigation retains answers and applies recommended defaults", async () => {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
    },
  });
  const { useGoalBuilderStore } = await import("./goal-builder-store.ts");
  const batches: GoalQuestionBatch[] = [
    { id: "behavior", title: "Behavior", position: 0, questions: [{ id: "choice", type: "single_select", title: "Choose", required: true, options: [{ id: "safe", label: "Safe", recommended: true }], defaultValue: "safe" }] },
    { id: "permissions", title: "Permissions", position: 1, questions: [{ id: "install", type: "confirmation", title: "Install dependencies?", required: true, defaultValue: false }] },
  ];
  useGoalBuilderStore.setState({ phase: "questions", batches, batchIndex: 0, answers: {}, defaultAnswerIds: [] });

  useGoalBuilderStore.getState().setAnswer("choice", "safe");
  useGoalBuilderStore.getState().setBatchIndex(1);
  useGoalBuilderStore.getState().setAnswer("install", true);
  useGoalBuilderStore.getState().setBatchIndex(0);
  assert.equal(useGoalBuilderStore.getState().answers.choice, "safe");
  assert.equal(useGoalBuilderStore.getState().answers.install, true);

  useGoalBuilderStore.getState().useRecommendedDefaults();
  assert.equal(useGoalBuilderStore.getState().answers.install, false);
  assert.ok(useGoalBuilderStore.getState().defaultAnswerIds.includes("install"));
});

test("deterministic Goal Builder flow covers questions, preview, and execution-time decisions", async () => {
  const { seedGoalBuilderDemo, useGoalBuilderStore } = await import("./goal-builder-store.ts");

  seedGoalBuilderDemo("questions");
  assert.equal(useGoalBuilderStore.getState().phase, "questions");
  assert.equal(useGoalBuilderStore.getState().batches[0]?.title, "Required behavior");
  assert.equal(useGoalBuilderStore.getState().batches.length, 2);
  assert.ok(useGoalBuilderStore.getState().defaultAnswerIds.length > 0);

  seedGoalBuilderDemo("preview");
  assert.equal(useGoalBuilderStore.getState().phase, "preview");
  assert.equal(useGoalBuilderStore.getState().goal?.version, 3);
  assert.equal(useGoalBuilderStore.getState().goal?.status, "awaiting_approval");

  seedGoalBuilderDemo("execution");
  assert.equal(useGoalBuilderStore.getState().phase, "execution_question");
  assert.equal(useGoalBuilderStore.getState().batches[0]?.questions[0]?.id, "account-linking");
});
