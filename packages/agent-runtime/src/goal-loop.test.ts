import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  GoalRunConfig,
  GoalRunEvent,
  ModelRequest,
  ModelResponse,
} from "@conduit/shared";
import type { ModelProvider } from "@conduit/model-providers";
import { DefaultProviderRegistry } from "@conduit/model-providers";
import type { ToolExecutor } from "@conduit/tools";
import { GoalLoopRunner } from "./goal-loop.ts";

function provider(
  id: string,
  createResponse: (request: ModelRequest) => Promise<ModelResponse>,
): ModelProvider {
  return {
    id,
    name: id,
    listModels: async () => [],
    createResponse,
    streamResponse: async () => ({ content: "" }),
  };
}

function config(overrides: Partial<GoalRunConfig> = {}): GoalRunConfig {
  return {
    goal: "Rename the product title",
    workspacePath: "/repo",
    codingModelId: "coding/model",
    judgeModelId: "judge/model",
    maxIterations: 2,
    ...overrides,
  };
}

const toolExecutor: ToolExecutor = {
  async execute(name, args) {
    if (name === "replace_in_file") return { success: true, result: { path: args.path } };
    if (name === "run_command") {
      return {
        success: true,
        result: { command: "pnpm test", exitCode: 0, stdout: "passed", stderr: "" },
      };
    }
    if (name === "get_git_diff") return { success: true, result: { diff: "+FarmBot" } };
    return { success: false, error: `Unexpected tool: ${name}` };
  },
};

test("Goal loop plans, implements, validates, judges, and completes through provider contracts", async () => {
  const registry = new DefaultProviderRegistry();
  const timeline: string[] = [];
  let codingCalls = 0;
  registry.register(provider("coding", async (request) => {
    timeline.push(`coding:${request.modelId}`);
    codingCalls += 1;
    if (codingCalls === 1) {
      return {
        content: "Implementing the requested title change",
        toolCalls: [
          {
            id: "edit-1",
            name: "replace_in_file",
            arguments: { path: "src/title.ts", search: "Old", replace: "FarmBot" },
          },
          {
            id: "test-1",
            name: "run_command",
            arguments: { command: "pnpm test" },
          },
        ],
      };
    }
    return { content: "Implemented and validated the title change" };
  }));
  registry.register(provider("judge", async (request) => {
    timeline.push(`judge:${request.structuredOutput?.name}`);
    if (request.structuredOutput?.name === "implementation_plan") {
      return {
        content: "",
        structuredOutput: {
          summary: "Rename and validate",
          tasks: [
            { id: "1", description: "Inspect title sources", status: "pending" },
            { id: "2", description: "Rename and validate", status: "pending" },
          ],
        },
      };
    }
    return {
      content: "",
      structuredOutput: {
        approved: true,
        summary: "The title change is complete",
        feedback: [],
        missingRequirements: [],
        confidence: 0.98,
      },
    };
  }));
  const events: GoalRunEvent[] = [];

  const result = await new GoalLoopRunner(registry).run(
    config(),
    toolExecutor,
    {},
    (event) => events.push(event),
  );

  assert.equal(result.status, "completed");
  assert.equal(result.state.iteration, 1);
  assert.equal(result.state.plan?.summary, "Rename and validate");
  assert.deepEqual(result.state.iterations[0]?.changedFiles, ["src/title.ts"]);
  assert.equal(result.state.iterations[0]?.validationResults[0]?.passed, true);
  assert.equal(result.state.iterations[0]?.judgeResult?.approved, true);
  assert.deepEqual(timeline, [
    "judge:implementation_plan",
    "coding:coding/model",
    "coding:coding/model",
    "judge:judge_evaluation",
  ]);
  assert.equal(events.some((event) => event.type === "run_completed"), true);
  assert.equal(events.some((event) => event.type === "run_failed"), false);
});

test("Goal loop stops before coding when planning fails", async () => {
  const registry = new DefaultProviderRegistry();
  let codingCalls = 0;
  registry.register(provider("coding", async () => {
    codingCalls += 1;
    return { content: "should not run" };
  }));
  registry.register(provider("judge", async () => {
    throw new Error("judge unavailable");
  }));

  const result = await new GoalLoopRunner(registry).run(config(), toolExecutor, {}, () => {});
  assert.equal(result.status, "failed");
  assert.match(result.error || "", /Judge could not create an implementation plan: judge unavailable/);
  assert.equal(codingCalls, 0);
  assert.equal(result.state.iteration, 0);
});

test("Goal cancellation aborts an in-flight planning request and returns cancelled", async () => {
  const registry = new DefaultProviderRegistry();
  registry.register(provider("coding", async () => ({ content: "unused" })));
  let started!: () => void;
  const requestStarted = new Promise<void>((resolve) => { started = resolve; });
  registry.register(provider("judge", async (request) => {
    started();
    return new Promise<ModelResponse>((_resolve, reject) => {
      request.signal?.addEventListener("abort", () => {
        reject(new DOMException("This operation was aborted", "AbortError"));
      }, { once: true });
    });
  }));
  const runner = new GoalLoopRunner(registry);
  const run = runner.run(config(), toolExecutor, {}, () => {});
  await requestStarted;
  runner.cancel();

  const result = await run;
  assert.equal(result.status, "cancelled");
  assert.equal(result.state.status, "cancelled");
  assert.equal(result.error, undefined);
});

test("Goal loop reports unknown model namespaces before planning", async () => {
  const registry = new DefaultProviderRegistry();
  registry.register(provider("coding", async () => ({ content: "unused" })));

  const result = await new GoalLoopRunner(registry).run(
    config({ judgeModelId: "missing/model" }),
    toolExecutor,
    {},
    () => {},
  );
  assert.equal(result.status, "failed");
  assert.equal(result.error, "No provider found for judge model: missing/model");
});
