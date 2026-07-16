import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  GoalRunEvent,
  ModelRequest,
  ModelResponse,
} from "@conduit/shared";
import type { ModelProvider } from "@conduit/model-providers";
import { Judge } from "./judge.ts";

function fakeProvider(
  responses: ModelResponse[],
  requests: ModelRequest[],
): ModelProvider {
  return {
    id: "fake",
    name: "Fake Judge",
    listModels: async () => [],
    createResponse: async (request) => {
      requests.push(request);
      const response = responses.shift();
      if (!response) throw new Error("No fake response available");
      return response;
    },
    streamResponse: async () => ({ content: "" }),
  };
}

test("planning judge sends a schema-bound, workspace-aware request", async () => {
  const requests: ModelRequest[] = [];
  const events: GoalRunEvent[] = [];
  const controller = new AbortController();
  const judge = new Judge(
    fakeProvider([{
      content: "",
      structuredOutput: {
        summary: "Implement the requested change",
        tasks: [
          { id: "1", description: "Inspect the relevant files", status: "pending" },
          { id: "2", description: "Implement and validate", status: "pending" },
        ],
        validation: { strategy: "commands", rationale: "Run the repository test suite.", commands: ["pnpm test"] },
      },
    }], requests),
    "fake/model",
    "/repo",
    "low",
    (event) => events.push(event),
    controller.signal,
  );

  const result = await judge.createImplementationPlan("Rename the title");

  assert.equal(result.plan.tasks.length, 2);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.modelId, "fake/model");
  assert.equal(requests[0]?.workspacePath, "/repo");
  assert.equal(requests[0]?.reasoningEffort, "low");
  assert.equal(requests[0]?.signal, controller.signal);
  assert.equal(requests[0]?.structuredOutput?.name, "implementation_plan");
  assert.equal(requests[0]?.tools, undefined);
  assert.equal(events.some((event) => event.type === "agent_heartbeat"), true);
});

test("judge approves an evidence-only objection rather than creating a coding repair loop", async () => {
  const judge = new Judge(
    fakeProvider([{
      content: "",
      structuredOutput: {
        approved: false,
        summary: "More confirmation would be useful.",
        feedback: ["Consider checking the release notes."],
        missingRequirements: [],
        repairFeedback: [],
        evidenceRequests: ["Confirm the deployed version."],
        followUps: [],
        confidence: 0.65,
      },
    }], []),
    "fake/model",
    "/repo",
    undefined,
    () => {},
  );

  const review = await judge.review({
    goal: "Rename the title",
    changedFiles: ["src/title.ts"],
    validationResults: [],
    iteration: 1,
    workspacePath: "/repo",
    diff: "+Conduit",
  });

  assert.equal(review.result.approved, true);
  assert.deepEqual(review.result.repairFeedback, []);
  assert.deepEqual(review.result.followUps, ["Consider checking the release notes."]);
});

test("judge review retries malformed output once with an explicit repair request", async () => {
  const requests: ModelRequest[] = [];
  const judge = new Judge(
    fakeProvider([
      { content: "not-json" },
      {
        content: '{"approved":true,"summary":"Complete","feedback":[],"missingRequirements":[],"confidence":0.95}',
      },
    ], requests),
    "fake/model",
    "/repo",
    undefined,
    () => {},
  );

  const review = await judge.review({
    goal: "Rename the title",
    changedFiles: ["src/title.ts"],
    validationResults: [{
      command: "pnpm test",
      exitCode: 0,
      stdout: "passed",
      stderr: "",
      passed: true,
    }],
    iteration: 1,
    workspacePath: "/repo",
    diff: "+FarmBot",
  });

  assert.equal(review.result.approved, true);
  assert.equal(requests.length, 2);
  assert.match(requests[1]?.messages.at(-1)?.content || "", /ONLY valid JSON/);
  assert.equal(requests[1]?.structuredOutput?.name, "judge_evaluation");
});

test("planning judge rejects schema-invalid plans before implementation begins", async () => {
  const requests: ModelRequest[] = [];
  const judge = new Judge(
    fakeProvider([{
      content: '{"summary":"Incomplete","tasks":[{"id":"1","description":"Inspect","status":"invented"}]}',
    }], requests),
    "fake/model",
    "/repo",
    undefined,
    () => {},
  );

  await assert.rejects(
    judge.createImplementationPlan("Rename the title"),
    /Invalid option|Invalid enum|status/,
  );
});

test("planning judge requires commands when the validation contract calls for them", async () => {
  const judge = new Judge(
    fakeProvider([{
      content: "",
      structuredOutput: {
        summary: "Incomplete validation contract",
        tasks: [{ id: "1", description: "Implement the change", status: "pending" }],
        validation: { strategy: "commands", rationale: "A test should be run.", commands: [] },
      },
    }], []),
    "fake/model",
    "/repo",
    undefined,
    () => {},
  );

  await assert.rejects(
    judge.createImplementationPlan("Rename the title"),
    /Command validation requires at least one command/,
  );
});
