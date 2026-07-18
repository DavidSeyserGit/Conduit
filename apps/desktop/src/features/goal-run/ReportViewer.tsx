import { useState, type CSSProperties, type ReactNode } from "react";
import type { GoalReport } from "@conduit/shared";
import { exportGoalReport } from "@/lib/report-export";
import { getModeColor } from "@/lib/mode-colors";
import { goalRepository, useAppStore } from "@/stores/app-store";

const sections = ["overview", "goal", "clarifications", "implementation", "criteria", "evidence", "reviews", "decision"];

export function ReportViewer({ report, onClose }: { report: GoalReport; onClose: () => void }) {
  const [artifact, setArtifact] = useState<{ title: string; content?: string; error?: string } | null>(null);
  const [exportMessage, setExportMessage] = useState<string | null>(null);
  const goalColor = getModeColor(useAppStore((state) => state.settings), "goal");

  const openArtifact = async (artifactId: string, title: string) => {
    setArtifact({ title });
    try {
      const result = await goalRepository().readArtifact(artifactId);
      setArtifact({ title, content: result.content });
    } catch (error) {
      setArtifact({ title, error: `Artifact unavailable: ${error instanceof Error ? error.message : String(error)}` });
    }
  };

  const runExport = async (format: "markdown" | "json") => {
    setExportMessage(null);
    try {
      const saved = await exportGoalReport(report, format);
      if (saved) setExportMessage(`${format === "markdown" ? "Markdown" : "JSON"} report saved.`);
    } catch (error) {
      setExportMessage(`Could not export report: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  return (
    <div className="goal-builder space-y-6 rounded-2xl border border-gray-200 bg-white p-5 text-sm text-gray-700 shadow-sm" style={{ "--goal-accent": goalColor } as CSSProperties}>
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wider text-gray-400">Professional report</div>
          <h2 className="mt-1 text-xl font-semibold text-gray-900">{report.goal.title}</h2>
          <p className="text-xs text-gray-500">Schema v{report.schemaVersion} · generated {new Date(report.generatedAt).toLocaleString()}</p>
        </div>
        <div className="flex gap-2">
          <ExportButton onClick={() => void runExport("markdown")}>Markdown</ExportButton>
          <ExportButton onClick={() => void runExport("json")}>JSON</ExportButton>
          <button onClick={onClose} className="rounded-lg px-3 py-1.5 text-xs text-gray-500 hover:bg-gray-50">Close</button>
        </div>
      </header>
      {exportMessage ? <p role="status" className="text-xs text-gray-500">{exportMessage}</p> : null}

      <nav aria-label="Report sections" className="flex flex-wrap gap-2 border-y border-gray-100 py-3">
        {sections.map((section) => <a key={section} href={`#report-${section}`} className="goal-accent-soft rounded-full bg-gray-100 px-3 py-1 text-xs capitalize text-gray-600 hover:bg-gray-200">{section}</a>)}
      </nav>

      <ReportSection id="overview" title="Overview">
        <div className="grid gap-2 sm:grid-cols-2">
          <Datum label="Status" value={report.overview.finalStatus.replaceAll("_", " ")} tone={report.overview.finalStatus === "achieved" ? "pass" : report.overview.finalStatus === "cancelled" ? "warn" : "fail"} />
          <Datum label="Runtime" value={`${Math.round(report.overview.runtimeMs / 1000)}s`} />
          <Datum label="Started" value={new Date(report.overview.startedAt).toLocaleString()} />
          <Datum label="Finished" value={new Date(report.overview.finishedAt).toLocaleString()} />
          <Datum label="Implementation model" value={report.overview.implementationModelId} />
          <Datum label="Reviewer models" value={report.overview.reviewerModelIds.join(", ") || "None"} />
          <Datum label="Iterations" value={String(report.overview.totalIterations)} />
          {report.overview.tokenUsage ? <Datum label="Tokens" value={report.overview.tokenUsage.totalTokens.toLocaleString()} /> : null}
          {report.overview.estimatedCost !== undefined ? <Datum label="Estimated cost" value={`$${report.overview.estimatedCost.toFixed(4)}`} /> : null}
        </div>
      </ReportSection>

      <ReportSection id="goal" title="Goal definition">
        <p>{report.goal.description}</p>
        <ReportList title="Original request" values={[report.goal.originalRequest]} />
        <ReportList title="Constraints" values={report.goal.constraints.map((item) => item.description)} />
        <ReportList title="Deliverables" values={report.goal.deliverables.map((item) => item.description)} />
        <ReportList title="Assumptions" values={report.goal.assumptions.map((item) => `${item.description}${item.confirmed ? " (confirmed)" : ""}`)} />
      </ReportSection>

      <ReportSection id="clarifications" title="Clarification history">
        {report.clarifications.length === 0 ? <Empty>No clarification questions were recorded.</Empty> : <div className="space-y-3">
          {report.clarifications.map((item) => <article key={`${item.question.id}-${item.answer.answeredAt}`} className="rounded-xl border border-gray-200 p-3">
            <h4 className="font-semibold text-gray-900">{item.question.title}</h4>
            {item.question.description ? <p className="mt-1 text-xs text-gray-500">{item.question.description}</p> : null}
            {"options" in item.question && item.question.options?.length ? <p className="mt-2 text-xs text-gray-500">Options shown: {item.question.options.map((option) => option.label).join(" · ")}</p> : null}
            <p className="mt-2 text-xs"><strong>Answer:</strong> {formatValue(item.answer.value)} · {item.answer.answeredBy} · goal v{item.resultingGoalVersion}</p>
          </article>)}
        </div>}
      </ReportSection>

      <ReportSection id="implementation" title="Implementation summary">
        <p>{report.implementation.summary}</p>
        <ReportList title="Files" values={[...report.implementation.filesAdded.map((path) => `Added: ${path}`), ...report.implementation.filesChanged.map((path) => `Changed: ${path}`), ...report.implementation.filesDeleted.map((path) => `Deleted: ${path}`)]} />
        <ReportList title="Recorded decisions" values={report.implementation.decisions} />
        <ReportList title="Commands" values={report.implementation.commands} monospace />
      </ReportSection>

      <ReportSection id="criteria" title="Success criteria">
        <div className="space-y-3">{report.criteria.map((criterion) => {
          const definition = report.goal.successCriteria.find((item) => item.id === criterion.criterionId);
          return <article key={criterion.criterionId} className="rounded-xl border border-gray-200 p-3">
            <Datum label={definition?.description ?? criterion.criterionId} value={criterion.status.replaceAll("_", " ")} tone={criterion.status === "passed" ? "pass" : criterion.status === "warning" || criterion.status === "not_verified" ? "warn" : "fail"} />
            <p className="mt-2 text-xs text-gray-600">{criterion.summary}</p>
            <LinkedIds label="Evidence" ids={criterion.evidenceIds} target="evidence" />
            <LinkedIds label="Findings" ids={criterion.reviewFindingIds} target="finding" />
            {criterion.limitations.map((item) => <p key={item} className="mt-1 text-xs text-amber-700">{item}</p>)}
          </article>;
        })}</div>
      </ReportSection>

      <ReportSection id="evidence" title="Validation and evidence">
        {report.validationResults.length === 0 && report.evidence.length === 0 ? <Empty>No validation evidence was recorded.</Empty> : null}
        <div className="space-y-2">
          {report.validationResults.map((item) => <Datum key={item.id} label={item.command} value={item.passed ? "passed" : `failed (${item.exitCode})`} tone={item.passed ? "pass" : "fail"} />)}
          {report.evidence.map((item) => <article id={`report-evidence-${item.id}`} key={item.id} className="scroll-mt-4 rounded-xl border border-gray-200 p-3">
            <Datum label={item.title} value={item.freshness.status} tone={item.freshness.status === "fresh" ? "pass" : "warn"} />
            <p className="mt-2 whitespace-pre-wrap text-xs text-gray-600">{item.summary}</p>
            {item.freshness.staleReason ? <p className="mt-1 text-xs text-amber-700">{item.freshness.staleReason}</p> : null}
            {item.artifactId ? <button onClick={() => void openArtifact(item.artifactId!, item.title)} className="goal-accent-outline mt-2 text-xs font-semibold">Open full artifact</button> : null}
          </article>)}
        </div>
      </ReportSection>

      <ReportSection id="reviews" title="Reviewer results">
        {report.reviews.length === 0 ? <Empty>No reviewer results were recorded.</Empty> : <div className="space-y-3">{report.reviews.map((review) => <article key={review.id} className="rounded-xl border border-gray-200 p-3">
          <Datum label={review.reviewerId} value={review.status.replaceAll("_", " ")} tone={review.status === "approved" ? "pass" : review.status === "approved_with_warnings" || review.status === "not_applicable" ? "warn" : "fail"} />
          <p className="mt-2 text-xs">{review.summary} · {Math.round(review.confidence * 100)}% confidence · {new Date(review.reviewedAt).toLocaleString()}</p>
          {review.findings.map((finding) => <div id={`report-finding-${finding.id}`} key={finding.id} className="mt-2 scroll-mt-4 border-l-2 border-gray-200 pl-2 text-xs text-gray-600">
            <p><span className="font-semibold uppercase">{finding.severity}</span> · {finding.title}</p>
            <p>{finding.description}</p>
            {finding.remediation ? <p className="text-gray-500">Remediation: {finding.remediation}</p> : null}
          </div>)}
          {review.evidenceRequests.map((request) => <p key={request.id} className={`mt-1 text-xs ${request.status === "collected" ? "text-emerald-700" : "text-amber-700"}`}>Evidence {request.status}: {request.description}{request.evidenceIds.length ? ` (${request.evidenceIds.join(", ")})` : ""}</p>)}
        </article>)}</div>}
      </ReportSection>

      <ReportSection id="decision" title="Final decision">
        <Datum label={report.finalDecision.achieved ? "Goal achieved" : "Goal not achieved"} value={report.finalDecision.requiredReviewsPassed ? "Required reviews passed" : "Required reviews incomplete"} tone={report.finalDecision.achieved ? "pass" : "fail"} />
        <p className="mt-3">{report.finalDecision.summary}</p>
        <ReportList title="Warnings" values={report.finalDecision.warnings} />
        <ReportList title="Open findings" values={report.finalDecision.unresolvedFindingIds} />
        <ReportList title="Open evidence requests" values={report.finalDecision.unresolvedEvidenceRequestIds} />
        <ReportList title="Follow-up" values={report.finalDecision.followUps} />
      </ReportSection>

      {artifact ? <div role="dialog" aria-label={artifact.title} className="rounded-xl border border-gray-200 bg-gray-50 p-4">
        <div className="flex justify-between"><strong>{artifact.title}</strong><button onClick={() => setArtifact(null)} className="text-xs text-gray-500">Close</button></div>
        {artifact.error ? <p className="mt-2 text-sm text-amber-700">{artifact.error}</p> : artifact.content ? <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap text-xs">{artifact.content}</pre> : <p className="mt-2 text-xs text-gray-500">Loading artifact…</p>}
      </div> : null}
    </div>
  );
}

function ExportButton({ children, onClick }: { children: ReactNode; onClick: () => void }) { return <button onClick={onClick} className="goal-accent-outline rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-semibold hover:bg-gray-50">{children}</button>; }
function ReportSection({ id, title, children }: { id: string; title: string; children: ReactNode }) { return <section id={`report-${id}`} className="scroll-mt-4"><h3 className="mb-3 text-base font-semibold text-gray-900">{title}</h3>{children}</section>; }
function Empty({ children }: { children: ReactNode }) { return <p className="text-xs text-gray-500">{children}</p>; }
function Datum({ label, value, tone }: { label: string; value: string; tone?: "pass" | "warn" | "fail" }) { const color = tone === "pass" ? "text-emerald-600" : tone === "warn" ? "text-amber-600" : tone === "fail" ? "text-red-600" : "text-gray-700"; return <div className="flex items-center justify-between gap-3 rounded-lg bg-gray-50 px-3 py-2"><span className="text-xs text-gray-500">{label}</span><span className={`text-right text-xs font-semibold ${color}`}>{value}</span></div>; }
function LinkedIds({ label, ids, target }: { label: string; ids: string[]; target: "evidence" | "finding" }) { return ids.length ? <p className="mt-2 text-xs">{label}: {ids.map((id) => <a key={id} href={`#report-${target}-${id}`} className="goal-accent-outline mr-2 hover:underline">{id}</a>)}</p> : null; }
function ReportList({ title, values, monospace = false }: { title: string; values: string[]; monospace?: boolean }) { return values.length ? <div className="mt-3"><h4 className="text-xs font-semibold uppercase tracking-wide text-gray-400">{title}</h4><ul className={`mt-1 list-disc space-y-1 pl-5 text-xs ${monospace ? "font-mono" : ""}`}>{values.map((value, index) => <li key={`${index}-${value}`}>{value}</li>)}</ul></div> : null; }
function formatValue(value: unknown): string { return typeof value === "string" ? value : JSON.stringify(value); }
