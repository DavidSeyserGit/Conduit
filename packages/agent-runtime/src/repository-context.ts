import type { RepositoryContext } from "@conduit/shared";
import { RepositoryContextSchema } from "@conduit/shared";
import type { ToolExecutor } from "@conduit/tools";

export interface RepositoryExcerpt {
  path: string;
  content: string;
  reason: string;
}

export interface PreparedRepositoryContext {
  context: RepositoryContext;
  excerpts: RepositoryExcerpt[];
}

const MANIFEST_NAMES = new Set([
  "package.json", "pnpm-workspace.yaml", "Cargo.toml", "pyproject.toml",
  "requirements.txt", "go.mod", "Gemfile", "pom.xml", "build.gradle",
  "CMakeLists.txt", "Makefile",
]);
const INSTRUCTION_NAMES = new Set(["AGENTS.md", "CONTRIBUTING.md", "README.md"]);
const STOP_WORDS = new Set([
  "add", "and", "change", "create", "from", "into", "make", "more", "please", "support", "that", "the", "this", "with",
]);

export async function prepareRepositoryContext(
  workspacePath: string,
  initialRequest: string,
  tools: ToolExecutor,
  now = () => new Date(),
): Promise<PreparedRepositoryContext> {
  const listing = await tools.execute("list_files", { path: ".", max_depth: 4 }, "ask");
  if (!listing.success || !listing.result) {
    throw new Error(`Repository inspection failed: ${listing.error ?? "could not list files"}`);
  }
  const entries = ((listing.result as { entries?: Array<{ path: string; type?: string; entry_type?: string }> }).entries ?? [])
    .filter((entry) => (entry.type ?? entry.entry_type) === "file");
  const allPaths = entries.map((entry) => entry.path).sort();
  const instructionPaths = allPaths.filter((path) => INSTRUCTION_NAMES.has(fileName(path))).slice(0, 8);
  const manifestPaths = allPaths.filter((path) => MANIFEST_NAMES.has(fileName(path))).slice(0, 10);

  const relevantPaths = new Map<string, string>();
  for (const path of manifestPaths) relevantPaths.set(path, "Repository manifest or build configuration");
  for (const path of instructionPaths) relevantPaths.set(path, "Repository instructions or project documentation");
  for (const path of allPaths.filter(isTestPath).slice(0, 6)) {
    relevantPaths.set(path, "Existing test implementation or test configuration");
  }

  const searchTerms = [...new Set(initialRequest.toLowerCase().match(/[a-z][a-z0-9_-]{3,}/g) ?? [])]
    .filter((term) => !STOP_WORDS.has(term))
    .slice(0, 4);
  for (const term of searchTerms) {
    const result = await tools.execute("search_files", { query: term, case_sensitive: false }, "ask");
    if (!result.success || !result.result) continue;
    const matches = (result.result as { matches?: Array<{ path: string }> }).matches ?? [];
    for (const match of matches.slice(0, 4)) {
      if (relevantPaths.size >= 18) break;
      relevantPaths.set(match.path, `Matches request term “${term}”`);
    }
  }

  const excerpts: RepositoryExcerpt[] = [];
  let remainingCharacters = 24_000;
  for (const [path, reason] of relevantPaths) {
    if (remainingCharacters <= 0) break;
    const result = await tools.execute("read_file", { path, offset: 0, limit: 160 }, "ask");
    if (!result.success || !result.result) continue;
    const raw = String((result.result as { content?: unknown }).content ?? "");
    const content = raw.slice(0, Math.min(remainingCharacters, 6_000));
    if (!content.trim()) continue;
    excerpts.push({ path, content, reason });
    remainingCharacters -= content.length;
  }

  const extensions = allPaths.map(extensionOf).filter(Boolean);
  const languages = inferLanguages(extensions);
  const combined = excerpts.map((excerpt) => excerpt.content).join("\n").toLowerCase();
  const frameworks = inferFrameworks(combined);
  const testFrameworks = inferTests(combined, allPaths);
  const packageManager = inferPackageManager(allPaths);
  const context = RepositoryContextSchema.parse({
    workspacePath,
    summary: buildSummary(languages, frameworks, packageManager, allPaths.length),
    languages,
    frameworks,
    packageManager,
    testFrameworks,
    instructions: excerpts
      .filter((excerpt) => instructionPaths.includes(excerpt.path))
      .map(({ path, reason }) => ({ path, reason, contentLocation: `${path}:1` })),
    relevantFiles: excerpts.map(({ path, reason }) => ({ path, reason, contentLocation: `${path}:1` })),
    preparedAt: now().toISOString(),
  });
  return { context, excerpts };
}

function fileName(path: string): string {
  return path.split(/[\\/]/).at(-1) ?? path;
}

function extensionOf(path: string): string {
  const name = fileName(path);
  const index = name.lastIndexOf(".");
  return index > 0 ? name.slice(index).toLowerCase() : "";
}

function isTestPath(path: string): boolean {
  return /(^|\/)(test|tests|spec|specs)(\/|$)|(?:^|[._-])(test|spec)\.[^/]+$/i.test(path);
}

function inferLanguages(extensions: string[]): string[] {
  const mappings: Array<[string, string[]]> = [
    ["TypeScript", [".ts", ".tsx"]], ["JavaScript", [".js", ".jsx", ".mjs", ".cjs"]],
    ["Rust", [".rs"]], ["Python", [".py"]], ["Go", [".go"]], ["Java", [".java"]],
    ["Kotlin", [".kt"]], ["Ruby", [".rb"]], ["Swift", [".swift"]], ["C/C++", [".c", ".h", ".cpp"]],
  ];
  return mappings.filter(([, values]) => values.some((value) => extensions.includes(value))).map(([name]) => name);
}

function inferFrameworks(content: string): string[] {
  const candidates: Array<[string, RegExp]> = [
    ["React", /["']react["']/], ["Tauri", /["']@tauri-apps\//], ["Next.js", /["']next["']/],
    ["Vue", /["']vue["']/], ["Svelte", /["']svelte["']/], ["Express", /["']express["']/],
    ["Django", /django/], ["Rails", /rails/], ["Axum", /\baxum\b/],
    ["ROS 2", /\b(?:ament_cmake|rclcpp|rosidl)\b/],
  ];
  return candidates.filter(([, pattern]) => pattern.test(content)).map(([name]) => name);
}

function inferTests(content: string, paths: string[]): string[] {
  const tests: string[] = [];
  if (/vitest/.test(content)) tests.push("Vitest");
  if (/jest/.test(content)) tests.push("Jest");
  if (/playwright/.test(content)) tests.push("Playwright");
  if (/pytest/.test(content)) tests.push("pytest");
  if (/\b(?:gtest|googletest|ament_add_gtest)\b/.test(content)) tests.push("GoogleTest");
  if (/\bcatch2\b/.test(content)) tests.push("Catch2");
  if (/\b(?:enable_testing|add_test)\s*\(/.test(content)) tests.push("CTest");
  if (paths.some((path) => path.endsWith(".test.ts") || path.endsWith(".test.tsx")) && tests.length === 0) tests.push("Node test runner");
  if (paths.some((path) => path.endsWith(".rs")) && /cargo/.test(content)) tests.push("Cargo test");
  return tests;
}

function inferPackageManager(paths: string[]): string | undefined {
  if (paths.some((path) => fileName(path) === "pnpm-lock.yaml")) return "pnpm";
  if (paths.some((path) => fileName(path) === "yarn.lock")) return "Yarn";
  if (paths.some((path) => fileName(path) === "package-lock.json")) return "npm";
  if (paths.some((path) => fileName(path) === "Cargo.lock")) return "Cargo";
  if (paths.some((path) => fileName(path) === "poetry.lock")) return "Poetry";
  return undefined;
}

function buildSummary(languages: string[], frameworks: string[], packageManager: string | undefined, files: number): string {
  const technology = [...languages, ...frameworks].join(", ") || "No primary technology detected";
  return `${technology}; ${packageManager ? `${packageManager} workspace; ` : ""}${files} bounded repository entries inspected.`;
}
