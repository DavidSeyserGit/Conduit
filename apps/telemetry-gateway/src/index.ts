export const TELEMETRY_EVENTS = [
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

type TelemetryEvent = typeof TELEMETRY_EVENTS[number];
type Platform = "macos" | "windows" | "linux" | "other";

interface Env {
  DB: {
    prepare(query: string): {
      bind(...values: Array<string | number>): { run(): Promise<unknown> };
    };
  };
}

interface TelemetryPayload {
  schemaVersion: 1;
  appVersion: string;
  platform: Platform;
  counts: Partial<Record<TelemetryEvent, number>>;
}

const ALLOWED_ORIGINS = new Set([
  "http://localhost:1420",
  "tauri://localhost",
  "https://tauri.localhost",
]);
const EVENT_SET = new Set<string>(TELEMETRY_EVENTS);
const PLATFORM_SET = new Set<string>(["macos", "windows", "linux", "other"]);
const MAX_BODY_BYTES = 16_384;
const MAX_COUNT = 1_000;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin");

    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true, service: "conduit-telemetry-gateway" }, 200, origin);
    }
    if (request.method === "OPTIONS") {
      if (!originAllowed(origin)) return json({ error: "Origin not allowed" }, 403, null);
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (request.method !== "POST" || url.pathname !== "/v1/events") {
      return json({ error: "Not found" }, 404, origin);
    }
    if (!originAllowed(origin)) return json({ error: "Origin not allowed" }, 403, null);

    const declaredLength = Number(request.headers.get("Content-Length") ?? "0");
    if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
      return json({ error: "Payload too large" }, 413, origin);
    }

    let raw: string;
    try {
      raw = await request.text();
    } catch {
      return json({ error: "Invalid request body" }, 400, origin);
    }
    if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) {
      return json({ error: "Payload too large" }, 413, origin);
    }

    const payload = parsePayload(raw);
    if (!payload) return json({ error: "Invalid telemetry payload" }, 400, origin);

    await Promise.all(
      (Object.entries(payload.counts) as Array<[TelemetryEvent, number]>).map(([event, count]) =>
        env.DB.prepare(
          `INSERT INTO daily_event_counts (day, event, app_version, platform, count)
           VALUES (date('now'), ?, ?, ?, ?)
           ON CONFLICT (day, event, app_version, platform)
           DO UPDATE SET count = count + excluded.count`,
        ).bind(event, payload.appVersion, payload.platform, count).run(),
      ),
    );

    return json({ accepted: true }, 202, origin);
  },
};

export function parsePayload(raw: string): TelemetryPayload | null {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  if (!hasExactKeys(value, ["schemaVersion", "appVersion", "platform", "counts"])) return null;
  if (value.schemaVersion !== 1) return null;
  if (typeof value.appVersion !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value.appVersion)) return null;
  if (typeof value.platform !== "string" || !PLATFORM_SET.has(value.platform)) return null;
  if (!isRecord(value.counts)) return null;

  const counts: Partial<Record<TelemetryEvent, number>> = {};
  for (const [event, count] of Object.entries(value.counts)) {
    if (!EVENT_SET.has(event) || typeof count !== "number" || !Number.isInteger(count) || count < 1 || count > MAX_COUNT) return null;
    counts[event as TelemetryEvent] = count;
  }
  if (Object.keys(counts).length === 0) return null;
  return { schemaVersion: 1, appVersion: value.appVersion, platform: value.platform as Platform, counts };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === [...expected].sort()[index]);
}

function originAllowed(origin: string | null): origin is string {
  return origin !== null && ALLOWED_ORIGINS.has(origin);
}

function corsHeaders(origin: string): HeadersInit {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Cache-Control": "no-store",
    Vary: "Origin",
  };
}

function json(body: unknown, status: number, origin: string | null): Response {
  const headers = new Headers({ "Content-Type": "application/json", "Cache-Control": "no-store" });
  if (originAllowed(origin)) {
    for (const [key, value] of Object.entries(corsHeaders(origin))) headers.set(key, value);
  }
  return new Response(JSON.stringify(body), { status, headers });
}
