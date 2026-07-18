import { useEffect, useState } from "react";
import type { GoalDefinition } from "@conduit/shared";

interface GoalPreviewProps {
  goal: GoalDefinition;
  busy: boolean;
  canReviseAnswers: boolean;
  onSave: (patch: Partial<Pick<GoalDefinition, "title" | "description" | "successCriteria" | "constraints" | "deliverables" | "assumptions">>) => Promise<void>;
  onReviseAnswers: () => void;
  onRegenerate: () => Promise<void>;
  onApprove: () => Promise<void>;
}

export function GoalPreview({ goal, busy, canReviseAnswers, onSave, onReviseAnswers, onRegenerate, onApprove }: GoalPreviewProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(goal);

  useEffect(() => {
    setDraft(goal);
    setEditing(false);
  }, [goal.version]);

  const save = async () => {
    await onSave({
      title: draft.title,
      description: draft.description,
      successCriteria: draft.successCriteria,
      constraints: draft.constraints,
      deliverables: draft.deliverables,
      assumptions: draft.assumptions,
    });
    setEditing(false);
  };

  return (
    <div className="mx-auto w-full max-w-4xl pb-10">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <span className="rounded-full bg-emerald-50 px-2.5 py-1 text-[11px] font-semibold text-emerald-700">Ready for review</span>
            <span className="text-xs font-medium text-gray-400">Goal version {goal.version}</span>
          </div>
          <p className="mt-2 text-sm text-gray-500">This is the execution contract. Implementation cannot begin until you approve this exact version.</p>
        </div>
        {!editing && <button type="button" onClick={() => setEditing(true)} className="goal-accent-ring rounded-xl border border-gray-200 bg-white px-3.5 py-2 text-xs font-semibold text-gray-700 shadow-sm hover:bg-gray-50 focus:outline-none">Edit goal</button>}
      </div>

      <article className="overflow-hidden rounded-3xl border border-gray-200 bg-white shadow-sm">
        <div className="border-b border-gray-100 bg-gradient-to-br from-gray-50 to-white px-6 py-6 sm:px-8">
          {editing ? (
            <div className="space-y-3">
              <label className="block text-xs font-semibold uppercase tracking-wide text-gray-500">Title<input value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} className="goal-accent-focus mt-1.5 w-full rounded-xl border border-gray-200 bg-white px-3.5 py-3 text-lg font-semibold normal-case tracking-normal text-gray-900 outline-none" /></label>
              <label className="block text-xs font-semibold uppercase tracking-wide text-gray-500">Description<textarea value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} rows={4} className="goal-accent-focus mt-1.5 w-full resize-y rounded-xl border border-gray-200 bg-white px-3.5 py-3 text-sm font-normal normal-case leading-6 tracking-normal text-gray-700 outline-none" /></label>
            </div>
          ) : (
            <><h2 className="text-xl font-semibold text-gray-900">{goal.title}</h2><p className="mt-2 max-w-3xl text-sm leading-6 text-gray-600">{goal.description}</p></>
          )}
        </div>

        <div className="grid gap-0 lg:grid-cols-2">
          <PreviewSection title="Success criteria" hint="What must be true when the work is complete">
            <EditableRows
              editing={editing}
              items={draft.successCriteria}
              empty="No success criteria"
              onChange={(items) => setDraft({ ...draft, successCriteria: items.map((item) => ({ ...item, required: true })) })}
              create={() => ({ id: `criterion-${crypto.randomUUID()}`, description: "", required: true })}
            />
          </PreviewSection>
          <PreviewSection title="Deliverables" hint="What the agent is expected to produce" border>
            <EditableRows
              editing={editing}
              items={draft.deliverables}
              empty="No deliverables"
              onChange={(items) => setDraft({ ...draft, deliverables: items.map((item) => ({ ...item, type: item.type ?? "implementation", required: true })) })}
              create={() => ({ id: `deliverable-${crypto.randomUUID()}`, description: "", type: "implementation" as const, required: true })}
            />
          </PreviewSection>
          <PreviewSection title="Constraints" hint="Boundaries the implementation must respect" top>
            <EditableRows
              editing={editing}
              items={draft.constraints}
              empty="No additional constraints"
              onChange={(items) => setDraft({ ...draft, constraints: items.map((item) => ({ ...item, source: item.source ?? "user" })) })}
              create={() => ({ id: `constraint-${crypto.randomUUID()}`, description: "", source: "user" as const })}
            />
          </PreviewSection>
          <PreviewSection title="Assumptions" hint="Things Conduit inferred and will carry forward" border top>
            <EditableRows
              editing={editing}
              items={draft.assumptions}
              empty="No assumptions"
              onChange={(items) => setDraft({ ...draft, assumptions: items.map((item) => ({ ...item, confirmed: item.confirmed ?? false })) })}
              create={() => ({ id: `assumption-${crypto.randomUUID()}`, description: "", confirmed: false })}
            />
          </PreviewSection>
        </div>
      </article>

      <div className="mt-5 flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap gap-2">
          {editing ? <><button type="button" disabled={busy} onClick={() => { setDraft(goal); setEditing(false); }} className="rounded-xl px-3.5 py-2 text-xs font-semibold text-gray-600 hover:bg-gray-100">Cancel edits</button><button type="button" disabled={busy || !draft.title.trim() || !draft.description.trim()} onClick={() => void save()} className="rounded-xl bg-gray-900 px-4 py-2 text-xs font-semibold text-white disabled:opacity-40">Save as new version</button></> : <>
            {canReviseAnswers && <button type="button" disabled={busy} onClick={onReviseAnswers} className="rounded-xl border border-gray-200 bg-white px-3.5 py-2 text-xs font-semibold text-gray-700 hover:bg-gray-50">Revise answers</button>}
            <button type="button" disabled={busy} onClick={() => void onRegenerate()} className="rounded-xl border border-gray-200 bg-white px-3.5 py-2 text-xs font-semibold text-gray-700 hover:bg-gray-50">Regenerate</button>
          </>}
        </div>
        {!editing && <button type="button" disabled={busy} onClick={() => void onApprove()} className="goal-accent-bg goal-accent-shadow rounded-xl px-5 py-3 text-sm font-semibold text-white transition disabled:cursor-wait disabled:opacity-50">Approve and start</button>}
      </div>
    </div>
  );
}

function PreviewSection({ title, hint, children, border, top }: { title: string; hint: string; children: React.ReactNode; border?: boolean; top?: boolean }) {
  return <section className={`px-6 py-6 sm:px-8 ${border ? "lg:border-l lg:border-gray-100" : ""} ${top ? "border-t border-gray-100" : ""}`}><h3 className="text-sm font-semibold text-gray-900">{title}</h3><p className="mt-1 text-xs text-gray-400">{hint}</p><div className="mt-4">{children}</div></section>;
}

function EditableRows<T extends { id: string; description: string }>({ editing, items, empty, onChange, create }: { editing: boolean; items: T[]; empty: string; onChange: (items: T[]) => void; create: () => T }) {
  if (!editing) return items.length ? <ul className="space-y-2.5">{items.map((item) => <li key={item.id} className="flex gap-2.5 text-sm leading-5 text-gray-700"><span className="goal-accent-dot mt-1.5 size-1.5 shrink-0 rounded-full" /><span>{item.description}</span></li>)}</ul> : <p className="text-sm italic text-gray-400">{empty}</p>;
  return <div className="space-y-2">{items.map((item, index) => <div key={item.id} className="flex gap-2"><input aria-label={`${empty} item ${index + 1}`} value={item.description} onChange={(event) => onChange(items.map((candidate) => candidate.id === item.id ? { ...candidate, description: event.target.value } : candidate))} className="goal-accent-focus min-w-0 flex-1 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 outline-none" /><button type="button" aria-label={`Remove item ${index + 1}`} onClick={() => onChange(items.filter((candidate) => candidate.id !== item.id))} className="rounded-lg px-2 text-xs text-gray-400 hover:bg-red-50 hover:text-red-600">Remove</button></div>)}<button type="button" onClick={() => onChange([...items, create()])} className="goal-accent-outline rounded-lg border border-dashed border-gray-300 px-3 py-2 text-xs font-medium text-gray-500">Add item</button></div>;
}
