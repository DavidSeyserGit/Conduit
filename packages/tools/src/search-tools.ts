import * as fs from "node:fs";
import * as path from "node:path";
import { assertWorkspaceExists } from "./safety.js";

export interface SearchMatch {
  path: string;
  line: number;
  column: number;
  text: string;
  context?: string;
}

export interface SearchFilesResult {
  query: string;
  matches: SearchMatch[];
  totalMatches: number;
  truncated: boolean;
}

const MAX_MATCHES = 100;
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

const SEARCHABLE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".rs", ".go", ".java", ".kt",
  ".json", ".yaml", ".yml", ".toml",
  ".md", ".txt", ".html", ".css", ".scss",
  ".sql", ".sh", ".bash", ".zsh",
  ".xml", ".svg", ".graphql",
  ".rb", ".php", ".swift", ".c", ".cpp", ".h",
]);

export function searchFiles(
  workspacePath: string,
  query: string,
  options: {
    caseSensitive?: boolean;
    regex?: boolean;
    filePattern?: string;
    maxResults?: number;
  } = {}
): SearchFilesResult {
  assertWorkspaceExists(workspacePath);
  const maxResults = options.maxResults ?? MAX_MATCHES;
  const matches: SearchMatch[] = [];

  const searchPattern = options.regex
    ? new RegExp(query, options.caseSensitive ? "" : "i")
    : null;

  walkAndSearch(
    workspacePath,
    workspacePath,
    query,
    searchPattern,
    options,
    matches,
    maxResults
  );

  return {
    query,
    matches,
    totalMatches: matches.length,
    truncated: matches.length >= maxResults,
  };
}

function walkAndSearch(
  workspacePath: string,
  currentDir: string,
  query: string,
  searchPattern: RegExp | null,
  options: { caseSensitive?: boolean; regex?: boolean; filePattern?: string },
  matches: SearchMatch[],
  maxResults: number
): void {
  if (matches.length >= maxResults) return;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(currentDir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (matches.length >= maxResults) return;
    if (entry.name.startsWith(".")) continue;
    if (IGNORED_DIRS.has(entry.name)) continue;

    const fullPath = path.join(currentDir, entry.name);

    if (entry.isDirectory()) {
      walkAndSearch(
        workspacePath,
        fullPath,
        query,
        searchPattern,
        options,
        matches,
        maxResults
      );
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name);
      if (!SEARCHABLE_EXTENSIONS.has(ext)) continue;

      if (options.filePattern) {
        const pattern = new RegExp(
          options.filePattern.replace(/\*/g, ".*"),
          "i"
        );
        if (!pattern.test(entry.name)) continue;
      }

      searchInFile(workspacePath, fullPath, query, searchPattern, options, matches, maxResults);
    }
  }
}

function searchInFile(
  workspacePath: string,
  filePath: string,
  query: string,
  searchPattern: RegExp | null,
  options: { caseSensitive?: boolean },
  matches: SearchMatch[],
  maxResults: number
): void {
  if (matches.length >= maxResults) return;

  let content: string;
  try {
    const stats = fs.statSync(filePath);
    if (stats.size > 1024 * 1024) return; // skip files > 1MB
    content = fs.readFileSync(filePath, "utf-8");
  } catch {
    return;
  }

  const relativePath = path.relative(workspacePath, filePath);
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    if (matches.length >= maxResults) return;

    const line = lines[i];
    let found = false;
    let column = 0;

    if (searchPattern) {
      const match = searchPattern.exec(line);
      if (match) {
        found = true;
        column = match.index;
      }
    } else {
      const searchIn = options.caseSensitive ? line : line.toLowerCase();
      const searchFor = options.caseSensitive ? query : query.toLowerCase();
      const idx = searchIn.indexOf(searchFor);
      if (idx !== -1) {
        found = true;
        column = idx;
      }
    }

    if (found) {
      matches.push({
        path: relativePath,
        line: i + 1,
        column,
        text: line.trim(),
        context: lines
          .slice(Math.max(0, i - 1), Math.min(lines.length, i + 2))
          .join("\n"),
      });
    }
  }
}
