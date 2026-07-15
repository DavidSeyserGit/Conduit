import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore, type Project } from "@/stores/app-store";
import { GitHubIssues, type GitHubIssue } from "@/features/github/GitHubIssues";
import { PopoverScope, usePopover } from "@/lib/popover";

type GitHubRepo = { full_name: string; clone_url: string; description?: string; private: boolean };
type GitHubTokenResponse = { success: boolean; result?: { token?: string | null }; error?: string };
const inTauri = () => Boolean((window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
const defaultGitHubClientId = "Ov23liMo1oJoAzSI7573";

function nextGitHubPage(link: string | null): string | null {
  return link?.match(/<([^>]+)>;\s*rel="next"/)?.[1] ?? null;
}

async function fetchAllGitHubRepos(accessToken: string): Promise<GitHubRepo[]> {
  const repos: GitHubRepo[] = [];
  let url: string | null = "https://api.github.com/user/repos?affiliation=owner,collaborator,organization_member&per_page=100";

  while (url) {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/vnd.github+json" },
    });
    if (!response.ok) throw new Error(`GitHub returned ${response.status}`);

    const page = await response.json() as GitHubRepo[];
    if (!Array.isArray(page)) throw new Error("GitHub returned an invalid repository list");
    repos.push(...page);
    url = nextGitHubPage(response.headers.get("link"));
  }

  return repos;
}

export function LeftSidebar() {
  const setShowSettings = useAppStore((s) => s.setShowSettings);
  const projects = useAppStore((s) => s.projects);
  const workspacePath = useAppStore((s) => s.workspacePath);
  const activeProjectPath = useAppStore((s) => s.activeProjectPath);
  const setWorkspacePath = useAppStore((s) => s.setWorkspacePath);
  const addProject = useAppStore((s) => s.addProject);
  const sessions = useAppStore((s) => s.sessions);
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const openSession = useAppStore((s) => s.openSession);
  const newChat = useAppStore((s) => s.newChat);
  const deleteChat = useAppStore((s) => s.deleteChat);
  const setMode = useAppStore((s) => s.setMode);
  const setGoalDraft = useAppStore((s) => s.setGoalDraft);
  const runHistory = useAppStore((s) => s.runHistory);
  const openRun = useAppStore((s) => s.openRun);
  const resumeRun = useAppStore((s) => s.resumeRun);
  const [showAdd, setShowAdd] = useState(false);
  const [issuesProject, setIssuesProject] = useState<Project | null>(null);
  const [collapsed, setCollapsed] = useState(false);

  const useIssueAsGoal = (issue: GitHubIssue) => {
    setMode("goal");
    setWorkspacePath(issuesProject?.path || workspacePath);
    setGoalDraft([
      `Implement GitHub issue #${issue.number}: ${issue.title}`,
      issue.body?.trim() || "No issue description was provided.",
      `GitHub issue: ${issue.html_url}`,
    ].join("\n\n"));
    setIssuesProject(null);
  };

  return (
    <aside className={`h-full flex flex-col bg-white border-r border-gray-100 shrink-0 transition-[width] duration-300 ease-out overflow-hidden ${collapsed ? "w-[64px]" : "w-[200px]"}`}>
      <div className={`relative flex items-center h-[52px] shrink-0 ${collapsed ? "px-2.5" : "px-4"}`}>
        <div className="w-7 h-7 bg-gray-950 rounded-full flex items-center justify-center text-white font-semibold text-sm shrink-0">
          L
        </div>
        <span className={`ml-2 font-semibold text-gray-900 whitespace-nowrap transition-[opacity,transform] duration-200 ${collapsed ? "opacity-0 -translate-x-2 pointer-events-none" : "opacity-100 translate-x-0"}`}>Conduit</span>
        <button
          onClick={() => setCollapsed((value) => !value)}
          className={`absolute top-1/2 -translate-y-1/2 z-10 text-gray-400 bg-white hover:text-gray-900 hover:bg-gray-100 rounded-md transition-colors focus:outline-none focus:ring-2 focus:ring-indigo-300 ${collapsed ? "right-0.5 p-0.5" : "right-2 p-1"}`}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d={collapsed ? "m9 18 6-6-6-6" : "m15 18-6-6 6-6"} /></svg>
        </button>
      </div>

      <nav className="flex-1 px-2 py-1 space-y-0.5 overflow-y-auto">
        <div className={`flex items-center justify-between px-3 pt-5 pb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-400 ${collapsed ? "hidden" : ""}`}>
          <span>Projects</span>
          <button onClick={() => setShowAdd(true)} className="p-1 rounded hover:bg-gray-100 text-gray-500" title="Add GitHub repository" aria-label="Add GitHub repository">+</button>
        </div>
        {projects.map((project) => (
          <div key={project.path} className={collapsed ? "hidden" : ""}>
            <div className={`group w-full flex items-center gap-1 rounded-lg text-sm ${activeProjectPath === project.path ? "bg-gray-100" : "hover:bg-gray-50"}`}>
            <button onClick={() => setWorkspacePath(project.path)} className="min-w-0 flex-1 flex items-center gap-2 px-3 py-1.5 text-left truncate text-gray-600" title={project.path}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="text-gray-400 shrink-0"><path d="M3 6a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v9a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V6Z" /></svg>
              <span className="truncate">{project.name}</span>
            </button>
            <button onClick={() => { setWorkspacePath(project.path); newChat(); }} className="mr-1 p-1 text-gray-400 hover:text-gray-900 rounded" title={`New chat in ${project.name}`} aria-label={`New chat in ${project.name}`}>
              <span className="text-base leading-none">+</span>
            </button>
            {project.remote && <button onClick={() => setIssuesProject(project)} className="mr-1 p-1 text-gray-400 hover:text-gray-900 rounded" title="View GitHub issues" aria-label={`View issues for ${project.name}`}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M9 12h6M9 16h4M7 3h10a2 2 0 0 1 2 2v14l-4-3-4 3-4-3-4 3V5a2 2 0 0 1 2-2h2Z" /></svg>
            </button>}
            </div>
            {activeProjectPath === project.path && sessions[project.path]?.map((session) => (
              <div key={session.id} className={`group/session w-full flex items-center gap-1 pl-8 pr-1 py-1 text-xs ${activeSessionId === session.id ? "text-gray-900 font-medium" : "text-gray-500"}`}>
                <button onClick={() => openSession(project.path, session.id)} className="min-w-0 flex-1 flex items-center gap-2 text-left truncate hover:text-gray-800" title={session.title}>
                  <span className="text-gray-300">›</span><span className="truncate">{session.title}</span>
                </button>
                <button
                  onClick={() => {
                    if (window.confirm(`Delete chat "${session.title}"?`)) deleteChat(project.path, session.id);
                  }}
                  className="p-1 text-gray-300 hover:text-red-600 opacity-0 group-hover/session:opacity-100 rounded"
                  title="Delete chat"
                  aria-label={`Delete chat ${session.title}`}
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" /></svg>
                </button>
              </div>
            ))}
          </div>
        ))}
        {runHistory.length > 0 && <>
          <div className={`flex items-center justify-between px-3 pt-5 pb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-400 ${collapsed ? "hidden" : ""}`}><span>Run history</span><span>{runHistory.length}</span></div>
          {runHistory.slice(0, 8).map((entry) => {
            const resumable = entry.run.status !== "completed";
            return <div key={entry.run.id} className={`group px-2 py-1 ${collapsed ? "hidden" : ""}`}>
              <button onClick={() => openRun(entry.run.id)} className="w-full text-left truncate text-xs text-gray-600 hover:text-gray-900" title={entry.run.goal}>{entry.run.goal}</button>
              <div className="flex items-center justify-between gap-2 mt-0.5 pl-1">
                <span className={`text-[10px] ${entry.run.status === "completed" ? "text-emerald-600" : "text-gray-400"}`}>{entry.run.status.replaceAll("_", " ")}</span>
                {resumable && <button onClick={() => void resumeRun(entry.run.id)} className="text-[10px] text-indigo-600 hover:text-indigo-800">Resume</button>}
              </div>
            </div>;
          })}
        </>}
      </nav>

      <div className={`p-2 border-t border-gray-100 ${collapsed ? "flex justify-center" : ""}`}>
        <button
          onClick={() => setShowSettings(true)}
          className={`w-full flex items-center rounded-lg text-sm text-gray-600 hover:bg-gray-50 hover:text-gray-900 transition-colors ${collapsed ? "justify-center px-0" : "gap-2.5 px-3"}`}
          title={collapsed ? "Settings" : undefined}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="3"/>
            <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z"/>
          </svg>
          {!collapsed && <span>Settings</span>}
        </button>
      </div>
      {showAdd && <AddProject onClose={() => setShowAdd(false)} onAdded={addProject} />}
      {issuesProject && <GitHubIssues project={issuesProject} onClose={() => setIssuesProject(null)} onUseAsGoal={useIssueAsGoal} />}
    </aside>
  );
}

function AddProject({ onClose, onAdded }: { onClose: () => void; onAdded: (project: Project) => void }) {
  const [repos, setRepos] = useState<GitHubRepo[]>([]);
  const [selected, setSelected] = useState<GitHubRepo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [token, setToken] = useState("");
  const [authorizing, setAuthorizing] = useState(false);
  const [verification, setVerification] = useState<{ url: string; code: string } | null>(null);
  const [search, setSearch] = useState("");
  const popover = usePopover({ open: true, onClose });

  useEffect(() => {
    if (!inTauri()) {
      const savedToken = localStorage.getItem("loopkit-github-token");
      if (savedToken) {
        loadRepos(savedToken).catch(() => { localStorage.removeItem("loopkit-github-token"); setLoading(false); });
      } else {
        loadBrowserRepos().catch(() => setLoading(false));
      }
      return;
    }
    invoke<GitHubTokenResponse>("github_get_token").then((response) => {
      const token = response.result?.token;
      if (token) return loadRepos(token);
      if (!response.success) throw new Error(response.error || "Could not read GitHub credentials");
      setLoading(false);
    }).catch((e) => { setError(String(e)); setLoading(false); });
  }, []);

  const loadRepos = async (accessToken: string) => {
    setToken(accessToken);
    setRepos(await fetchAllGitHubRepos(accessToken));
    setLoading(false);
  };

  const authorize = async () => {
    setAuthorizing(true); setError("");
    try {
      if (!inTauri()) {
        const response = await fetch("/api/github/device/start", { method: "POST" });
        const device = await response.json();
        if (!response.ok) throw new Error(device.error_description || device.error || "GitHub authorization failed");
        setVerification({ url: device.verification_uri, code: device.user_code });
        for (let i = 0; i < 60; i++) {
          await new Promise((resolve) => setTimeout(resolve, (device.interval || 5) * 1000));
          const poll = await fetch("/api/github/device/poll", { method: "POST" });
          const result = await poll.json();
          if (result.authorized) {
            if (result.token) localStorage.setItem("loopkit-github-token", result.token);
            await loadBrowserRepos();
            return;
          }
          if (!result.pending) throw new Error(result.error || "GitHub authorization failed");
        }
        throw new Error("GitHub authorization timed out");
      }
      const clientId = inTauri() ? await invoke<string>("github_client_id") : (import.meta.env.VITE_GITHUB_CLIENT_ID || defaultGitHubClientId);
      if (!clientId) throw new Error("Set GITHUB_CLIENT_ID before starting the app.");
      const response = await fetch("https://github.com/login/device/code", { method: "POST", headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: clientId, scope: "repo" }) });
      const device = await response.json();
      if (!response.ok) throw new Error(device.error_description || "GitHub authorization failed");
      setVerification({ url: device.verification_uri, code: device.user_code });
      for (let i = 0; i < 60; i++) {
        await new Promise((resolve) => setTimeout(resolve, (device.interval || 5) * 1000));
        const poll = await fetch("https://github.com/login/oauth/access_token", { method: "POST", headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: clientId, device_code: device.device_code, grant_type: "urn:ietf:params:oauth:grant-type:device_code" }) });
        const result = await poll.json();
        if (result.access_token) {
          if (inTauri()) await invoke("github_store_token", { token: result.access_token });
          else localStorage.setItem("loopkit-github-token", result.access_token);
          await loadRepos(result.access_token); return;
        }
        if (result.error !== "authorization_pending" && result.error !== "slow_down") throw new Error(result.error_description || result.error);
      }
      throw new Error("GitHub authorization timed out");
    } catch (e) { setError(String(e)); setLoading(false); } finally { setAuthorizing(false); setVerification(null); }
  };

  const loadBrowserRepos = async () => {
    const savedToken = localStorage.getItem("loopkit-github-token");
    if (savedToken) return loadRepos(savedToken);
    const response = await fetch("/api/github/repos");
    if (!response.ok) throw new Error(`GitHub returned ${response.status}`);
    setRepos(await response.json()); setToken("session"); setLoading(false);
  };

  const clone = async () => {
    if (!selected) return;
    if (!inTauri()) {
      setLoading(true); setError("");
      try {
        const response = await fetch("/api/github/clone", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ full_name: selected.full_name, clone_url: selected.clone_url, token }) });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "Clone failed");
        onAdded({ name: selected.full_name.split("/").pop()!, path: result.path, remote: selected.full_name }); onClose();
      } catch (e) { setError(String(e)); setLoading(false); }
      return;
    }
    const { open } = await import("@tauri-apps/plugin-dialog");
    const parent = await open({ directory: true, multiple: false, title: "Choose where to clone the repository" });
    if (!parent || typeof parent !== "string") return;
    setLoading(true); setError("");
    try {
      const name = selected.full_name.split("/").pop()!;
      const result = await invoke<{ path: string }>("git_clone_repo", { url: selected.clone_url, destination: parent, name });
      onAdded({ name, path: result.path, remote: selected.full_name }); onClose();
    } catch (e) { setError(String(e)); setLoading(false); }
  };

  return <PopoverScope popover={popover}><div className="fixed inset-0 z-50 flex items-center justify-center bg-black/20">
    <div ref={popover.setBoundary} className="w-[420px] max-h-[80vh] bg-white rounded-xl shadow-xl border border-gray-200 p-4 flex flex-col">
      <div className="flex items-center justify-between mb-3"><h2 className="font-semibold">Add GitHub repository</h2><button onClick={onClose} className="text-gray-400 hover:text-gray-700 text-xl">×</button></div>
      <p className="text-xs text-gray-500 mb-3">Authorize GitHub to access repositories you own or collaborate on.</p>
      {!token && !loading && <button onClick={authorize} disabled={authorizing} className="w-full mb-3 px-3 py-2 text-sm bg-gray-900 text-white rounded-lg disabled:bg-gray-300">{authorizing ? "Waiting for GitHub…" : "Connect GitHub"}</button>}
      {verification && <div className="mb-3 rounded-lg bg-indigo-50 p-3 text-sm text-indigo-900"><div>Open GitHub and enter this code:</div><code className="block text-lg font-semibold tracking-widest my-1">{verification.code}</code><a href={verification.url} target="_blank" rel="noreferrer" className="font-medium underline">Open GitHub authorization</a></div>}
      {repos.length > 0 && <div className="mb-2 flex items-center gap-2 px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-gray-400"><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></svg>
        <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search repositories" className="min-w-0 flex-1 bg-transparent text-sm outline-none text-gray-900 placeholder-gray-400" />
      </div>}
      <div className="overflow-y-auto min-h-0 border border-gray-100 rounded-lg">
        {loading && !repos.length ? <div className="p-4 text-sm text-gray-500">Loading repositories...</div> : repos.filter((repo) => `${repo.full_name} ${repo.description || ""}`.toLowerCase().includes(search.toLowerCase())).map((repo) => <button key={repo.full_name} onClick={() => setSelected(repo)} className={`w-full text-left px-3 py-2 border-b border-gray-100 last:border-0 ${selected?.full_name === repo.full_name ? "bg-indigo-50" : "hover:bg-gray-50"}`}><div className="text-sm font-medium">{repo.full_name}</div><div className="text-xs text-gray-500 truncate">{repo.description || (repo.private ? "Private repository" : "Public repository")}</div></button>)}
        {!loading && !repos.filter((repo) => `${repo.full_name} ${repo.description || ""}`.toLowerCase().includes(search.toLowerCase())).length && <div className="p-4 text-sm text-gray-500">{error || (search ? "No matching repositories." : "No repositories found.")}</div>}
      </div>
      {error && repos.length > 0 && <p className="text-xs text-red-600 mt-2">{error}</p>}
      <div className="flex justify-end gap-2 mt-4"><button onClick={onClose} className="px-3 py-1.5 text-sm text-gray-600">Cancel</button><button onClick={clone} disabled={!selected || loading} className="px-3 py-1.5 text-sm bg-gray-900 text-white rounded-lg disabled:bg-gray-300">Clone repository</button></div>
    </div>
  </div></PopoverScope>;
}
