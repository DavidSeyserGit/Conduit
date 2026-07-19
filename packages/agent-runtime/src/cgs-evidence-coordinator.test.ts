import assert from "node:assert/strict";
import { test } from "node:test";
import { CGS_VERSION, type EvidenceRequest, type GoalPermissions } from "@conduit/cgs";
import { EvidenceCoordinator, invalidateEvidenceAfterImplementation } from "./cgs-evidence-coordinator.ts";

const at = "2026-07-19T10:00:00Z";
const request: EvidenceRequest = { cgsVersion: CGS_VERSION, kind: "evidence-request", id: "request_1", createdAt: at, runId: "run_1", goalId: "goal_1", requestedByReviewerId: "conduit.testing", type: "test", description: "Run tests", required: true, command: { command: "pnpm test" }, status: "requested" };
const permissions: GoalPermissions = { allowFileReads: true, allowFileWrites: false, allowCommandExecution: true, allowNetworkAccess: false, allowDependencyChanges: false, allowGitOperations: false };

test("reviewer evidence executes only through the coordinator and becomes stale after implementation", async () => {
  let executions = 0;
  const coordinator = new EvidenceCoordinator({ async execute(input) { executions += 1; return { cgsVersion: CGS_VERSION, kind: "evidence-artifact", id: "artifact_1", createdAt: at, runId: input.runId, goalId: input.goalId, requestId: input.id, type: "test_result", status: "success", summary: "Passed", payload: { exitCode: 0 }, producedAt: at }; } });
  const artifact = await coordinator.collect(request, { permissions, authorize: async () => true });
  assert.equal(executions, 1);
  assert.equal(invalidateEvidenceAfterImplementation([artifact])[0]?.stale, true);
  const denied = await coordinator.collect(request, { permissions: { ...permissions, allowCommandExecution: false } });
  assert.equal(denied.status, "unavailable");
  assert.equal(executions, 1);
});
