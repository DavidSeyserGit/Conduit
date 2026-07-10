import { useAppStore } from "@/stores/app-store";

export function ProjectBar() {
  const workspacePath = useAppStore((s) => s.workspacePath);
  const setWorkspacePath = useAppStore((s) => s.setWorkspacePath);
  const setShowSettings = useAppStore((s) => s.setShowSettings);
  const projectName = workspacePath
    ? workspacePath.split("/").pop() ?? workspacePath
    : "No project";

  const handleSelectProject = async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({
        directory: true,
        multiple: false,
        title: "Select working directory",
      });
      if (selected && typeof selected === "string") {
        setWorkspacePath(selected);
      }
    } catch {
      const path = prompt("Enter workspace path:");
      if (path) setWorkspacePath(path);
    }
  };

  return (
    <header className="flex items-center justify-between px-4 py-2.5 border-b border-zinc-800 bg-zinc-900/80 backdrop-blur-sm">
      <div className="flex items-center gap-4">
        <h1 className="text-sm font-semibold tracking-tight text-zinc-100">
          LoopKit
        </h1>
        <button
          onClick={handleSelectProject}
          className="text-xs text-zinc-400 hover:text-zinc-200 transition-colors"
        >
          Project: <span className="text-zinc-300">{projectName}</span>
        </button>
      </div>
      <button
        onClick={() => setShowSettings(true)}
        className="p-1.5 rounded-md text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors"
        title="Settings"
      >
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
          <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
        </svg>
      </button>
    </header>
  );
}
