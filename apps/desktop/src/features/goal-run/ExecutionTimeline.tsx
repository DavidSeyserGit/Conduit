import { useEffect, useRef } from "react";
import type { CSSProperties } from "react";
import type { GoalRunEvent, GoalRunState } from "@loopkit/shared";
import { downloadRunAsJSON } from "@loopkit/agent-runtime";
import ReactMarkdown from "react-markdown";
import { useAppStore } from "@/stores/app-store";

export function ChatTimeline() {
  const messages = useAppStore((s) => s.messages);
  const runEvents = useAppStore((s) => s.runEvents);
  const currentRun = useAppStore((s) => s.currentRun);
  const isRunning = useAppStore((s) => s.isRunning);
  const statusColor = useAppStore((s) => s.settings.inputGlowColor ?? "#3b82f6");
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, runEvents, currentRun, isRunning]);

  if (messages.length === 0 && runEvents.length === 0) {
    return (
      <div className="flex-1 min-h-0 overflow-y-auto flex items-center justify-center">
        <div className="text-center max-w-md px-4">
          <h1 className="text-2xl font-semibold text-gray-900 mb-2">Welcome to LoopKit</h1>
          <p className="text-sm text-gray-500">
            Select a project, choose a mode, and start chatting or set a goal.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-0 overflow-y-auto px-6 py-6">
      <div className="max-w-6xl mx-auto space-y-6">
        {messages.map((msg) => (
          <div key={msg.id} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
            <div className={`max-w-[82%] ${msg.role === "user" ? "items-end" : "items-start"}`}>
              <div className="text-[11px] font-medium text-gray-400 mb-1 px-1">
                {msg.role === "user" ? "You" : "LoopKit"}
              </div>
              <div className={`text-sm leading-relaxed prose prose-sm max-w-none px-4 py-3 ${msg.role === "user" ? "bg-gray-900 text-white [&_*]:text-white rounded-2xl rounded-br-md" : "bg-gray-50 border border-gray-200 text-gray-800 rounded-2xl rounded-bl-md"}`}>
                <div className={`chat-markdown ${msg.role === "user" ? "chat-markdown-user" : ""}`}><ReactMarkdown>{msg.content}</ReactMarkdown></div>
                {msg.isStreaming && (
                  <span className="inline-block w-1.5 h-4 bg-indigo-500 animate-pulse ml-0.5 rounded align-middle" />
                )}
              </div>
            </div>
          </div>
        ))}

        {runEvents.map((event, i) => {
          if (event.type === "agent_status") {
            return (
              <div key={`status-${i}`} className="flex justify-start">
                <div className="agent-status text-xs px-1" style={{ "--status-color": statusColor } as CSSProperties}>{event.message}</div>
              </div>
            );
          }
          if (event.type === "agent_message") {
            return (
              <div key={`model-${i}`} className="flex justify-start">
                <div className="max-w-[82%]">
                  <div className="text-[11px] font-medium text-gray-400 mb-1 px-1">Model</div>
                  <div className="bg-gray-50 border border-gray-200 rounded-2xl rounded-bl-md px-4 py-3 shadow-sm">
                    <div className="text-sm leading-relaxed chat-markdown"><ReactMarkdown>{event.content}</ReactMarkdown></div>
                  </div>
                </div>
              </div>
            );
          }
          if (event.type === "judge_completed") {
            const r = event.result;
            const percent = (r.confidence * 100).toFixed(0);
            const barColor = r.confidence >= 0.7 ? "bg-emerald-500" : r.confidence >= 0.4 ? "bg-amber-500" : "bg-red-500";
            return (
              <div key={`judge-${i}`} className="flex justify-start">
                <div className="max-w-[82%]">
                  <div className="flex items-center gap-2 text-[11px] font-medium text-gray-400 mb-1 px-1">
                    <span>Judge</span>
                    <span className="text-gray-400">· {percent}% confidence</span>
                  </div>
                  <div className="bg-white border border-gray-200 rounded-2xl rounded-bl-md px-4 py-3 shadow-sm space-y-2">
                    <div className="flex items-center gap-2">
                      <span className={`text-sm font-semibold ${r.approved ? "text-emerald-600" : "text-red-500"}`}>
                        {r.approved ? "Approved" : "Rejected"}
                      </span>
                    </div>
                    <div className="w-full h-1.5 bg-gray-200 rounded-full overflow-hidden">
                      <div className={`h-full ${barColor} transition-all duration-300`} style={{ width: `${percent}%` }} />
                    </div>
                    <p className="text-sm text-gray-700">{r.summary}</p>
                    {r.feedback.map((f, fi) => (
                      <p key={fi} className="text-xs text-gray-600 pl-2">— {f}</p>
                    ))}
                    {r.missingRequirements.map((m, mi) => (
                      <p key={mi} className="text-xs text-amber-700 pl-2">Missing: {m}</p>
                    ))}
                  </div>
                </div>
              </div>
            );
          }
          if (event.type === "tool_started" || event.type === "tool_completed") {
            const tool = event.toolCall;
            const completed = event.type === "tool_completed";
            return (
              <div key={`tool-${i}`} className="flex justify-start">
                <div className="text-xs text-gray-500 px-1">
                  <span className={completed && tool.status === "failed" ? "text-red-500" : "text-emerald-500"}>
                    {completed ? (tool.status === "failed" ? "✗" : "✓") : "⋯"}
                  </span>{" "}
                  {completed ? "Finished" : "Running"} <code className="font-mono">{tool.name}</code>
                </div>
              </div>
            );
          }
          return null;
        })}

        {runEvents.length > 0 && runEvents.some((e) => e.type === "run_started") && !runEvents.some((e) => e.type === "run_completed" || e.type === "run_failed") && (
          <div className="flex justify-start">
            <div className="text-[11px] font-medium text-gray-400 px-1">Working through the repository…</div>
          </div>
        )}

        {runEvents.find((e) => e.type === "run_failed")?.type === "run_failed" && (
          <div className="flex justify-start">
            <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
              Run failed: {(runEvents.find((e) => e.type === "run_failed") as Extract<GoalRunEvent, { type: "run_failed" }>).error}
            </div>
          </div>
        )}

        {currentRun && !isRunning && (
          <RunSummary run={currentRun} events={runEvents} />
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}

function RunSummary({
  run,
  events,
}: {
  run: GoalRunState;
  events: GoalRunEvent[];
}) {
  const openGitDiff = useAppStore((s) => s.openGitDiff);
  const elapsed = run.finishedAt
    ? Math.round(
        (new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime()) / 1000
      )
    : 0;

  const statusLabel: Record<string, string> = {
    completed: "Goal completed",
    cancelled: "Goal cancelled",
    iteration_limit_reached: "Iteration limit reached",
    failed: "Goal failed",
  };

  const handleExport = () => {
    downloadRunAsJSON(run, events);
  };

  return (
    <div className="border border-gray-200 rounded-xl p-4 bg-white text-xs space-y-2">
      <div className="flex items-center justify-between">
        <div className="font-semibold text-gray-900 text-sm">
          {statusLabel[run.status] ?? run.status}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleExport}
            className="px-3 py-1.5 text-xs bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-lg transition-colors font-medium flex items-center gap-1.5"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
            </svg>
            Export
          </button>
          <button
            onClick={() => void openGitDiff()}
            className="px-3 py-1.5 text-xs bg-gray-900 hover:bg-gray-800 text-white rounded-lg transition-colors font-medium flex items-center gap-1.5"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path d="M8 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h3M16 3h3a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-3M8 7h8M8 12h8M8 17h5" /></svg>
            Changes
          </button>
        </div>
      </div>

      <div className="text-gray-500 space-y-0.5">
        <div>Iterations: {run.iteration}</div>
        {run.tokenUsage && (
          <div>
            Tokens: {run.tokenUsage.totalTokens.toLocaleString()}
          </div>
        )}
        {run.estimatedCost !== undefined && run.estimatedCost > 0 && (
          <div>Estimated cost: {formatCost(run.estimatedCost)}</div>
        )}
        {run.codingCost && <div>Coding: {formatCost(run.codingCost.totalCost)}</div>}
        {run.judgeCost && <div>Judge: {formatCost(run.judgeCost.totalCost)}</div>}
        <div>Elapsed: {elapsed}s</div>
      </div>

      {run.metrics && (
        <div className="pt-2 border-t border-gray-100 space-y-1.5">
          <div className="font-medium text-gray-700 text-xs">Loop Metrics</div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-gray-500">
            <div>Total tool calls: {run.metrics.totalToolCalls}</div>
            <div>Avg confidence: {(run.metrics.averageConfidence * 100).toFixed(0)}%</div>
            <div>Iterations to complete: {run.metrics.iterationsToComplete}</div>
            <div>Success rate: {(run.metrics.successRate * 100).toFixed(0)}%</div>
          </div>
          {run.metrics.confidenceTrend.length > 1 && (
            <div className="flex items-center gap-1.5 pt-1">
              <span className="text-gray-500">Confidence trend:</span>
              <div className="flex items-end gap-0.5 h-4">
                {run.metrics.confidenceTrend.map((conf, i) => (
                  <div
                    key={i}
                    className="w-1.5 bg-gray-400 rounded-t"
                    style={{ height: `${Math.max(conf * 100, 5)}%` }}
                    title={`Iteration ${i + 1}: ${(conf * 100).toFixed(0)}%`}
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function formatCost(cost: number): string {
  return cost > 0 && cost < 0.0001 ? "<$0.0001" : `$${cost.toFixed(4)}`;
}
