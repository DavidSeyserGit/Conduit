import { useEffect, useState } from "react";
import type { AgentPlan, GoalRunEvent, GoalRunState } from "@loopkit/shared";
import { useAppStore } from "@/stores/app-store";

function latestEvent<T extends GoalRunEvent["type"]>(
  events: GoalRunEvent[],
  type: T,
): Extract<GoalRunEvent, { type: T }> | undefined {
  return [...events].reverse().find((event): event is Extract<GoalRunEvent, { type: T }> => event.type === type);
}

function planForRun(events: GoalRunEvent[], run: GoalRunState | null): AgentPlan | undefined {
  return latestEvent(events, "plan_updated")?.plan ?? run?.plan;
}

export function GoalCanvasOverlay() {
  const mode = useAppStore((state) => state.mode);
  const runEvents = useAppStore((state) => state.runEvents);
  const currentRun = useAppStore((state) => state.currentRun);
  const workspacePath = useAppStore((state) => state.workspacePath);
  const activeProjectPath = useAppStore((state) => state.activeProjectPath);
  const isRunning = useAppStore((state) => state.isRunning);
  const maxIterations = useAppStore((state) => state.maxIterations);

  const plan = planForRun(runEvents, currentRun);
  const isWorktree = Boolean(activeProjectPath && workspacePath && workspacePath !== activeProjectPath);
  const started = latestEvent(runEvents, "run_started");
  const hasRun = Boolean(started || currentRun);
  const hasTerminalEvent = runEvents.some((event) => event.type === "run_completed" || event.type === "run_failed");
  // The stream is the source of truth for the visual state. This keeps the
  // marker live while a provider is working even if a transient UI flag resets.
  const isRunActive = isRunning || (hasRun && !hasTerminalEvent);
  const startedAt = started?.startedAt ?? currentRun?.startedAt;
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!isRunActive) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [isRunActive, startedAt]);

  if (mode !== "goal" || !hasRun || hasTerminalEvent) return null;

  const totalIterations = Math.min(10, Math.max(1, currentRun?.maxIterations || maxIterations));
  const latestIteration = latestEvent(runEvents, "iteration_started")?.iteration;
  const currentIteration = currentRun?.iteration || latestIteration || 1;
  const completedIterations = runEvents.filter((event) => event.type === "judge_completed").length;
  const toolCalls = runEvents.filter((event) => event.type === "tool_started").length;
  const changedFiles = new Set(runEvents.filter((event) => event.type === "file_changed").map((event) => event.path)).size;
  const elapsedSeconds = startedAt ? Math.max(0, Math.floor(((isRunActive ? now : new Date(currentRun?.finishedAt || Date.now()).getTime()) - new Date(startedAt).getTime()) / 1_000)) : 0;
  const heartbeat = latestEvent(runEvents, "agent_heartbeat");
  const heartbeatAge = heartbeat ? Math.max(0, Math.floor((now - new Date(heartbeat.at).getTime()) / 1_000)) : undefined;
  const heartbeatFresh = heartbeatAge !== undefined && heartbeatAge <= 25;
  const requestAge = heartbeat ? Math.max(0, Math.floor((now - new Date(heartbeat.startedAt).getTime()) / 1_000)) : undefined;
  const runIndicatorClass = !isRunActive
    ? "bg-gray-400"
    : heartbeatFresh
      ? "bg-emerald-500 animate-pulse"
      : "bg-amber-500 animate-pulse";

  return (
    <aside className="pointer-events-auto w-[220px] py-1 text-gray-500">
      <header className="px-1 pb-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${runIndicatorClass}`} />
          <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-gray-500">Run</span>
          <span className="truncate text-[11px] text-gray-400">{formatElapsed(elapsedSeconds)}</span>
        </div>
        <div className="mt-2 flex items-center gap-1">
          {Array.from({ length: totalIterations }, (_, index) => {
            const iteration = index + 1;
            const complete = iteration <= completedIterations;
            const active = isRunActive && iteration === currentIteration;
            return <span key={iteration} className={`flex h-4 w-4 items-center justify-center rounded-full text-[9px] font-semibold ${complete ? "bg-emerald-100 text-emerald-700" : active ? "bg-indigo-100 text-indigo-700" : "bg-gray-100 text-gray-400"}`}>{complete ? "✓" : iteration}</span>;
          })}
          <span className="ml-1 text-[10px] text-gray-400">Iteration {currentIteration}/{totalIterations}</span>
        </div>
      </header>

      <div className="space-y-1 border-t border-gray-200/60 px-1 pt-2 text-[10px] text-gray-400">
        <div>{toolCalls} tool calls</div>
        <div>{changedFiles} changed files</div>
      </div>

      {isRunActive && <div className={`mt-2 flex items-center gap-1.5 px-1 text-[10px] ${heartbeatFresh ? "text-emerald-700" : "text-amber-700"}`}>
        <span className={`h-1.5 w-1.5 rounded-full ${heartbeatFresh ? "bg-emerald-500" : "bg-amber-500"}`} />
        {heartbeat
          ? heartbeatFresh
            ? heartbeat.source === "process"
              ? `${heartbeat.provider} process confirmed alive ${formatAgo(heartbeatAge!)} ago`
              : `Waiting for ${heartbeat.provider} ${heartbeat.phase === "planning" ? "plan" : heartbeat.phase === "judging" ? "judge response" : "response"} · open ${formatAgo(requestAge!)} `
            : `No recent ${heartbeat.provider} confirmation · last ${formatAgo(heartbeatAge!)} ago`
          : "Waiting for agent confirmation…"}
      </div>}

      {plan?.tasks.length ? <section className="mt-3 border-t border-gray-200/60 pt-2.5">
        <div className="flex items-center justify-between gap-2 px-1 pb-1">
          <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-gray-400">Plan</span>
          <span className="text-[10px] text-gray-400">{plan.tasks.filter((task) => task.status === "completed").length}/{plan.tasks.length}</span>
        </div>
        <div className="space-y-1">
          {plan.tasks.slice(0, 6).map((task) => (
            <div key={task.id} className={`flex items-start gap-2 rounded-md px-1 py-1 text-[11px] leading-snug ${task.status === "in_progress" ? "bg-white/55 text-indigo-700 backdrop-blur-sm" : "text-gray-500"}`}>
              <span className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${task.status === "completed" ? "bg-emerald-500" : task.status === "in_progress" ? "bg-indigo-500" : task.status === "blocked" ? "bg-amber-500" : "bg-gray-300"}`} />
              <span className={task.status === "completed" ? "text-gray-400 line-through" : ""}>{task.description}</span>
            </div>
          ))}
        </div>
      </section> : null}

      <footer className="mt-3 border-t border-gray-200/60 px-1 pt-2 text-[10px]">
        <div className="font-semibold uppercase tracking-[0.12em] text-gray-400">Workspace</div>
        <div className={`mt-1 ${isWorktree ? "text-emerald-700" : "text-gray-500"}`}>{isWorktree ? "isolated worktree" : "project root"}</div>
      </footer>
    </aside>
  );
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

function formatAgo(seconds: number): string {
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m`;
}
