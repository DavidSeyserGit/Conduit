import { readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";

const roots = ["apps", "packages", "scripts"];
const ignoredDirectories = new Set(["dist", "node_modules", "target", "workspaces"]);

async function collectTests(directory) {
  const tests = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) tests.push(...await collectTests(entryPath));
    else if (entry.isFile() && entry.name.endsWith(".test.ts")) tests.push(entryPath);
  }
  return tests;
}

const tests = (await Promise.all(roots.map(collectTests))).flat().sort();
if (tests.length === 0) {
  throw new Error("No test files found");
}

const child = spawn(
  process.execPath,
  ["--import", "tsx", "--test", "--test-concurrency=1", ...tests],
  { cwd: process.cwd(), env: process.env, stdio: "inherit" },
);
child.once("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});
child.once("close", (code) => {
  process.exitCode = code ?? 1;
});
