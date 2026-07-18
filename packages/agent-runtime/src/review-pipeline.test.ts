import assert from "node:assert/strict";
import test from "node:test";
import type { ModelProvider } from "@conduit/model-providers";
import type { ModelRequest, ModelResponse, ReviewResult } from "@conduit/shared";
import {
  GeneralReviewer,
  ModelSpecialistReviewer,
  REVIEWER_DEFINITIONS,
  ReviewPipeline,
  ReviewerRegistry,
  aggregateFinalApproval,
  reconcileFindingLifecycle,
  routeReviewers,
  selectReviewersForRerun,
  type RoutedReviewInput,
} from "./review-pipeline.ts";

const at = "2026-07-18T10:00:00.000Z";

function input(title: string, paths: string[], patch = ""): RoutedReviewInput {
  return {
    goal: {
      schemaVersion: 1,
      id: "goal-1",
      originalRequest: title,
      title,
      description: title,
      successCriteria: [{ id: "criterion-1", description: "Requested behavior works", required: true }],
      constraints: [{ id: "constraint-1", description: "Preserve existing behavior", source: "user" }],
      deliverables: [{ id: "deliverable-1", type: "implementation", description: "Implementation", required: true }],
      assumptions: [],
      answers: [],
      status: "approved",
      version: 1,
      createdAt: at,
      updatedAt: at,
    },
    repositoryContext: {
      workspacePath: "/repo",
      summary: "TypeScript repository",
      languages: ["TypeScript"],
      frameworks: [],
      testFrameworks: ["node:test"],
      instructions: [],
      relevantFiles: paths.map((path) => ({ path, reason: "Changed file" })),
      preparedAt: at,
    },
    diff: {
      baseRevision: "abc",
      changes: paths.map((path) => ({ path, status: "modified" as const })),
      collectedAt: at,
    },
    validationResults: [],
    availableEvidence: [],
    patch,
  };
}

function review(reviewerId: string, status: ReviewResult["status"] = "approved", overrides: Partial<ReviewResult> = {}): ReviewResult {
  return {
    id: `${reviewerId}-review`,
    reviewerId,
    status,
    confidence: 0.9,
    summary: `${reviewerId} review`,
    findings: [],
    evidenceRequests: [],
    reviewedAt: at,
    ...overrides,
  };
}

function specialistOutput(status = "approved") {
  return { status, confidence: 0.9, summary: "Narrow review complete", findings: [], evidenceRequests: [] };
}

function generalOutput(requiredReviewers: string[]) {
  return {
    goalStatus: "implemented",
    confidence: 0.9,
    summary: "The goal is implemented.",
    findings: [],
    evidenceRequests: [],
    requiredReviewers,
    optionalReviewers: [],
    evidenceIds: [],
  };
}

function fakeProvider(responses: ModelResponse[], requests: ModelRequest[] = []): ModelProvider {
  return {
    id: "fake",
    name: "Fake reviewer",
    listModels: async () => [],
    createResponse: async (request) => {
      requests.push(request);
      const response = responses.shift();
      if (!response) throw new Error("Reviewer model unavailable");
      return response;
    },
    streamResponse: async () => ({ content: "" }),
  };
}

test("deterministic routing covers representative goal and diff classes", () => {
  const authentication = routeReviewers(input("Add GitHub authentication", ["src/auth/github.ts"]));
  assert.deepEqual(new Set(authentication.requiredReviewers), new Set(["code_quality", "testing", "security", "documentation"]));

  const css = routeReviewers(input("Adjust the dark mode CSS", ["src/theme.css"]));
  assert.equal(css.requiredReviewers.includes("ui"), true);
  assert.equal(css.requiredReviewers.includes("accessibility"), true);

  const migration = routeReviewers(input("Add a database migration with rollback", ["migrations/003_users.sql"]));
  for (const id of ["migration", "security", "performance", "testing"]) assert.equal(migration.requiredReviewers.includes(id), true);

  const refactor = routeReviewers(input("Refactor module boundaries", ["src/runtime.ts"]));
  assert.equal(refactor.requiredReviewers.includes("architecture"), true);

  const documentation = routeReviewers(input("Update setup documentation", ["docs/setup.md"]));
  assert.deepEqual(documentation, { requiredReviewers: ["documentation"], optionalReviewers: [] });

  const performance = routeReviewers(input("Improve request latency and add a benchmark", ["src/query.ts"]));
  assert.equal(performance.requiredReviewers.includes("performance"), true);
  assert.equal(performance.requiredReviewers.includes("testing"), true);
});

test("final approval cannot bypass general, mandatory, evidence, critical, or policy gates", () => {
  assert.equal(aggregateFinalApproval(review("general", "changes_requested"), ["testing"], [review("testing")]).approved, false);
  assert.match(aggregateFinalApproval(review("general"), ["testing"], []).reason, /did not run/);
  assert.equal(aggregateFinalApproval(review("general"), ["testing"], [review("testing", "not_applicable")]).approved, false);
  assert.equal(aggregateFinalApproval(review("general"), ["testing"], [review("testing")], false).approved, false);

  const evidence = review("testing", "approved", {
    evidenceRequests: [{
      id: "request-1", reviewerId: "testing", type: "test", description: "Run tests", required: true,
      status: "pending", evidenceIds: [], requestedAt: at,
    }],
  });
  assert.match(aggregateFinalApproval(review("general"), ["testing"], [evidence]).reason, /evidence/i);

  const critical = review("security", "approved", {
    findings: [{ id: "critical-1", severity: "critical", title: "Unsafe", description: "Critical issue" }],
  });
  assert.match(aggregateFinalApproval(review("general"), ["security"], [critical]).reason, /critical/i);
  assert.equal(aggregateFinalApproval(review("general"), ["testing"], [review("testing", "approved_with_warnings")]).approved, true);
});

test("pipeline keeps functional and specialist review distinct and runs only routed reviewers", async () => {
  const requests: ModelRequest[] = [];
  const provider = fakeProvider([
    { content: "", structuredOutput: generalOutput(["documentation"]) },
    { content: "", structuredOutput: specialistOutput() },
  ], requests);
  const registry = new ReviewerRegistry().register(new ModelSpecialistReviewer(
    REVIEWER_DEFINITIONS.documentation, provider, "review/model", "/repo",
  ));
  const stages: string[] = [];
  const pipeline = new ReviewPipeline(new GeneralReviewer(provider, "review/model", "/repo"), registry);
  const result = await pipeline.run(input("Update docs", ["README.md"]), {
    onGeneralStarted: () => stages.push("general:start"),
    onGeneralCompleted: () => stages.push("general:done"),
    onSpecialistStarted: (id) => stages.push(`${id}:start`),
    onSpecialistCompleted: (value) => stages.push(`${value.reviewerId}:done`),
  });

  assert.equal(result.approved, true);
  assert.deepEqual(stages, ["general:start", "general:done", "documentation:start", "documentation:done"]);
  assert.equal(requests.length, 2);
  assert.equal(requests.every((request) => request.tools === undefined), true);
});

test("reviewer output is repaired once and unavailable required reviewers block approval", async () => {
  const requests: ModelRequest[] = [];
  const provider = fakeProvider([
    { content: "not json" },
    { content: "", structuredOutput: generalOutput(["documentation"]) },
  ], requests);
  const pipeline = new ReviewPipeline(new GeneralReviewer(provider, "review/model", "/repo"), new ReviewerRegistry());
  const result = await pipeline.run(input("Update docs", ["README.md"]));
  assert.equal(requests.length, 2);
  assert.equal(result.approved, false);
  assert.equal(result.specialistReviews[0]?.status, "blocked");
});

test("affected-only reruns preserve approvals and expand into new domains", () => {
  const previous = new Map<string, ReviewResult>([
    ["testing", review("testing")],
    ["documentation", review("documentation")],
    ["security", review("security", "changes_requested")],
  ]);
  assert.deepEqual(
    selectReviewersForRerun(["testing", "documentation", "security"], ["src/auth.ts"], ["src/auth.ts"], previous),
    ["security"],
  );
  assert.deepEqual(
    selectReviewersForRerun(["testing", "documentation", "security"], ["src/auth.ts", "docs/auth.md"], ["src/auth.ts"], previous),
    ["documentation", "security"],
  );
});

test("finding lifecycle records resolved, superseded, and open identities", () => {
  const old = review("testing", "changes_requested", {
    findings: [
      { id: "same", severity: "medium", title: "Same", description: "Still present" },
      { id: "fixed", severity: "high", title: "Fixed", description: "Resolved" },
    ],
  });
  const current = review("testing", "changes_requested", {
    findings: [
      { id: "same", severity: "medium", title: "Same", description: "Still present" },
      { id: "new", severity: "low", title: "New", description: "New warning" },
    ],
  });
  assert.deepEqual(reconcileFindingLifecycle([old], [current], 2), [
    { findingId: "same", reviewerId: "testing", disposition: "superseded", round: 2 },
    { findingId: "fixed", reviewerId: "testing", disposition: "resolved", round: 2 },
    { findingId: "same", reviewerId: "testing", disposition: "open", round: 2 },
    { findingId: "new", reviewerId: "testing", disposition: "open", round: 2 },
  ]);
});

test("registry rejects duplicate reviewer identities", () => {
  const provider = fakeProvider([]);
  const reviewer = new ModelSpecialistReviewer(REVIEWER_DEFINITIONS.testing, provider, "review/model", "/repo");
  const registry = new ReviewerRegistry().register(reviewer);
  assert.throws(() => registry.register(reviewer), /already registered/);
});

test("review cancellation and timeout fail closed", async () => {
  let started!: () => void;
  const requestStarted = new Promise<void>((resolve) => { started = resolve; });
  const hanging = providerWithAbort(started);
  const controller = new AbortController();
  const cancelled = new GeneralReviewer(hanging, "review/model", "/repo", undefined, 1_000);
  const cancellation = cancelled.review(input("Update docs", ["README.md"]), ["documentation"], controller.signal);
  await requestStarted;
  controller.abort();
  await assert.rejects(cancellation, /cancelled/);

  const timedOut = new GeneralReviewer(providerWithAbort(() => {}), "review/model", "/repo", undefined, 5);
  await assert.rejects(
    timedOut.review(input("Update docs", ["README.md"]), ["documentation"]),
    /timed out/,
  );
});

test("required reviewer disagreement blocks completion", () => {
  const decision = aggregateFinalApproval(
    review("general"),
    ["security", "testing"],
    [review("security"), review("testing", "changes_requested")],
  );
  assert.equal(decision.approved, false);
  assert.match(decision.reason, /testing/);
});

test("general review reruns link to the previous result", async () => {
  const provider = fakeProvider([
    { content: "", structuredOutput: generalOutput([]) },
    { content: "", structuredOutput: generalOutput([]) },
  ]);
  const reviewer = new GeneralReviewer(provider, "review/model", "/repo");
  const first = await reviewer.review(input("Update docs", ["README.md"]), ["documentation"]);
  const second = await reviewer.review(
    { ...input("Update docs", ["README.md"]), previousReview: first.result },
    ["documentation"],
  );
  assert.equal(second.result.supersedesReviewId, first.result.id);
});

function providerWithAbort(onStart: () => void): ModelProvider {
  return {
    id: "hanging",
    name: "Hanging reviewer",
    listModels: async () => [],
    createResponse: async (request) => {
      onStart();
      return new Promise<ModelResponse>((_resolve, reject) => {
        request.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      });
    },
    streamResponse: async () => ({ content: "" }),
  };
}
