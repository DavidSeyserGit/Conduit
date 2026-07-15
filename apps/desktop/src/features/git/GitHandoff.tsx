import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

type HandoffStatus = {
  branch: string;
  changed: boolean;
  githubRepo?: string;
  base: string;
};

type ToolResponse<T> = { success: boolean; result?: T; error?: string };

const inTauri = () => Boolean((window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);

export function GitHandoff({ workspacePath, goal }: { workspacePath: string; goal: string }) {
  const [status, setStatus] = useState<HandoffStatus | null>(null);
  const [message, setMessage] = useState(`Goal: ${goal.replace(/\s+/g, " ").slice(0, 72)}`);
  const [busy, setBusy] = useState<"commit" | "push" | null>(null);
  const [prUrl, setPrUrl] = useState<string | null>(null);
  const [error, setError] = useState("");

  const refresh = async () => {
    if (!inTauri()) return;
    const response = await invoke<ToolResponse<HandoffStatus>>("git_handoff_status", { workspace: workspacePath });
    if (!response.success || !response.result) throw new Error(response.error || "Could not read Git status");
    setStatus(response.result);
  };

  useEffect(() => { void refresh().catch((reason) => setError(reason instanceof Error ? reason.message : String(reason))); }, [workspacePath]);

  if (!inTauri()) return null;

  const commit = async () => {
    setBusy("commit"); setError("");
    try {
      const response = await invoke<ToolResponse<{ committed: boolean }>>("git_commit_changes", { workspace: workspacePath, message });
      if (!response.success) throw new Error(response.error || "Could not commit changes");
      await refresh();
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } finally { setBusy(null); }
  };

  const push = async () => {
    setBusy("push"); setError("");
    try {
      const response = await invoke<ToolResponse<{ pullRequestUrl?: string }>>("git_push_branch", { workspace: workspacePath });
      if (!response.success || !response.result) throw new Error(response.error || "Could not push branch");
      setPrUrl(response.result.pullRequestUrl || null);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } finally { setBusy(null); }
  };

  return (
    <section className="mt-4 rounded-xl border border-gray-200 bg-white p-4">
      <div className="flex items-center justify-between gap-3"><div><div className="text-sm font-semibold text-gray-900">Ship this work</div><p className="mt-0.5 text-xs text-gray-500">Commit this branch, push it directly to GitHub, then create a pull request.</p></div>{status && <span className="shrink-0 rounded-md bg-gray-100 px-2 py-1 text-[10px] text-gray-500">{status.branch}</span>}</div>
      {status?.changed && <div className="mt-3 flex gap-2"><input value={message} onChange={(event) => setMessage(event.target.value)} className="min-w-0 flex-1 rounded-lg border border-gray-200 px-3 py-2 text-xs outline-none focus:border-indigo-400" aria-label="Commit message" /><button onClick={() => void commit()} disabled={busy !== null || !message.trim()} className="rounded-lg bg-gray-900 px-3 py-2 text-xs font-medium text-white disabled:bg-gray-300">{busy === "commit" ? "Committing…" : "Commit"}</button></div>}
      {status && !status.changed && <div className="mt-3 flex items-center justify-between gap-3"><span className="text-xs text-emerald-700">Changes committed locally</span><button onClick={() => void push()} disabled={busy !== null} className="rounded-lg bg-gray-900 px-3 py-2 text-xs font-medium text-white disabled:bg-gray-300">{busy === "push" ? "Pushing…" : "Push branch"}</button></div>}
      {prUrl && <div className="mt-3 flex items-center justify-between gap-3 rounded-lg bg-indigo-50 px-3 py-2"><span className="text-xs text-indigo-800">Branch pushed. GitHub can now create the PR.</span><button onClick={() => window.open(prUrl, "_blank", "noopener,noreferrer")} className="shrink-0 text-xs font-semibold text-indigo-700 hover:text-indigo-900">Open PR form</button></div>}
      {error && <p className="mt-3 text-xs text-red-600">{error}</p>}
    </section>
  );
}
