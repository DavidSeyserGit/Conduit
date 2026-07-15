import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Project } from "@/stores/app-store";
import { PopoverScope, usePopover } from "@/lib/popover";

export interface GitHubIssue {
  number: number;
  title: string;
  body?: string | null;
  html_url: string;
  user?: { login: string };
  labels?: Array<{ name: string; color: string }>;
  updated_at: string;
}

type Props = {
  project: Project;
  onClose: () => void;
  onUseAsGoal: (issue: GitHubIssue) => void;
};

const inTauri = () => Boolean((window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);

export function GitHubIssues({ project, onClose, onUseAsGoal }: Props) {
  const [issues, setIssues] = useState<GitHubIssue[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const popover = usePopover({ open: true, onClose });

  useEffect(() => {
    let active = true;
    const load = async () => {
      if (!project.remote) {
        setError("This project is not linked to a GitHub repository.");
        setLoading(false);
        return;
      }
      try {
        let response: Response;
        if (inTauri()) {
          const auth = await invoke<{ result?: { token?: string | null }; error?: string }>("github_get_token");
          const token = auth.result?.token;
          if (!token) throw new Error(auth.error || "Connect GitHub before loading issues.");
          response = await fetch(`https://api.github.com/repos/${project.remote}/issues?state=open&sort=updated&per_page=50`, {
            headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
          });
        } else {
          const token = localStorage.getItem("loopkit-github-token");
          response = token
            ? await fetch(`https://api.github.com/repos/${project.remote}/issues?state=open&sort=updated&per_page=50`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" } })
            : await fetch(`/api/github/issues?repo=${encodeURIComponent(project.remote)}`);
        }
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || `GitHub returned ${response.status}`);
        if (active) setIssues(payload as GitHubIssue[]);
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (active) setLoading(false);
      }
    };
    void load();
    return () => { active = false; };
  }, [project.remote]);

  return (
    <PopoverScope popover={popover}>
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/20">
      <div ref={popover.setBoundary} className="w-[520px] max-h-[80vh] bg-white rounded-xl shadow-xl border border-gray-200 p-4 flex flex-col">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h2 className="font-semibold text-gray-900">GitHub issues</h2>
            <p className="text-xs text-gray-500 mt-0.5">{project.remote}</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700 text-xl" aria-label="Close issues">×</button>
        </div>
        <div className="overflow-y-auto min-h-0 border border-gray-100 rounded-lg">
          {loading && <div className="p-4 text-sm text-gray-500">Loading open issues…</div>}
          {!loading && error && <div className="p-4 text-sm text-red-600">{error}</div>}
          {!loading && !error && !issues.length && <div className="p-4 text-sm text-gray-500">No open issues found.</div>}
          {!loading && !error && issues.map((issue) => (
            <div key={issue.number} className="p-3 border-b border-gray-100 last:border-0 hover:bg-gray-50">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm font-medium text-gray-900">#{issue.number} {issue.title}</div>
                  <div className="text-xs text-gray-500 mt-1">Updated {new Date(issue.updated_at).toLocaleDateString()} {issue.user?.login ? `by ${issue.user.login}` : ""}</div>
                  {issue.labels?.length ? <div className="flex gap-1 mt-2 flex-wrap">{issue.labels.map((label) => <span key={label.name} className="px-1.5 py-0.5 rounded text-[10px] bg-gray-100 text-gray-600">{label.name}</span>)}</div> : null}
                </div>
                <button onClick={() => onUseAsGoal(issue)} className="shrink-0 px-2.5 py-1.5 text-xs bg-gray-900 hover:bg-gray-700 text-white rounded-md font-medium">Use as goal</button>
              </div>
            </div>
          ))}
        </div>
        <div className="flex justify-end mt-4"><button onClick={onClose} className="px-3 py-1.5 text-sm text-gray-600">Close</button></div>
      </div>
    </div>
    </PopoverScope>
  );
}
