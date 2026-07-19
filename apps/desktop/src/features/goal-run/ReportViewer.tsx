import { useMemo, useState, type CSSProperties, type ReactNode } from "react";
import type { GoalReport, ReviewFinding, ReviewResult } from "@conduit/cgs/legacy";
import type { GoalReport as CgsGoalReport } from "@conduit/cgs";
import { exportGoalReport } from "@/lib/report-export";
import { getModeColor } from "@/lib/mode-colors";
import { goalRepository, useAppStore } from "@/stores/app-store";
import {
  formatClarificationAnswer,
  formatDuration,
  humanize,
  implementationPreview,
  reportStats,
  type ReportViewId,
  type ReviewGroup,
} from "./report-view-model";

const reportViews: Array<{ id: ReportViewId; label: string; description: string }> = [
  { id: "summary", label: "Summary", description: "Outcome and next steps" },
  { id: "goal", label: "Goal", description: "Contract and decisions" },
  { id: "changes", label: "Changes", description: "Implementation record" },
  { id: "evidence", label: "Evidence", description: "Validation and artifacts" },
  { id: "reviews", label: "Reviews", description: "Current verdicts and history" },
];

type Tone = "success" | "warning" | "danger" | "neutral";

export function ReportViewer({ report, onClose }: { report: GoalReport | CgsGoalReport; onClose: () => void }) {
  return isCgsReport(report)
    ? <CanonicalReportViewer report={report} onClose={onClose} />
    : <LegacyReportViewer report={report} onClose={onClose} />;
}

function isCgsReport(report: GoalReport | CgsGoalReport): report is CgsGoalReport {
  return (report as { kind?: unknown }).kind === "report" && (report as { cgsVersion?: unknown }).cgsVersion === "0.1.0";
}

function CanonicalReportViewer({ report, onClose }: { report: CgsGoalReport; onClose: () => void }) {
  const [exportMessage, setExportMessage] = useState<string | null>(null);
  const runExport = async (format: "markdown" | "json") => {
    try { if (await exportGoalReport(report, format)) setExportMessage(`${format === "markdown" ? "Markdown" : "JSON"} report saved.`); }
    catch (error) { setExportMessage(`Could not export report: ${error instanceof Error ? error.message : String(error)}`); }
  };
  const achieved = report.decision === "completed" || report.decision === "completed_with_warnings";
  return <article className="overflow-hidden rounded-2xl border border-gray-200 bg-white text-sm text-gray-700 shadow-sm" aria-labelledby="cgs-report-title">
    <header className="border-b border-gray-200 bg-gradient-to-b from-white to-gray-50 px-6 py-5">
      <div className="flex items-start justify-between gap-4"><div><div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-gray-400">CGS {report.cgsVersion} report · Goal revision {report.goalRevision}</div><h2 id="cgs-report-title" className="mt-2 text-2xl font-semibold text-gray-900">{report.goalSnapshot.title}</h2><p className="mt-2 max-w-3xl leading-6 text-gray-600">{report.summary}</p></div><button type="button" onClick={onClose} aria-label="Close report" className="rounded-lg px-3 py-2 text-gray-500 hover:bg-gray-100">Close</button></div>
      <div className="mt-4 flex flex-wrap gap-2"><span className={`rounded-full px-3 py-1 text-xs font-semibold ${achieved ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-700"}`}>{humanize(report.decision)}</span><button type="button" onClick={() => void runExport("markdown")} className="rounded-lg border border-gray-200 px-3 py-1 text-xs font-semibold">Export Markdown</button><button type="button" onClick={() => void runExport("json")} className="rounded-lg border border-gray-200 px-3 py-1 text-xs font-semibold">Export JSON</button></div>
      {exportMessage ? <p role="status" className="mt-3 text-xs text-gray-500">{exportMessage}</p> : null}
    </header>
    <div className="grid gap-5 p-6 lg:grid-cols-2">
      <CanonicalSection title="Success criteria">{report.goalSnapshot.successCriteria.map((criterion) => <CanonicalItem key={criterion.id} title={criterion.description} detail={criterion.priority} />)}</CanonicalSection>
      <CanonicalSection title="Implementation"><p>{report.implementationSummary.summary}</p><p className="mt-2 text-xs text-gray-500">{report.implementationSummary.filesAdded.length} added · {report.implementationSummary.filesChanged.length} changed · {report.implementationSummary.filesDeleted.length} deleted · {report.implementationSummary.attempts} attempts</p></CanonicalSection>
      <CanonicalSection title="Validation and evidence"><p>{report.validationSummary.summary}</p><p className="mt-2 text-xs text-gray-500">{report.evidenceSummary.summary}</p>{report.evidenceSummary.staleArtifactIds.length ? <p className="mt-2 text-xs font-medium text-amber-700">{report.evidenceSummary.staleArtifactIds.length} stale artifacts excluded</p> : null}</CanonicalSection>
      <CanonicalSection title="Reviewer outcomes">{report.reviewerSummaries.length ? report.reviewerSummaries.map((review) => <CanonicalItem key={review.reviewResultId} title={`${review.reviewerId} · ${humanize(review.status)}`} detail={review.summary} />) : <p className="text-gray-400">No reviewer summaries.</p>}</CanonicalSection>
      {(report.knownRisks.length || report.suggestedFollowUps.length) ? <CanonicalSection title="Risks and follow-ups">{report.knownRisks.map((risk) => <CanonicalItem key={risk.id} title={risk.description} detail={`${risk.severity} risk`} />)}{report.suggestedFollowUps.map((followUp) => <CanonicalItem key={followUp.id} title={followUp.description} detail={followUp.priority} />)}</CanonicalSection> : null}
    </div>
  </article>;
}

function CanonicalSection({ title, children }: { title: string; children: ReactNode }) { return <section className="rounded-xl border border-gray-200 p-4"><h3 className="mb-3 font-semibold text-gray-900">{title}</h3><div className="space-y-3">{children}</div></section>; }
function CanonicalItem({ title, detail }: { title: string; detail: string }) { return <div><p className="font-medium text-gray-800">{title}</p><p className="mt-0.5 text-xs text-gray-500">{detail}</p></div>; }

function LegacyReportViewer({ report, onClose }: { report: GoalReport; onClose: () => void }) {
  const [activeView, setActiveView] = useState<ReportViewId>("summary");
  const [artifact, setArtifact] = useState<{ title: string; content?: string; error?: string } | null>(null);
  const [exportMessage, setExportMessage] = useState<string | null>(null);
  const [showExportMenu, setShowExportMenu] = useState(false);
  const goalColor = getModeColor(useAppStore((state) => state.settings), "goal");
  const stats = useMemo(() => reportStats(report), [report]);

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

  const navigateTo = (view: ReportViewId, targetId?: string) => {
    setActiveView(view);
    if (targetId) requestAnimationFrame(() => requestAnimationFrame(() => document.getElementById(targetId)?.scrollIntoView({ behavior: "smooth", block: "center" })));
  };

  return (
    <article
      className="goal-builder overflow-hidden rounded-2xl border border-gray-200 bg-white text-sm text-gray-700 shadow-sm"
      style={{ "--goal-accent": goalColor } as CSSProperties}
      aria-labelledby="report-title"
    >
      <header className="border-b border-gray-200 bg-gradient-to-b from-white to-gray-50 px-5 pb-5 pt-4 sm:px-6">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-gray-400">
            <span className="goal-accent-dot h-2 w-2 rounded-full" aria-hidden="true" />
            Run report
            <span className="font-normal normal-case tracking-normal text-gray-400">· Goal v{report.goal.version} · Runtime {report.overview.conduitRuntimeVersion ?? "legacy"} · CGS {report.overview.cgsVersion ?? "legacy"}</span>
          </div>
          <div className="flex items-center gap-1.5">
            <div className="relative" onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setShowExportMenu(false); }}>
              <button
                type="button"
                aria-haspopup="menu"
                aria-expanded={showExportMenu}
                onClick={() => setShowExportMenu((visible) => !visible)}
                className="goal-accent-outline inline-flex h-8 items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 text-xs font-semibold text-gray-700 transition-colors hover:bg-gray-50"
              >
                <DownloadIcon />
                Export
                <SmallChevronIcon />
              </button>
              {showExportMenu ? <div role="menu" aria-label="Export report" className="absolute right-0 top-10 z-30 w-52 rounded-xl border border-gray-200 bg-white p-1.5 shadow-xl">
                <ExportMenuItem icon={<DocumentIcon />} title="Markdown" description="Readable project report" onClick={() => { setShowExportMenu(false); void runExport("markdown"); }} />
                <ExportMenuItem icon={<CodeIcon />} title="JSON" description="Structured report data" onClick={() => { setShowExportMenu(false); void runExport("json"); }} />
              </div> : null}
            </div>
            <button type="button" onClick={onClose} aria-label="Close report" className="ml-1 grid h-8 w-8 place-items-center rounded-lg text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700">
              <CloseIcon />
            </button>
          </div>
        </div>
        <div className="mt-4 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div className="min-w-0">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <StatusBadge status={report.overview.finalStatus} />
              <span className="text-xs text-gray-500">Generated {formatDate(report.generatedAt)}</span>
            </div>
            <h2 id="report-title" className="truncate text-2xl font-semibold tracking-tight text-gray-900">{report.goal.title}</h2>
            <p className="mt-1 max-w-3xl text-sm leading-6 text-gray-600">{report.finalDecision.summary}</p>
          </div>
          <div className="flex shrink-0 flex-wrap gap-x-5 gap-y-2 text-xs text-gray-500">
            <HeaderMetric label="Runtime" value={formatDuration(report.overview.runtimeMs)} />
            <HeaderMetric label="Iterations" value={String(report.overview.totalIterations)} />
            <HeaderMetric label="Criteria" value={`${stats.passedCriteria}/${report.criteria.length} passed`} />
          </div>
        </div>
        {exportMessage ? <div role="status" className="mt-3 rounded-lg bg-gray-100 px-3 py-2 text-xs text-gray-600">{exportMessage}</div> : null}
      </header>

      <nav aria-label="Report views" className="border-b border-gray-200 bg-white px-3 sm:px-5">
        <div role="tablist" className="flex gap-1 overflow-x-auto py-2">
          {reportViews.map((view) => (
            <button
              key={view.id}
              type="button"
              role="tab"
              aria-selected={activeView === view.id}
              aria-controls={`report-panel-${view.id}`}
              onClick={() => setActiveView(view.id)}
              className={`group min-w-fit rounded-lg px-3 py-2 text-left transition-colors ${activeView === view.id ? "goal-accent-selected" : "hover:bg-gray-50"}`}
            >
              <span className={`block text-xs font-semibold ${activeView === view.id ? "text-gray-900" : "text-gray-600"}`}>{view.label}</span>
              <span className="mt-0.5 hidden text-[10px] text-gray-400 sm:block">{view.description}</span>
            </button>
          ))}
        </div>
      </nav>

      <div className="p-4 sm:p-6">
        {activeView === "summary" ? <SummaryView report={report} onNavigate={navigateTo} /> : null}
        {activeView === "goal" ? <GoalView report={report} /> : null}
        {activeView === "changes" ? <ChangesView report={report} /> : null}
        {activeView === "evidence" ? <EvidenceView report={report} onOpenArtifact={openArtifact} /> : null}
        {activeView === "reviews" ? <ReviewsView groups={stats.reviewGroups} /> : null}
      </div>

      {artifact ? <ArtifactDialog artifact={artifact} onClose={() => setArtifact(null)} /> : null}
    </article>
  );
}

function SummaryView({ report, onNavigate }: { report: GoalReport; onNavigate: (view: ReportViewId, targetId?: string) => void }) {
  const stats = reportStats(report);
  const achieved = report.finalDecision.achieved;
  const needsAttention = stats.attentionCount > 0 || !achieved;
  return (
    <div id="report-panel-summary" role="tabpanel" className="space-y-6">
      <section className={`overflow-hidden rounded-2xl border ${achieved ? "border-emerald-200 bg-emerald-50" : "border-red-200 bg-red-50"}`}>
        <div className="flex gap-4 p-4 sm:p-5">
          <div className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl ${achieved ? "bg-emerald-100 text-emerald-700" : "bg-red-100 text-red-700"}`}>
            {achieved ? <CheckIcon /> : <AlertIcon />}
          </div>
          <div className="min-w-0 flex-1">
            <p className={`text-xs font-semibold uppercase tracking-wider ${achieved ? "text-emerald-700" : "text-red-700"}`}>{achieved ? "Goal achieved" : "Goal not achieved"}</p>
            <h3 className="mt-1 text-lg font-semibold text-gray-900">{achieved ? "All completion gates passed" : "The run stopped before completion"}</h3>
            <p className="mt-1.5 max-w-3xl text-sm leading-6 text-gray-700">{report.finalDecision.summary}</p>
          </div>
        </div>
      </section>

      <section aria-label="Run health" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <MetricCard label="Success criteria" value={`${stats.passedCriteria} of ${report.criteria.length}`} detail={stats.passedCriteria === report.criteria.length ? "All passed" : "Need review"} tone={stats.passedCriteria === report.criteria.length ? "success" : "warning"} />
        <MetricCard label="Reviewer state" value={`${stats.approvedReviews} of ${stats.reviewGroups.length}`} detail="Current verdicts clear" tone={stats.approvedReviews === stats.reviewGroups.length ? "success" : "warning"} />
        <MetricCard label="Fresh evidence" value={String(stats.freshEvidence)} detail={`${report.validationResults.filter((item) => item.passed).length} validations passed`} tone={report.validationResults.some((item) => !item.passed) ? "danger" : "success"} />
        <MetricCard label="Needs attention" value={String(stats.attentionCount)} detail={stats.attentionCount ? "Warnings or follow-ups" : "Nothing outstanding"} tone={stats.attentionCount ? "warning" : "neutral"} />
      </section>

      {needsAttention ? <AttentionPanel report={report} onNavigate={onNavigate} /> : null}

      <ReportBlock title="Success criteria" description="The agreed definition of done, linked to its supporting evidence and review findings." action={<button type="button" onClick={() => onNavigate("goal")} className="goal-accent-outline text-xs font-semibold">View goal contract</button>}>
        <div className="divide-y divide-gray-100">
          {report.criteria.map((criterion) => {
            const definition = report.goal.successCriteria.find((item) => item.id === criterion.criterionId);
            const tone = criterion.status === "passed" ? "success" : criterion.status === "warning" || criterion.status === "not_verified" ? "warning" : "danger";
            return <div key={criterion.criterionId} className="flex flex-col gap-3 py-4 first:pt-0 last:pb-0 sm:flex-row sm:items-start">
              <div className={`mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full ${toneClasses(tone).soft}`}>
                {tone === "success" ? <SmallCheckIcon /> : <SmallAlertIcon />}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <h4 className="font-medium leading-5 text-gray-900">{definition?.description ?? criterion.criterionId}</h4>
                  <StatePill label={humanize(criterion.status)} tone={tone} />
                </div>
                <p className="mt-1 text-xs leading-5 text-gray-600">{criterion.summary}</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {criterion.evidenceIds.length ? <button type="button" onClick={() => onNavigate("evidence", `report-evidence-${criterion.evidenceIds[0]}`)} className="goal-accent-soft rounded-md px-2 py-1 text-[11px] font-medium">{criterion.evidenceIds.length} evidence item{criterion.evidenceIds.length === 1 ? "" : "s"}</button> : null}
                  {criterion.reviewFindingIds.length ? <button type="button" onClick={() => onNavigate("reviews")} className="rounded-md bg-amber-50 px-2 py-1 text-[11px] font-medium text-amber-800">{criterion.reviewFindingIds.length} linked finding{criterion.reviewFindingIds.length === 1 ? "" : "s"}</button> : null}
                </div>
              </div>
            </div>;
          })}
        </div>
      </ReportBlock>

      <details className="group rounded-xl border border-gray-200 bg-gray-50">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-4 py-3 text-xs font-semibold text-gray-700">
          Run details and model usage
          <ChevronIcon />
        </summary>
        <div className="grid gap-3 border-t border-gray-200 p-4 sm:grid-cols-2 lg:grid-cols-3">
          <Detail label="Started" value={formatDate(report.overview.startedAt)} />
          <Detail label="Finished" value={formatDate(report.overview.finishedAt)} />
          <Detail label="Implementation model" value={report.overview.implementationModelId} />
          <Detail label="Reviewer models" value={report.overview.reviewerModelIds.join(", ") || "None"} />
          {report.overview.tokenUsage ? <Detail label="Tokens" value={report.overview.tokenUsage.totalTokens.toLocaleString()} /> : null}
          {report.overview.estimatedCost !== undefined ? <Detail label="Estimated cost" value={`$${report.overview.estimatedCost.toFixed(4)}`} /> : null}
        </div>
      </details>
    </div>
  );
}

function GoalView({ report }: { report: GoalReport }) {
  return <div id="report-panel-goal" role="tabpanel" className="space-y-6">
    <ReportBlock title="Approved goal" description={`Version ${report.goal.version} · the contract used by implementation and every reviewer.`}>
      <p className="text-base leading-7 text-gray-800">{report.goal.description}</p>
      <div className="mt-4 rounded-xl border-l-4 border-gray-300 bg-gray-50 px-4 py-3">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">Original request</p>
        <p className="mt-1 text-sm text-gray-700">{report.goal.originalRequest}</p>
      </div>
    </ReportBlock>
    <div className="grid gap-4 lg:grid-cols-2">
      <StructuredListCard title="Constraints" values={report.goal.constraints.map((item) => item.description)} />
      <StructuredListCard title="Deliverables" values={report.goal.deliverables.map((item) => item.description)} />
      <StructuredListCard title="Assumptions" values={report.goal.assumptions.map((item) => item.description)} badges={report.goal.assumptions.map((item) => item.confirmed ? "Confirmed" : "Unconfirmed")} />
      <StructuredListCard title="Success criteria" values={report.goal.successCriteria.map((item) => item.description)} />
    </div>
    <ReportBlock title="Clarification history" description="Product decisions that shaped the approved goal. Repository facts are resolved automatically and do not appear here.">
      {report.clarifications.length === 0 ? <EmptyState icon={<QuestionIcon />} title="No clarification needed" description="The initial request and repository context were sufficient to build the goal." /> : <ol className="space-y-0">
        {report.clarifications.map((item, index) => <li key={`${item.question.id}-${item.answer.answeredAt}`} className="relative grid grid-cols-[28px_1fr] gap-3 pb-5 last:pb-0">
          {index < report.clarifications.length - 1 ? <span className="absolute bottom-0 left-[13px] top-7 w-px bg-gray-200" aria-hidden="true" /> : null}
          <span className="goal-accent-soft z-10 grid h-7 w-7 place-items-center rounded-full text-[11px] font-semibold">{index + 1}</span>
          <div className="rounded-xl border border-gray-200 bg-gray-50 p-4">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <h4 className="font-semibold text-gray-900">{item.question.title}</h4>
              <span className="rounded-md bg-gray-100 px-2 py-1 text-[10px] font-medium text-gray-500">Goal v{item.resultingGoalVersion}</span>
            </div>
            {item.question.description ? <p className="mt-1 text-xs leading-5 text-gray-500">{item.question.description}</p> : null}
            <div className="mt-3 flex items-start gap-2 rounded-lg bg-white px-3 py-2.5">
              <SmallCheckIcon />
              <div><p className="text-[10px] font-semibold uppercase tracking-wide text-gray-400">Selected answer</p><p className="mt-0.5 text-sm font-medium text-gray-800">{formatClarificationAnswer(item)}</p></div>
            </div>
          </div>
        </li>)}
      </ol>}
    </ReportBlock>
  </div>;
}

function ChangesView({ report }: { report: GoalReport }) {
  const fileGroups = [
    { label: "Added", values: report.implementation.filesAdded, tone: "success" as Tone },
    { label: "Changed", values: report.implementation.filesChanged, tone: "neutral" as Tone },
    { label: "Deleted", values: report.implementation.filesDeleted, tone: "danger" as Tone },
  ];
  return <div id="report-panel-changes" role="tabpanel" className="space-y-6">
    <ReportBlock title="Implementation" description="A concise record of what the coding agent changed. The full narrative remains available for audit.">
      <p className="text-sm leading-6 text-gray-700">{implementationPreview(report.implementation.summary)}</p>
      {implementationPreview(report.implementation.summary) !== report.implementation.summary ? <details className="mt-3 rounded-lg bg-gray-50">
        <summary className="cursor-pointer list-none px-3 py-2 text-xs font-semibold text-gray-600">Read full implementation narrative</summary>
        <p className="border-t border-gray-200 px-3 py-3 text-xs leading-5 text-gray-600">{report.implementation.summary}</p>
      </details> : null}
    </ReportBlock>
    <section>
      <div className="mb-3 flex items-end justify-between gap-3"><div><h3 className="text-base font-semibold text-gray-900">Files changed</h3><p className="mt-1 text-xs text-gray-500">Grouped by repository operation.</p></div><span className="text-xs font-medium text-gray-500">{fileGroups.reduce((total, group) => total + group.values.length, 0)} total</span></div>
      <div className="grid gap-3 lg:grid-cols-3">
        {fileGroups.map((group) => <div key={group.label} className="rounded-xl border border-gray-200 bg-gray-50 p-3">
          <div className="flex items-center justify-between"><h4 className="text-xs font-semibold text-gray-700">{group.label}</h4><StatePill label={String(group.values.length)} tone={group.tone} /></div>
          {group.values.length ? <ul className="mt-3 space-y-2">{group.values.map((path) => <li key={path} className="break-all rounded-md bg-white px-2.5 py-2 font-mono text-[11px] text-gray-600">{path}</li>)}</ul> : <p className="mt-3 text-xs text-gray-400">No files {group.label.toLowerCase()}.</p>}
        </div>)}
      </div>
    </section>
    <AuditDetails title="Recorded decisions" count={report.implementation.decisions.length} values={report.implementation.decisions} />
    <AuditDetails title="Commands executed" count={report.implementation.commands.length} values={report.implementation.commands} monospace />
  </div>;
}

function EvidenceView({ report, onOpenArtifact }: { report: GoalReport; onOpenArtifact: (artifactId: string, title: string) => Promise<void> }) {
  return <div id="report-panel-evidence" role="tabpanel" className="space-y-6">
    <ReportBlock title="Validation runs" description="Commands executed by the runtime to validate the implementation.">
      {report.validationResults.length === 0 ? <EmptyState icon={<EvidenceIcon />} title="No validation commands" description="This run did not record command-level validation." /> : <div className="divide-y divide-gray-100">
        {report.validationResults.map((item) => <div key={item.id} className="flex items-start gap-3 py-3 first:pt-0 last:pb-0">
          <span className={`mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full ${item.passed ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-700"}`}>{item.passed ? <SmallCheckIcon /> : <SmallAlertIcon />}</span>
          <div className="min-w-0 flex-1"><code className="break-all text-xs text-gray-700">{item.command}</code><p className="mt-1 text-[11px] text-gray-400">Exit code {item.exitCode}</p></div>
          <StatePill label={item.passed ? "Passed" : "Failed"} tone={item.passed ? "success" : "danger"} />
        </div>)}
      </div>}
    </ReportBlock>
    <section>
      <div className="mb-3"><h3 className="text-base font-semibold text-gray-900">Collected evidence</h3><p className="mt-1 text-xs text-gray-500">Reusable proof gathered for reviewers. Stale items remain visible but cannot approve the run.</p></div>
      {report.evidence.length === 0 ? <EmptyState icon={<EvidenceIcon />} title="No evidence collected" description="No reviewer requested additional evidence for this run." /> : <div className="grid gap-3 lg:grid-cols-2">
        {report.evidence.map((item) => <article id={`report-evidence-${item.id}`} key={item.id} className="scroll-mt-24 rounded-xl border border-gray-200 bg-gray-50 p-4">
          <div className="flex items-start justify-between gap-3"><div className="min-w-0"><p className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">{humanize(item.type)}</p><h4 className="mt-1 font-semibold text-gray-900">{item.title}</h4></div><StatePill label={humanize(item.freshness.status)} tone={item.freshness.status === "fresh" ? "success" : "warning"} /></div>
          <p className="mt-3 max-h-28 overflow-auto whitespace-pre-wrap text-xs leading-5 text-gray-600">{item.summary}</p>
          {item.freshness.staleReason ? <p className="mt-2 rounded-md bg-amber-50 px-2.5 py-2 text-xs text-amber-800">{item.freshness.staleReason}</p> : null}
          <div className="mt-3 flex items-center justify-between gap-3 text-[11px] text-gray-400"><span>{formatDate(item.collectedAt)}</span>{item.artifactId ? <button type="button" onClick={() => void onOpenArtifact(item.artifactId!, item.title)} className="goal-accent-outline font-semibold">Open full artifact</button> : null}</div>
        </article>)}
      </div>}
    </section>
  </div>;
}

function ReviewsView({ groups }: { groups: ReviewGroup[] }) {
  const applicable = groups.filter((group) => group.latest.status !== "not_applicable");
  const notApplicable = groups.filter((group) => group.latest.status === "not_applicable");
  return <div id="report-panel-reviews" role="tabpanel" className="space-y-6">
    <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between"><div><h3 className="text-base font-semibold text-gray-900">Reviewer decisions</h3><p className="mt-1 text-xs text-gray-500">Each card shows the current verdict. Older rounds are retained as expandable history.</p></div><span className="text-xs font-medium text-gray-500">{applicable.length} applicable · {notApplicable.length} not applicable</span></div>
    {groups.length === 0 ? <EmptyState icon={<ReviewIcon />} title="No reviews recorded" description="The run stopped before reviewer routing completed." /> : null}
    <div className="space-y-4">{applicable.map((group) => <ReviewerCard key={group.reviewerId} group={group} />)}</div>
    {notApplicable.length ? <details className="rounded-xl border border-gray-200 bg-gray-50">
      <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3 text-xs font-semibold text-gray-600"><span>{notApplicable.length} reviewer{notApplicable.length === 1 ? " was" : "s were"} not applicable</span><ChevronIcon /></summary>
      <div className="space-y-2 border-t border-gray-200 p-3">{notApplicable.map((group) => <ReviewerCard key={group.reviewerId} group={group} compact />)}</div>
    </details> : null}
  </div>;
}

function ReviewerCard({ group, compact = false }: { group: ReviewGroup; compact?: boolean }) {
  const review = group.latest;
  const tone = reviewTone(review.status);
  return <article id={`report-review-${group.reviewerId}`} className={`scroll-mt-24 rounded-xl border border-gray-200 bg-white ${compact ? "p-3" : "p-4 sm:p-5"}`}>
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="flex items-start gap-3"><span className={`grid h-11 w-11 shrink-0 place-items-center rounded-xl ${toneClasses(tone).soft}`}><ReviewIcon /></span><div><p className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">{group.reviewerId === "general" ? "Completion and routing" : "Specialist reviewer"}</p><h4 className={`${compact ? "text-lg" : "text-xl sm:text-2xl"} mt-0.5 font-semibold leading-tight tracking-tight text-gray-900`}>{humanize(group.reviewerId)} review</h4></div></div>
      <div className="flex items-center gap-2"><span className="text-[11px] text-gray-400">{Math.round(review.confidence * 100)}% confidence</span><StatePill label={humanize(review.status)} tone={tone} /></div>
    </div>
    <p className={`${compact ? "mt-2" : "mt-4"} text-xs leading-5 text-gray-600`}>{review.summary}</p>
    {!compact && review.findings.length ? <div className="mt-4 space-y-2">{review.findings.map((finding) => <FindingCard key={finding.id} finding={finding} />)}</div> : null}
    {!compact && review.evidenceRequests.length ? <div className="mt-4 space-y-2"><p className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">Evidence requests</p>{review.evidenceRequests.map((request) => <div key={request.id} className="flex items-start justify-between gap-3 rounded-lg bg-gray-50 px-3 py-2.5"><p className="text-xs leading-5 text-gray-600">{request.description}</p><StatePill label={humanize(request.status)} tone={request.status === "collected" ? "success" : request.status === "failed" || request.status === "rejected" ? "danger" : "warning"} /></div>)}</div> : null}
    {group.history.length ? <details className="mt-4 rounded-lg bg-gray-50">
      <summary className="flex cursor-pointer list-none items-center justify-between px-3 py-2.5 text-xs font-semibold text-gray-600"><span>Previous rounds <span className="ml-1 font-normal text-gray-400">({group.history.length})</span></span><ChevronIcon /></summary>
      <div className="space-y-3 border-t border-gray-200 p-3">{group.history.map((previous, index) => <div key={previous.id} className="border-l-2 border-gray-200 pl-3"><div className="flex flex-wrap items-center justify-between gap-2"><span className="text-[11px] font-semibold text-gray-500">Round {group.history.length - index}</span><div className="flex items-center gap-2"><span className="text-[10px] text-gray-400">{formatDate(previous.reviewedAt)}</span><StatePill label={humanize(previous.status)} tone={reviewTone(previous.status)} /></div></div><p className="mt-1.5 text-xs leading-5 text-gray-600">{previous.summary}</p>{previous.findings.length ? <p className="mt-1 text-[11px] text-gray-400">{previous.findings.length} finding{previous.findings.length === 1 ? "" : "s"} recorded in this round</p> : null}</div>)}</div>
    </details> : null}
  </article>;
}

function FindingCard({ finding }: { finding: ReviewFinding }) {
  const tone = finding.severity === "critical" || finding.severity === "high" ? "danger" : finding.severity === "medium" || finding.severity === "low" ? "warning" : "neutral";
  return <div className="rounded-lg border border-gray-200 bg-gray-50 p-3">
    <div className="flex flex-wrap items-start justify-between gap-2"><h5 className="text-xs font-semibold text-gray-800">{finding.title}</h5><StatePill label={humanize(finding.severity)} tone={tone} /></div>
    <p className="mt-1.5 text-xs leading-5 text-gray-600">{finding.description}</p>
    {finding.filePath ? <p className="mt-2 break-all font-mono text-[10px] text-gray-400">{finding.filePath}{finding.lineStart ? `:${finding.lineStart}` : ""}</p> : null}
    {finding.remediation ? <div className="mt-2 rounded-md bg-white px-2.5 py-2 text-xs leading-5 text-gray-600"><span className="font-semibold text-gray-700">Recommended fix:</span> {finding.remediation}</div> : null}
  </div>;
}

function AttentionPanel({ report, onNavigate }: { report: GoalReport; onNavigate: (view: ReportViewId) => void }) {
  const items = [
    ...report.finalDecision.warnings.map((text) => ({ label: "Warning", text, view: "reviews" as ReportViewId })),
    ...report.finalDecision.followUps.map((text) => ({ label: "Follow-up", text, view: "reviews" as ReportViewId })),
    ...report.finalDecision.unresolvedFindingIds.map((text) => ({ label: "Open finding", text, view: "reviews" as ReportViewId })),
    ...report.finalDecision.unresolvedEvidenceRequestIds.map((text) => ({ label: "Missing evidence", text, view: "evidence" as ReportViewId })),
  ];
  if (!items.length && !report.finalDecision.achieved) items.push({ label: "Blocked", text: "Required reviews did not reach an approvable state.", view: "reviews" });
  return <ReportBlock title="Needs attention" description="Outstanding items carried forward from the final decision.">
    <div className="space-y-2">{items.slice(0, 6).map((item, index) => <button key={`${item.label}-${index}`} type="button" onClick={() => onNavigate(item.view)} className="flex w-full items-start gap-3 rounded-lg bg-amber-50 px-3 py-2.5 text-left transition-colors hover:bg-amber-100"><SmallAlertIcon /><span className="min-w-0 flex-1"><span className="text-[10px] font-semibold uppercase tracking-wide text-amber-700">{item.label}</span><span className="mt-0.5 block text-xs leading-5 text-amber-800">{item.text}</span></span><ArrowIcon /></button>)}</div>
  </ReportBlock>;
}

function ReportBlock({ title, description, action, children }: { title: string; description?: string; action?: ReactNode; children: ReactNode }) {
  return <section className="rounded-xl border border-gray-200 bg-white p-4 sm:p-5"><div className="mb-4 flex items-start justify-between gap-4"><div><h3 className="text-base font-semibold text-gray-900">{title}</h3>{description ? <p className="mt-1 text-xs leading-5 text-gray-500">{description}</p> : null}</div>{action}</div>{children}</section>;
}

function MetricCard({ label, value, detail, tone }: { label: string; value: string; detail: string; tone: Tone }) { return <div className="rounded-xl border border-gray-200 bg-gray-50 p-3.5"><div className="flex items-center justify-between gap-2"><p className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">{label}</p><span className={`h-2 w-2 rounded-full ${toneClasses(tone).dot}`} /></div><p className="mt-2 text-xl font-semibold tracking-tight text-gray-900">{value}</p><p className="mt-0.5 text-[11px] text-gray-500">{detail}</p></div>; }
function HeaderMetric({ label, value }: { label: string; value: string }) { return <div><span className="text-[10px] uppercase tracking-wide text-gray-400">{label}</span><span className="ml-2 font-semibold text-gray-700">{value}</span></div>; }
function Detail({ label, value }: { label: string; value: string }) { return <div className="min-w-0"><p className="text-[10px] font-semibold uppercase tracking-wide text-gray-400">{label}</p><p className="mt-1 break-words text-xs font-medium text-gray-700">{value}</p></div>; }

function StructuredListCard({ title, values, badges }: { title: string; values: string[]; badges?: string[] }) { return <section className="rounded-xl border border-gray-200 bg-gray-50 p-4"><div className="flex items-center justify-between"><h3 className="text-sm font-semibold text-gray-900">{title}</h3><span className="text-[11px] text-gray-400">{values.length}</span></div>{values.length ? <ul className="mt-3 space-y-2.5">{values.map((value, index) => <li key={`${index}-${value}`} className="flex items-start gap-2 text-xs leading-5 text-gray-600"><span className="goal-accent-dot mt-2 h-1.5 w-1.5 shrink-0 rounded-full" /><span className="flex-1">{value}</span>{badges?.[index] ? <span className="rounded bg-white px-1.5 py-0.5 text-[10px] text-gray-500">{badges[index]}</span> : null}</li>)}</ul> : <p className="mt-3 text-xs text-gray-400">None recorded.</p>}</section>; }

function AuditDetails({ title, count, values, monospace = false }: { title: string; count: number; values: string[]; monospace?: boolean }) { return <details className="rounded-xl border border-gray-200 bg-gray-50"><summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3 text-xs font-semibold text-gray-700"><span>{title} <span className="ml-1 font-normal text-gray-400">({count})</span></span><ChevronIcon /></summary><div className="border-t border-gray-200 p-3">{values.length ? <ul className="space-y-2">{values.map((value, index) => <li key={`${index}-${value}`} className={`rounded-lg bg-white px-3 py-2 text-xs leading-5 text-gray-600 ${monospace ? "break-all font-mono" : ""}`}>{value}</li>)}</ul> : <p className="text-xs text-gray-400">None recorded.</p>}</div></details>; }

function EmptyState({ icon, title, description }: { icon: ReactNode; title: string; description: string }) { return <div className="rounded-xl border border-dashed border-gray-200 bg-gray-50 px-5 py-8 text-center"><span className="mx-auto grid h-10 w-10 place-items-center rounded-xl bg-gray-100 text-gray-400">{icon}</span><h4 className="mt-3 text-sm font-semibold text-gray-700">{title}</h4><p className="mx-auto mt-1 max-w-md text-xs leading-5 text-gray-500">{description}</p></div>; }

function StatusBadge({ status }: { status: GoalReport["overview"]["finalStatus"] }) { const tone = status === "achieved" ? "success" : status === "cancelled" || status === "blocked" ? "warning" : "danger"; return <StatePill label={humanize(status)} tone={tone} />; }
function StatePill({ label, tone }: { label: string; tone: Tone }) { const classes = toneClasses(tone); return <span className={`inline-flex shrink-0 items-center rounded-full px-2 py-1 text-[10px] font-semibold ${classes.soft}`}>{label}</span>; }
function reviewTone(status: ReviewResult["status"]): Tone { if (status === "approved") return "success"; if (status === "approved_with_warnings" || status === "not_applicable" || status === "needs_evidence") return "warning"; return "danger"; }
function toneClasses(tone: Tone) { return tone === "success" ? { soft: "bg-emerald-50 text-emerald-700", dot: "bg-emerald-500" } : tone === "warning" ? { soft: "bg-amber-50 text-amber-800", dot: "bg-amber-500" } : tone === "danger" ? { soft: "bg-red-50 text-red-700", dot: "bg-red-500" } : { soft: "bg-gray-100 text-gray-600", dot: "bg-gray-400" }; }

function ExportMenuItem({ icon, title, description, onClick }: { icon: ReactNode; title: string; description: string; onClick: () => void }) { return <button type="button" role="menuitem" onClick={onClick} className="flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-gray-50"><span className="grid h-8 w-8 place-items-center rounded-lg bg-gray-100 text-gray-500">{icon}</span><span><span className="block text-xs font-semibold text-gray-800">{title}</span><span className="mt-0.5 block text-[10px] text-gray-400">{description}</span></span></button>; }

function ArtifactDialog({ artifact, onClose }: { artifact: { title: string; content?: string; error?: string }; onClose: () => void }) { return <div className="fixed inset-0 z-50 grid place-items-center bg-gray-900/40 p-4" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section role="dialog" aria-modal="true" aria-label={artifact.title} className="max-h-[80vh] w-full max-w-3xl overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-2xl"><header className="flex items-center justify-between border-b border-gray-200 px-4 py-3"><div><p className="text-[10px] font-semibold uppercase tracking-wide text-gray-400">Evidence artifact</p><h3 className="mt-0.5 font-semibold text-gray-900">{artifact.title}</h3></div><button type="button" onClick={onClose} aria-label="Close artifact" className="grid h-8 w-8 place-items-center rounded-lg text-gray-400 hover:bg-gray-100"><CloseIcon /></button></header><div className="max-h-[calc(80vh-64px)] overflow-auto p-4">{artifact.error ? <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-800">{artifact.error}</p> : artifact.content ? <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-5 text-gray-700">{artifact.content}</pre> : <p className="text-sm text-gray-500">Loading artifact…</p>}</div></section></div>; }

function formatDate(value: string): string { return new Date(value).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }); }

function DownloadIcon() { return <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" d="M12 3v12m0 0 4-4m-4 4-4-4M5 20h14" /></svg>; }
function CodeIcon() { return <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" d="m8 9-3 3 3 3m8-6 3 3-3 3m-2-9-4 12" /></svg>; }
function DocumentIcon() { return <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" d="M7 3h7l4 4v14H7zM9 12h6m-6 4h6" /></svg>; }
function SmallChevronIcon() { return <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" d="m6 9 6 6 6-6" /></svg>; }
function CloseIcon() { return <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path strokeLinecap="round" d="m6 6 12 12M18 6 6 18" /></svg>; }
function CheckIcon() { return <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" d="m5 12 4 4L19 6" /></svg>; }
function AlertIcon() { return <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" d="M12 9v4m0 4h.01M10.3 4.5 3.4 17a2 2 0 0 0 1.75 3h13.7a2 2 0 0 0 1.75-3L13.7 4.5a2 2 0 0 0-3.4 0Z" /></svg>; }
function SmallCheckIcon() { return <svg className="h-3.5 w-3.5 shrink-0 text-emerald-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.2" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" d="m5 12 4 4L19 6" /></svg>; }
function SmallAlertIcon() { return <svg className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path strokeLinecap="round" d="M12 7v6m0 4h.01" /></svg>; }
function ChevronIcon() { return <svg className="h-4 w-4 text-gray-400 transition-transform group-open:rotate-180" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" d="m9 6 6 6-6 6" /></svg>; }
function ArrowIcon() { return <svg className="mt-2 h-3.5 w-3.5 shrink-0 text-amber-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" d="m9 18 6-6-6-6" /></svg>; }
function QuestionIcon() { return <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" d="M9.1 9a3 3 0 1 1 5.7 1.3c-.7 1-1.8 1.3-2.3 2.2V14m0 4h.01" /></svg>; }
function EvidenceIcon() { return <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6M7 3h7l4 4v14H7z" /></svg>; }
function ReviewIcon() { return <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8m8 8 2 2 4-4" /></svg>; }
