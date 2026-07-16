import type { GoalRunEvent, GoalRunState } from "@conduit/shared";

export function RunRail({
  events,
  currentRun,
  maxIterations,
  isRunning,
}: {
  events: GoalRunEvent[];
  currentRun: GoalRunState | null;
  maxIterations: number;
  isRunning: boolean;
}) {
  if (!events.some((event) => event.type === "run_started")) return null;

  const totalIterations = Math.min(10, Math.max(1, currentRun?.maxIterations || maxIterations));
  const latestIteration = [...events].reverse().find((event) => event.type === "iteration_started");
  const currentIteration = currentRun?.iteration || (latestIteration?.type === "iteration_started" ? latestIteration.iteration : 1);
  const completedIterations = events.filter((event) => event.type === "judge_completed").length;
  const changedFiles = new Set(events.filter((event) => event.type === "file_changed").map((event) => event.path)).size;
  const toolCalls = events.filter((event) => event.type === "tool_started").length;
  const failed = events.some((event) => event.type === "run_failed");
  const complete = events.some((event) => event.type === "run_completed");

  return (
    <div className="flex items-center gap-2 min-w-0 px-1 py-1 text-[11px] text-gray-500" title={`${complete ? "Run complete" : failed ? "Run stopped" : "Run in progress"} · ${currentIteration}/${totalIterations} iterations · ${toolCalls} tools · ${changedFiles} files changed`}>
      <span className="uppercase tracking-wide text-[10px] font-semibold text-gray-400">Run</span>
      <div className="flex items-center gap-1">
        {Array.from({ length: totalIterations }, (_, index) => {
          const iteration = index + 1;
          const iterationComplete = complete || iteration <= completedIterations;
          const iterationActive = !complete && !failed && iteration === currentIteration;
          return (
            <span
              key={iteration}
              className={`w-4 h-4 rounded-full flex items-center justify-center text-[9px] font-semibold transition-colors duration-300 ${
                iterationComplete
                  ? "bg-emerald-100 text-emerald-700"
                  : iterationActive
                    ? "bg-indigo-100 text-indigo-700 run-rail-current"
                    : "bg-gray-100 text-gray-400"
              }`}
            >
              {iterationComplete ? "✓" : iteration}
            </span>
          );
        })}
      </div>
      <span className="whitespace-nowrap text-gray-500">{currentIteration}/{totalIterations}</span>
      <span className="hidden sm:inline text-gray-300">·</span>
      <span className="hidden sm:inline whitespace-nowrap">{toolCalls} tools</span>
      <span className="hidden md:inline whitespace-nowrap">{changedFiles} files</span>
      {!isRunning && <span className={`hidden md:inline ${failed ? "text-red-500" : "text-emerald-600"}`}>{failed ? "stopped" : "done"}</span>}
    </div>
  );
}
