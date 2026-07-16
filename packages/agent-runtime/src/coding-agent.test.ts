import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { ModelProvider } from "@conduit/model-providers";
import type { ToolExecutor } from "@conduit/tools";
import { CodingAgent, type CodingAgentConfig } from "./coding-agent.ts";

const originalFetch = globalThis.fetch;
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
  else Reflect.deleteProperty(globalThis, "window");
});

test("desktop coding transport parses fragmented NDJSON events and result", async () => {
  Object.defineProperty(globalThis, "window", { value: {}, configurable: true });
  let body: Record<string, unknown> | undefined;
  globalThis.fetch = async (input, init) => {
    assert.equal(input, "/api/agent/pi-iteration");
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    const payload = [
      JSON.stringify({ event: { type: "agent_status", message: "working" } }),
      JSON.stringify({ event: { type: "file_changed", path: "src/title.ts" } }),
      JSON.stringify({
        result: {
          changedFiles: ["src/title.ts"],
          validationResults: [],
          agentSummary: "Renamed the title",
          toolCalls: [],
          messages: [],
        },
      }),
      "",
    ].join("\n");
    const midpoint = Math.floor(payload.length / 2);
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(payload.slice(0, midpoint)));
        controller.enqueue(encoder.encode(payload.slice(midpoint)));
        controller.close();
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { "Content-Type": "application/x-ndjson" },
    });
  };
  const events: string[] = [];

  const result = await new CodingAgent().run(makeConfig({
    emit: (event) => events.push(event.type),
  }));

  assert.deepEqual(result.changedFiles, ["src/title.ts"]);
  assert.equal(result.agentSummary, "Renamed the title");
  assert.deepEqual(events, ["agent_status", "file_changed"]);
  assert.equal(body?.workspace, "/repo");
  assert.equal(body?.modelId, "fake/model");
  assert.equal(body?.codingReasoningEffort, "low");
});

test("desktop coding transport preserves backend packet errors", async () => {
  Object.defineProperty(globalThis, "window", { value: {}, configurable: true });
  globalThis.fetch = async () => new Response(
    `${JSON.stringify({ event: { type: "agent_status", message: "starting" } })}\n${JSON.stringify({ error: "CLI authentication expired" })}\n`,
    { status: 200, headers: { "Content-Type": "application/x-ndjson" } },
  );

  await assert.rejects(
    new CodingAgent().run(makeConfig()),
    /CLI authentication expired/,
  );
});

test("desktop coding transport reports an interrupted stream with its last status", async () => {
  Object.defineProperty(globalThis, "window", { value: {}, configurable: true });
  const encoder = new TextEncoder();
  let pullCount = 0;
  globalThis.fetch = async () => new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        pullCount += 1;
        if (pullCount === 1) {
          controller.enqueue(encoder.encode(`${JSON.stringify({ event: { type: "agent_status", message: "editing" } })}\n`));
        } else {
          controller.error(new Error("socket reset"));
        }
      },
    }),
    { status: 200, headers: { "Content-Type": "application/x-ndjson" } },
  );

  await assert.rejects(
    new CodingAgent().run(makeConfig()),
    /Agent stream interrupted after status “editing”: socket reset/,
  );
});

test("desktop coding transport aborts its fetch when the Goal run is cancelled", async () => {
  Object.defineProperty(globalThis, "window", { value: {}, configurable: true });
  globalThis.fetch = async (_input, init) => new Promise<Response>((_resolve, reject) => {
    assert.ok(init?.signal);
    init.signal.addEventListener("abort", () => {
      reject(new DOMException("This operation was aborted", "AbortError"));
    }, { once: true });
  });
  const controller = new AbortController();
  const run = new CodingAgent().run(makeConfig({ signal: controller.signal }));
  controller.abort();

  await assert.rejects(run, /aborted/i);
});

function makeConfig(overrides: Partial<CodingAgentConfig> = {}): CodingAgentConfig {
  return {
    goal: "Rename the title",
    workspacePath: "/repo",
    modelId: "fake/model",
    provider: unusedProvider,
    toolExecutor: unusedTools,
    iteration: 1,
    maxIterations: 2,
    emit: () => {},
    codingReasoningEffort: "low",
    ...overrides,
  };
}

const unusedProvider: ModelProvider = {
  id: "fake",
  name: "fake",
  listModels: async () => [],
  createResponse: async () => { throw new Error("Browser transport should handle the request"); },
  streamResponse: async () => { throw new Error("Browser transport should handle the request"); },
};

const unusedTools: ToolExecutor = {
  execute: async () => { throw new Error("No tool call expected"); },
};
