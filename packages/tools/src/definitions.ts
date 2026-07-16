import type { ToolDefinition } from "@conduit/shared";

export type ToolMode = "ask" | "goal";

export interface ToolCallResult {
  success: boolean;
  result?: unknown;
  error?: string;
}

export interface ToolExecutor {
  execute(
    name: string,
    args: Record<string, unknown>,
    mode: ToolMode
  ): Promise<ToolCallResult>;
}

export interface ToolExecutorContext {
  onFileChanged?: (path: string) => void;
  onApprovalRequired?: (requestId: string, command: string) => void;
}

const ASK_TOOLS: ToolDefinition[] = [
  {
    name: "list_files",
    description: "List files and directories in the workspace",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative path within workspace (default: .)" },
        max_depth: { type: "number", description: "Maximum directory depth (default: 3)" },
      },
    },
  },
  {
    name: "search_files",
    description: "Search for text patterns in workspace files",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Text or regex pattern to search for" },
        regex: { type: "boolean", description: "Treat query as regex" },
        case_sensitive: { type: "boolean", description: "Case-sensitive search" },
        file_pattern: { type: "string", description: "Glob-like file name filter" },
      },
      required: ["query"],
    },
  },
  {
    name: "read_file",
    description: "Read the contents of a file",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative path to the file" },
        offset: { type: "number", description: "Line offset to start reading from" },
        limit: { type: "number", description: "Maximum number of lines to read" },
      },
      required: ["path"],
    },
  },
];

const GOAL_EXTRA_TOOLS: ToolDefinition[] = [
  {
    name: "write_file",
    description: "Write content to a file (creates or overwrites)",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative path to the file" },
        content: { type: "string", description: "File content to write" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "replace_in_file",
    description: "Replace a string in a file",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative path to the file" },
        search: { type: "string", description: "String to find" },
        replace: { type: "string", description: "Replacement string" },
        replace_all: { type: "boolean", description: "Replace all occurrences" },
      },
      required: ["path", "search", "replace"],
    },
  },
  {
    name: "create_file",
    description: "Create a new file (fails if file exists)",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative path for the new file" },
        content: { type: "string", description: "File content" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "delete_file",
    description: "Delete a file from the workspace",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative path to the file" },
      },
      required: ["path"],
    },
  },
  {
    name: "run_command",
    description: "Execute a shell command in the workspace directory",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to execute" },
      },
      required: ["command"],
    },
  },
  {
    name: "get_git_diff",
    description: "Get the git diff of changed files in the workspace",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Optional specific file path" },
      },
    },
  },
];

export function getToolDefinitions(mode: ToolMode): ToolDefinition[] {
  if (mode === "ask") return ASK_TOOLS;
  return [...ASK_TOOLS, ...GOAL_EXTRA_TOOLS];
}

export const WRITE_TOOLS = new Set([
  "write_file",
  "replace_in_file",
  "create_file",
  "delete_file",
]);

export const GOAL_ONLY_TOOLS = new Set([
  ...WRITE_TOOLS,
  "run_command",
  "get_git_diff",
  "capture_git_snapshot",
]);
