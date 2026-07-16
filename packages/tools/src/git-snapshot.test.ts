import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { captureGitSnapshot, getScopedGitDiff } from "./git-snapshot.js";

function git(workspace: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: workspace, encoding: "utf8" });
}

function repository(): string {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "conduit-snapshot-test-"));
  git(workspace, "init", "-q");
  git(workspace, "config", "user.email", "conduit@example.test");
  git(workspace, "config", "user.name", "Conduit Test");
  fs.writeFileSync(path.join(workspace, "shared.txt"), "initial\n");
  fs.writeFileSync(path.join(workspace, "stable.txt"), "stable\n");
  git(workspace, "add", "-A");
  git(workspace, "commit", "-qm", "initial");
  return workspace;
}

test("run snapshots exclude pre-existing dirty and untracked changes", () => {
  const workspace = repository();
  try {
    fs.writeFileSync(path.join(workspace, "shared.txt"), "change from plan A\n");
    fs.writeFileSync(path.join(workspace, "plan-a-untracked.txt"), "already accepted\n");
    const indexBefore = fs.readFileSync(path.join(workspace, ".git", "index"));
    const baseline = captureGitSnapshot(workspace);

    fs.writeFileSync(path.join(workspace, "shared.txt"), "change from plan A\nchange from plan B\n");
    fs.writeFileSync(path.join(workspace, "plan-b-new.txt"), "new goal\n");
    const result = getScopedGitDiff(workspace, baseline.tree);

    assert.deepEqual(result.changedFiles, ["plan-b-new.txt", "shared.txt"]);
    assert.match(result.diff, /change from plan B/);
    assert.doesNotMatch(result.diff, /plan-a-untracked|already accepted/);
    assert.deepEqual(fs.readFileSync(path.join(workspace, ".git", "index")), indexBefore);
    assert.equal(git(workspace, "worktree", "list", "--porcelain").match(/^worktree /gm)?.length, 1);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("each new run baseline scopes the next change without merging branches", () => {
  const workspace = repository();
  try {
    const planABaseline = captureGitSnapshot(workspace);
    fs.writeFileSync(path.join(workspace, "shared.txt"), "plan A\n");
    assert.deepEqual(getScopedGitDiff(workspace, planABaseline.tree).changedFiles, ["shared.txt"]);

    const planBBaseline = captureGitSnapshot(workspace);
    fs.writeFileSync(path.join(workspace, "shared.txt"), "plan A\nplan B\n");
    const planBChanges = getScopedGitDiff(workspace, planBBaseline.tree);

    assert.deepEqual(planBChanges.changedFiles, ["shared.txt"]);
    assert.match(planBChanges.diff, /\+plan B/);
    assert.doesNotMatch(planBChanges.diff, /\+plan A/);
    assert.equal(git(workspace, "branch", "--format=%(refname:short)").trim().split("\n").length, 1);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
