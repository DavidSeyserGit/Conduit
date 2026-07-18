import assert from "node:assert/strict";
import { test } from "node:test";
import { runWorkspaceCommand } from "./workspace-command.ts";

test("browser workspace commands report successful process exit codes", async () => {
  const result = await runWorkspaceCommand("node -e \"process.stdout.write('ok')\"", process.cwd());

  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "ok");
  assert.equal(result.timedOut, false);
});

test("browser workspace commands preserve a non-zero process exit code", async () => {
  const result = await runWorkspaceCommand("node -e \"process.stderr.write('failed'); process.exit(7)\"", process.cwd());

  assert.equal(result.exitCode, 7);
  assert.equal(result.stderr, "failed");
  assert.equal(result.timedOut, false);
});

test("browser workspace commands enforce a caller timeout", async () => {
  const startedAt = Date.now();
  const result = await runWorkspaceCommand("node -e \"setTimeout(() => {}, 10000)\"", process.cwd(), { timeoutMs: 25 });

  assert.equal(result.timedOut, true);
  assert.ok(Date.now() - startedAt < 2_000);
});
