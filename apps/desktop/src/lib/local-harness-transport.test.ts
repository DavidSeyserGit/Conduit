import assert from "node:assert/strict";
import { test } from "node:test";
import type { GoalRunEvent } from "@conduit/shared";
import { TauriLocalHarnessTransport } from "./local-harness-transport.ts";

test("Tauri transport sends serializable judge requests and forwards events", async () => {
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  let channel: { onmessage: ((event: { type: "content_delta"; content: string }) => void) | null } | undefined;
  const transport = new TauriLocalHarnessTransport(
    async <T>(command: string, args?: Record<string, unknown>) => {
      calls.push({ command, args });
      if (command === "local_harness_response") {
        channel = args?.onEvent as typeof channel;
        channel?.onmessage?.({ type: "content_delta", content: "ready" });
        return { content: "ready", finishReason: "stop" } as T;
      }
      return undefined as T;
    },
    () => ({ onmessage: null }),
  );
  const events: string[] = [];

  const result = await transport.createResponse("codex", {
    modelId: "codex/gpt-5.6",
    workspacePath: "/repo",
    messages: [{ role: "user", content: "Plan" }],
    structuredOutput: { name: "plan", schema: { type: "object" } },
  }, (event) => events.push(event.type));

  assert.equal(result.content, "ready");
  assert.deepEqual(events, ["content_delta"]);
  assert.equal(calls[0]?.command, "local_harness_response");
  const request = calls[0]?.args?.request as Record<string, unknown>;
  assert.equal(request.workspacePath, "/repo");
  assert.equal("signal" in request, false);
  assert.equal(channel?.onmessage, null);
});

test("Tauri transport cancels native work with the same request ID", async () => {
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  let rejectRun: ((error: Error) => void) | undefined;
  const transport = new TauriLocalHarnessTransport(
    <T>(command: string, args?: Record<string, unknown>) => {
      calls.push({ command, args });
      if (command === "local_harness_coding_iteration") {
        return new Promise<T>((_resolve, reject) => { rejectRun = reject; });
      }
      if (command === "local_harness_cancel") {
        rejectRun?.(new Error("native process cancelled"));
      }
      return Promise.resolve(undefined as T);
    },
    <T>() => ({ onmessage: null as ((event: T) => void) | null }),
  );
  const controller = new AbortController();
  const events: GoalRunEvent[] = [];
  const run = transport.runCodingIteration("kilo", {
    goal: "change",
    workspacePath: "/repo",
    modelId: "kilo/kilo/model",
    iteration: 1,
    maxIterations: 2,
    permissionMode: "ask_every_time",
    signal: controller.signal,
  }, (event) => events.push(event));
  controller.abort();

  await assert.rejects(run, /aborted/i);
  const start = calls.find((call) => call.command === "local_harness_coding_iteration");
  const cancel = calls.find((call) => call.command === "local_harness_cancel");
  assert.equal(typeof start?.args?.requestId, "string");
  assert.equal((start?.args?.request as Record<string, unknown>)?.permissionMode, "ask_every_time");
  assert.equal(cancel?.args?.requestId, start?.args?.requestId);
  assert.deepEqual(events, []);
});
