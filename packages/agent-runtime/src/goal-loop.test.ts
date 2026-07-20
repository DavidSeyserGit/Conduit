import assert from "node:assert/strict";
import { test } from "node:test";
import type { GoalReport } from "@conduit/cgs/legacy";
import type {
  GoalRunConfig,
  GoalRunEvent,
  GoalRunState,
  GoalPersistenceRepository,
  GoalRunSnapshot,
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
    if (name === "capture_git_snapshot") return { success: true, result: { tree: "a".repeat(40) } };
    if (name === "replace_in_file") return { success: true, result: { path: args.path } };
    if (name === "run_command") {
      return {
        success: true,
        result: { command: "pnpm test", exitCode: 0, stdout: "passed", stderr: "" },
      };
    }
    if (name === "get_git_diff") return { success: true, result: { diff: "+FarmBot", changedFiles: ["src/title.ts"] } };
    return { success: false, error: `Unexpected tool: ${name}` };
  },
};

function generalReview(goalStatus: "incomplete" | "implemented" = "implemented", findings: unknown[] = [], evidenceRequests: unknown[] = []) {
  return {
    goalStatus,
    confidence: goalStatus === "implemented" ? 0.95 : 0.65,
    summary: goalStatus === "implemented" ? "The requested behavior is implemented." : "A goal requirement remains incomplete.",
    findings,
    evidenceRequests,
    requiredReviewers: [],
    optionalReviewers: [],
    evidenceIds: [],
  };
}

function specialistReview(status: "approved" | "approved_with_warnings" = "approved") {
  return { status, confidence: 0.95, summary: "The specialist review passed.", findings: [], evidenceRequests: [] };
}

test("Goal loop executes its planned validation contract before judging", async () => {
  const registry = new DefaultProviderRegistry();
  const timeline: string[] = [];
  const judgePrompts: string[] = [];
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
          validation: { strategy: "commands", rationale: "The workspace provides a targeted test script.", commands: ["pnpm test"] },
        },
      };
    }
    judgePrompts.push(request.messages.at(-1)?.content || "");
    if (request.structuredOutput?.name === "general_review") return { content: "", structuredOutput: generalReview() };
    return { content: "", structuredOutput: specialistReview() };
  }));
  const events: GoalRunEvent[] = [];
  const persistence = reportPersistence();

  const result = await new GoalLoopRunner(registry, persistence).run(
    config(),
    toolExecutor,
    {},
    (event) => events.push(event),
  );

  assert.equal(result.status, "completed");
  assert.equal(result.state.iteration, 1);
  assert.equal(result.state.plan?.summary, "Rename and validate");
  assert.deepEqual(result.state.iterations[0]?.changedFiles, ["src/title.ts"]);
  assert.deepEqual(result.state.iterations[0]?.validationResults.map((validation) => validation.command), ["pnpm test"]);
  assert.match(judgePrompts[0] || "", /pnpm test/);
  assert.equal(result.state.iterations[0]?.judgeResult?.approved, true);
  assert.deepEqual(timeline, [
    "judge:implementation_plan",
    "coding:coding/model",
    "coding:coding/model",
    "judge:general_review",
    "judge:review_code_quality",
    "judge:review_testing",
  ]);
  assert.equal(events.some((event) => event.type === "run_completed"), true);
  assert.equal(events.some((event) => event.type === "run_failed"), false);
  assert.equal(result.report?.overview.finalStatus, "achieved");
  assert.equal(persistence.report?.runId, result.state.id);
  assert.deepEqual((await persistence.restoreRun(result.state.id))?.report, result.report);
});

test("Goal loop recovers when the general reviewer times out once", async () => {
  const registry = new DefaultProviderRegistry();
  const events: GoalRunEvent[] = [];
  let generalAttempts = 0;
  registry.register(provider("coding", async () => ({ content: "Implemented the title change" })));
  registry.register(provider("judge", async (request) => {
    if (request.structuredOutput?.name === "implementation_plan") {
      return {
        content: "",
        structuredOutput: {
          summary: "Rename and validate",
          tasks: [{ id: "1", description: "Rename the title", status: "pending" }],
          validation: { strategy: "not_applicable", rationale: "Review the isolated text change.", commands: [] },
        },
      };
    }
    if (request.structuredOutput?.name === "general_review") {
      generalAttempts += 1;
      if (generalAttempts === 1) throw new Error("reviewer network timeout");
      return { content: "", structuredOutput: generalReview() };
    }
    return { content: "", structuredOutput: specialistReview() };
  }));

  const result = await new GoalLoopRunner(registry).run(config(), toolExecutor, {}, (event) => events.push(event));

  assert.equal(result.status, "completed");
  assert.equal(generalAttempts, 2);
  assert.equal(events.some((event) => event.type === "agent_status" && /General reviewer.*retrying attempt 2\/2/.test(event.message)), true);
  assert.equal(events.some((event) => event.type === "run_failed"), false);
});

test("Goal loop collects requested evidence and reruns the requesting reviewer", async () => {
  const registry = new DefaultProviderRegistry();
  const events: GoalRunEvent[] = [];
  let generalReviewCalls = 0;
  let evidenceCommandCalls = 0;

  registry.register(provider("coding", async () => ({ content: "Implemented the requested title change" })));
  registry.register(provider("judge", async (request) => {
    if (request.structuredOutput?.name === "implementation_plan") {
      return {
        content: "",
        structuredOutput: {
          summary: "Rename the title",
          tasks: [{ id: "1", description: "Update the title", status: "pending" }],
          validation: { strategy: "not_applicable", rationale: "The reviewer will request targeted evidence.", commands: [] },
        },
      };
    }
    if (request.structuredOutput?.name === "general_review") {
      generalReviewCalls += 1;
      const hasEvidence = request.messages.at(-1)?.content.includes("pnpm test finished with exit code 0") ?? false;
      return {
        content: "",
        structuredOutput: generalReview("implemented", [], hasEvidence ? [] : [{
          id: "title-tests",
          type: "test",
          description: "Run the title regression tests.",
          required: true,
          suggestedCommand: "pnpm test",
          expectedOutcome: "The regression tests pass.",
        }]),
      };
    }
    return { content: "", structuredOutput: specialistReview() };
  }));

  const evidenceTools: ToolExecutor = {
    async execute(name) {
      if (name === "capture_git_snapshot") return { success: true, result: { tree: "a".repeat(40) } };
      if (name === "get_git_diff") return { success: true, result: { diff: "+FarmBot", changedFiles: ["src/title.ts"] } };
      if (name === "run_command") {
        evidenceCommandCalls += 1;
        return { success: true, result: { command: "pnpm test", exitCode: 0, stdout: "passed", stderr: "", durationMs: 10 } };
      }
      return { success: false, error: `Unexpected tool: ${name}` };
    },
  };

  const result = await new GoalLoopRunner(registry).run(config(), evidenceTools, {}, (event) => events.push(event));

  assert.equal(result.status, "completed");
  assert.equal(generalReviewCalls, 2);
  assert.equal(evidenceCommandCalls, 1);
  assert.equal(result.state.iterations[0]?.evidence?.[0]?.type, "test");
  assert.equal(result.state.iterations[0]?.evidenceRequests?.[0]?.status, "collected");
  assert.equal(events.some((event) => event.type === "evidence_collection_started"), true);
  assert.equal(events.some((event) => event.type === "evidence_collected"), true);
  assert.equal(events.some((event) => event.type === "evidence_collection_completed"), true);
});

test("structured Goal implementation is blocked before providers and tools until the exact version is approved", async () => {
  const registry = new DefaultProviderRegistry();
  let toolCalls = 0;
  const gatedTools: ToolExecutor = {
    async execute() {
      toolCalls += 1;
      return { success: true };
    },
  };
  const structuredGoal = {
    schemaVersion: 1 as const,
    id: "goal-1",
    originalRequest: "Rename the title",
    title: "Rename the title",
    description: "Rename the product title.",
    successCriteria: [{ id: "criterion-1", description: "The new title is visible", required: true }],
    constraints: [],
    deliverables: [{ id: "deliverable-1", type: "implementation" as const, description: "Updated title", required: true }],
    assumptions: [],
    answers: [],
    status: "awaiting_approval" as const,
    version: 2,
    createdAt: "2026-07-18T12:00:00.000Z",
    updatedAt: "2026-07-18T12:00:00.000Z",
  };
  const events: GoalRunEvent[] = [];
  const result = await new GoalLoopRunner(registry).run(
    config({ structuredGoal, approvedGoalVersion: 1 }),
    gatedTools,
    {},
    (event) => events.push(event),
  );
  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /exact structured goal version/);
  assert.equal(toolCalls, 0);
  assert.deepEqual(events.map((event) => event.type), ["run_failed"]);
});

test("Goal loop sends only classified repair feedback to the next coding iteration", async () => {
  const registry = new DefaultProviderRegistry();
  let codingCalls = 0;
  let secondCodingPrompt = "";
  let judgeCalls = 0;

  registry.register(provider("coding", async (request) => {
    codingCalls += 1;
    if (codingCalls === 1) return { content: "First implementation", toolCalls: [{ id: "edit", name: "replace_in_file", arguments: { path: "src/title.ts", search: "Old", replace: "New" } }] };
    if (codingCalls === 2) return { content: "First implementation complete" };
    secondCodingPrompt = request.messages.at(-1)?.content || "";
    return { content: "Applied the requested title correction" };
  }));
  registry.register(provider("judge", async (request) => {
    judgeCalls += 1;
    if (judgeCalls === 1) return {
      content: "",
      structuredOutput: {
        summary: "Plan the title update",
        tasks: [{ id: "1", description: "Update the title", status: "pending" }],
        validation: { strategy: "not_applicable", rationale: "This isolated text update has no available automated check.", commands: [] },
      },
    };
    if (request.structuredOutput?.name === "general_review" && judgeCalls === 2) return {
      content: "",
      structuredOutput: generalReview("incomplete", [{
        id: "title-incomplete",
        severity: "high",
        title: "Visible title is incomplete",
        description: "Update the visible application title to the requested value.",
        filePath: "src/title.ts",
        lineStart: 1,
        lineEnd: 1,
        criterionId: null,
        remediation: "Update the visible application title to the requested value.",
      }], [{
        id: "visual-confirmation",
        type: "file",
        description: "Confirm the resulting title in the desktop window.",
        required: false,
        suggestedCommand: null,
        expectedOutcome: null,
      }]),
    };
    if (request.structuredOutput?.name === "general_review") return { content: "", structuredOutput: generalReview() };
    return { content: "", structuredOutput: specialistReview() };
  }));

  const result = await new GoalLoopRunner(registry).run(config(), toolExecutor, {}, () => {});

  assert.equal(result.status, "completed");
  assert.match(secondCodingPrompt, /Update the visible application title/);
  assert.doesNotMatch(secondCodingPrompt, /formatting the surrounding documentation|broader documentation review|Confirm the resulting title/);
});

test("Goal loop keeps one scoped baseline across judge repair iterations", async () => {
  const registry = new DefaultProviderRegistry();
  let judgeCalls = 0;
  let snapshotCalls = 0;
  const diffBaselines: unknown[] = [];
  const baselineTree = "b".repeat(40);

  registry.register(provider("coding", async () => ({ content: "Applied the requested change" })));
  registry.register(provider("judge", async () => {
    judgeCalls += 1;
    if (judgeCalls === 1) return {
      content: "",
      structuredOutput: {
        summary: "Update the title",
        tasks: [{ id: "1", description: "Update the title", status: "pending" }],
        validation: { strategy: "not_applicable", rationale: "No automated check applies.", commands: [] },
      },
    };
    if (judgeCalls === 2) return {
      content: "",
      structuredOutput: generalReview("incomplete", [{
        id: "finish-title",
        severity: "medium",
        title: "Title remains incomplete",
        description: "Finish the title update.",
        filePath: "src/title.ts",
        lineStart: 1,
        lineEnd: 1,
        criterionId: null,
        remediation: "Finish the title update.",
      }]),
    };
    if (judgeCalls === 3) return { content: "", structuredOutput: generalReview() };
    return { content: "", structuredOutput: specialistReview() };
  }));

  const scopedExecutor: ToolExecutor = {
    async execute(name, args) {
      if (name === "capture_git_snapshot") {
        snapshotCalls += 1;
        return { success: true, result: { tree: baselineTree } };
      }
      if (name === "get_git_diff") {
        diffBaselines.push(args.baselineTree);
        return { success: true, result: { diff: "+title", changedFiles: ["src/title.ts"] } };
      }
      return { success: false, error: `Unexpected tool: ${name}` };
    },
  };

  const result = await new GoalLoopRunner(registry).run(config(), scopedExecutor, {}, () => {});

  assert.equal(result.status, "completed");
  assert.equal(snapshotCalls, 1);
  assert.deepEqual(diffBaselines, [baselineTree, baselineTree]);
  assert.equal(result.state.baselineTree, baselineTree);
});

test("resumed runs reuse their original scoped baseline", async () => {
  const registry = new DefaultProviderRegistry();
  const baselineTree = "c".repeat(40);
  let snapshotCalls = 0;
  let reviewedBaseline: unknown;
  const resumeState: GoalRunState = {
    id: "stopped-run",
    goal: "Rename the product title",
    workspacePath: "/repo",
    status: "iteration_limit_reached",
    codingModelId: "coding/model",
    judgeModelId: "judge/model",
    iteration: 0,
    maxIterations: 1,
    baselineTree,
    plan: {
      summary: "Rename the title",
      tasks: [{ id: "1", description: "Rename the title", status: "pending" }],
      validation: { strategy: "not_applicable", rationale: "No automated check applies.", commands: [] },
    },
    iterations: [],
    startedAt: new Date().toISOString(),
  };

  registry.register(provider("coding", async () => ({ content: "Finished the resumed change" })));
  registry.register(provider("judge", async (request) => ({
    content: "",
    structuredOutput: request.structuredOutput?.name === "general_review" ? generalReview() : specialistReview(),
  })));
  const scopedExecutor: ToolExecutor = {
    async execute(name, args) {
      if (name === "capture_git_snapshot") {
        snapshotCalls += 1;
        return { success: true, result: { tree: "d".repeat(40) } };
      }
      if (name === "get_git_diff") {
        reviewedBaseline = args.baselineTree;
        return { success: true, result: { diff: "+title", changedFiles: ["src/title.ts"] } };
      }
      return { success: false, error: `Unexpected tool: ${name}` };
    },
  };

  const result = await new GoalLoopRunner(registry).run(
    config({ resumeState }),
    scopedExecutor,
    {},
    () => {},
  );

  assert.equal(result.status, "completed");
  assert.equal(snapshotCalls, 0);
  assert.equal(reviewedBaseline, baselineTree);
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

function reportPersistence(): GoalPersistenceRepository & { report: GoalReport | null } {
  let imported: GoalRunState | null = null;
  const repository: GoalPersistenceRepository & { report: GoalReport | null } = {
    report: null,
    async status() { return { available: true }; },
    async saveGoal() {}, async saveGoalVersion() {}, async replaceQuestions() {}, async saveAnswer() {}, async saveRun() {},
    async appendEvent() { return 1; }, async saveReview() {}, async saveEvidenceRequest() {}, async saveEvidence() {},
    async saveReport(report) { repository.report = report; }, async deleteRun() {}, async deleteGoal() {},
    async importLegacyRun(run) { imported = structuredClone(run); }, async getGoal() { return null; },
    async restoreRun(): Promise<GoalRunSnapshot | null> {
      if (!imported) return null;
      return { run: imported, goal: null, versions: [], questions: [], answers: [], events: [], reviews: [], findings: [], evidenceRequests: [], evidence: [], report: repository.report };
    },
    async listRuns() { return imported ? [imported] : []; },
    async writeArtifact(runId, content, contentType = "text/plain") { return { id: "artifact", runId, relativePath: "artifact", sha256: "hash", size: content.length, contentType, createdAt: "2026-07-18T12:00:00.000Z" }; },
    async readArtifact() { throw new Error("not used"); }, async cleanupArtifacts() { return 0; },
  };
  return repository;
}
