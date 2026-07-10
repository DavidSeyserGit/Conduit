import { useState } from "react";
import React from "react";
import type { ReactNode } from "react";
import type { ChatMode } from "@loopkit/shared";
import { useAppStore } from "@/stores/app-store";
import { ModelSelectors } from "@/features/model-picker/ModelPicker";

export function ChatInput() {
  const [input, setInput] = useState("");
  const mode = useAppStore((s) => s.mode);
  const isRunning = useAppStore((s) => s.isRunning);
  const workspacePath = useAppStore((s) => s.workspacePath);
  const codingModelId = useAppStore((s) => s.codingModelId);
  const judgeModelId = useAppStore((s) => s.judgeModelId);
  const sendMessage = useAppStore((s) => s.sendMessage);
  const startGoalRun = useAppStore((s) => s.startGoalRun);
  const cancelRun = useAppStore((s) => s.cancelRun);
  const pendingApproval = useAppStore((s) => s.pendingApproval);
  const approveCommand = useAppStore((s) => s.approveCommand);
  const rejectCommand = useAppStore((s) => s.rejectCommand);

  const messages = useAppStore((s) => s.messages);
  const hasMessages = messages.length > 0;

  const canSend =
    input.trim().length > 0 &&
    !isRunning &&
    workspacePath &&
    codingModelId &&
    (mode === "ask" || judgeModelId);

  const handleSubmit = () => {
    if (!canSend) return;
    const content = input.trim();
    setInput("");
    if (mode === "ask") {
      sendMessage(content);
    } else {
      startGoalRun(content);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const handleTextChange = (value: string) => {
    setInput(value);
  };

  return (
    <div className={`${hasMessages ? "border-t border-gray-200 bg-white" : "bg-white"} py-4 px-4`}>
      {pendingApproval && (
        <div className="mb-3 px-4 py-2 bg-amber-50 border border-amber-200 rounded-lg flex items-center justify-between">
          <div className="text-xs text-amber-800 truncate flex-1 mr-3">
            Approve command: <code className="text-amber-700 font-mono text-xs">{pendingApproval.command}</code>
          </div>
          <div className="flex gap-2 shrink-0">
            <button
              onClick={approveCommand}
              className="px-2.5 py-1 text-xs bg-emerald-600 hover:bg-emerald-500 text-white rounded-md transition-colors font-medium"
            >
              Approve
            </button>
            <button
              onClick={rejectCommand}
              className="px-2.5 py-1 text-xs bg-gray-200 hover:bg-gray-300 text-gray-700 rounded-md transition-colors font-medium"
            >
              Reject
            </button>
          </div>
        </div>
      )}

      <div className="max-w-2xl mx-auto">
        <div className="relative">
          <div className="flex items-center bg-gray-100 rounded-full border border-gray-200 focus-within:border-gray-300 focus-within:bg-white transition-all pr-2">
            <input
              type="text"
              value={input}
              onChange={(e) => handleTextChange(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={
                mode === "goal" ? "Describe your goal..." : "Message LoopKit..."
              }
              disabled={isRunning}
              className="flex-1 bg-transparent px-4 py-3 text-sm text-gray-900 placeholder-gray-400 outline-none"
            />
            {isRunning ? (
              <button
                onClick={cancelRun}
                className="px-3 py-1.5 text-xs bg-red-600 hover:bg-red-500 text-white rounded-full transition-colors font-medium shrink-0"
              >
                Stop
              </button>
            ) : (
              <button
                onClick={handleSubmit}
                disabled={!canSend}
                className="p-2 bg-gray-900 hover:bg-gray-800 disabled:bg-gray-300 text-white disabled:text-gray-400 rounded-full transition-colors shrink-0"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="5" y1="12" x2="19" y2="12"/>
                  <polyline points="12 5 19 12 12 19"/>
                </svg>
              </button>
            )}
          </div>
        </div>

        <div className="flex items-center justify-between mt-3 px-1">
          <div className="flex items-center gap-2">
            <ActionChip icon={<SearchIcon />} label="Search" />
            <ActionChip icon={<GlobeIcon />} label="Web scraping" />
            <ActionChip icon={<ImageIcon />} label="Browse Images" />
          </div>
          <div className="flex items-center gap-2">
            <ModelSelectors compact />
          </div>
        </div>
      </div>

      {hasMessages && (
        <div className="text-xs text-gray-400 text-center mt-3">
          LoopKit can generate inaccurate information. Verify all responses.
        </div>
      )}
    </div>
  );
}

function ActionChip({ icon, label }: { icon: ReactNode; label: string }) {
  return (
    <button className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-gray-100 hover:bg-gray-200 transition-colors text-xs text-gray-700">
      <span className="text-gray-500">{icon}</span>
      <span>{label}</span>
    </button>
  );
}

function SearchIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
      <circle cx="11" cy="11" r="8"/>
      <line x1="21" y1="21" x2="16.65" y2="16.65"/>
    </svg>
  );
}

function GlobeIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
      <circle cx="12" cy="12" r="10"/>
      <line x1="2" y1="12" x2="22" y2="12"/>
      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
    </svg>
  );
}

function ImageIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
      <rect x="3" y="3" width="18" height="18" rx="2"/>
      <circle cx="8.5" cy="8.5" r="1.5"/>
      <polyline points="21 15 16 10 5 21"/>
    </svg>
  );
}

export function ModePicker({
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
        className="flex items-center gap-1 px-3 py-1.5 text-xs bg-white border border-gray-200 rounded-full text-gray-700 hover:border-gray-300 hover:bg-gray-50 transition-colors font-medium"
      >
        {mode === "goal" ? "Goal" : "Chat"}
        <svg className="w-3 h-3 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div className="absolute bottom-full mb-2 left-0 z-50 bg-white border border-gray-200 rounded-xl shadow-lg overflow-hidden min-w-[180px]">
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
