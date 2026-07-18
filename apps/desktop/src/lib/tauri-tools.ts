import { invoke } from "@tauri-apps/api/core";
import type { ToolExecutor, ToolMode, ToolCallResult, ToolExecutorContext, ToolExecutionOptions } from "@conduit/tools";
import { GOAL_ONLY_TOOLS, WRITE_TOOLS } from "@conduit/tools";
import type { CommandPermissionMode } from "@conduit/shared";

interface TauriToolResult {
  success: boolean;
  result?: unknown;
  error?: string;
}

export function createTauriToolExecutor(
  getWorkspacePath: () => string,
  context: ToolExecutorContext = {},
  getPermissionMode: () => CommandPermissionMode = () => "auto_approve_safe"
): ToolExecutor {
  return {
    async execute(
      name: string,
      args: Record<string, unknown>,
      mode: ToolMode,
      options?: ToolExecutionOptions,
    ): Promise<ToolCallResult> {
      if (mode === "ask" && GOAL_ONLY_TOOLS.has(name)) {
        return { success: false, error: `${name} is not available in Ask mode` };
      }

      try {
        if (!(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__) {
          const response = await fetch("/api/workspace/tool", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            signal: options?.signal,
            body: JSON.stringify({
              workspace: getWorkspacePath(),
              name,
              args,
              mode,
              permissionMode: options?.permissionMode ?? getPermissionMode(),
              timeoutMs: options?.timeoutMs,
            }),
          });
          const body = await response.text();
          if (!body) return { success: false, error: `Workspace tool returned an empty response (${response.status})` };
          let result: TauriToolResult;
          try {
            result = JSON.parse(body) as TauriToolResult;
          } catch {
            return { success: false, error: `Workspace tool returned invalid JSON (${response.status})` };
          }
          if (result.success && WRITE_TOOLS.has(name) && args.path) context.onFileChanged?.(args.path as string);
          return result;
        }
        const result = await invoke<TauriToolResult>("tool_execute", {
          workspace: getWorkspacePath(),
          name,
          args,
          mode,
          permissionMode: options?.permissionMode ?? getPermissionMode(),
          timeoutMs: options?.timeoutMs,
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
