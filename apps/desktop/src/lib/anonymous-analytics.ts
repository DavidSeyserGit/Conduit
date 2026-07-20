import { CONDUIT_DESKTOP_VERSION } from "../version.js";

export const ANONYMOUS_ANALYTICS_EVENTS = [
  "app_opened",
  "goal_started",
  "goal_completed",
  "goal_failed",
  "goal_cancelled",
  "profile_opened",
  "plan_chooser_opened",
  "billing_manage_opened",
  "checkout_yearly_started",
  "checkout_three_month_started",
  "checkout_team_started",
] as const;

export type AnonymousAnalyticsEvent = typeof ANONYMOUS_ANALYTICS_EVENTS[number];
export type AnonymousAnalyticsPlatform = "macos" | "windows" | "linux" | "other";

export interface AnonymousAnalyticsPayload {
  schemaVersion: 1;
  appVersion: string;
  platform: AnonymousAnalyticsPlatform;
  counts: Partial<Record<AnonymousAnalyticsEvent, number>>;
}

interface CounterStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

type AnalyticsSender = (payload: AnonymousAnalyticsPayload) => Promise<void>;

const STORAGE_KEY = "conduit.anonymous-analytics.v1";
const MAX_COUNTER_VALUE = 1_000;
const FLUSH_DELAY_MS = 30_000;
const EVENT_NAMES = new Set<string>(ANONYMOUS_ANALYTICS_EVENTS);

export class AnonymousAnalyticsCollector {
  private enabled = false;
  private flushing = false;

  constructor(
    private readonly storage: CounterStorage,
    private readonly sender: AnalyticsSender,
    private readonly appVersion: string,
    private readonly platform: AnonymousAnalyticsPlatform,
  ) {}

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.storage.removeItem(STORAGE_KEY);
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  record(event: AnonymousAnalyticsEvent): void {
    if (!this.enabled) return;
    const counts = this.readCounts();
    counts[event] = Math.min(MAX_COUNTER_VALUE, (counts[event] ?? 0) + 1);
    this.storage.setItem(STORAGE_KEY, JSON.stringify(counts));
  }

  payload(): AnonymousAnalyticsPayload {
    return {
      schemaVersion: 1,
      appVersion: this.appVersion,
      platform: this.platform,
      counts: this.enabled ? this.readCounts() : {},
    };
  }

  async flush(): Promise<boolean> {
    if (!this.enabled || this.flushing) return false;
    const snapshot = this.readCounts();
    if (Object.keys(snapshot).length === 0) return false;
    this.flushing = true;
    try {
      await this.sender({ schemaVersion: 1, appVersion: this.appVersion, platform: this.platform, counts: snapshot });
      const current = this.readCounts();
      for (const event of ANONYMOUS_ANALYTICS_EVENTS) {
        const remaining = (current[event] ?? 0) - (snapshot[event] ?? 0);
        if (remaining > 0) current[event] = remaining;
        else delete current[event];
      }
      if (Object.keys(current).length > 0) this.storage.setItem(STORAGE_KEY, JSON.stringify(current));
      else this.storage.removeItem(STORAGE_KEY);
      return true;
    } finally {
      this.flushing = false;
    }
  }

  private readCounts(): Partial<Record<AnonymousAnalyticsEvent, number>> {
    try {
      const parsed = JSON.parse(this.storage.getItem(STORAGE_KEY) ?? "{}") as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
      const counts: Partial<Record<AnonymousAnalyticsEvent, number>> = {};
      for (const [name, value] of Object.entries(parsed)) {
        if (!EVENT_NAMES.has(name) || !Number.isInteger(value) || (value as number) <= 0) continue;
        counts[name as AnonymousAnalyticsEvent] = Math.min(MAX_COUNTER_VALUE, value as number);
      }
      return counts;
    } catch {
      return {};
    }
  }
}

const viteEnv = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env;
const telemetryUrl = normalizeTelemetryUrl(viteEnv?.VITE_CONDUIT_TELEMETRY_URL);
const browserStorage = typeof window === "undefined" ? null : window.localStorage;
const collector = browserStorage
  ? new AnonymousAnalyticsCollector(browserStorage, sendPayload, CONDUIT_DESKTOP_VERSION, detectPlatform())
  : null;
let flushTimer: number | null = null;

export function configureAnonymousAnalytics(enabled: boolean): void {
  collector?.setEnabled(enabled);
  if (!enabled && flushTimer !== null) {
    window.clearTimeout(flushTimer);
    flushTimer = null;
  }
}

export function recordAnonymousEvent(event: AnonymousAnalyticsEvent): void {
  collector?.record(event);
  if (!collector?.isEnabled() || !telemetryUrl || flushTimer !== null) return;
  flushTimer = window.setTimeout(() => {
    flushTimer = null;
    void collector.flush().catch(() => undefined);
  }, FLUSH_DELAY_MS);
}

export function pendingAnonymousAnalyticsPayload(): AnonymousAnalyticsPayload {
  return collector?.payload() ?? {
    schemaVersion: 1,
    appVersion: CONDUIT_DESKTOP_VERSION,
    platform: "other",
    counts: {},
  };
}

async function sendPayload(payload: AnonymousAnalyticsPayload): Promise<void> {
  if (!telemetryUrl) throw new Error("Anonymous analytics is not configured in this build.");
  const response = await fetch(`${telemetryUrl}/v1/events`, {
    method: "POST",
    credentials: "omit",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error("Anonymous analytics delivery failed.");
}

function normalizeTelemetryUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) return null;
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
    if (url.protocol !== "https:" && !(local && url.protocol === "http:")) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function detectPlatform(): AnonymousAnalyticsPlatform {
  const platform = navigator.platform.toLowerCase();
  if (platform.includes("mac")) return "macos";
  if (platform.includes("win")) return "windows";
  if (platform.includes("linux")) return "linux";
  return "other";
}
