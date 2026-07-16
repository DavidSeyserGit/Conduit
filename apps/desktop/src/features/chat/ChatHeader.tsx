import { useState } from "react";
import type { ChatMode } from "@conduit/shared";
import { useAppStore } from "@/stores/app-store";
import { getModeColor } from "@/lib/mode-colors";
import { PopoverScope, usePopover } from "@/lib/popover";

export function ChatHeader() {
  const workspacePath = useAppStore((s) => s.workspacePath);
  const activeProjectPath = useAppStore((s) => s.activeProjectPath);
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const sessions = useAppStore((s) => s.sessions);
  const sessionUsage = useAppStore((s) => s.sessionUsage);
  const mode = useAppStore((s) => s.mode);
  const setMode = useAppStore((s) => s.setMode);
  const isRunning = useAppStore((s) => s.isRunning);
  const createWorktree = useAppStore((s) => s.createWorktree);
  const removeWorktree = useAppStore((s) => s.removeWorktree);
  const openGitDiff = useAppStore((s) => s.openGitDiff);
  const settings = useAppStore((s) => s.settings);
  const updateSettings = useAppStore((s) => s.updateSettings);
  const modeColor = getModeColor(settings, mode);
  const isDark = settings.theme === "dark";

  const activeSession = sessions[activeProjectPath]?.find((session) => session.id === activeSessionId);
  const projectName = activeProjectPath
    ? activeProjectPath.split("/").pop() ?? activeProjectPath
    : "Select project";

  return (
    <div className="flex items-center justify-between gap-3 px-5 py-2.5 border-b border-gray-100 bg-white shrink-0">
      <div className="flex items-center gap-2 min-w-0">
        <div className="flex items-center gap-1.5 px-2.5 py-1.5 text-sm text-gray-700 truncate" title={workspacePath || undefined}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-gray-400 shrink-0">
            <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/>
          </svg>
          <span className="truncate font-medium">{projectName}</span>
        </div>

        <ModePicker mode={mode} onChange={setMode} disabled={isRunning} color={modeColor} />
        {activeSession?.branch && <span className="flex items-center gap-1.5 px-2 py-1 text-[11px] text-emerald-700 bg-emerald-50 border border-emerald-100 rounded-md" title={workspacePath}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M6 3v18M18 3v18M6 7h12M6 17h12" /><circle cx="6" cy="7" r="2" /><circle cx="18" cy="17" r="2" /></svg>
          <span className="max-w-[180px] truncate">{activeSession.branch}</span>
        </span>}
        {(sessionUsage.totalTokens > 0 || sessionUsage.totalCost > 0) && <span className="hidden md:inline-flex items-center gap-1.5 px-2 py-1 text-[11px] text-gray-500 bg-gray-50 border border-gray-100 rounded-md" title={`Prompt ${sessionUsage.promptTokens.toLocaleString()} tokens, output ${sessionUsage.completionTokens.toLocaleString()}, cache read ${sessionUsage.cacheReadTokens.toLocaleString()}, cache write ${sessionUsage.cacheWriteTokens.toLocaleString()}`}>
          <span>{formatTokens(sessionUsage.totalTokens)} tokens</span>
          {(sessionUsage.cacheReadTokens > 0 || sessionUsage.cacheWriteTokens > 0) && <span className="text-indigo-500">{formatTokens(sessionUsage.cacheReadTokens + sessionUsage.cacheWriteTokens)} cached</span>}
          <span className="text-gray-700">{formatCost(sessionUsage.totalCost)}</span>
        </span>}
      </div>

      <div className="flex items-center gap-2 shrink-0">
        {activeProjectPath && <button
          onClick={() => void openGitDiff()}
          className="p-2 text-gray-500 hover:text-gray-900 hover:bg-gray-100 rounded-lg transition-colors"
          title="Show Git changes"
          aria-label="Show Git changes"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M8 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h3M16 3h3a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-3M8 7h8M8 12h8M8 17h5" /></svg>
        </button>}
        {activeProjectPath && !activeSession?.worktreePath && <button
          onClick={() => void createWorktree().catch((error) => window.alert(error instanceof Error ? error.message : String(error)))}
          disabled={isRunning}
          className="p-2 text-gray-500 hover:text-gray-900 hover:bg-gray-100 rounded-lg transition-colors disabled:opacity-40"
          title="Create isolated Git worktree"
          aria-label="Create isolated Git worktree"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M6 3v18M18 3v18M6 7h12M6 17h12" /><circle cx="6" cy="7" r="2" /><circle cx="18" cy="17" r="2" /></svg>
        </button>}
        {activeSession?.worktreePath && <button
          onClick={() => { if (window.confirm("Remove this chat's worktree? Uncommitted changes will be deleted.")) void removeWorktree().catch((error) => window.alert(error instanceof Error ? error.message : String(error))); }}
          disabled={isRunning}
          className="p-2 text-gray-500 hover:text-red-600 hover:bg-gray-100 rounded-lg transition-colors disabled:opacity-40"
          title="Remove worktree"
          aria-label="Remove worktree"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" /></svg>
        </button>}
        <button
          onClick={() => updateSettings({ theme: isDark ? "light" : "dark" })}
          className="p-2 text-gray-500 hover:text-gray-900 hover:bg-gray-100 rounded-lg transition-colors"
          title={isDark ? "Use light mode" : "Use dark mode"}
          aria-label={isDark ? "Use light mode" : "Use dark mode"}
          aria-pressed={isDark}
        >
          {isDark ? (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" /></svg>
          ) : (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8Z" /></svg>
          )}
        </button>
      </div>
    </div>
  );
}

function formatTokens(tokens: number): string {
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(tokens >= 10000 ? 0 : 1)}k` : String(tokens);
}

function formatCost(cost: number): string {
  return cost > 0 && cost < 0.0001 ? "<$0.0001" : `$${cost.toFixed(4)}`;
}

function ModePicker({
  mode,
  onChange,
  disabled,
  color,
}: {
  mode: ChatMode;
  onChange: (mode: ChatMode) => void;
  disabled: boolean;
  color: string;
}) {
  const [open, setOpen] = useState(false);
  const popover = usePopover({ open, onClose: () => setOpen(false) });

  return (
    <PopoverScope popover={popover}>
    <div ref={popover.setBoundary} className="relative shrink-0">
      <button
        onClick={() => !disabled && setOpen(!open)}
        disabled={disabled}
        className="flex items-center gap-1 px-2.5 py-1.5 text-sm rounded-lg transition-colors disabled:opacity-50 font-medium"
        style={{ color, backgroundColor: `${color}14`, border: `1px solid ${color}30` }}
      >
        {mode === "goal" ? "Goal" : "Ask"}
        <svg className="w-3 h-3 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div className="absolute top-full mt-2 left-0 z-50 bg-white border border-gray-200 rounded-xl shadow-lg overflow-hidden min-w-[200px]">
          {(["ask", "goal"] as ChatMode[]).map((m) => (
            <button
              key={m}
              onClick={() => {
                onChange(m);
                setOpen(false);
              }}
              className={`block w-full text-left px-4 py-2.5 hover:bg-gray-50 transition-colors ${
                m === mode ? "bg-gray-100" : "text-gray-700"
              }`}
              style={m === mode ? { color } : undefined}
            >
              <div className="text-sm font-medium">{m === "goal" ? "Goal" : "Ask"}</div>
              <div className="text-xs text-gray-500 mt-0.5">
                {m === "goal"
                  ? "Coding agent loop with judge"
                  : "Read-only repository chat"}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
    </PopoverScope>
  );
}
