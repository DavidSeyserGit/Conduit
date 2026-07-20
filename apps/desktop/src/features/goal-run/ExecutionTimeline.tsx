import { useEffect, useRef, useState } from "react";
import type { GoalRunEvent, GoalRunState } from "@conduit/shared";
import type { GoalReport, ReviewResult } from "@conduit/cgs/legacy";
import type { GoalReport as CgsGoalReport } from "@conduit/cgs";
import { downloadRunAsJSON } from "@conduit/runtime";
import ReactMarkdown from "react-markdown";
import { useAppStore } from "@/stores/app-store";
import { getModeColor } from "@/lib/mode-colors";
import { GoalCanvasOverlay } from "@/features/goal-run/GoalCanvasOverlay";
import { formatToolCall } from "@/features/goal-run/tool-call-display";
import { GitHandoff } from "@/features/git/GitHandoff";
import { GoalBuilder } from "@/features/goal-builder/GoalBuilder";
import { useGoalBuilderStore } from "@/stores/goal-builder-store";
import { ReportViewer } from "@/features/goal-run/ReportViewer";

export function ChatTimeline() {
  const messages = useAppStore((s) => s.messages);
  const runEvents = useAppStore((s) => s.runEvents);
  const currentRun = useAppStore((s) => s.currentRun);
  const isRunning = useAppStore((s) => s.isRunning);
  const mode = useAppStore((s) => s.mode);
  const goalBuilderPhase = useGoalBuilderStore((s) => s.phase);
  const settings = useAppStore((s) => s.settings);
  const runHistory = useAppStore((s) => s.runHistory);
  const modeStatusColor = getModeColor(settings, mode);
  const bottomRef = useRef<HTMLDivElement>(null);
  const hasActiveRun = mode === "goal"
    && (runEvents.some((event) => event.type === "run_started") || Boolean(currentRun))
    && !runEvents.some((event) => event.type === "run_completed" || event.type === "run_failed");

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, runEvents, currentRun, isRunning]);

  if (mode === "goal" && goalBuilderPhase !== "idle") return <GoalBuilder />;

  if (messages.length === 0 && runEvents.length === 0) {
    return (
      <div className="flex-1 min-h-0 overflow-y-auto flex items-center justify-center">
        <div className="text-center max-w-md px-4">
          <h1 className="text-2xl font-semibold text-gray-900 mb-2">Welcome to Conduit</h1>
          <p className="text-sm text-gray-500">
            Select a project, choose a mode, and start chatting or set a goal.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {hasActiveRun && <div className="shrink-0 px-6 pt-4 pb-2 border-b border-gray-100 bg-white">
        <div className="max-w-6xl mx-auto"><GoalCanvasOverlay /></div>
      </div>}
      <div className="relative flex-1 min-h-0 overflow-y-auto px-6 py-6">
        <div className="max-w-6xl mx-auto space-y-6">
        {messages.map((msg) => (
          <div key={msg.id} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
            <div className={`max-w-[82%] ${msg.role === "user" ? "items-end" : "items-start"}`}>
              <div className="text-[11px] font-medium text-gray-400 mb-1 px-1">
                {msg.role === "user" ? "You" : "Conduit"}
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
            if (/^(Kilo|Codex|Pi) (started|finished) a step|^(Kilo|Codex|Pi) is still working/i.test(event.message)) return null;
            return (
              <div key={`status-${i}`} className="flex justify-start">
                <div className="text-xs px-1 text-gray-400">{event.message}</div>
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
          if (event.type === "reviews_routed") {
            const reviewers = event.decision.requiredReviewers.map(reviewerLabel);
            return (
              <div key={`routing-${i}`} className="flex justify-start">
                <div className="text-xs px-1 text-gray-400">
                  Review route: {reviewers.length > 0 ? reviewers.join(" · ") : "No specialist review required"}
                </div>
              </div>
            );
          }
          if (event.type === "general_review_completed") {
            return <ReviewResultCard key={`general-review-${i}`} label="General review" result={event.result} />;
          }
          if (event.type === "specialist_review_completed") {
            return <ReviewResultCard key={`specialist-review-${i}`} label={reviewerLabel(event.result.reviewerId)} result={event.result} />;
          }
          if (event.type === "evidence_collection_started") {
            return (
              <div key={`evidence-started-${i}`} className="flex justify-start">
                <div className="text-xs px-1 text-gray-400">
                  Collecting {event.requestIds.length} evidence item{event.requestIds.length === 1 ? "" : "s"}…
                </div>
              </div>
            );
          }
          if (event.type === "evidence_collected") {
            return (
              <div key={`evidence-collected-${i}`} className="flex justify-start">
                <div className="text-xs px-1 text-emerald-600">
                  ✓ {event.reused ? "Reused" : "Collected"} {event.evidence.title}
                </div>
              </div>
            );
          }
          if (event.type === "evidence_request_updated" && ["failed", "rejected", "stale"].includes(event.request.status)) {
            return (
              <div key={`evidence-request-${i}`} className="flex justify-start">
                <div className="text-xs px-1 text-amber-600">
                  Evidence {event.request.status}: {event.request.description}
                </div>
              </div>
            );
          }
          if (event.type === "judge_completed") {
            if (runEvents.some((candidate) => candidate.type === "general_review_completed")) return null;
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
            const display = formatToolCall(tool, completed);
            return (
              <div key={`tool-${i}`} className="flex justify-start">
                <div className="text-xs text-gray-500 px-1">
                  <span className={completed && tool.status === "failed" ? "text-red-500" : "text-emerald-500"}>
                    {completed ? (tool.status === "failed" ? "✗" : "✓") : "⋯"}
                  </span>{" "}
                  <span style={{ color: completed && tool.status === "failed" ? undefined : modeStatusColor }}>
                    {completed
                      ? tool.status === "failed" ? "Could not complete" : "Finished"
                      : `${display.name.charAt(0).toUpperCase()}${display.name.slice(1)}`}
                    {completed ? ` ${display.name}` : null}
                  </span>
                  {display.detail ? <span className="text-gray-400"> {display.detail}</span> : null}
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
          <RunSummary
            run={currentRun}
            events={runEvents}
            report={runHistory.find((entry) => entry.run.id === currentRun.id)?.cgsReport
              ?? runHistory.find((entry) => entry.run.id === currentRun.id)?.report
              ?? [...runEvents].reverse().find((event) => event.type === "run_completed")?.result.cgsReport
              ?? [...runEvents].reverse().find((event) => event.type === "run_completed")?.result.report}
          />
        )}
        <div ref={bottomRef} />
        </div>
      </div>
    </div>
  );
}

function ReviewResultCard({ label, result }: { label: string; result: ReviewResult }) {
  const approved = result.status === "approved" || result.status === "approved_with_warnings";
  const warning = result.status === "approved_with_warnings" || result.status === "needs_evidence";
  const statusColor = approved ? "text-emerald-600" : warning ? "text-amber-600" : "text-red-500";
  return (
    <div className="flex justify-start">
      <div className="max-w-[82%]">
        <div className="flex items-center gap-2 text-[11px] font-medium text-gray-400 mb-1 px-1">
          <span>{label}</span>
          <span>· {Math.round(result.confidence * 100)}% confidence</span>
        </div>
        <div className="bg-white border border-gray-200 rounded-2xl rounded-bl-md px-4 py-3 shadow-sm space-y-2">
          <div className={`text-sm font-semibold ${statusColor}`}>{formatReviewStatus(result.status)}</div>
          <p className="text-sm text-gray-700">{result.summary}</p>
          {result.findings.map((finding) => (
            <div key={finding.id} className="text-xs text-gray-600 pl-2">
              <span className="font-medium uppercase text-[10px]">{finding.severity}</span> · {finding.title}
              {finding.filePath ? <span className="text-gray-400"> — {finding.filePath}{finding.lineStart ? `:${finding.lineStart}` : ""}</span> : null}
            </div>
          ))}
          {result.evidenceRequests.map((request) => (
            <p key={request.id} className="text-xs text-amber-700 pl-2">Evidence: {request.description}</p>
          ))}
        </div>
      </div>
    </div>
  );
}

function reviewerLabel(id: string): string {
  return id.split("_").map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`).join(" ");
}

function formatReviewStatus(status: ReviewResult["status"]): string {
  return status.split("_").map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`).join(" ");
}

function RunSummary({
  run,
  events,
  report,
}: {
  run: GoalRunState;
  events: GoalRunEvent[];
  report?: GoalReport | CgsGoalReport;
}) {
  const [showReport, setShowReport] = useState(Boolean(report));
  const openGitDiff = useAppStore((s) => s.openGitDiff);
  const models = useAppStore((s) => s.models);
  const goalColor = getModeColor(useAppStore((s) => s.settings), "goal");
  useEffect(() => {
    if (report) setShowReport(true);
  }, [report]);
  const elapsed = run.finishedAt
    ? Math.round(
        (new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime()) / 1000
      )
    : 0;

  const statusLabel: Record<string, string> = {
    completed: "Goal completed",
    cancelled: "Goal cancelled",
    iteration_limit_reached: "Iteration limit reached",
    blocked: "Validation environment unavailable",
    failed: "Goal failed",
  };

  const handleExport = () => {
    downloadRunAsJSON(run, events);
  };

  if (report && showReport) return <ReportViewer report={report} onClose={() => setShowReport(false)} />;

  return (
    <div className="goal-builder border border-gray-200 rounded-xl p-4 bg-white text-xs space-y-2" style={{ "--goal-accent": goalColor } as React.CSSProperties}>
      <div className="flex items-center justify-between">
        <div className="font-semibold text-gray-900 text-sm">
          {statusLabel[run.status] ?? run.status}
        </div>
        <div className="flex items-center gap-2">
          {report ? <button onClick={() => setShowReport(true)} className="goal-accent-soft px-3 py-1.5 text-xs rounded-lg transition-colors font-medium">View report</button> : null}
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

      <ProofOfWorkCard run={run} models={models} elapsed={elapsed} />
      <GitHandoff workspacePath={run.workspacePath} goal={run.goal} />
    </div>
  );
}

function ProofOfWorkCard({
  run,
  models,
  elapsed,
}: {
  run: GoalRunState;
  models: Array<{ id: string; displayName: string }>;
  elapsed: number;
}) {
  const [copied, setCopied] = useState(false);
  const latestJudge = [...run.iterations].reverse().find((iteration) => iteration.judgeResult)?.judgeResult;
  const changedFiles = new Set(run.iterations.flatMap((iteration) => iteration.changedFiles));
  const validationResults = run.iterations.flatMap((iteration) => iteration.validationResults);
  const passedValidations = validationResults.filter((result) => result.passed).length;
  const blockedValidations = validationResults.filter((result) => result.outcome === "blocked_environment").length;
  const totalTools = run.iterations.reduce((total, iteration) => total + iteration.toolCalls.length, 0);
  const approved = run.status === "completed" && latestJudge?.approved;
  const worker = modelName(run.codingModelId, models);
  const judge = modelName(run.judgeModelId, models);
  const verdict = approved
    ? "Ready to review"
    : run.status === "blocked"
      ? "Implementation ready; validation environment unavailable"
      : run.status === "failed"
        ? "Run needs attention"
        : "Not yet approved";

  const receipt = [
    "Conduit proof of work",
    `Verdict: ${verdict}${latestJudge ? ` (${Math.round(latestJudge.confidence * 100)}% judge confidence)` : ""}`,
    `Goal: ${run.goal}`,
    `Worker: ${worker}`,
    `Judge: ${judge}`,
    `Versions: Desktop ${run.conduitDesktopVersion ?? "legacy"} · Runtime ${run.conduitRuntimeVersion ?? "legacy"} · CGS ${run.cgsVersion ?? "legacy"}`,
    `Evidence: ${changedFiles.size} files changed · ${passedValidations}/${validationResults.length} validations passed${blockedValidations ? ` · ${blockedValidations} environment-blocked` : ""} · ${totalTools} tool calls · ${formatElapsed(elapsed)}`,
    latestJudge?.summary ? `Judge: ${latestJudge.summary}` : "",
  ].filter(Boolean).join("\n");

  const copyReceipt = async () => {
    try {
      await navigator.clipboard.writeText(receipt);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard access is browser-policy dependent; the receipt remains visible.
    }
  };

  return (
    <section className="pt-3 border-t border-gray-100">
      <div className="rounded-xl border border-gray-200 bg-gradient-to-br from-white to-gray-50 p-3.5 space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-[10px] uppercase tracking-[0.12em] font-semibold text-gray-400">Proof of work</div>
            <div className={`mt-1 text-sm font-semibold ${approved ? "text-emerald-700" : "text-gray-800"}`}>{verdict}</div>
          </div>
          <button onClick={() => void copyReceipt()} className="shrink-0 px-2.5 py-1.5 text-[11px] font-medium text-gray-700 bg-white border border-gray-200 hover:border-gray-300 rounded-lg transition-colors">
            {copied ? "Copied" : "Copy receipt"}
          </button>
        </div>

        <p className="text-xs text-gray-700 leading-relaxed line-clamp-2">{run.goal}</p>

        <div className="grid grid-cols-2 gap-2 text-[11px]">
          <EvidenceItem label="Worker" value={worker} />
          <EvidenceItem label="Judge" value={judge} />
          <EvidenceItem label="Evidence" value={`${changedFiles.size} files · ${totalTools} tools`} />
          <EvidenceItem label="Validation" value={validationResults.length ? `${passedValidations}/${validationResults.length} passed` : "Not run"} />
          <EvidenceItem label="Contracts" value={`Runtime ${run.conduitRuntimeVersion ?? "legacy"} · CGS ${run.cgsVersion ?? "legacy"}`} />
        </div>

        <div className="flex items-center justify-between gap-3 pt-0.5 text-[10px] text-gray-400">
          <span>{formatElapsed(elapsed)} · {run.iteration} iteration{run.iteration === 1 ? "" : "s"}</span>
          {latestJudge && <span>{Math.round(latestJudge.confidence * 100)}% judge confidence</span>}
        </div>
      </div>
    </section>
  );
}

function EvidenceItem({ label, value }: { label: string; value: string }) {
  return <div className="min-w-0 rounded-lg bg-white/80 border border-gray-100 px-2.5 py-2"><div className="text-[9px] uppercase tracking-wide text-gray-400">{label}</div><div className="mt-0.5 truncate text-gray-700 font-medium" title={value}>{value}</div></div>;
}

function modelName(id: string, models: Array<{ id: string; displayName: string }>): string {
  return models.find((model) => model.id === id)?.displayName ?? id.split("/").slice(-2).join("/");
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function formatCost(cost: number): string {
  return cost > 0 && cost < 0.0001 ? "<$0.0001" : `$${cost.toFixed(4)}`;
}
