import { useEffect, useState } from "react";
import type { GoalRunEvent, GoalRunState } from "@conduit/shared";
import { useAppStore } from "@/stores/app-store";

function latestEvent<T extends GoalRunEvent["type"]>(
  events: GoalRunEvent[],
  type: T,
): Extract<GoalRunEvent, { type: T }> | undefined {
  return [...events].reverse().find((event): event is Extract<GoalRunEvent, { type: T }> => event.type === type);
}

function planForRun(events: GoalRunEvent[], run: GoalRunState | null) {
  return latestEvent(events, "plan_updated")?.plan ?? run?.plan;
}

export function GoalCanvasOverlay() {
  const mode = useAppStore((state) => state.mode);
  const runEvents = useAppStore((state) => state.runEvents);
  const currentRun = useAppStore((state) => state.currentRun);
  const isRunning = useAppStore((state) => state.isRunning);
  const maxIterations = useAppStore((state) => state.maxIterations);

  const plan = planForRun(runEvents, currentRun);
  const [showPlan, setShowPlan] = useState(false);
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

  useEffect(() => {
    if (!plan?.tasks.length) setShowPlan(false);
  }, [plan?.tasks.length]);

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
    <section className="rounded-xl border border-gray-200 bg-white/95 px-3 text-gray-500 shadow-sm backdrop-blur">
      <div className="flex h-11 items-center gap-4 whitespace-nowrap">
        <header className="flex items-center gap-3 min-w-0">
          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${runIndicatorClass}`} />
          <span className="text-xs font-semibold text-gray-700">Run in progress</span>
          <span className="text-[11px] text-gray-400">{formatElapsed(elapsedSeconds)}</span>
        </header>
        <div className="flex items-center gap-1">
          {Array.from({ length: totalIterations }, (_, index) => {
            const iteration = index + 1;
            const complete = iteration <= completedIterations;
            const active = isRunActive && iteration === currentIteration;
            return <span key={iteration} className={`flex h-4 w-4 items-center justify-center rounded-full text-[9px] font-semibold ${complete ? "bg-emerald-100 text-emerald-700" : active ? "bg-indigo-100 text-indigo-700" : "bg-gray-100 text-gray-400"}`}>{complete ? "✓" : iteration}</span>;
          })}
          <span className="ml-1 text-[10px] text-gray-400">Iteration {currentIteration}/{totalIterations}</span>
        </div>
        <div className="flex items-center gap-3 text-[11px] text-gray-400">
          <span>{toolCalls} tools</span>
          <span>{changedFiles} files changed</span>
        </div>
        {isRunActive && <div className={`flex min-w-0 flex-1 items-center gap-1.5 text-[11px] ${heartbeatFresh ? "text-emerald-700" : "text-amber-700"}`}>
          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${heartbeatFresh ? "bg-emerald-500" : "bg-amber-500"}`} />
          <span className="truncate">{heartbeat
            ? heartbeatFresh
              ? heartbeat.source === "process"
                ? `${heartbeat.provider} process confirmed alive ${formatAgo(heartbeatAge!)} ago`
                : `Waiting for ${heartbeat.provider} ${heartbeat.phase === "planning" ? "plan" : heartbeat.phase === "judging" ? "judge response" : "response"} · open ${formatAgo(requestAge!)} `
              : `No recent ${heartbeat.provider} confirmation · last ${formatAgo(heartbeatAge!)} ago`
            : "Waiting for agent confirmation…"}</span>
        </div>}
        {plan?.tasks.length ? <button type="button" onClick={() => setShowPlan((value) => !value)} className="flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-medium text-gray-600 hover:bg-gray-100 hover:text-gray-900" aria-expanded={showPlan}>
          Plan {plan.tasks.filter((task) => task.status === "completed").length}/{plan.tasks.length}
          <svg className={`h-3 w-3 transition-transform ${showPlan ? "rotate-180" : ""}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m6 9 6 6 6-6" /></svg>
        </button> : null}
      </div>
      {showPlan && plan?.tasks.length ? <div className="grid gap-1 border-t border-gray-200/60 py-2 sm:grid-cols-2 lg:grid-cols-3">
        {plan.tasks.map((task) => <div key={task.id} title={task.description} className={`flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-[11px] ${task.status === "in_progress" ? "bg-indigo-50 text-indigo-700" : "bg-gray-50 text-gray-600"}`}>
          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${task.status === "completed" ? "bg-emerald-500" : task.status === "in_progress" ? "bg-indigo-500" : task.status === "blocked" ? "bg-amber-500" : "bg-gray-300"}`} />
          <span className={`truncate ${task.status === "completed" ? "text-gray-400 line-through" : ""}`}>{task.description}</span>
        </div>)}
      </div> : null}
    </section>
  );
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

function formatAgo(seconds: number): string {
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m`;
}
