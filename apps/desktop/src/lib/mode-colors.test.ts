/// <reference path="../../../../node_modules/.pnpm/@types+node@22.20.1/node_modules/@types/node/index.d.ts" />
import { test } from "node:test";
import assert from "node:assert/strict";
import { getModeColor, DEFAULT_ASK_COLOR, DEFAULT_GOAL_COLOR, FALLBACK_GOAL_COLOR } from "./mode-colors.ts";
import type { AppSettings } from "@loopkit/shared";

function makeSettings(overrides: Partial<AppSettings> = {}): AppSettings {
	return {
		inputGlowColor: "#3b82f6",
		askModeColor: "#3b82f6",
		goalModeColor: "#8b5cf6",
		commandPermissionMode: "ask",
		defaultMaxIterations: 5,
		...overrides,
	} as AppSettings;
}

test("ask mode returns askModeColor when set", () => {
	const settings = makeSettings({ askModeColor: "#ff00ff" });
	assert.equal(getModeColor(settings, "ask"), "#ff00ff");
});

test("ask mode falls back to inputGlowColor when askModeColor is missing", () => {
	const settings = makeSettings({ askModeColor: undefined, inputGlowColor: "#abcdef" });
	assert.equal(getModeColor(settings, "ask"), "#abcdef");
});

test("ask mode falls back to DEFAULT_ASK_COLOR when neither is set", () => {
	const settings = makeSettings({ askModeColor: undefined, inputGlowColor: undefined });
	assert.equal(getModeColor(settings, "ask"), DEFAULT_ASK_COLOR);
});

test("goal mode returns goalModeColor when it differs from askColor", () => {
	const settings = makeSettings({ askModeColor: "#111111", goalModeColor: "#222222" });
	assert.equal(getModeColor(settings, "goal"), "#222222");
});

test("goal mode uses FALLBACK_GOAL_COLOR when goalModeColor equals askColor", () => {
	const settings = makeSettings({ askModeColor: DEFAULT_GOAL_COLOR, goalModeColor: DEFAULT_GOAL_COLOR });
	assert.equal(getModeColor(settings, "goal"), FALLBACK_GOAL_COLOR);
});

test("goal mode returns DEFAULT_GOAL_COLOR when goalModeColor is unset and askColor is not DEFAULT_GOAL_COLOR", () => {
	const settings = makeSettings({ askModeColor: "#123456", goalModeColor: undefined });
	assert.equal(getModeColor(settings, "goal"), DEFAULT_GOAL_COLOR);
});

test("goal mode uses FALLBACK_GOAL_COLOR when goalModeColor is unset and askColor is DEFAULT_GOAL_COLOR", () => {
	const settings = makeSettings({ askModeColor: DEFAULT_GOAL_COLOR, goalModeColor: undefined });
	assert.equal(getModeColor(settings, "goal"), FALLBACK_GOAL_COLOR);
});

test("deprecated inputGlowColor still works when askModeColor is missing", () => {
	const settings = makeSettings({ askModeColor: undefined, inputGlowColor: "#0f0f0f" });
	assert.equal(getModeColor(settings, "ask"), "#0f0f0f");
	assert.equal(getModeColor(settings, "goal"), DEFAULT_GOAL_COLOR);
});
