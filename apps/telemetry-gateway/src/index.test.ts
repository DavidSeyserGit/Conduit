import assert from "node:assert/strict";
import test from "node:test";
import worker, { parsePayload } from "./index.js";

const validPayload = {
  schemaVersion: 1,
  appVersion: "0.4.0-rc.1",
  platform: "macos",
  counts: { goal_started: 2, profile_opened: 1 },
};

test("accepts only aggregate allowlisted counters", () => {
  assert.deepEqual(parsePayload(JSON.stringify(validPayload)), validPayload);
  assert.equal(parsePayload(JSON.stringify({ ...validPayload, userId: "user_1" })), null);
  assert.equal(parsePayload(JSON.stringify({ ...validPayload, counts: { goal_title: 1 } })), null);
  assert.equal(parsePayload(JSON.stringify({ ...validPayload, counts: {} })), null);
});

test("writes anonymous daily aggregate increments", async () => {
  const writes: Array<{ values: Array<string | number> }> = [];
  const db = {
    prepare: () => ({
      bind: (...values: Array<string | number>) => ({
        run: async () => { writes.push({ values }); },
      }),
    }),
  };
  const response = await worker.fetch(new Request("https://telemetry.conduit.seyser.org/v1/events", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "tauri://localhost" },
    body: JSON.stringify(validPayload),
  }), { DB: db } as never);

  assert.equal(response.status, 202);
  assert.deepEqual(writes, [
    { values: ["goal_started", "0.4.0-rc.1", "macos", 2] },
    { values: ["profile_opened", "0.4.0-rc.1", "macos", 1] },
  ]);
  assert.doesNotMatch(JSON.stringify(writes), /user|device|session|account/i);
});

test("rejects untrusted browser origins", async () => {
  const response = await worker.fetch(new Request("https://telemetry.conduit.seyser.org/v1/events", {
    method: "POST",
    headers: { Origin: "https://example.com" },
    body: JSON.stringify(validPayload),
  }), { DB: { prepare: () => { throw new Error("must not write"); } } } as never);
  assert.equal(response.status, 403);
});
