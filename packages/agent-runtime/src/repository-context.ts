import type { RepositoryContext } from "@conduit/cgs/legacy";
import { RepositoryContextSchema } from "@conduit/cgs/legacy";
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

export interface RepositoryPreparationOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  onProgress?: (message: string) => void;
}

const DEFAULT_INSPECTION_TIMEOUT_MS = 20_000;
const TOOL_TIMEOUT_MS = 10_000;
const MAX_RELEVANT_FILES = 12;
const MAX_CONTEXT_CHARACTERS = 12_000;

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
  options: RepositoryPreparationOptions = {},
): Promise<PreparedRepositoryContext> {
  const inspection = inspectionTools(tools, options);
  options.onProgress?.("Listing repository files…");
  const listing = await inspection.execute("list_files", { path: ".", max_depth: 3 });
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
  if (searchTerms.length > 0) {
    options.onProgress?.("Locating relevant code…");
    const query = searchTerms.map(escapeRegex).join("|");
    const result = await inspection.execute("search_files", { query, regex: true, case_sensitive: false });
    if (result.success && result.result) {
      const matches = (result.result as { matches?: Array<{ path: string }> }).matches ?? [];
      for (const match of matches) {
        if (relevantPaths.size >= MAX_RELEVANT_FILES) break;
        relevantPaths.set(match.path, "Matches terminology from the request");
      }
    }
  }

  options.onProgress?.("Reading relevant project files…");
  const reads = await Promise.all([...relevantPaths].slice(0, MAX_RELEVANT_FILES).map(async ([path, reason]) => {
    const result = await inspection.execute("read_file", { path, offset: 0, limit: 120 });
    if (!result.success || !result.result) return null;
    return { path, reason, raw: String((result.result as { content?: unknown }).content ?? "") };
  }));
  const excerpts: RepositoryExcerpt[] = [];
  let remainingCharacters = MAX_CONTEXT_CHARACTERS;
  for (const read of reads) {
    if (!read || remainingCharacters <= 0) continue;
    const { path, reason, raw } = read;
    const content = raw.slice(0, Math.min(remainingCharacters, 3_000));
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

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function inspectionTools(tools: ToolExecutor, options: RepositoryPreparationOptions) {
  const timeoutSignal = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_INSPECTION_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
  return {
    async execute(name: string, args: Record<string, unknown>) {
      try {
        signal.throwIfAborted();
        return await abortable(tools.execute(name, args, "ask", { signal, timeoutMs: TOOL_TIMEOUT_MS }), signal);
      } catch (error) {
        if (options.signal?.aborted) throw new Error("Repository inspection cancelled");
        if (timeoutSignal.aborted) throw new Error(`Repository inspection took longer than ${Math.max(1, Math.round((options.timeoutMs ?? DEFAULT_INSPECTION_TIMEOUT_MS) / 1_000))} seconds and was stopped`);
        throw error;
      }
    },
  };
}

async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw signal.reason;
  return await new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
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
