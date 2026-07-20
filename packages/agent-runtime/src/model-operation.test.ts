import assert from "node:assert/strict";
import test from "node:test";
import { retryModelOperation } from "./model-operation.ts";

test("a timed-out model attempt is aborted and retried with a fresh signal", async () => {
  const signals: AbortSignal[] = [];
  const retries: string[] = [];
  const result = await retryModelOperation(async (signal, attempt) => {
    signals.push(signal);
    if (attempt === 1) {
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      });
    }
    return "completed";
  }, {
    label: "Reviewer",
    timeoutMs: 5,
    maxAttempts: 2,
    onRetry: ({ reason }) => retries.push(reason),
  });

  assert.equal(result, "completed");
  assert.equal(signals.length, 2);
  assert.notEqual(signals[0], signals[1]);
  assert.equal(signals[0]?.aborted, true);
  assert.match(retries[0] ?? "", /timed out/);
});

test("user cancellation is never retried", async () => {
  const controller = new AbortController();
  let attempts = 0;
  const pending = retryModelOperation(async (signal) => {
    attempts += 1;
    return await new Promise<string>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    });
  }, { label: "Coding agent", signal: controller.signal, timeoutMs: 1_000, maxAttempts: 3 });
  controller.abort();

  await assert.rejects(pending, /Coding agent cancelled/);
  assert.equal(attempts, 1);
});

test("exhausted retries report every attempted recovery", async () => {
  let attempts = 0;
  await assert.rejects(
    retryModelOperation(async (signal) => {
      attempts += 1;
      return await new Promise<string>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      });
    }, { label: "General reviewer", timeoutMs: 5, maxAttempts: 3 }),
    /General reviewer did not complete after 3 attempts: attempt timed out/,
  );
  assert.equal(attempts, 3);
});
