import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { GoalBuilderOperationCoordinator, handoffImplementation } from "./goal-builder-operations.ts";

function cancellable(calls: string[], label: string) {
  return {
    cancel: async (runId: string) => { calls.push(`${label}:run:${runId}`); },
    cancelActive: async () => { calls.push(`${label}:active`); },
  };
}

test("Goal Builder permits one operation and invalidates it before cancellation awaits", async () => {
  const calls: string[] = [];
  const coordinator = new GoalBuilderOperationCoordinator();
  const operation = coordinator.begin(() => cancellable(calls, "first"));
  assert.ok(operation);
  assert.equal(coordinator.begin(() => cancellable(calls, "second")), null);

  const cancelling = coordinator.cancel("run-1", () => cancellable(calls, "fallback"));
  assert.equal(coordinator.isCurrent(operation), false);
  assert.equal(coordinator.busy, false);
  await cancelling;
  assert.deepEqual(calls, ["first:active"]);
});

test("Goal Builder cancellation uses persisted-run fallback only when no operation is active", async () => {
  const calls: string[] = [];
  const coordinator = new GoalBuilderOperationCoordinator();
  await coordinator.cancel("run-2", () => cancellable(calls, "fallback"));
  assert.deepEqual(calls, ["fallback:run:run-2"]);
});

test("late completion cannot finish a replacement operation", () => {
  const coordinator = new GoalBuilderOperationCoordinator();
  const first = coordinator.begin(() => cancellable([], "first"));
  assert.ok(first);
  coordinator.reset();
  const second = coordinator.begin(() => cancellable([], "second"));
  assert.ok(second);

  coordinator.finish(first);
  assert.equal(coordinator.isCurrent(second), true);
});

test("ChatTimeline calls hooks before switching to the Goal Builder", () => {
  const source = readFileSync(new URL("../features/goal-run/ExecutionTimeline.tsx", import.meta.url), "utf8");
  const effect = source.indexOf("useEffect(() =>");
  const goalBuilderReturn = source.indexOf('if (mode === "goal" && goalBuilderPhase !== "idle") return <GoalBuilder />');
  assert.ok(effect >= 0);
  assert.ok(goalBuilderReturn > effect, "the Goal Builder return must not change ChatTimeline's hook count");
});

test("approved goals leave setup as soon as implementation starts", async () => {
  let finishImplementation: (() => void) | undefined;
  const implementation = new Promise<void>((resolve) => { finishImplementation = resolve; });
  const events: string[] = [];
  const handoff = handoffImplementation(
    () => { events.push("implementation-started"); return implementation; },
    () => { events.push("builder-closed"); },
  );

  await Promise.resolve();
  assert.deepEqual(events, ["implementation-started", "builder-closed"]);
  finishImplementation?.();
  await handoff;
});
