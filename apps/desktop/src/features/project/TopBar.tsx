import { useAppStore } from "@/stores/app-store";

export function TopBar() {
  const setShowSettings = useAppStore((s) => s.setShowSettings);

  const handleSelectProject = async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({
        directory: true,
        multiple: false,
        title: "Select working directory",
      });
      if (selected && typeof selected === "string") {
        useAppStore.getState().setWorkspacePath(selected);
      }
    } catch {
      const path = prompt("Enter workspace path:");
      if (path) useAppStore.getState().setWorkspacePath(path);
    }
  };

  return (
    <header className="flex items-center justify-between px-5 py-2.5 bg-white border-b border-gray-100 shrink-0">
      <div className="flex items-center gap-2">
        <button
          onClick={handleSelectProject}
          className="flex items-center gap-2 hover:bg-gray-50 rounded-lg px-2 py-1 transition-colors group"
        >
          <div className="w-7 h-7 bg-gradient-to-br from-indigo-500 to-purple-600 rounded-lg flex items-center justify-center text-white text-xs font-bold shadow-sm">
            L
          </div>
          <span className="font-semibold text-gray-900">LoopKit</span>
          <span className="text-gray-300 mx-1">·</span>
          <span className="text-sm text-gray-500 group-hover:text-gray-700 transition-colors">
            AI Chat
          </span>
        </button>
      </div>

      <div className="flex items-center gap-2">
        <button className="px-3.5 py-1.5 text-sm bg-gray-900 hover:bg-gray-800 text-white rounded-lg transition-colors font-medium">
          Upgrade
        </button>
        <button
          onClick={() => setShowSettings(true)}
          className="p-2 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
          title="Chat"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/>
          </svg>
        </button>
        <button
          onClick={() => setShowSettings(true)}
          className="p-2 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
          title="Settings"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <circle cx="12" cy="12" r="3"/>
            <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z"/>
          </svg>
        </button>
      </div>
    </header>
  );
}
