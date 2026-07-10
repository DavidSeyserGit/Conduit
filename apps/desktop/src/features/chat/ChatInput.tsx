import { useState } from "react";
import { useAppStore } from "@/stores/app-store";

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
    <div className="border-t border-gray-100 bg-white py-3 px-4 shrink-0">
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

      <div className="max-w-3xl mx-auto">
        <div className="flex items-center bg-gray-100 rounded-full border border-gray-200 focus-within:border-gray-300 focus-within:bg-white transition-all pr-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={
              mode === "goal" ? "Describe your goal..." : "Message LoopKit..."
            }
            disabled={isRunning}
            className="flex-1 bg-transparent px-4 py-3 text-sm text-gray-900 placeholder-gray-400 outline-none disabled:opacity-50"
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
    </div>
  );
}
