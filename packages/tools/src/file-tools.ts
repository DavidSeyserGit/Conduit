import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { ToolError } from "@loopkit/shared";
import {
  assertWorkspaceExists,
  isSafeSymlink,
  normalizeWorkspacePath,
} from "./safety.js";

export interface ListFilesResult {
  path: string;
  entries: FileEntry[];
}

export interface FileEntry {
  name: string;
  path: string;
  type: "file" | "directory";
  size?: number;
}

export interface ReadFileResult {
  path: string;
  content: string;
  size: number;
  truncated: boolean;
}

export interface WriteFileResult {
  path: string;
  bytesWritten: number;
  created: boolean;
}

export interface DeleteFileResult {
  path: string;
  deleted: boolean;
}

const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "target",
  "build",
  ".next",
  ".turbo",
  "__pycache__",
  ".venv",
  "venv",
]);

export function listFiles(
  workspacePath: string,
  relativePath = ".",
  maxDepth = 3
): ListFilesResult {
  assertWorkspaceExists(workspacePath);
  const absolutePath = normalizeWorkspacePath(workspacePath, relativePath);

  if (!fs.existsSync(absolutePath)) {
    throw new ToolError(`Path does not exist: ${relativePath}`);
  }

  const entries: FileEntry[] = [];
  collectEntries(workspacePath, absolutePath, relativePath, entries, 0, maxDepth);

  return { path: relativePath, entries };
}

function collectEntries(
  workspacePath: string,
  absolutePath: string,
  relativePath: string,
  entries: FileEntry[],
  depth: number,
  maxDepth: number
): void {
  if (depth > maxDepth) return;

  let dirEntries: fs.Dirent[];
  try {
    dirEntries = fs.readdirSync(absolutePath, { withFileTypes: true });
  } catch (err) {
    throw new ToolError(
      `Cannot read directory ${relativePath}: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  for (const entry of dirEntries) {
    if (entry.name.startsWith(".") && entry.name !== ".env.example") continue;
    if (IGNORED_DIRS.has(entry.name)) continue;

    const entryRelative = path.join(relativePath, entry.name);
    const entryAbsolute = path.join(absolutePath, entry.name);

    if (!isSafeSymlink(workspacePath, entryAbsolute)) continue;

    if (entry.isDirectory()) {
      entries.push({
        name: entry.name,
        path: entryRelative,
        type: "directory",
      });
      collectEntries(
        workspacePath,
        entryAbsolute,
        entryRelative,
        entries,
        depth + 1,
        maxDepth
      );
    } else if (entry.isFile()) {
      let size: number | undefined;
      try {
        size = fs.statSync(entryAbsolute).size;
      } catch {
        // skip
      }
      entries.push({
        name: entry.name,
        path: entryRelative,
        type: "file",
        size,
      });
    }
  }
}

export function readFile(
  workspacePath: string,
  relativePath: string,
  offset = 0,
  limit?: number
): ReadFileResult {
  assertWorkspaceExists(workspacePath);
  const absolutePath = normalizeWorkspacePath(workspacePath, relativePath);

  if (!fs.existsSync(absolutePath)) {
    throw new ToolError(`File does not exist: ${relativePath}`);
  }

  if (!isSafeSymlink(workspacePath, absolutePath)) {
    throw new ToolError(`Unsafe symlink detected: ${relativePath}`);
  }

  const stats = fs.statSync(absolutePath);
  if (!stats.isFile()) {
    throw new ToolError(`Not a file: ${relativePath}`);
  }

  const content = fs.readFileSync(absolutePath, "utf-8");
  const lines = content.split("\n");
  const effectiveLimit = limit ?? lines.length;
  const selectedLines = lines.slice(offset, offset + effectiveLimit);
  const truncated = offset > 0 || selectedLines.length < lines.length;

  return {
    path: relativePath,
    content: selectedLines.join("\n"),
    size: stats.size,
    truncated,
  };
}

export function writeFile(
  workspacePath: string,
  relativePath: string,
  content: string
): WriteFileResult {
  assertWorkspaceExists(workspacePath);
  const absolutePath = normalizeWorkspacePath(workspacePath, relativePath);
  const created = !fs.existsSync(absolutePath);

  const dir = path.dirname(absolutePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(absolutePath, content, "utf-8");

  return {
    path: relativePath,
    bytesWritten: Buffer.byteLength(content, "utf-8"),
    created,
  };
}

export function replaceInFile(
  workspacePath: string,
  relativePath: string,
  search: string,
  replace: string,
  replaceAll = false
): WriteFileResult {
  const { content } = readFile(workspacePath, relativePath);

  if (!content.includes(search)) {
    throw new ToolError(`Search string not found in ${relativePath}`);
  }

  const newContent = replaceAll
    ? content.split(search).join(replace)
    : content.replace(search, replace);

  return writeFile(workspacePath, relativePath, newContent);
}

export function createFile(
  workspacePath: string,
  relativePath: string,
  content: string
): WriteFileResult {
  assertWorkspaceExists(workspacePath);
  const absolutePath = normalizeWorkspacePath(workspacePath, relativePath);

  if (fs.existsSync(absolutePath)) {
    throw new ToolError(`File already exists: ${relativePath}`);
  }

  return writeFile(workspacePath, relativePath, content);
}

export function deleteFile(
  workspacePath: string,
  relativePath: string
): DeleteFileResult {
  assertWorkspaceExists(workspacePath);
  const absolutePath = normalizeWorkspacePath(workspacePath, relativePath);

  if (!fs.existsSync(absolutePath)) {
    throw new ToolError(`File does not exist: ${relativePath}`);
  }

  if (!isSafeSymlink(workspacePath, absolutePath)) {
    throw new ToolError(`Unsafe symlink detected: ${relativePath}`);
  }

  fs.unlinkSync(absolutePath);

  return { path: relativePath, deleted: true };
}

export function getGitDiff(
  workspacePath: string,
  relativePath?: string
): { diff: string; hasChanges: boolean } {
  assertWorkspaceExists(workspacePath);

  try {
    const args = relativePath
      ? ["diff", "--", relativePath]
      : ["diff"];
    const diff = execSync(`git ${args.join(" ")}`, {
      cwd: workspacePath,
      encoding: "utf-8",
      maxBuffer: 2 * 1024 * 1024,
    });
    return { diff, hasChanges: diff.length > 0 };
  } catch (err: unknown) {
    const execErr = err as { stdout?: string; status?: number };
    if (execErr.status === 1 && execErr.stdout) {
      return { diff: execErr.stdout, hasChanges: true };
    }
    return { diff: "", hasChanges: false };
  }
}
