import { useEffect, useRef, useState } from "react";
import type { GoalRunEvent, GoalRunState } from "@loopkit/shared";
import { downloadRunAsJSON } from "@loopkit/agent-runtime";
import ReactMarkdown from "react-markdown";
import { useAppStore } from "@/stores/app-store";

export function ChatTimeline() {
  const messages = useAppStore((s) => s.messages);
  const runEvents = useAppStore((s) => s.runEvents);
  const currentRun = useAppStore((s) => s.currentRun);
  const isRunning = useAppStore((s) => s.isRunning);
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

        {runEvents.length > 0 && <GoalRunTimeline events={runEvents} />}

        {currentRun && !isRunning && (
          <RunSummary run={currentRun} events={runEvents} />
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}

function GoalRunTimeline({ events }: { events: GoalRunEvent[] }) {
  const iterations = groupByIteration(events);

  return (
    <div className="border border-gray-200 rounded-2xl bg-gray-50/70 p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-sm font-semibold text-gray-900">Goal execution</div>
        <span className="text-[11px] text-gray-400">Agent activity</span>
      </div>

      {events.some((e) => e.type === "run_started") && (
        <div className="text-xs text-gray-500">Working through the repository…</div>
      )}

      {events.find((e) => e.type === "run_failed")?.type === "run_failed" && (
        <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
          Run failed: {(events.find((e) => e.type === "run_failed") as Extract<GoalRunEvent, { type: "run_failed" }>).error}
        </div>
      )}

      {iterations.map((iter) => (
        <div key={iter.number} className="space-y-3">
          <IterationBlock iteration={iter} />
          {iter.agentMessages.map((event) => event.type === "agent_message" && (
            <div key={event.messageId} className="flex justify-start">
              <div className="max-w-[82%]">
                <div className="text-[11px] font-medium text-gray-400 mb-1 px-1">LoopKit</div>
                <div className="prose prose-sm max-w-none text-gray-800 bg-white border border-gray-200 rounded-2xl rounded-bl-md px-4 py-3 shadow-sm">
                  <div className="chat-markdown"><ReactMarkdown>{event.content}</ReactMarkdown></div>
                </div>
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

interface IterationData {
  number: number;
  toolCalls: GoalRunEvent[];
  agentMessages: GoalRunEvent[];
  judgeResult?: GoalRunEvent;
  planUpdated?: GoalRunEvent;
  validations: GoalRunEvent[];
}

function groupByIteration(events: GoalRunEvent[]): IterationData[] {
  const map = new Map<number, IterationData>();
  let currentIteration = 0;

  for (const event of events) {
    if (event.type === "iteration_started") {
      currentIteration = event.iteration;
      map.set(currentIteration, {
        number: currentIteration,
        toolCalls: [],
        agentMessages: [],
        validations: [],
      });
    }

    const iter = map.get(currentIteration);
    if (!iter) continue;

    switch (event.type) {
      case "tool_started":
      case "tool_completed":
        iter.toolCalls.push(event);
        break;
      case "agent_message":
        iter.agentMessages.push(event);
        break;
      case "judge_completed":
        iter.judgeResult = event;
        break;
      case "plan_updated":
        iter.planUpdated = event;
        break;
      case "validation_completed":
        iter.validations.push(event);
        break;
    }
  }

  return Array.from(map.values());
}

function IterationBlock({ iteration }: { iteration: IterationData }) {
  const [expanded, setExpanded] = useState(false);
  const completedTools = iteration.toolCalls.filter((e) => e.type === "tool_completed");
  const judgeResult = iteration.judgeResult?.type === "judge_completed"
    ? iteration.judgeResult.result
    : undefined;
  const judgeApproved = judgeResult?.approved;
  const judgeConfidence = judgeResult?.confidence;

  return (
    <div className="border border-gray-200 rounded-xl overflow-hidden bg-white shadow-sm">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-4 py-3 bg-white hover:bg-gray-50 transition-colors text-left"
      >
        <span className="text-sm font-semibold text-gray-800">
          Iteration {iteration.number}
        </span>
        <div className="flex items-center gap-2.5">
          {completedTools.length > 0 && (
            <span className="text-xs text-gray-500">
              {completedTools.length} tool{completedTools.length !== 1 ? "s" : ""}
            </span>
          )}
          {judgeApproved !== undefined && (
            <span
              className={`text-xs font-semibold ${
                judgeApproved ? "text-emerald-600" : "text-red-500"
              }`}
            >
              {judgeApproved ? "Approved" : "Rejected"}
            </span>
          )}
          {judgeConfidence !== undefined && (
            <span className="text-xs text-gray-500">
              {(judgeConfidence * 100).toFixed(0)}% conf
            </span>
          )}
          <svg
            className={`w-3.5 h-3.5 text-gray-400 transition-transform ${expanded ? "rotate-180" : ""}`}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth="2.5"
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
          </svg>
        </div>
      </button>

      <div className="px-4 py-2.5 space-y-1.5 bg-white">
        {completedTools.map((event, i) => {
          if (event.type !== "tool_completed") return null;
          const tc = event.toolCall;
          const icon = tc.status === "completed" ? "✓" : "✗";
          return (
            <div key={i} className="text-xs text-gray-600 flex items-start gap-2">
              <span className={tc.status === "completed" ? "text-emerald-500 font-semibold" : "text-red-500 font-semibold"}>
                {icon}
              </span>
              <span>{formatToolName(tc.name)}</span>
            </div>
          );
        })}

        {iteration.validations.map((event, i) => {
          if (event.type !== "validation_completed") return null;
          const v = event.result;
          return (
            <div key={`v-${i}`} className="text-xs text-gray-600 flex items-start gap-2">
              <span className={v.passed ? "text-emerald-500 font-semibold" : "text-red-500 font-semibold"}>
                {v.passed ? "✓" : "✗"}
              </span>
              <span>Ran: <code className="font-mono text-xs bg-gray-100 px-1 rounded">{v.command}</code></span>
            </div>
          );
        })}

      </div>

      {expanded && (
        <div className="px-4 py-3 border-t border-gray-200 space-y-2 bg-gray-50">
          {iteration.planUpdated?.type === "plan_updated" && (
            <div className="text-xs">
              <span className="text-gray-500 font-medium">Plan: </span>
              <span className="text-gray-700">{iteration.planUpdated.plan.summary}</span>
            </div>
          )}

          {iteration.judgeResult?.type === "judge_completed" && (
            <JudgeFeedback result={iteration.judgeResult.result} />
          )}

          {completedTools.map((event, i) => {
            if (event.type !== "tool_completed") return null;
            return (
              <ToolDetail key={`detail-${i}`} toolCall={event.toolCall} />
            );
          })}
        </div>
      )}
    </div>
  );
}

function JudgeFeedback({
  result,
}: {
  result: {
    approved: boolean;
    summary: string;
    feedback: string[];
    missingRequirements: string[];
    confidence: number;
  };
}) {
  const confidencePercent = (result.confidence * 100).toFixed(0);
  const confidenceColor = result.confidence >= 0.7 ? "bg-emerald-500" : result.confidence >= 0.4 ? "bg-amber-500" : "bg-red-500";

  return (
    <div className="text-xs space-y-2 bg-white border border-gray-200 rounded-lg p-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-gray-700 font-semibold">Judge</span>
          <span className={`font-semibold ${result.approved ? "text-emerald-600" : "text-red-500"}`}>
            {result.approved ? "Approved" : "Rejected"}
          </span>
        </div>
        <span className="text-gray-500 font-medium">{confidencePercent}% confidence</span>
      </div>
      
      <div className="w-full h-1.5 bg-gray-200 rounded-full overflow-hidden">
        <div
          className={`h-full ${confidenceColor} transition-all duration-300`}
          style={{ width: `${confidencePercent}%` }}
        />
      </div>

      <p className="text-gray-700">{result.summary}</p>
      {result.feedback.map((f, i) => (
        <p key={i} className="text-gray-600 pl-2">— {f}</p>
      ))}
      {result.missingRequirements.map((r, i) => (
        <p key={i} className="text-amber-700 pl-2">Missing: {r}</p>
      ))}
    </div>
  );
}

function ToolDetail({
  toolCall,
}: {
  toolCall: {
    name: string;
    arguments: Record<string, unknown>;
    result?: unknown;
    status: string;
    error?: string;
  };
}) {
  const [showResult, setShowResult] = useState(false);

  return (
    <div className="text-xs">
      <button
        onClick={() => setShowResult(!showResult)}
        className="text-gray-700 hover:text-gray-900 font-medium"
      >
        {toolCall.name}({JSON.stringify(toolCall.arguments).slice(0, 60)}...)
      </button>
      {showResult && toolCall.result !== undefined && (
        <pre className="mt-2 p-2.5 bg-gray-900 rounded-lg text-gray-300 overflow-x-auto max-h-32 text-[10px]">
          {JSON.stringify(toolCall.result, null, 2)}
        </pre>
      )}
      {showResult && toolCall.error && (
        <div className="mt-2 p-2.5 bg-red-50 border border-red-200 rounded-lg text-red-700 whitespace-pre-wrap">
          {toolCall.error}
        </div>
      )}
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
        <button
          onClick={handleExport}
          className="px-3 py-1.5 text-xs bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-lg transition-colors font-medium flex items-center gap-1.5"
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
            <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
          </svg>
          Export
        </button>
      </div>

      <div className="text-gray-500 space-y-0.5">
        <div>Iterations: {run.iteration}</div>
        {run.tokenUsage && (
          <div>
            Tokens: {run.tokenUsage.totalTokens.toLocaleString()}
          </div>
        )}
        {run.estimatedCost !== undefined && (
          <div>Cost: ${run.estimatedCost.toFixed(2)}</div>
        )}
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

function formatToolName(name: string): string {
  const labels: Record<string, string> = {
    list_files: "Listed files",
    search_files: "Searched files",
    read_file: "Read file",
    write_file: "Wrote file",
    replace_in_file: "Replaced in file",
    create_file: "Created file",
    delete_file: "Deleted file",
    run_command: "Ran command",
    get_git_diff: "Got git diff",
  };
  return labels[name] ?? name;
}
