import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import type { RepositoryChange } from "@conduit/cgs/legacy";
import { ToolError } from "@conduit/shared";
import { assertWorkspaceExists } from "./safety.js";

export interface GitSnapshotResult {
  tree: string;
}

export interface GitDiffResult {
  diff: string;
  hasChanges: boolean;
  changedFiles: string[];
  changes: RepositoryChange[];
}

function runGit(workspacePath: string, args: string[], env?: NodeJS.ProcessEnv): string {
  try {
    return execFileSync("git", args, {
      cwd: workspacePath,
      env: env ? { ...process.env, ...env } : process.env,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error: unknown) {
    const result = error as { stderr?: string | Buffer; message?: string };
    const stderr = typeof result.stderr === "string"
      ? result.stderr
      : result.stderr?.toString("utf8");
    throw new ToolError(stderr?.trim() || result.message || "Git command failed");
  }
}

export function captureGitSnapshot(workspacePath: string): GitSnapshotResult {
  assertWorkspaceExists(workspacePath);
  runGit(workspacePath, ["rev-parse", "--git-dir"]);

  const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "conduit-git-index-"));
  const indexPath = path.join(tempDirectory, "index");
  const env = { GIT_INDEX_FILE: indexPath };

  try {
    try {
      runGit(workspacePath, ["read-tree", "HEAD"], env);
    } catch {
      runGit(workspacePath, ["read-tree", "--empty"], env);
    }
    runGit(workspacePath, ["add", "-A", "--", "."], env);
    const tree = runGit(workspacePath, ["write-tree"], env).trim();
    if (!/^[0-9a-f]{40,64}$/.test(tree)) {
      throw new ToolError("Git returned an invalid workspace snapshot");
    }
    return { tree };
  } finally {
    fs.rmSync(tempDirectory, { recursive: true, force: true });
  }
}

export function getScopedGitDiff(
  workspacePath: string,
  baselineTree: string,
  relativePath?: string,
): GitDiffResult {
  if (!/^[0-9a-f]{40,64}$/.test(baselineTree)) {
    throw new ToolError("Invalid Git baseline snapshot");
  }
  runGit(workspacePath, ["cat-file", "-e", `${baselineTree}^{tree}`]);
  const currentTree = captureGitSnapshot(workspacePath).tree;
  const pathArgs = relativePath ? ["--", relativePath] : [];
  const diff = runGit(workspacePath, [
    "diff",
    "--no-ext-diff",
    "--no-color",
    baselineTree,
    currentTree,
    ...pathArgs,
  ]);
  const names = runGit(workspacePath, [
    "diff",
    "--name-only",
    "-z",
    baselineTree,
    currentTree,
    ...pathArgs,
  ]);
  const statuses = runGit(workspacePath, [
    "diff",
    "--name-status",
    "-z",
    baselineTree,
    currentTree,
    ...pathArgs,
  ]);
  return {
    diff,
    hasChanges: diff.length > 0,
    changedFiles: names.split("\0").filter(Boolean),
    changes: parseNameStatus(statuses),
  };
}

function parseNameStatus(value: string): RepositoryChange[] {
  const fields = value.split("\0").filter(Boolean);
  const changes: RepositoryChange[] = [];
  for (let index = 0; index < fields.length;) {
    const code = fields[index++] ?? "M";
    if (code.startsWith("R") || code.startsWith("C")) {
      const previousPath = fields[index++];
      const path = fields[index++];
      if (path && previousPath) changes.push({ path, previousPath, status: "renamed" });
      continue;
    }
    const path = fields[index++];
    if (!path) continue;
    changes.push({ path, status: code.startsWith("A") ? "added" : code.startsWith("D") ? "deleted" : "modified" });
  }
  return changes;
}
