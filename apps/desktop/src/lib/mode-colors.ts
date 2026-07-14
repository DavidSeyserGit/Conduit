import type { AppSettings, ChatMode } from "@loopkit/shared";

export const DEFAULT_ASK_COLOR = "#3b82f6";
export const DEFAULT_GOAL_COLOR = "#8b5cf6";
export const FALLBACK_GOAL_COLOR = "#ec4899";

export function getModeColor(settings: AppSettings, mode: ChatMode): string {
  const askColor = settings.askModeColor ?? settings.inputGlowColor ?? DEFAULT_ASK_COLOR;
  if (mode === "ask") return askColor;

  const goalColor = settings.goalModeColor;
  if (goalColor && goalColor !== askColor) return goalColor;
  return askColor === DEFAULT_GOAL_COLOR ? FALLBACK_GOAL_COLOR : DEFAULT_GOAL_COLOR;
}
