export const SUPPORT_PROMPT_MIN_SESSIONS = 5;
export const SUPPORT_PROMPT_MIN_INTERACTIONS = 20;
export const SUPPORT_PROMPT_REPEAT_INTERVAL_MS = 28 * 24 * 60 * 60 * 1000;
export const SUPPORT_PROMPT_VISIBLE_MS = 12_000;
export const SUPPORT_PROMPT_FADE_MS = 250;

// Replace this with the dedicated funding page once one is available.
export const SUPPORT_PROJECT_URL = "https://github.com/DavidSeyserGit/Conduit";

export interface SupportPromptEligibility {
  sessionCount: number;
  interactionCount: number;
  lastShownAt?: string;
  dismissedAt?: string;
}

export interface SupportPromptSession {
  messages: Array<{ role: string }>;
  runHistory: unknown[];
}

export function summarizeSupportUsage(sessions: SupportPromptSession[]): { sessionCount: number; interactionCount: number } {
  return sessions.reduce((usage, session) => {
    const userMessages = session.messages.filter((message) => message.role === "user").length;
    if (userMessages > 0 || session.runHistory.length > 0) usage.sessionCount += 1;
    usage.interactionCount += userMessages + session.runHistory.length;
    return usage;
  }, { sessionCount: 0, interactionCount: 0 });
}

export function shouldShowSupportPrompt(eligibility: SupportPromptEligibility, now = Date.now()): boolean {
  const hasMeaningfulUsage = eligibility.sessionCount >= SUPPORT_PROMPT_MIN_SESSIONS
    || eligibility.interactionCount >= SUPPORT_PROMPT_MIN_INTERACTIONS;
  if (!hasMeaningfulUsage) return false;

  const promptDates = [eligibility.lastShownAt, eligibility.dismissedAt]
    .map((value) => value ? new Date(value).getTime() : Number.NaN)
    .filter(Number.isFinite);
  const mostRecentPrompt = promptDates.length ? Math.max(...promptDates) : 0;
  return mostRecentPrompt === 0 || now - mostRecentPrompt >= SUPPORT_PROMPT_REPEAT_INTERVAL_MS;
}
