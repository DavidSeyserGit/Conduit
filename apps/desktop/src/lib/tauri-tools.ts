import { invoke } from "@tauri-apps/api/core";
import type { ToolExecutor, ToolMode, ToolCallResult, ToolExecutorContext } from "@loopkit/tools";
import { GOAL_ONLY_TOOLS, WRITE_TOOLS } from "@loopkit/tools";

interface TauriToolResult {
  success: boolean;
  result?: unknown;
  error?: string;
}

export function createTauriToolExecutor(
  getWorkspacePath: () => string,
  context: ToolExecutorContext = {}
): ToolExecutor {
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
        const result = await invoke<TauriToolResult>("tool_execute", {
          workspace: getWorkspacePath(),
          name,
          args,
          mode,
        });

        if (result.success && WRITE_TOOLS.has(name) && args.path) {
          context.onFileChanged?.(args.path as string);
        }

        return result;
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  };
}
