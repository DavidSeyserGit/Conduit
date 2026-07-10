import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore, type Project } from "@/stores/app-store";

type GitHubRepo = { full_name: string; clone_url: string; description?: string; private: boolean };
const inTauri = () => Boolean((window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
const defaultGitHubClientId = "Ov23liMo1oJoAzSI7573";

export function LeftSidebar() {
  const setShowSettings = useAppStore((s) => s.setShowSettings);
  const projects = useAppStore((s) => s.projects);
  const workspacePath = useAppStore((s) => s.workspacePath);
  const setWorkspacePath = useAppStore((s) => s.setWorkspacePath);
  const addProject = useAppStore((s) => s.addProject);
  const [showAdd, setShowAdd] = useState(false);

  return (
    <aside className="w-[200px] flex flex-col bg-white border-r border-gray-100 shrink-0">
      <div className="flex items-center gap-2 px-4 py-3.5">
        <div className="w-7 h-7 bg-gray-950 rounded-full flex items-center justify-center text-white font-semibold text-sm">
          L
        </div>
        <span className="font-semibold text-gray-900">LoopKit</span>
      </div>

      <nav className="flex-1 px-2 py-1 space-y-0.5 overflow-y-auto">
        <div className="w-full flex items-center gap-2.5 px-3 py-1.5 rounded-lg text-sm text-gray-900 bg-gray-100">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-gray-500">
            <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/>
          </svg>
          <span>Chat</span>
        </div>
        <div className="flex items-center justify-between px-3 pt-5 pb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-400">
          <span>Projects</span>
          <button onClick={() => setShowAdd(true)} className="p-1 rounded hover:bg-gray-100 text-gray-500" title="Add GitHub repository" aria-label="Add GitHub repository">+</button>
        </div>
        {projects.map((project) => (
          <button key={project.path} onClick={() => setWorkspacePath(project.path)} className={`w-full flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm text-left truncate ${workspacePath === project.path ? "bg-gray-100 text-gray-900" : "text-gray-600 hover:bg-gray-50"}`} title={project.path}>
            <span className="w-1.5 h-1.5 rounded-full bg-gray-400 shrink-0" />
            <span className="truncate">{project.name}</span>
          </button>
        ))}
      </nav>

      <div className="p-2 border-t border-gray-100">
        <button
          onClick={() => setShowSettings(true)}
          className="w-full flex items-center gap-2.5 px-3 py-1.5 rounded-lg text-sm text-gray-600 hover:bg-gray-50 hover:text-gray-900 transition-colors"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="3"/>
            <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z"/>
          </svg>
          <span>Settings</span>
        </button>
      </div>
      {showAdd && <AddProject onClose={() => setShowAdd(false)} onAdded={addProject} />}
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

  useEffect(() => {
    if (!inTauri()) {
      fetch("/api/github/repos").then((response) => response.ok ? response.json() : null).then((repos: GitHubRepo[] | null) => repos ? (setRepos(repos), setToken("session")) : undefined).catch(() => undefined).finally(() => setLoading(false));
      return;
    }
    invoke<{ token: string | null }>("github_get_token").then(({ token }) => token ? loadRepos(token) : setLoading(false)).catch((e) => { setError(String(e)); setLoading(false); });
  }, []);

  const loadRepos = async (accessToken: string) => {
    setToken(accessToken);
    const response = await fetch("https://api.github.com/user/repos?affiliation=owner,collaborator,organization_member&per_page=100", { headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/vnd.github+json" } });
    if (!response.ok) throw new Error(`GitHub returned ${response.status}`);
    setRepos(await response.json()); setLoading(false);
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
          if (result.authorized) { await loadBrowserRepos(); return; }
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
    const response = await fetch("/api/github/repos");
    if (!response.ok) throw new Error(`GitHub returned ${response.status}`);
    setRepos(await response.json()); setToken("session"); setLoading(false);
  };

  const clone = async () => {
    if (!selected) return;
    if (!inTauri()) {
      setLoading(true); setError("");
      try {
        const response = await fetch("/api/github/clone", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ full_name: selected.full_name, clone_url: selected.clone_url }) });
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

  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/20" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
    <div className="w-[420px] max-h-[80vh] bg-white rounded-xl shadow-xl border border-gray-200 p-4 flex flex-col">
      <div className="flex items-center justify-between mb-3"><h2 className="font-semibold">Add GitHub repository</h2><button onClick={onClose} className="text-gray-400 hover:text-gray-700 text-xl">×</button></div>
      <p className="text-xs text-gray-500 mb-3">Authorize GitHub to access repositories you own or collaborate on.</p>
      {!token && !loading && <button onClick={authorize} disabled={authorizing} className="w-full mb-3 px-3 py-2 text-sm bg-gray-900 text-white rounded-lg disabled:bg-gray-300">{authorizing ? "Waiting for GitHub…" : "Connect GitHub"}</button>}
      {verification && <div className="mb-3 rounded-lg bg-indigo-50 p-3 text-sm text-indigo-900"><div>Open GitHub and enter this code:</div><code className="block text-lg font-semibold tracking-widest my-1">{verification.code}</code><a href={verification.url} target="_blank" rel="noreferrer" className="font-medium underline">Open GitHub authorization</a></div>}
      <div className="overflow-y-auto min-h-0 border border-gray-100 rounded-lg">
        {loading && !repos.length ? <div className="p-4 text-sm text-gray-500">Loading repositories…</div> : repos.map((repo) => <button key={repo.full_name} onClick={() => setSelected(repo)} className={`w-full text-left px-3 py-2 border-b border-gray-100 last:border-0 ${selected?.full_name === repo.full_name ? "bg-indigo-50" : "hover:bg-gray-50"}`}><div className="text-sm font-medium">{repo.full_name}</div><div className="text-xs text-gray-500 truncate">{repo.description || (repo.private ? "Private repository" : "Public repository")}</div></button>)}
        {!loading && !repos.length && <div className="p-4 text-sm text-gray-500">{error || "No repositories found."}</div>}
      </div>
      {error && repos.length > 0 && <p className="text-xs text-red-600 mt-2">{error}</p>}
      <div className="flex justify-end gap-2 mt-4"><button onClick={onClose} className="px-3 py-1.5 text-sm text-gray-600">Cancel</button><button onClick={clone} disabled={!selected || loading} className="px-3 py-1.5 text-sm bg-gray-900 text-white rounded-lg disabled:bg-gray-300">Clone repository</button></div>
    </div>
  </div>;
}
