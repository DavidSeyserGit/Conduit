import type { CommandPermissionMode } from "@conduit/shared";
import type { ToolExecutor, ToolMode, ToolCallResult, ToolExecutorContext } from "../definitions.js";
import { GOAL_ONLY_TOOLS } from "../definitions.js";
import {
  listFiles,
  readFile,
  writeFile,
  replaceInFile,
  createFile,
  deleteFile,
  getGitDiff,
} from "../file-tools.js";
import { searchFiles } from "../search-tools.js";
import { CommandExecutor } from "../command-tools.js";
import { captureGitSnapshot, getScopedGitDiff } from "../git-snapshot.js";

export function createNodeToolExecutor(
  workspacePath: string,
  permissionMode: CommandPermissionMode = "auto_approve_safe",
  context: ToolExecutorContext = {}
): ToolExecutor {
  const commandExecutor = new CommandExecutor(workspacePath, permissionMode);

  return {
    async execute(
      name: string,
      args: Record<string, unknown>,
      mode: ToolMode
    ): Promise<ToolCallResult> {
      if (mode === "ask" && GOAL_ONLY_TOOLS.has(name)) {
        return { success: false, error: `${name} is not available in Ask mode` };
      }

      try {
        const result = await dispatchNodeTool(
          name,
          args,
          workspacePath,
          commandExecutor,
          context
        );
        return { success: true, result };
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  };
}

async function dispatchNodeTool(
  name: string,
  args: Record<string, unknown>,
  workspacePath: string,
  commandExecutor: CommandExecutor,
  context: ToolExecutorContext
): Promise<unknown> {
  switch (name) {
    case "list_files":
      return listFiles(
        workspacePath,
        (args.path as string) ?? ".",
        (args.max_depth as number) ?? 3
      );

    case "search_files":
      return searchFiles(workspacePath, args.query as string, {
        regex: args.regex as boolean,
        caseSensitive: args.case_sensitive as boolean,
        filePattern: args.file_pattern as string,
      });

    case "read_file":
      return readFile(
        workspacePath,
        args.path as string,
        (args.offset as number) ?? 0,
        args.limit as number
      );

    case "write_file": {
      const result = writeFile(workspacePath, args.path as string, args.content as string);
      context.onFileChanged?.(args.path as string);
      return result;
    }

    case "replace_in_file": {
      const result = replaceInFile(
        workspacePath,
        args.path as string,
        args.search as string,
        args.replace as string,
        args.replace_all as boolean
      );
      context.onFileChanged?.(args.path as string);
      return result;
    }

    case "create_file": {
      const result = createFile(workspacePath, args.path as string, args.content as string);
      context.onFileChanged?.(args.path as string);
      return result;
    }

    case "delete_file":
      return deleteFile(workspacePath, args.path as string);

    case "run_command":
      return commandExecutor.runCommand(args.command as string, {
        onApprovalRequired: context.onApprovalRequired,
      });

    case "get_git_diff":
      if (args.baselineTree) {
        return getScopedGitDiff(
          workspacePath,
          args.baselineTree as string,
          args.path as string,
        );
      }
      return getGitDiff(workspacePath, args.path as string);

    case "capture_git_snapshot":
      return captureGitSnapshot(workspacePath);

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export { CommandExecutor } from "../command-tools.js";
