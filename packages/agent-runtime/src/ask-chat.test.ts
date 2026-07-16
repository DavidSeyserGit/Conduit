import assert from "node:assert/strict";
import { test } from "node:test";
import type { ModelProvider } from "@conduit/model-providers";
import type { ModelRequest, ModelStreamEvent } from "@conduit/shared";
import type { ToolExecutor } from "@conduit/tools";
import { AskChatRunner } from "./ask-chat.ts";

const usage = { promptTokens: 5, completionTokens: 3, totalTokens: 8 };

test("Ask mode forwards cancellation and counts streamed usage exactly once", async () => {
  const requests: ModelRequest[] = [];
  const streamed: string[] = [];
  const controller = new AbortController();
  const provider: ModelProvider = {
    id: "fake",
    name: "fake",
    listModels: async () => [],
    createResponse: async () => ({ content: "" }),
    streamResponse: async (request, onEvent) => {
      requests.push(request);
      onEvent({ type: "content_delta", content: "hello " });
      onEvent({ type: "content_delta", content: "world" });
      onEvent({ type: "done", usage });
      return { content: "hello world", usage, finishReason: "stop" };
    },
  };

  const result = await new AskChatRunner().run({
    workspacePath: "/repo",
    modelId: "fake/model",
    provider,
    toolExecutor: unusedTools(),
    messages: [],
    userMessage: "Say hello",
    onStream: (content) => streamed.push(content),
    signal: controller.signal,
  });

  assert.equal(requests[0]?.workspacePath, "/repo");
  assert.equal(requests[0]?.signal, controller.signal);
  assert.equal(requests[0]?.tools?.some((tool) => tool.name === "write_file"), false);
  assert.deepEqual(streamed, ["hello ", "world"]);
  assert.equal(result.message.content, "hello world");
  assert.deepEqual(result.tokenUsage, usage);
});

test("Ask mode executes read-only tool calls and returns their result to the provider", async () => {
  const requests: ModelRequest[] = [];
  const executions: Array<{ name: string; mode: string }> = [];
  let round = 0;
  const provider: ModelProvider = {
    id: "fake",
    name: "fake",
    listModels: async () => [],
    createResponse: async () => ({ content: "" }),
    streamResponse: async (request, _onEvent: (event: ModelStreamEvent) => void) => {
      requests.push(request);
      round += 1;
      if (round === 1) {
        return {
          content: "",
          toolCalls: [{ id: "read-1", name: "read_file", arguments: { path: "README.md" } }],
        };
      }
      return { content: "The README contains the project overview." };
    },
  };
  const toolExecutor: ToolExecutor = {
    async execute(name, _args, mode) {
      executions.push({ name, mode });
      return { success: true, result: { content: "Project overview" } };
    },
  };

  const result = await new AskChatRunner().run({
    workspacePath: "/repo",
    modelId: "fake/model",
    provider,
    toolExecutor,
    messages: [],
    userMessage: "What is this project?",
  });

  assert.deepEqual(executions, [{ name: "read_file", mode: "ask" }]);
  assert.equal(requests.length, 2);
  assert.equal(requests[1]?.messages.at(-1)?.role, "tool");
  assert.match(requests[1]?.messages.at(-1)?.content || "", /Project overview/);
  assert.equal(result.message.content, "The README contains the project overview.");
});

function unusedTools(): ToolExecutor {
  return {
    async execute() {
      throw new Error("No tool call expected");
    },
  };
}
