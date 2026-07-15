import type { StoredToolCall } from "@conduit/shared";

export interface ToolCallDisplay {
  action: "Running" | "Ran" | "Failed";
  name: string;
  detail?: string;
}

function stringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function quote(value: string): string {
  return `"${value.replaceAll('"', '\\"')}"`;
}

function truncate(value: string, max = 180): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function shellWords(command: string): string[] {
  const words: string[] = [];
  const pattern = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^']*)'|`([^`]*)`|(\S+)/g;
  for (const match of command.matchAll(pattern)) {
    words.push(match[1] ?? match[2] ?? match[3] ?? match[4]);
  }
  return words;
}

function commandContext(command: string): string | undefined {
  const words = shellWords(command);
  if (words.length === 0) return undefined;

  const executableIndex = words.findIndex((word) =>
    /^(rg|ripgrep|grep|git|ls|eza|tree|find|fd|cat|head|tail|sed|less|bat|pwd|du)$/.test(word)
  );
  if (executableIndex === -1) return `command ${quote(truncate(command))}`;

  const executable = words[executableIndex];
  const rest = words.slice(executableIndex + 1);
  const isGitGrep = executable === "git" && rest[0] === "grep";
  const commandName = isGitGrep ? "git grep" : executable;
  const commandArgs = isGitGrep ? rest.slice(1) : rest;

  if (executable === "rg" || executable === "ripgrep" || executable === "grep" || isGitGrep) {
    const values: string[] = [];
    const optionsWithValues = new Set(["-e", "--regexp", "-g", "--glob", "-t", "--type", "--iglob", "--type-not", "-f", "--file"]);
    let afterSeparator = false;
    for (let i = 0; i < commandArgs.length; i += 1) {
      const value = commandArgs[i];
      if (value === "--") {
        afterSeparator = true;
        continue;
      }
      if (!afterSeparator && value.startsWith("-")) {
        if (optionsWithValues.has(value)) i += 1;
        continue;
      }
      values.push(value);
    }
    if (values.length > 0) {
      const path = values[1];
      return `searching for ${quote(values[0])}${path ? ` in ${quote(path)}` : ""}`;
    }
    return `searching with ${commandName}`;
  }

  if (["ls", "eza", "tree", "find", "fd", "pwd", "du"].includes(executable)) {
    const path = commandArgs.find((value) => !value.startsWith("-"));
    return path ? `inspecting ${quote(path)}` : "inspecting the workspace";
  }

  if (["cat", "head", "tail", "sed", "less", "bat"].includes(executable)) {
    const path = [...commandArgs].reverse().find((value) => !value.startsWith("-"));
    return path ? `reading ${quote(path)}` : "reading a file";
  }

  if (executable === "git") {
    const separatorIndex = commandArgs.indexOf("--");
    const path = separatorIndex >= 0 ? commandArgs[separatorIndex + 1] : undefined;
    return path ? `${commandName} for ${quote(path)}` : commandName;
  }

  return `command ${quote(truncate(command))}`;
}

function structuredToolContext(name: string, args: Record<string, unknown>): string | undefined {
  const normalizedName = name.toLowerCase();
  const path = stringArg(args, "path") ?? stringArg(args, "file") ?? stringArg(args, "filePath");
  const query = stringArg(args, "query") ?? stringArg(args, "pattern") ?? stringArg(args, "search");
  const command = stringArg(args, "command") ?? stringArg(args, "cmd");

  switch (normalizedName) {
    case "list_files":
    case "list":
      return `in ${quote(path || ".")}`;
    case "search_files":
    case "grep":
      return `${query ? `for ${quote(query)}` : "for a pattern"}${path ? ` in ${quote(path)}` : ""}`;
    case "read_file":
    case "read":
      return path ? `at ${quote(path)}` : undefined;
    case "write_file":
    case "create_file":
    case "delete_file":
      return path ? `at ${quote(path)}` : undefined;
    case "replace_in_file":
      return path ? `in ${quote(path)}` : undefined;
    case "get_git_diff":
      return path ? `for ${quote(path)}` : "for the workspace";
    case "run_command": {
      return command ? commandContext(command) : undefined;
    }
    case "bash":
    case "shell":
    case "execute":
      return command ? commandContext(command) : "running a workspace command";
    default: {
      const server = stringArg(args, "server");
      const tool = stringArg(args, "tool");
      return server && tool ? `${server}/${tool}` : undefined;
    }
  }
}

function readableToolName(name: string): string {
  switch (name.toLowerCase()) {
    case "read_file":
    case "read": return "reading a file";
    case "search_files":
    case "grep": return "searching the codebase";
    case "list_files":
    case "list": return "inspecting the workspace";
    case "run_command":
    case "bash":
    case "shell":
    case "execute": return "running a workspace command";
    case "write_file": return "updating a file";
    case "create_file": return "creating a file";
    case "delete_file": return "deleting a file";
    case "replace_in_file": return "editing a file";
    case "get_git_diff": return "checking changes";
    default: return "using a workspace tool";
  }
}

export function formatToolCall(tool: StoredToolCall, completed: boolean): ToolCallDisplay {
  const action = completed
    ? tool.status === "failed" ? "Failed" : "Ran"
    : "Running";
  const detail = structuredToolContext(tool.name, tool.arguments);
  return { action, name: readableToolName(tool.name), detail };
}
