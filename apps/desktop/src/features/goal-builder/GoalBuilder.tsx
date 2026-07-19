import { useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import type { GoalAnswerValue } from "@conduit/cgs/legacy";
import type { JsonValue } from "@conduit/cgs";
import { useGoalBuilderStore } from "../../stores/goal-builder-store.js";
import { QuestionRenderer } from "./QuestionRenderer";
import { GoalPreview } from "./GoalPreview";
import { hasRecommendedDefault, validateQuestionAnswer } from "./question-utils";
import { useAppStore } from "../../stores/app-store.js";
import { getModeColor } from "../../lib/mode-colors.js";
import { legacyGoalToCgs, legacyQuestionBatchesToCgs } from "@conduit/runtime";

export function GoalBuilder() {
  const phase = useGoalBuilderStore((state) => state.phase);
  const initialRequest = useGoalBuilderStore((state) => state.initialRequest);
  const goal = useGoalBuilderStore((state) => state.goal);
  const batches = useGoalBuilderStore((state) => state.batches);
  const batchIndex = useGoalBuilderStore((state) => state.batchIndex);
  const answers = useGoalBuilderStore((state) => state.answers);
  const revisionMode = useGoalBuilderStore((state) => state.revisionMode);
  const statusMessage = useGoalBuilderStore((state) => state.statusMessage);
  const error = useGoalBuilderStore((state) => state.error);
  const setAnswer = useGoalBuilderStore((state) => state.setAnswer);
  const setBatchIndex = useGoalBuilderStore((state) => state.setBatchIndex);
  const useRecommendedDefaults = useGoalBuilderStore((state) => state.useRecommendedDefaults);
  const submitAnswers = useGoalBuilderStore((state) => state.submitAnswers);
  const reviseAnswers = useGoalBuilderStore((state) => state.reviseAnswers);
  const returnToPreview = useGoalBuilderStore((state) => state.returnToPreview);
  const editGoal = useGoalBuilderStore((state) => state.editGoal);
  const regenerate = useGoalBuilderStore((state) => state.regenerate);
  const approveAndStart = useGoalBuilderStore((state) => state.approveAndStart);
  const answerExecutionQuestion = useGoalBuilderStore((state) => state.answerExecutionQuestion);
  const cancel = useGoalBuilderStore((state) => state.cancel);
  const start = useGoalBuilderStore((state) => state.start);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const elapsedSeconds = useElapsedSeconds(Boolean(statusMessage) || phase === "analyzing" || phase === "approving");

  const batch = batches[batchIndex];
  const busy = Boolean(statusMessage) || phase === "analyzing" || phase === "approving";
  const progress = batches.length > 0 ? Math.round(((batchIndex + 1) / batches.length) * 100) : 0;
  const hasDefaults = useMemo(() => batch?.questions.some(hasRecommendedDefault) ?? false, [batch]);
  const cgsGoal = useMemo(() => goal ? legacyGoalToCgs(goal) : null, [goal]);
  const cgsBatches = useMemo(() => legacyQuestionBatchesToCgs(goal?.id ?? "goal-pending", batches, goal?.updatedAt ?? "2026-01-01T00:00:00Z"), [goal?.id, goal?.updatedAt, batches]);
  const cgsBatch = cgsBatches[batchIndex];

  if (phase === "idle") return null;

  if (phase === "analyzing" || phase === "approving") {
    return <GoalBuilderShell request={initialRequest}>
      <div className="flex min-h-[380px] flex-col items-center justify-center px-6 text-center" role="status" aria-live="polite">
        <div className="goal-accent-spinner relative mb-6 size-14 rounded-full border-2"><div className="absolute inset-0 animate-spin rounded-full border-2 border-transparent" /></div>
        <h2 className="text-lg font-semibold text-gray-900">{phase === "approving" ? "Starting the approved goal" : "Turning your request into a goal"}</h2>
        <p className="mt-2 max-w-md text-sm leading-6 text-gray-500">{statusMessage || "Inspecting the repository and resolving technical facts…"}</p>
        {elapsedSeconds >= 8 && <p className="mt-2 text-xs text-gray-400">Still working · {elapsedSeconds}s elapsed. Larger repositories and local reviewer models can take a little longer.</p>}
        <div className="mt-5 flex items-center gap-2 text-xs text-gray-400"><span className="goal-accent-dot size-1.5 animate-pulse rounded-full" />Repository inspection is read-only</div>
        <button type="button" onClick={() => void cancel()} className="mt-8 rounded-xl px-4 py-2 text-xs font-semibold text-gray-500 hover:bg-gray-100">Cancel</button>
      </div>
    </GoalBuilderShell>;
  }

  if (phase === "error") {
    return <GoalBuilderShell request={initialRequest}><div className="flex min-h-[360px] flex-col items-center justify-center px-6 text-center"><div className="mb-4 flex size-11 items-center justify-center rounded-full bg-red-50 text-red-600">!</div><h2 className="text-lg font-semibold text-gray-900">Goal setup stopped</h2><p role="alert" className="mt-2 max-w-lg text-sm leading-6 text-red-600">{error}</p><div className="mt-6 flex gap-2"><button type="button" onClick={() => void cancel()} className="rounded-xl border border-gray-200 px-4 py-2 text-xs font-semibold text-gray-600">Start over</button><button type="button" onClick={() => void start(initialRequest)} className="rounded-xl bg-gray-900 px-4 py-2 text-xs font-semibold text-white">Try again</button></div></div></GoalBuilderShell>;
  }

  if (phase === "preview" && cgsGoal) {
    return <GoalBuilderShell request={initialRequest} wide>
      <GoalPreview goal={cgsGoal} busy={busy} canReviseAnswers={batches.length > 0} onSave={async (patch) => editGoal({
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.description !== undefined ? { description: patch.description } : {}),
        ...(patch.successCriteria ? { successCriteria: patch.successCriteria.map((criterion) => ({ id: criterion.id, description: criterion.description, required: criterion.priority === "required", ...(criterion.verification?.[0]?.description ? { verificationHint: criterion.verification[0].description } : {}) })) } : {}),
        ...(patch.constraints ? { constraints: patch.constraints.map((constraint) => ({ id: constraint.id, description: constraint.description, source: "user" as const })) } : {}),
        ...(patch.deliverables ? { deliverables: patch.deliverables.map((deliverable) => ({ id: deliverable.id, description: deliverable.description, required: deliverable.required, type: deliverable.type === "test" ? "unit_tests" as const : deliverable.type === "documentation" || deliverable.type === "migration" || deliverable.type === "other" ? deliverable.type : "implementation" as const })) } : {}),
        ...(patch.assumptions ? { assumptions: patch.assumptions.map((assumption) => ({ id: assumption.id, description: assumption.description, confirmed: assumption.confirmed ?? false })) } : {}),
      })} onReviseAnswers={reviseAnswers} onRegenerate={regenerate} onApprove={approveAndStart} />
      <LiveStatus status={statusMessage} error={error} elapsedSeconds={elapsedSeconds} />
    </GoalBuilderShell>;
  }

  if ((phase === "questions" || phase === "execution_question") && batch) {
    const validateBatch = () => {
      const nextErrors: Record<string, string> = {};
      for (const question of batch.questions) {
        const validation = validateQuestionAnswer(question, answers[question.id]);
        if (validation) nextErrors[question.id] = validation;
      }
      setErrors(nextErrors);
      return Object.keys(nextErrors).length === 0;
    };
    const continueFlow = () => {
      if (!validateBatch()) return;
      if (phase === "execution_question") return void answerExecutionQuestion();
      if (batchIndex < batches.length - 1) {
        setErrors({});
        setBatchIndex(batchIndex + 1);
      } else {
        void submitAnswers();
      }
    };
    return <GoalBuilderShell request={initialRequest}>
      <div className="mx-auto w-full max-w-3xl pb-10">
        <div className="mb-6">
          <div className="flex items-center justify-between text-xs font-medium text-gray-400">
            <span>{phase === "execution_question" ? "Implementation paused" : revisionMode ? "Revise your answers" : `Question group ${batchIndex + 1} of ${batches.length}`}</span>
            {phase !== "execution_question" && <span>{progress}%</span>}
          </div>
          {phase !== "execution_question" && <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-gray-100"><div className="goal-accent-bg h-full rounded-full transition-all" style={{ width: `${progress}%` }} /></div>}
          <h2 className="mt-5 text-xl font-semibold text-gray-900">{phase === "execution_question" ? "Conduit needs your decision" : batch.title}</h2>
          <p className="mt-1.5 text-sm leading-6 text-gray-500">{phase === "execution_question" ? "The agent reached a decision that cannot be inferred safely. Your answer will be recorded in the goal history before work resumes." : "Answer only the product decisions Conduit could not determine from the repository."}</p>
        </div>

        {hasDefaults && <button type="button" onClick={useRecommendedDefaults} className="goal-accent-soft mb-4 rounded-xl border px-3.5 py-2 text-xs font-semibold transition">Use recommended defaults</button>}
        <div className="space-y-4">{cgsBatch?.questions.map((question) => <div key={question.id}><QuestionRenderer question={question} value={answers[question.id] as JsonValue | undefined} error={errors[question.id]} onChange={(value: JsonValue) => { setAnswer(question.id, value as GoalAnswerValue); setErrors((current) => { const next = { ...current }; delete next[question.id]; return next; }); }} />{!question.required && answers[question.id] !== null && <button type="button" onClick={() => setAnswer(question.id, null)} className="ml-3 mt-2 text-xs font-medium text-gray-400 hover:text-gray-700">Skip this optional question</button>}</div>)}</div>

        <LiveStatus status={statusMessage} error={error} elapsedSeconds={elapsedSeconds} />
        <div className="mt-6 flex items-center justify-between gap-3">
          <button type="button" onClick={() => batchIndex > 0 ? setBatchIndex(batchIndex - 1) : revisionMode ? returnToPreview() : void cancel()} className="rounded-xl px-4 py-2.5 text-xs font-semibold text-gray-600 hover:bg-gray-100">{batchIndex > 0 ? "Back" : revisionMode ? "Back to preview" : "Cancel"}</button>
          <button type="button" disabled={busy} onClick={continueFlow} className="rounded-xl bg-gray-900 px-5 py-2.5 text-sm font-semibold text-white hover:bg-gray-800 disabled:opacity-40">{phase === "execution_question" ? "Submit and resume" : batchIndex < batches.length - 1 ? "Continue" : revisionMode ? "Regenerate goal" : "Build goal preview"}</button>
        </div>
      </div>
    </GoalBuilderShell>;
  }

  return null;
}

function GoalBuilderShell({ request, children, wide = false }: { request: string; children: React.ReactNode; wide?: boolean }) {
  const settings = useAppStore((state) => state.settings);
  const goalColor = getModeColor(settings, "goal");
  return <div className="goal-builder flex-1 min-h-0 overflow-y-auto bg-gray-50 px-5 py-6 sm:px-8" style={{ "--goal-accent": goalColor } as CSSProperties}><div className={`${wide ? "max-w-5xl" : "max-w-4xl"} mx-auto`}><div className="mb-5 flex items-center gap-3"><div className="goal-accent-bg flex size-8 shrink-0 items-center justify-center rounded-xl text-xs font-bold text-white">G</div><div className="min-w-0"><div className="text-[11px] font-semibold uppercase tracking-wider text-gray-400">Structured goal</div><div className="truncate text-sm font-medium text-gray-700" title={request}>{request}</div></div></div>{children}</div></div>;
}

function LiveStatus({ status, error, elapsedSeconds }: { status: string | null; error: string | null; elapsedSeconds: number }) {
  return <div aria-live="polite" className="mt-4 min-h-5 text-center text-xs">{status && <span className="text-gray-500">{status}{elapsedSeconds >= 8 ? ` · ${elapsedSeconds}s` : ""}{elapsedSeconds >= 15 && <span className="mt-1 block text-gray-400">Conduit is still responding. Cancel remains safe if you do not want to wait.</span>}</span>}{error && <span role="alert" className="font-medium text-red-600">{error}</span>}</div>;
}

function useElapsedSeconds(active: boolean): number {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    setElapsed(0);
    if (!active) return;
    const startedAt = Date.now();
    const timer = window.setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1_000)), 1_000);
    return () => window.clearInterval(timer);
  }, [active]);
  return elapsed;
}
