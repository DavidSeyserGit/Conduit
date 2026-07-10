import { useState } from "react";
import type { GoalRunEvent } from "@loopkit/shared";
import ReactMarkdown from "react-markdown";
import { useAppStore } from "@/stores/app-store";

export function ChatTimeline() {
  const messages = useAppStore((s) => s.messages);
  const runEvents = useAppStore((s) => s.runEvents);
  const currentRun = useAppStore((s) => s.currentRun);
  const isRunning = useAppStore((s) => s.isRunning);

  if (messages.length === 0 && runEvents.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-zinc-500 text-sm">
        <div className="text-center max-w-md">
          <p className="text-lg font-medium text-zinc-400 mb-2">Welcome to LoopKit</p>
          <p>Select a project directory, choose a mode, and start chatting or set a goal.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
      {messages.map((msg) => (
        <div key={msg.id} className="space-y-1">
          <div className="text-xs font-medium text-zinc-500 uppercase tracking-wider">
            {msg.role === "user" ? "User" : "Agent"}
          </div>
          <div className="text-sm text-zinc-200 prose prose-invert prose-sm max-w-none">
            <ReactMarkdown>{msg.content}</ReactMarkdown>
            {msg.isStreaming && (
              <span className="inline-block w-1.5 h-4 bg-indigo-400 animate-pulse ml-0.5" />
            )}
          </div>
        </div>
      ))}

      {runEvents.length > 0 && <GoalRunTimeline events={runEvents} />}

      {currentRun && !isRunning && (
        <RunSummary run={currentRun} />
      )}
    </div>
  );
}

function GoalRunTimeline({ events }: { events: GoalRunEvent[] }) {
  const iterations = groupByIteration(events);

  return (
    <div className="space-y-3 border-t border-zinc-800 pt-4">
      <div className="text-xs font-medium text-indigo-400 uppercase tracking-wider">
        Goal Execution
      </div>

      {events.some((e) => e.type === "run_started") && (
        <div className="text-sm text-zinc-400">Goal started</div>
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
    <div className="border border-zinc-800 rounded-lg overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-3 py-2 bg-zinc-900/50 hover:bg-zinc-800/50 transition-colors text-left"
      >
        <span className="text-sm font-medium text-zinc-300">
          Iteration {iteration.number}
        </span>
        <div className="flex items-center gap-2">
          {completedTools.length > 0 && (
            <span className="text-xs text-zinc-500">
              {completedTools.length} tool{completedTools.length !== 1 ? "s" : ""}
            </span>
          )}
          {judgeApproved !== undefined && (
            <span
              className={`text-xs font-medium ${
                judgeApproved ? "text-green-400" : "text-red-400"
              }`}
            >
              {judgeApproved ? "Approved" : "Rejected"}
            </span>
          )}
          <svg
            className={`w-3.5 h-3.5 text-zinc-500 transition-transform ${expanded ? "rotate-180" : ""}`}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
          </svg>
        </div>
      </button>

      <div className="px-3 py-2 space-y-1">
        {completedTools.map((event, i) => {
          if (event.type !== "tool_completed") return null;
          const tc = event.toolCall;
          const icon = tc.status === "completed" ? "✓" : "✗";
          return (
            <div key={i} className="text-xs text-zinc-400 flex items-start gap-1.5">
              <span className={tc.status === "completed" ? "text-green-500" : "text-red-500"}>
                {icon}
              </span>
              <span>
                {formatToolName(tc.name)}
                {tc.error && <span className="text-red-400 ml-1">— {tc.error}</span>}
              </span>
            </div>
          );
        })}

        {iteration.validations.map((event, i) => {
          if (event.type !== "validation_completed") return null;
          const v = event.result;
          return (
            <div key={`v-${i}`} className="text-xs text-zinc-400 flex items-start gap-1.5">
              <span className={v.passed ? "text-green-500" : "text-red-500"}>
                {v.passed ? "✓" : "✗"}
              </span>
              <span>Ran: {v.command}</span>
            </div>
          );
        })}
      </div>

      {expanded && (
        <div className="px-3 py-2 border-t border-zinc-800 space-y-2">
          {iteration.planUpdated?.type === "plan_updated" && (
            <div className="text-xs">
              <span className="text-zinc-500">Plan: </span>
              <span className="text-zinc-300">{iteration.planUpdated.plan.summary}</span>
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
    <div className="text-xs space-y-1.5 bg-zinc-900/80 rounded p-2">
      <div className="flex items-center gap-2">
        <span className="text-zinc-500 font-medium">Judge</span>
        <span className={result.approved ? "text-green-400" : "text-red-400"}>
          {result.approved ? "Approved" : "Rejected"}
        </span>
        <span className="text-zinc-600">
          ({(result.confidence * 100).toFixed(0)}% confidence)
        </span>
      </div>
      <p className="text-zinc-300">{result.summary}</p>
      {result.feedback.map((f, i) => (
        <p key={i} className="text-zinc-400 pl-2">— {f}</p>
      ))}
      {result.missingRequirements.map((r, i) => (
        <p key={i} className="text-amber-400/80 pl-2">Missing: {r}</p>
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
        className="text-zinc-500 hover:text-zinc-300"
      >
        {toolCall.name}({JSON.stringify(toolCall.arguments).slice(0, 60)}...)
      </button>
      {showResult && toolCall.result !== undefined && (
        <pre className="mt-1 p-2 bg-zinc-950 rounded text-zinc-400 overflow-x-auto max-h-32 text-[10px]">
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
    <div className="border border-zinc-800 rounded-lg p-3 bg-zinc-900/30 text-xs space-y-1">
      <div className="font-medium text-zinc-300">
        {statusLabel[run.status] ?? run.status}
      </div>
      <div className="text-zinc-500 space-y-0.5">
        <div>Iterations: {run.iteration}</div>
        {run.tokenUsage && (
          <>
            <div>
              Coding tokens: {run.tokenUsage.totalTokens.toLocaleString()}
            </div>
          </>
        )}
        {run.estimatedCost !== undefined && (
          <div>Estimated cost: ${run.estimatedCost.toFixed(2)}</div>
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
