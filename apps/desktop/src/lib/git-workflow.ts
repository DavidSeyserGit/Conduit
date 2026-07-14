import { invoke } from "@tauri-apps/api/core";

export interface WorktreeResult {
  path: string;
  branch: string;
}

interface ToolResponse {
  success: boolean;
  result?: WorktreeResult | { removed: boolean };
  error?: string;
}

const inTauri = () => Boolean((window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);

export async function createChatWorktree(repository: string, branch: string, sessionId: string): Promise<WorktreeResult> {
  if (inTauri()) {
    const response = await invoke<ToolResponse>("git_worktree_create", { repository, branch, sessionId });
    if (!response.success || !response.result || !("path" in response.result)) throw new Error(response.error || "Could not create Git worktree");
    return response.result;
  }
  const response = await fetch("/api/workspace/git-worktree", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "create", repository, branch, sessionId }),
  });
  const payload = await response.json() as ToolResponse;
  if (!response.ok || !payload.success || !payload.result || !("path" in payload.result)) throw new Error(payload.error || "Could not create Git worktree");
  return payload.result;
}

export async function removeChatWorktree(repository: string, worktree: string): Promise<void> {
  if (inTauri()) {
    const response = await invoke<ToolResponse>("git_worktree_remove", { repository, worktree });
    if (!response.success) throw new Error(response.error || "Could not remove Git worktree");
    return;
  }
  const response = await fetch("/api/workspace/git-worktree", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "remove", repository, worktree }),
  });
  const payload = await response.json() as ToolResponse;
  if (!response.ok || !payload.success) throw new Error(payload.error || "Could not remove Git worktree");
}
