import assert from "node:assert/strict";
import test from "node:test";
import {
  SUPPORT_PROMPT_MIN_INTERACTIONS,
  SUPPORT_PROMPT_MIN_SESSIONS,
  SUPPORT_PROMPT_REPEAT_INTERVAL_MS,
  shouldShowSupportPrompt,
  summarizeSupportUsage,
} from "./support-prompt.js";

test("support prompt stays hidden until usage is meaningful", () => {
  assert.equal(shouldShowSupportPrompt({ sessionCount: SUPPORT_PROMPT_MIN_SESSIONS - 1, interactionCount: SUPPORT_PROMPT_MIN_INTERACTIONS - 1 }), false);
  assert.equal(shouldShowSupportPrompt({ sessionCount: SUPPORT_PROMPT_MIN_SESSIONS, interactionCount: 0 }), true);
  assert.equal(shouldShowSupportPrompt({ sessionCount: 0, interactionCount: SUPPORT_PROMPT_MIN_INTERACTIONS }), true);
});

test("support prompt waits four weeks after showing or dismissal", () => {
  const now = Date.parse("2026-07-18T12:00:00.000Z");
  const recent = new Date(now - SUPPORT_PROMPT_REPEAT_INTERVAL_MS + 1).toISOString();
  const elapsed = new Date(now - SUPPORT_PROMPT_REPEAT_INTERVAL_MS).toISOString();
  const usage = { sessionCount: SUPPORT_PROMPT_MIN_SESSIONS, interactionCount: 0 };

  assert.equal(shouldShowSupportPrompt({ ...usage, lastShownAt: recent }, now), false);
  assert.equal(shouldShowSupportPrompt({ ...usage, lastShownAt: elapsed }, now), true);
  assert.equal(shouldShowSupportPrompt({ ...usage, dismissedAt: recent }, now), false);
});

test("support usage counts active sessions, user messages, and completed runs", () => {
  assert.deepEqual(summarizeSupportUsage([
    { messages: [{ role: "user" }, { role: "assistant" }], runHistory: ["run"] },
    { messages: [{ role: "assistant" }], runHistory: [] },
    { messages: [], runHistory: ["run"] },
  ]), { sessionCount: 2, interactionCount: 3 });
});
