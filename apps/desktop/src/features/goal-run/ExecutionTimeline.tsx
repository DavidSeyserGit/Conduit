import { useState } from "react";
import type { GoalRunEvent } from "@loopkit/shared";
import ReactMarkdown from "react-markdown";
import { useAppStore } from "@/stores/app-store";
import { WelcomeCards } from "@/features/welcome/WelcomeCards";

export function ChatTimeline() {
  const messages = useAppStore((s) => s.messages);
  const runEvents = useAppStore((s) => s.runEvents);
  const currentRun = useAppStore((s) => s.currentRun);
  const isRunning = useAppStore((s) => s.isRunning);

  if (messages.length === 0 && runEvents.length === 0) {
    return (
      <div className="flex-1 min-h-0 overflow-y-auto flex flex-col">
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center max-w-lg px-4">
            <h1 className="text-3xl font-bold text-gray-900 mb-2">Welcome to LoopKit</h1>
            <p className="text-sm text-gray-500 mb-8 max-w-md mx-auto">
              Get started by asking questions. LoopKit can do the rest. Not sure where to start?
            </p>
            <WelcomeCards />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-0 overflow-y-auto px-6 py-6">
      <div className="max-w-3xl mx-auto space-y-6">
        {messages.map((msg) => (
          <div key={msg.id} className="flex gap-3">
            {msg.role === "user" && (
              <div className="w-7 h-7 rounded-full bg-gradient-to-br from-emerald-400 to-teal-600 flex items-center justify-center text-white text-xs font-semibold shrink-0 mt-0.5">
                U
              </div>
            )}
            <div className={`flex-1 ${msg.role === "user" ? "" : "ml-10"}`}>
              <div className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-1">
                {msg.role === "user" ? "You" : "LoopKit"}
              </div>
              <div className="text-sm text-gray-800 prose prose-sm max-w-none leading-relaxed">
                <ReactMarkdown>{msg.content}</ReactMarkdown>
                {msg.isStreaming && (
                  <span className="inline-block w-1.5 h-4 bg-indigo-500 animate-pulse ml-0.5 rounded" />
                )}
              </div>
            </div>
          </div>
        ))}

        {runEvents.length > 0 && <GoalRunTimeline events={runEvents} />}

        {currentRun && !isRunning && (
          <RunSummary run={currentRun} />
        )}
      </div>
    </div>
  );
}

function GoalRunTimeline({ events }: { events: GoalRunEvent[] }) {
  const iterations = groupByIteration(events);

  return (
    <div className="border-t border-gray-200 pt-5 space-y-3">
      <div className="text-xs font-semibold text-indigo-600 uppercase tracking-wider">
        Goal Execution
      </div>

      {events.some((e) => e.type === "run_started") && (
        <div className="text-sm text-gray-500">Goal started</div>
      )}

      {iterations.map((iter) => (
        <IterationBlock key={iter.number} iteration={iter} />
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
  const judgeApproved =
    iteration.judgeResult?.type === "judge_completed"
      ? iteration.judgeResult.result.approved
      : undefined;

  return (
    <div className="border border-gray-200 rounded-xl overflow-hidden bg-white">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-4 py-3 bg-gray-50 hover:bg-gray-100 transition-colors text-left"
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

      <div className="px-4 py-2.5 space-y-1.5">
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
  return (
    <div className="text-xs space-y-1.5 bg-white border border-gray-200 rounded-lg p-3">
      <div className="flex items-center gap-2">
        <span className="text-gray-700 font-semibold">Judge</span>
        <span className={`font-semibold ${result.approved ? "text-emerald-600" : "text-red-500"}`}>
          {result.approved ? "Approved" : "Rejected"}
        </span>
        <span className="text-gray-400">
          ({(result.confidence * 100).toFixed(0)}%)
        </span>
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
    </div>
  );
}

function RunSummary({
  run,
}: {
  run: {
    status: string;
    iteration: number;
    tokenUsage?: { promptTokens: number; completionTokens: number; totalTokens: number };
    estimatedCost?: number;
    startedAt: string;
    finishedAt?: string;
  };
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

  return (
    <div className="border border-gray-200 rounded-xl p-4 bg-gradient-to-br from-indigo-50 to-white text-xs space-y-1.5">
      <div className="font-semibold text-gray-900 text-sm">
        {statusLabel[run.status] ?? run.status}
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
