import { useState } from "react";
import type { ChatMode } from "@loopkit/shared";
import { useAppStore } from "@/stores/app-store";

export function ChatHeader() {
  const workspacePath = useAppStore((s) => s.workspacePath);
  const setShowSettings = useAppStore((s) => s.setShowSettings);
  const mode = useAppStore((s) => s.mode);
  const setMode = useAppStore((s) => s.setMode);
  const isRunning = useAppStore((s) => s.isRunning);

  const projectName = workspacePath
    ? workspacePath.split("/").pop() ?? workspacePath
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

        <ModePicker mode={mode} onChange={setMode} disabled={isRunning} />
      </div>

      <div className="flex items-center gap-2 shrink-0">
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
    </div>
  );
}

function ModePicker({
  mode,
  onChange,
  disabled,
}: {
  mode: ChatMode;
  onChange: (mode: ChatMode) => void;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="relative shrink-0">
      <button
        onClick={() => !disabled && setOpen(!open)}
        disabled={disabled}
        className="flex items-center gap-1 px-2.5 py-1.5 text-sm bg-gray-100 hover:bg-gray-200 rounded-lg text-gray-700 transition-colors disabled:opacity-50 font-medium"
      >
        {mode === "goal" ? "Goal" : "Chat"}
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
                m === mode ? "bg-indigo-50 text-indigo-700" : "text-gray-700"
              }`}
            >
              <div className="text-sm font-medium">{m === "goal" ? "Goal" : "Chat"}</div>
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
  );
}
