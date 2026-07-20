import assert from "node:assert/strict";
import { test } from "node:test";
import type { CodingIterationRequest, ModelProvider } from "@conduit/model-providers";
import type { ToolExecutor } from "@conduit/tools";
import { CodingAgent, type CodingAgentConfig } from "./coding-agent.ts";

test("coding agent delegates autonomous iterations through the provider contract", async () => {
  let received: CodingIterationRequest | undefined;
  const events: string[] = [];
  const provider: ModelProvider = {
    ...baseProvider,
    runCodingIteration: async (request, emit) => {
      received = request;
      emit({ type: "agent_status", message: "working" });
      emit({ type: "file_changed", path: "src/title.ts" });
      return {
        changedFiles: ["src/title.ts"],
        validationResults: [],
        agentSummary: "Renamed the title",
        toolCalls: [],
        messages: [],
      };
    },
  };

  const result = await new CodingAgent().run(makeConfig({
    provider,
    emit: (event) => events.push(event.type),
  }));

  assert.deepEqual(result.changedFiles, ["src/title.ts"]);
  assert.equal(result.agentSummary, "Renamed the title");
  assert.deepEqual(events, ["agent_status", "file_changed"]);
  assert.equal(received?.workspacePath, "/repo");
  assert.equal(received?.modelId, "fake/model");
  assert.equal(received?.reasoningEffort, "low");
});

test("coding agent preserves autonomous provider errors", async () => {
  const provider: ModelProvider = {
    ...baseProvider,
    runCodingIteration: async () => {
      throw new Error("CLI authentication expired");
    },
  };

  await assert.rejects(
    new CodingAgent().run(makeConfig({ provider })),
    /CLI authentication expired/,
  );
});

test("coding agent retries a transient autonomous provider timeout against the current workspace", async () => {
  let attempts = 0;
  const statuses: string[] = [];
  const provider: ModelProvider = {
    ...baseProvider,
    runCodingIteration: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("local coding request timed out");
      return {
        changedFiles: ["src/title.ts"],
        validationResults: [],
        agentSummary: "Continued from the existing workspace",
        toolCalls: [],
        messages: [],
      };
    },
  };

  const result = await new CodingAgent().run(makeConfig({
    provider,
    emit: (event) => { if (event.type === "agent_status") statuses.push(event.message); },
  }));

  assert.equal(attempts, 2);
  assert.deepEqual(result.changedFiles, ["src/title.ts"]);
  assert.match(statuses[0] ?? "", /retrying attempt 2\/2.*current workspace/i);
});

test("coding agent forwards Goal cancellation to an autonomous provider", async () => {
  const provider: ModelProvider = {
    ...baseProvider,
    runCodingIteration: async (request) => new Promise((_resolve, reject) => {
      assert.ok(request.signal);
      request.signal.addEventListener("abort", () => {
        reject(new DOMException("This operation was aborted", "AbortError"));
      }, { once: true });
    }),
  };
  const controller = new AbortController();
  const run = new CodingAgent().run(makeConfig({ provider, signal: controller.signal }));
  controller.abort();

  await assert.rejects(run, /aborted|cancelled/i);
});

test("non-autonomous providers use the provider-neutral tool loop", async () => {
  let requests = 0;
  const provider: ModelProvider = {
    ...baseProvider,
    createResponse: async (request) => {
      requests += 1;
      assert.equal(request.workspacePath, "/repo");
      assert.equal(request.tools?.some((tool) => tool.name === "write_file"), true);
      return { content: "Completed safely", finishReason: "stop" };
    },
  };

  const result = await new CodingAgent().run(makeConfig({ provider }));

  assert.equal(requests, 1);
  assert.equal(result.agentSummary, "Completed safely");
  assert.deepEqual(result.changedFiles, []);
});

test("provider-neutral coding retries a transient response timeout", async () => {
  let attempts = 0;
  const provider: ModelProvider = {
    ...baseProvider,
    createResponse: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("network timeout");
      return { content: "Completed after retry", finishReason: "stop" };
    },
  };

  const result = await new CodingAgent().run(makeConfig({ provider }));

  assert.equal(attempts, 2);
  assert.equal(result.agentSummary, "Completed after retry");
});

function makeConfig(overrides: Partial<CodingAgentConfig> = {}): CodingAgentConfig {
  return {
    goal: "Rename the title",
    workspacePath: "/repo",
    modelId: "fake/model",
    provider: baseProvider,
    toolExecutor: unusedTools,
    iteration: 1,
    maxIterations: 2,
    emit: () => {},
    codingReasoningEffort: "low",
    ...overrides,
  };
}

const baseProvider: ModelProvider = {
  id: "fake",
  name: "fake",
  listModels: async () => [],
  createResponse: async () => ({ content: "", finishReason: "stop" }),
  streamResponse: async () => ({ content: "", finishReason: "stop" }),
};

const unusedTools: ToolExecutor = {
  execute: async () => { throw new Error("No tool call expected"); },
};
