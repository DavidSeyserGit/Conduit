import type { GoalRunEvent, LoopMetrics, IterationMetrics } from "@conduit/shared";

export function computeLoopMetrics(events: GoalRunEvent[]): LoopMetrics {
  const perIteration = computePerIterationMetrics(events);
  
  const totalIterations = perIteration.length;
  const totalToolCalls = perIteration.reduce((sum, m) => sum + m.toolCallCount, 0);
  const totalDurationMs = perIteration.reduce((sum, m) => sum + m.durationMs, 0);
  const averageConfidence = totalIterations > 0
    ? perIteration.reduce((sum, m) => sum + m.confidence, 0) / totalIterations
    : 0;
  const confidenceTrend = perIteration.map((m) => m.confidence);
  const approvedCount = perIteration.filter((m) => m.approved).length;
  const iterationsToComplete = approvedCount > 0
    ? perIteration.findIndex((m) => m.approved) + 1
    : totalIterations;
  const successRate = totalIterations > 0 ? approvedCount / totalIterations : 0;

  return {
    totalIterations,
    totalToolCalls,
    totalDurationMs,
    averageConfidence,
    confidenceTrend,
    iterationsToComplete,
    successRate,
    perIteration,
  };
}

function computePerIterationMetrics(events: GoalRunEvent[]): IterationMetrics[] {
  const iterationMap = new Map<number, {
    iteration: number;
    toolCallCount: number;
    startTime?: number;
    endTime?: number;
    confidence: number;
    approved: boolean;
    changedFiles: Set<string>;
    validationPassed: boolean;
  }>();

  let currentIteration = 0;

  for (const event of events) {
    if (event.type === "iteration_started") {
      currentIteration = event.iteration;
      iterationMap.set(currentIteration, {
        iteration: currentIteration,
        toolCallCount: 0,
        startTime: Date.now(),
        confidence: 0,
        approved: false,
        changedFiles: new Set(),
        validationPassed: true,
      });
    }

    const iter = iterationMap.get(currentIteration);
    if (!iter) continue;

    switch (event.type) {
      case "tool_completed":
        iter.toolCallCount++;
        break;
      case "file_changed":
        iter.changedFiles.add(event.path);
        break;
      case "validation_completed":
        if (!event.result.passed) {
          iter.validationPassed = false;
        }
        break;
      case "judge_completed":
        iter.confidence = event.result.confidence;
        iter.approved = event.result.approved;
        iter.endTime = Date.now();
        break;
      case "run_completed":
      case "run_failed":
        if (!iter.endTime) {
          iter.endTime = Date.now();
        }
        break;
    }
  }

  return Array.from(iterationMap.values()).map((iter) => ({
    iteration: iter.iteration,
    toolCallCount: iter.toolCallCount,
    durationMs: iter.startTime && iter.endTime ? iter.endTime - iter.startTime : 0,
    confidence: iter.confidence,
    approved: iter.approved,
    changedFiles: iter.changedFiles.size,
    validationPassed: iter.validationPassed,
  }));
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds}s`;
}
