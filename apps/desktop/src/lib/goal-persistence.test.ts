import assert from "node:assert/strict";
import test from "node:test";
import {
  TauriGoalPersistenceRepository,
  migrateLegacyRunHistoryFromLocalStorage,
} from "./goal-persistence.js";
import { CGS_VERSION, type GoalSpecification } from "@conduit/cgs";

const at = "2026-07-18T08:00:00.000Z";
const later = "2026-07-18T08:01:00.000Z";
const cgsGoal: GoalSpecification = {
  cgsVersion: CGS_VERSION, kind: "goal", id: "goal-cgs-1", createdAt: at, title: "Portable goal", description: "Keep it portable.",
  successCriteria: [{ id: "criterion-1", description: "It works", priority: "required" }], constraints: [], deliverables: [], assumptions: [],
  permissions: { allowFileReads: true, allowFileWrites: false, allowCommandExecution: false, allowNetworkAccess: false, allowDependencyChanges: false, allowGitOperations: false },
  clarificationHistory: [], reviewPipeline: { generalReviewer: { reviewerId: "conduit.general", required: true }, specialistReviewers: [], routingMode: "hybrid", completionPolicy: "all_required_approve" }, status: "approved", revision: 1,
};

const currentRun = {
  formatVersion: 1 as const,
  id: "run-1",
  goalId: "goal-1",
  activeGoalVersion: 1,
  workflowPhase: "awaiting_user_input" as const,
  workspacePath: "/tmp/repository",
  startedAt: at,
  updatedAt: later,
};

const legacyRun = {
  id: "legacy-run",
  goal: "Legacy request",
  workspacePath: "/tmp/repository",
  status: "completed" as const,
  codingModelId: "codex/model",
  judgeModelId: "openrouter/model",
  iteration: 1,
  maxIterations: 3,
  iterations: [],
  startedAt: at,
  finishedAt: later,
};

test("typed persistence validates and maps writes to the native repository command", async () => {
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  const repository = new TauriGoalPersistenceRepository(async <T>(command: string, args?: Record<string, unknown>) => {
    calls.push({ command, args });
    return { sequence: 4 } as T;
  });

  await repository.saveRun(currentRun);
  const sequence = await repository.appendEvent({
    id: "event-1",
    runId: currentRun.id,
    occurredAt: later,
    type: "workflow_state_transitioned",
    from: "awaiting_goal_approval",
    to: "implementing",
    summary: "Goal approved",
  });

  assert.equal(sequence, 4);
  assert.deepEqual(calls[0], {
    command: "goal_storage_write",
    args: { operation: { operation: "upsert_run", run: currentRun } },
  });
  assert.equal((calls[1]?.args?.operation as Record<string, unknown>).operation, "append_event");
});

test("typed persistence rejects invalid records before invoking native storage", async () => {
  let invoked = false;
  const repository = new TauriGoalPersistenceRepository(async <T>() => {
    invoked = true;
    return {} as T;
  });

  await assert.rejects(() => repository.saveRun({ ...currentRun, updatedAt: "2026-07-18T07:00:00.000Z" }));
  assert.equal(invoked, false);
});

test("CGS persistence validates and round-trips the lossless artifact JSON", async () => {
  const calls: unknown[] = [];
  const writer = new TauriGoalPersistenceRepository(async <T>(_command: string, args?: Record<string, unknown>) => { calls.push(args?.operation); return {} as T; });
  await writer.saveCgsArtifact({ ...cgsGoal, extensionField: { retained: true } });
  assert.equal((calls[0] as Record<string, unknown>).operation, "upsert_cgs_artifact");
  const reader = new TauriGoalPersistenceRepository(async <T>() => ({ ...cgsGoal, extensionField: { retained: true } } as T));
  assert.deepEqual((await reader.getCgsArtifact(cgsGoal.id))?.extensionField, { retained: true });
});

test("restart restoration parses a persisted legacy run snapshot", async () => {
  const repository = new TauriGoalPersistenceRepository(async <T>(command: string) => {
    assert.equal(command, "goal_storage_read");
    return {
      run: legacyRun,
      goal: null,
      versions: [],
      questions: [],
      answers: [],
      events: [{ type: "run_started", runId: legacyRun.id, startedAt: at }],
      reviews: [],
      findings: [],
      evidenceRequests: [],
      evidence: [],
      report: null,
    } as T;
  });

  const snapshot = await repository.restoreRun(legacyRun.id);
  assert.equal(snapshot?.run.id, legacyRun.id);
  assert.equal(snapshot?.events.length, 1);
});

test("legacy migration imports deduplicated runs and completes only after writes", async () => {
  const writes: unknown[] = [];
  const repository = new TauriGoalPersistenceRepository(async <T>(command: string, args?: Record<string, unknown>) => {
    if (command === "goal_storage_write") writes.push(args?.operation);
    return {} as T;
  });
  const values = new Map<string, string>();
  values.set("loopkit-app", JSON.stringify({
    state: {
      currentRun: legacyRun,
      runEvents: [{ type: "run_started" }],
      runHistory: [{ run: legacyRun, events: [{ type: "run_completed" }] }],
      sessions: {
        "/tmp/repository": [{ currentRun: legacyRun, runEvents: [], runHistory: [] }],
      },
    },
  }));
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };

  const result = await migrateLegacyRunHistoryFromLocalStorage(repository, storage);
  assert.deepEqual(result, { imported: 1, skipped: 0, alreadyCompleted: false });
  assert.equal(writes.length, 1);
  assert.equal((writes[0] as Record<string, unknown>).operation, "import_legacy_run");
  assert.equal(values.get("conduit-goal-storage-migrated-v1"), "complete");

  assert.deepEqual(await migrateLegacyRunHistoryFromLocalStorage(repository, storage), {
    imported: 0,
    skipped: 0,
    alreadyCompleted: true,
  });
});

test("legacy migration leaves corrupt local data untouched", async () => {
  const repository = new TauriGoalPersistenceRepository(async <T>() => ({} as T));
  const values = new Map<string, string>([["loopkit-app", "not-json"]]);
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };

  await assert.rejects(() => migrateLegacyRunHistoryFromLocalStorage(repository, storage), /left untouched/);
  assert.equal(values.has("conduit-goal-storage-migrated-v1"), false);
});

test("legacy migration skips runs containing malformed events", async () => {
  const writes: unknown[] = [];
  const repository = new TauriGoalPersistenceRepository(async <T>(command: string, args?: Record<string, unknown>) => {
    if (command === "goal_storage_write") writes.push(args?.operation);
    return {} as T;
  });
  const values = new Map<string, string>([["loopkit-app", JSON.stringify({
    state: { runHistory: [{ run: legacyRun, events: [null, "invalid"] }] },
  })]]);
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };

  assert.deepEqual(await migrateLegacyRunHistoryFromLocalStorage(repository, storage), {
    imported: 0,
    skipped: 1,
    alreadyCompleted: false,
  });
  assert.equal(writes.length, 0);
  assert.equal(values.get("conduit-goal-storage-migrated-v1"), "complete");
});
