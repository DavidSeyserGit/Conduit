import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

async function sourceFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(target));
    else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(target);
  }
  return files;
}

test("portable packages never depend on Desktop", async () => {
  for (const root of ["packages/cgs/src", "packages/agent-runtime/src"]) {
    for (const file of await sourceFiles(root)) {
      const source = await readFile(file, "utf8");
      assert.equal(source.includes("apps/desktop"), false, `${file} imports Desktop`);
      assert.equal(source.includes("@conduit/desktop"), false, `${file} imports Desktop`);
    }
  }
});

test("CGS has no internal, provider, persistence, or UI dependency", async () => {
  const manifest = JSON.parse(await readFile("packages/cgs/package.json", "utf8"));
  assert.deepEqual(Object.keys(manifest.dependencies), ["zod"]);
  for (const file of await sourceFiles("packages/cgs/src")) {
    if (path.basename(file).startsWith("legacy") || file.endsWith(".test.ts")) continue;
    const source = await readFile(file, "utf8");
    assert.doesNotMatch(source, /@conduit\/|react|tauri|electron|sqlite|provider/i, file);
  }
});
