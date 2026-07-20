import assert from "node:assert/strict";
import test from "node:test";
import { environmentLimitation, executeValidationCommand, validationCommandCandidates } from "./validation-execution.js";

test("pytest evidence falls back to the available Python module launcher", async () => {
  const attempted: string[] = [];
  const execution = await executeValidationCommand("pytest -q test", async (command) => {
    attempted.push(command);
    return command.startsWith("python3")
      ? { success: true, result: { command, exitCode: 0, stdout: "3 passed, 3 skipped", stderr: "", durationMs: 20 } }
      : { success: true, result: { command, exitCode: 127, stdout: "", stderr: "/bin/sh: pytest: command not found", durationMs: 2 } };
  });
  assert.deepEqual(attempted, ["pytest -q test", "python3 -m pytest -q test"]);
  assert.equal(execution.result.outcome, "passed");
  assert.equal(execution.result.command, "python3 -m pytest -q test");
});

test("a missing ROS runtime is environment-blocked rather than a failed assertion", async () => {
  let attempts = 0;
  const execution = await executeValidationCommand("python3 -m pytest -q test", async (command) => {
    attempts += 1;
    return {
      success: true,
      result: { command, exitCode: 1, stdout: "", stderr: "ModuleNotFoundError: No module named 'ompl'", durationMs: 5 },
    };
  });
  assert.equal(execution.result.outcome, "blocked_environment");
  assert.equal(execution.result.passed, false);
  assert.equal(attempts, 1);
  assert.match(execution.result.limitation ?? "", /ROS runtime module|test/);
});

test("ordinary assertion failures remain failures", () => {
  assert.equal(environmentLimitation(1, "AssertionError: expected 4, received 3"), undefined);
  assert.deepEqual(validationCommandCandidates("colcon test"), ["colcon test"]);
});
