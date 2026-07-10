import { useState } from "react";
import type { ChatMode } from "@loopkit/shared";
import { useAppStore } from "@/stores/app-store";
import { ModelSelectors } from "@/features/model-picker/ModelPicker";

export function ChatInput() {
  const [input, setInput] = useState("");
  const mode = useAppStore((s) => s.mode);
  const setMode = useAppStore((s) => s.setMode);
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

  return (
    <div className="border-t border-zinc-800 bg-zinc-900/80 backdrop-blur-sm">
      {pendingApproval && (
        <div className="px-4 py-2 bg-amber-500/10 border-b border-amber-500/20 flex items-center justify-between">
          <div className="text-xs text-amber-300 truncate flex-1 mr-3">
            Approve command: <code className="text-amber-200">{pendingApproval.command}</code>
          </div>
          <div className="flex gap-2 shrink-0">
            <button
              onClick={approveCommand}
              className="px-2 py-1 text-xs bg-green-600 hover:bg-green-500 text-white rounded transition-colors"
            >
              Approve
            </button>
            <button
              onClick={rejectCommand}
              className="px-2 py-1 text-xs bg-zinc-700 hover:bg-zinc-600 text-zinc-200 rounded transition-colors"
            >
              Reject
            </button>
          </div>
        </div>
      )}

      <div className="px-4 py-2">
        <ModelSelectors />
      </div>

      <div className="px-4 pb-3 flex items-center gap-2">
        <ModePicker mode={mode} onChange={setMode} disabled={isRunning} />

        <div className="flex-1 relative">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={
              mode === "goal" ? "Type a goal..." : "Ask about the codebase..."
            }
            disabled={isRunning}
            rows={1}
            className="w-full px-3 py-2 text-sm bg-zinc-800 border border-zinc-700 rounded-lg text-zinc-200 placeholder-zinc-500 resize-none focus:outline-none focus:border-indigo-500 disabled:opacity-50"
          />
        </div>

        {isRunning ? (
          <button
            onClick={cancelRun}
            className="px-4 py-2 text-sm bg-red-600 hover:bg-red-500 text-white rounded-lg transition-colors shrink-0"
          >
            Cancel
          </button>
        ) : (
          <button
            onClick={handleSubmit}
            disabled={!canSend}
            className="px-4 py-2 text-sm bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
          >
            Send
          </button>
        )}
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
        className="px-3 py-2 text-sm bg-zinc-800 border border-zinc-700 rounded-lg text-zinc-200 hover:border-zinc-600 transition-colors disabled:opacity-50 flex items-center gap-1"
      >
        {mode === "goal" ? "Goal" : "Ask"}
        <svg className="w-3 h-3 text-zinc-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div className="absolute bottom-full mb-1 left-0 z-50 bg-zinc-900 border border-zinc-700 rounded-lg shadow-xl overflow-hidden">
          {(["ask", "goal"] as ChatMode[]).map((m) => (
            <button
              key={m}
              onClick={() => {
                onChange(m);
                setOpen(false);
              }}
              className={`block w-full text-left px-4 py-2 text-sm hover:bg-zinc-800 transition-colors ${
                m === mode ? "text-indigo-400" : "text-zinc-300"
              }`}
            >
              {m === "goal" ? "Goal" : "Ask"}
              <span className="block text-xs text-zinc-500 mt-0.5">
                {m === "goal"
                  ? "Coding agent loop with judge"
                  : "Read-only repository chat"}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
