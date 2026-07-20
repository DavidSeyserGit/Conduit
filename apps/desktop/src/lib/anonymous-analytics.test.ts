import assert from "node:assert/strict";
import test from "node:test";
import { AnonymousAnalyticsCollector } from "./anonymous-analytics.js";

class MemoryStorage {
  private readonly values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

test("anonymous analytics is inert until explicitly enabled", () => {
  const collector = new AnonymousAnalyticsCollector(new MemoryStorage(), async () => undefined, "0.4.0", "macos");
  collector.record("goal_started");
  assert.deepEqual(collector.payload().counts, {});
});

test("payload contains only coarse build data and aggregate counters", () => {
  const collector = new AnonymousAnalyticsCollector(new MemoryStorage(), async () => undefined, "0.4.0", "linux");
  collector.setEnabled(true);
  collector.record("goal_started");
  collector.record("goal_started");
  const payload = collector.payload();
  assert.deepEqual(payload, { schemaVersion: 1, appVersion: "0.4.0", platform: "linux", counts: { goal_started: 2 } });
  assert.doesNotMatch(JSON.stringify(payload), /user|device|session|account|goalId/i);
});

test("disabling immediately clears queued counters", () => {
  const collector = new AnonymousAnalyticsCollector(new MemoryStorage(), async () => undefined, "0.4.0", "windows");
  collector.setEnabled(true);
  collector.record("profile_opened");
  collector.setEnabled(false);
  collector.setEnabled(true);
  assert.deepEqual(collector.payload().counts, {});
});

test("successful flush subtracts only the transmitted snapshot", async () => {
  const storage = new MemoryStorage();
  let collector: AnonymousAnalyticsCollector;
  collector = new AnonymousAnalyticsCollector(storage, async () => {
    collector.record("goal_started");
  }, "0.4.0", "other");
  collector.setEnabled(true);
  collector.record("goal_started");
  assert.equal(await collector.flush(), true);
  assert.deepEqual(collector.payload().counts, { goal_started: 1 });
});

test("failed delivery retains queued counters", async () => {
  const collector = new AnonymousAnalyticsCollector(new MemoryStorage(), async () => { throw new Error("offline"); }, "0.4.0", "other");
  collector.setEnabled(true);
  collector.record("goal_failed");
  await assert.rejects(collector.flush(), /offline/);
  assert.deepEqual(collector.payload().counts, { goal_failed: 1 });
});
