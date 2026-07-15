import type { GoalRunState, GoalRunEvent, ExportedRun } from "@conduit/shared";
import { computeLoopMetrics } from "./metrics.js";

export function exportRunToJSON(
  run: GoalRunState,
  events: GoalRunEvent[]
): ExportedRun {
  const metrics = computeLoopMetrics(events);
  const totalDurationMs = run.finishedAt && run.startedAt
    ? new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime()
    : 0;

  return {
    version: "1.0",
    exportedAt: new Date().toISOString(),
    run: { ...run, metrics },
    events,
    metadata: {
      codingModelId: run.codingModelId,
      judgeModelId: run.judgeModelId,
      totalIterations: run.iteration,
      totalDurationMs,
    },
  };
}

export function downloadRunAsJSON(
  run: GoalRunState,
  events: GoalRunEvent[],
  filename?: string
): void {
  const exported = exportRunToJSON(run, events);
  const json = JSON.stringify(exported, null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  
  const defaultFilename = `conduit-run-${run.id.slice(0, 8)}-${new Date().toISOString().slice(0, 10)}.json`;
  const a = document.createElement("a");
  a.href = url;
  a.download = filename ?? defaultFilename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
