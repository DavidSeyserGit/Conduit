import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { ModelRequest } from "@conduit/shared";
import { CodexProvider } from "./codex.ts";
import { KiloProvider, parseKiloModels } from "./kilo.ts";

const originalFetch = globalThis.fetch;
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
  else Reflect.deleteProperty(globalThis, "window");
});

test("Kilo createResponse bridges Goal judge requests to the streaming backend", async () => {
  Object.defineProperty(globalThis, "window", { value: {}, configurable: true });
  let requestBody: Record<string, unknown> | undefined;
  globalThis.fetch = async (input, init) => {
    assert.equal(input, "/api/agent/kilo-chat");
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    const packets = [
      { event: { type: "agent_status", message: "starting" } },
      { event: { type: "content_delta", content: "{\"summary\":\"ready\",\"tasks\":[]}" } },
      {
        result: {
          content: "{\"summary\":\"ready\",\"tasks\":[]}",
          structuredOutput: { summary: "ready", tasks: [] },
          finishReason: "stop",
        },
      },
    ].map((packet) => JSON.stringify(packet)).join("\n") + "\n";
    return new Response(packets, { status: 200 });
  };

  const request: ModelRequest = {
    modelId: "kilo/kilo/kilo-auto/free",
    workspacePath: "/repo",
    messages: [{ role: "user", content: "Plan the change" }],
    structuredOutput: {
      name: "implementation_plan",
      schema: { type: "object" },
    },
  };
  const result = await new KiloProvider().createResponse(request);

  assert.deepEqual(result.structuredOutput, { summary: "ready", tasks: [] });
  assert.equal(requestBody?.workspace, "/repo");
  assert.equal(requestBody?.modelId, "kilo/kilo/kilo-auto/free");
  assert.deepEqual(requestBody?.structuredOutput, request.structuredOutput);
});

test("Kilo provider surfaces NDJSON backend errors and missing workspaces", async () => {
  Object.defineProperty(globalThis, "window", { value: {}, configurable: true });
  globalThis.fetch = async () => new Response(
    `${JSON.stringify({ error: "Kilo authentication failed" })}\n`,
    { status: 200 },
  );
  const provider = new KiloProvider();

  await assert.rejects(
    provider.createResponse({
      modelId: "kilo/kilo/model",
      workspacePath: "/repo",
      messages: [],
    }),
    /Kilo authentication failed/,
  );
  await assert.rejects(
    provider.createResponse({ modelId: "kilo/kilo/model", messages: [] }),
    /requires a workspace/,
  );
});

test("Kilo model parser creates unambiguous canonical model IDs", () => {
  const models = parseKiloModels([
    "kilo/kilo-auto/free",
    "{",
    '  "providerID": "kilo",',
    '  "name": "Kilo Auto Free",',
    '  "capabilities": { "toolcall": true, "reasoning": true }',
    "}",
  ].join("\n"));

  assert.equal(models[0]?.id, "kilo/kilo/kilo-auto/free");
  assert.equal(models[0]?.supportsJudge, true);
});

test("Codex provider forwards workspace, schema, and reasoning to the desktop backend", async () => {
  Object.defineProperty(globalThis, "window", { value: {}, configurable: true });
  let body: Record<string, unknown> | undefined;
  globalThis.fetch = async (input, init) => {
    assert.equal(input, "/api/codex/response");
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return Response.json({
      result: {
        content: "{\"approved\":true}",
        structuredOutput: { approved: true },
        finishReason: "stop",
      },
    });
  };
  const request: ModelRequest = {
    modelId: "codex/gpt-5.6",
    workspacePath: "/repo",
    reasoningEffort: "low",
    messages: [{ role: "user", content: "Judge" }],
    structuredOutput: { name: "judge", schema: { type: "object" } },
  };

  const result = await new CodexProvider().createResponse(request);
  assert.deepEqual(result.structuredOutput, { approved: true });
  assert.equal(body?.workspace, "/repo");
  assert.equal(body?.modelId, "codex/gpt-5.6");
  assert.equal(body?.reasoningEffort, "low");
  assert.deepEqual(body?.structuredOutput, request.structuredOutput);
});

test("Codex provider preserves backend error detail", async () => {
  Object.defineProperty(globalThis, "window", { value: {}, configurable: true });
  globalThis.fetch = async () => Response.json(
    { error: "Workspace is not a Git repository" },
    { status: 500 },
  );

  await assert.rejects(
    new CodexProvider().createResponse({
      modelId: "codex/gpt-5.6",
      workspacePath: "/repo",
      messages: [],
    }),
    /Workspace is not a Git repository/,
  );
});

test("local providers propagate Goal cancellation to their backend fetch", async () => {
  Object.defineProperty(globalThis, "window", { value: {}, configurable: true });
  let abortedRequests = 0;
  globalThis.fetch = async (_input, init) => new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    assert.ok(signal);
    signal.addEventListener("abort", () => {
      abortedRequests += 1;
      reject(new DOMException("This operation was aborted", "AbortError"));
    }, { once: true });
  });

  const kiloController = new AbortController();
  const kiloRequest = new KiloProvider().createResponse({
    modelId: "kilo/kilo/model",
    workspacePath: "/repo",
    messages: [],
    signal: kiloController.signal,
  });
  kiloController.abort();
  await assert.rejects(kiloRequest, /aborted/i);

  const codexController = new AbortController();
  const codexRequest = new CodexProvider().createResponse({
    modelId: "codex/model",
    workspacePath: "/repo",
    messages: [],
    signal: codexController.signal,
  });
  codexController.abort();
  await assert.rejects(codexRequest, /aborted/i);
  assert.equal(abortedRequests, 2);
});
