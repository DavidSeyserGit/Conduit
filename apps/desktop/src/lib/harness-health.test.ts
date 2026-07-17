import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchHarnessHealth, harnessStatusView } from "./harness-health.ts";

test("fetchHarnessHealth returns null outside Tauri", async () => {
  const result = await fetchHarnessHealth(async () => {
    throw new Error("should not be called");
  });
  assert.equal(result, null);
});

test("fetchHarnessHealth passes through the probe result in Tauri", async () => {
  (globalThis as { window?: unknown }).window = { __TAURI_INTERNALS__: {} };
  try {
    const health = { codex: { installed: true, authenticated: "yes" as const } };
    const result = await fetchHarnessHealth(async <T>() => health as T);
    assert.deepEqual(result, health);
  } finally {
    delete (globalThis as { window?: unknown }).window;
  }
});

test("fetchHarnessHealth swallows probe failures", async () => {
  (globalThis as { window?: unknown }).window = { __TAURI_INTERNALS__: {} };
  try {
    const result = await fetchHarnessHealth(async () => {
      throw new Error("probe failed");
    });
    assert.equal(result, null);
  } finally {
    delete (globalThis as { window?: unknown }).window;
  }
});

test("harnessStatusView maps probe results to status lines", () => {
  assert.equal(harnessStatusView("kilo", null), null);
  assert.deepEqual(
    harnessStatusView("kilo", { kilo: { installed: false, authenticated: "unknown" } }, "npm install -g @kilocode/cli"),
    { tone: "warn", text: "CLI not found · install: npm install -g @kilocode/cli" },
  );
  assert.deepEqual(
    harnessStatusView("codex", { codex: { installed: true, authenticated: "no" } }),
    { tone: "warn", text: "Not signed in · run: codex login" },
  );
  assert.deepEqual(
    harnessStatusView("kimi", { kimi: { installed: true, authenticated: "no" } }),
    { tone: "warn", text: "Not signed in · run: kimi login" },
  );
  assert.deepEqual(
    harnessStatusView("codex", { codex: { installed: true, authenticated: "yes" } }),
    { tone: "ok", text: "CLI ready" },
  );
  const unknown = harnessStatusView("kilo", { kilo: { installed: true, authenticated: "unknown" } });
  assert.equal(unknown?.tone, "muted");
  const withDetail = harnessStatusView("kilo", {
    kilo: { installed: true, authenticated: "unknown", detail: "boom" },
  });
  assert.equal(withDetail?.text, "Status unknown · boom");
});
