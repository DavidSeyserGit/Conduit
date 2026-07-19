import * as React from "react";
import type { GoalAnswerValue, GoalQuestion } from "@conduit/cgs/legacy";
import type { GoalQuestion as CgsGoalQuestion, JsonValue } from "@conduit/cgs";

export interface QuestionRendererProps {
  question: CgsGoalQuestion;
  value: JsonValue | undefined;
  error?: string | null;
  onChange: (value: JsonValue) => void;
}

export function QuestionRenderer({ question, value, error, onChange }: QuestionRendererProps) {
  const legacy = questionViewModel(question);
  return <LegacyQuestionRenderer question={legacy} dataType={question.type} value={toLegacyAnswerValue(question, value)} error={error} onChange={(next) => onChange(fromLegacyAnswerValue(question, next))} />;
}

function LegacyQuestionRenderer({ question, dataType, value, error, onChange }: { question: GoalQuestion; dataType: string; value: GoalAnswerValue | undefined; error?: string | null; onChange: (value: GoalAnswerValue) => void }) {
  const id = React.useId();
  const descriptionId = `${id}-description`;
  const errorId = `${id}-error`;
  const describedBy = [question.description || question.sourceReason ? descriptionId : "", error ? errorId : ""].filter(Boolean).join(" ") || undefined;

  return (
    <section className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm" data-question-type={dataType}>
      <div className="mb-4">
        <div className="flex items-start gap-2">
          <h3 className="flex-1 text-sm font-semibold leading-5 text-gray-900">{question.title}</h3>
          {!question.required && <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-gray-500">Optional</span>}
        </div>
        {(question.description || question.sourceReason) && (
          <p id={descriptionId} className="mt-1.5 text-xs leading-5 text-gray-500">
            {question.description}{question.description && question.sourceReason ? " " : ""}
            {question.sourceReason && <span className="text-gray-400">Why we’re asking: {question.sourceReason}</span>}
          </p>
        )}
      </div>

      {(question.type === "single_select" || question.type === "repository_reference") && (
        <SingleChoice question={question} value={value} onChange={onChange} describedBy={describedBy} />
      )}
      {question.type === "multi_select" && <MultipleChoice question={question} value={value} onChange={onChange} describedBy={describedBy} />}
      {question.type === "confirmation" && <Confirmation value={value} onChange={onChange} describedBy={describedBy} name={id} />}
      {question.type === "text" && (
        <textarea
          aria-label={question.title}
          aria-describedby={describedBy}
          aria-invalid={Boolean(error)}
          value={typeof value === "string" ? value : ""}
          onChange={(event) => onChange(event.target.value)}
          rows={4}
          className="goal-accent-focus w-full resize-y rounded-xl border border-gray-200 bg-gray-50 px-3.5 py-3 text-sm leading-6 text-gray-900 outline-none transition focus:bg-white"
          placeholder="Enter additional context…"
        />
      )}
      {question.type === "constraint_editor" && <ConstraintEditor value={value} onChange={onChange} />}
      {question.type === "success_criteria_editor" && <CriteriaEditor value={value} onChange={onChange} />}

      {error && <p id={errorId} role="alert" className="mt-3 text-xs font-medium text-red-600">{error}</p>}
    </section>
  );
}

/** Desktop-only view adapter; the semantic source remains the CGS question. */
function questionViewModel(question: CgsGoalQuestion): GoalQuestion {
  const base = {
    id: question.id,
    title: question.prompt,
    description: question.rationale,
    required: question.required,
    sourceReason: question.rationale,
  };
  const defaultValue = toLegacyAnswerValue(question, question.defaultValue);
  if (question.type === "confirmation") return { ...base, type: "confirmation", ...(typeof defaultValue === "boolean" ? { defaultValue } : {}) };
  if (question.type === "free_text") return { ...base, type: "text", ...(typeof defaultValue === "string" ? { defaultValue } : {}) };
  if (question.type === "constraint_editor") return { ...base, type: "constraint_editor", ...(Array.isArray(defaultValue) ? { defaultValue: defaultValue as Extract<GoalQuestion, { type: "constraint_editor" }>["defaultValue"] } : {}) };
  if (question.type === "success_criterion_editor") return { ...base, type: "success_criteria_editor", ...(Array.isArray(defaultValue) ? { defaultValue: defaultValue as Extract<GoalQuestion, { type: "success_criteria_editor" }>["defaultValue"] } : {}) };
  const options = (question.options ?? []).map((option) => ({ id: option.id, label: option.label, description: option.description }));
  if (question.type === "multi_select") return { ...base, type: "multi_select", options, ...(Array.isArray(defaultValue) ? { defaultValue: defaultValue.filter((item): item is string => typeof item === "string") } : {}) };
  return { ...base, type: question.type, options, ...(typeof defaultValue === "string" ? { defaultValue } : {}) };
}

function toLegacyAnswerValue(question: CgsGoalQuestion, value: JsonValue | undefined): GoalAnswerValue | undefined {
  if (value === undefined) return undefined;
  if (question.type === "single_select" || question.type === "repository_reference") {
    return question.options?.find((option) => sameJson(option.value, value))?.id ?? (typeof value === "string" ? value : undefined);
  }
  if (question.type === "multi_select") {
    if (!Array.isArray(value)) return undefined;
    return value.map((item) => question.options?.find((option) => sameJson(option.value, item))?.id).filter((item): item is string => Boolean(item));
  }
  if (question.type === "constraint_editor") {
    if (!Array.isArray(value)) return undefined;
    return value.map((item) => { const constraint = item as { id: string; description: string }; return { id: constraint.id, description: constraint.description, source: "user" as const }; });
  }
  if (question.type === "success_criterion_editor") {
    if (!Array.isArray(value)) return undefined;
    return value.map((item) => { const criterion = item as { id: string; description: string; priority?: string }; return { id: criterion.id, description: criterion.description, required: criterion.priority !== "preferred" }; });
  }
  return value as GoalAnswerValue;
}

function fromLegacyAnswerValue(question: CgsGoalQuestion, value: GoalAnswerValue): JsonValue {
  if (question.type === "single_select" || question.type === "repository_reference") {
    return typeof value === "string" ? question.options?.find((option) => option.id === value)?.value ?? value : null;
  }
  if (question.type === "multi_select") {
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").map((id) => question.options?.find((option) => option.id === id)?.value ?? id) : [];
  }
  if (question.type === "constraint_editor") {
    return Array.isArray(value) ? value.map((item) => { const constraint = item as { id: string; description: string }; return { id: constraint.id, description: constraint.description, category: "other", required: true }; }) : [];
  }
  if (question.type === "success_criterion_editor") {
    return Array.isArray(value) ? value.map((item) => { const criterion = item as { id: string; description: string; required?: boolean }; return { id: criterion.id, description: criterion.description, priority: criterion.required === false ? "preferred" : "required" }; }) : [];
  }
  return value as JsonValue;
}

const sameJson = (left: JsonValue, right: JsonValue): boolean => JSON.stringify(left) === JSON.stringify(right);

function SingleChoice({ question, value, onChange, describedBy }: {
  question: Extract<GoalQuestion, { type: "single_select" | "repository_reference" }>;
  value: GoalAnswerValue | undefined;
  onChange: (value: GoalAnswerValue) => void;
  describedBy?: string;
}) {
  const selected = typeof value === "string" ? value : "";
  const known = question.options.some((option) => option.id === selected);
  const custom = selected && !known ? selected : "";
  return (
    <fieldset aria-describedby={describedBy} className="space-y-2">
      <legend className="sr-only">{question.title}</legend>
      {question.options.map((option) => (
        <label key={option.id} className={`goal-accent-ring flex cursor-pointer items-start gap-3 rounded-xl border px-3.5 py-3 transition ${selected === option.id ? "goal-accent-selected" : "border-gray-200 hover:border-gray-300"}`}>
          <input type="radio" name={question.id} value={option.id} checked={selected === option.id} onChange={() => onChange(option.id)} className="goal-accent-control mt-0.5 size-4" />
          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-center gap-2 text-sm font-medium text-gray-800">{option.label}{option.recommended && <Recommended />}</span>
            {option.description && <span className="mt-0.5 block break-words text-xs leading-5 text-gray-500">{option.description}</span>}
          </span>
        </label>
      ))}
      {question.allowCustomAnswer && (
        <label className={`goal-accent-ring block rounded-xl border px-3.5 py-3 transition ${custom ? "goal-accent-selected" : "border-gray-200"}`}>
          <span className="text-sm font-medium text-gray-800">Custom answer</span>
          <input aria-label={`Custom answer for ${question.title}`} value={custom} onChange={(event) => onChange(event.target.value)} className="goal-accent-focus mt-2 w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm outline-none" placeholder="Describe your preferred option…" />
        </label>
      )}
    </fieldset>
  );
}

function MultipleChoice({ question, value, onChange, describedBy }: {
  question: Extract<GoalQuestion, { type: "multi_select" }>;
  value: GoalAnswerValue | undefined;
  onChange: (value: GoalAnswerValue) => void;
  describedBy?: string;
}) {
  const selected = Array.isArray(value) && value.every((item) => typeof item === "string") ? value as string[] : [];
  const known = new Set(question.options.map((option) => option.id));
  const custom = selected.find((item) => !known.has(item)) ?? "";
  const toggle = (id: string) => onChange(selected.includes(id) ? selected.filter((item) => item !== id) : [...selected, id]);
  return (
    <fieldset aria-describedby={describedBy} className="space-y-2">
      <legend className="sr-only">{question.title}</legend>
      {question.options.map((option) => (
        <label key={option.id} className={`goal-accent-ring flex cursor-pointer items-start gap-3 rounded-xl border px-3.5 py-3 transition ${selected.includes(option.id) ? "goal-accent-selected" : "border-gray-200 hover:border-gray-300"}`}>
          <input type="checkbox" checked={selected.includes(option.id)} onChange={() => toggle(option.id)} className="goal-accent-control mt-0.5 size-4 rounded" />
          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-center gap-2 text-sm font-medium text-gray-800">{option.label}{option.recommended && <Recommended />}</span>
            {option.description && <span className="mt-0.5 block break-words text-xs leading-5 text-gray-500">{option.description}</span>}
          </span>
        </label>
      ))}
      {question.allowCustomAnswer && (
        <input aria-label={`Custom answer for ${question.title}`} value={custom} onChange={(event) => onChange([...selected.filter((item) => known.has(item)), ...(event.target.value ? [event.target.value] : [])])} className="goal-accent-focus w-full rounded-xl border border-gray-200 bg-white px-3.5 py-3 text-sm text-gray-900 outline-none" placeholder="Add another requirement…" />
      )}
    </fieldset>
  );
}

function Confirmation({ value, onChange, describedBy, name }: { value: GoalAnswerValue | undefined; onChange: (value: GoalAnswerValue) => void; describedBy?: string; name: string }) {
  return <fieldset aria-describedby={describedBy} className="grid gap-2 sm:grid-cols-2"><legend className="sr-only">Confirmation</legend>{[
    { value: true, label: "Allow", detail: "Continue with this permission" },
    { value: false, label: "Do not allow", detail: "Keep the current restriction" },
  ].map((option) => <label key={String(option.value)} className={`goal-accent-ring cursor-pointer rounded-xl border px-3.5 py-3 ${value === option.value ? "goal-accent-selected" : "border-gray-200"}`}><span className="flex items-center gap-2 text-sm font-medium text-gray-800"><input type="radio" name={name} checked={value === option.value} onChange={() => onChange(option.value)} className="goal-accent-control size-4" />{option.label}</span><span className="ml-6 mt-1 block text-xs text-gray-500">{option.detail}</span></label>)}</fieldset>;
}

function ConstraintEditor({ value, onChange }: { value: GoalAnswerValue | undefined; onChange: (value: GoalAnswerValue) => void }) {
  const items = Array.isArray(value) && value.every((item) => item !== null && typeof item === "object") ? value as Array<{ id: string; description: string; source: "user" }> : [];
  return <EditableList label="constraint" items={items} onChange={(next) => onChange(next.map((item) => ({ ...item, source: "user" as const })))} />;
}

function CriteriaEditor({ value, onChange }: { value: GoalAnswerValue | undefined; onChange: (value: GoalAnswerValue) => void }) {
  const items = Array.isArray(value) && value.every((item) => item !== null && typeof item === "object") ? value as Array<{ id: string; description: string; required: boolean }> : [];
  return <EditableList label="success criterion" items={items} onChange={(next) => onChange(next.map((item) => ({ ...item, required: true })))} />;
}

function EditableList({ label, items, onChange }: { label: string; items: Array<{ id: string; description: string }>; onChange: (items: Array<{ id: string; description: string }>) => void }) {
  const [draft, setDraft] = React.useState("");
  const inputLabel = React.useMemo(() => `Add ${label}`, [label]);
  return <div className="space-y-2">{items.map((item, index) => <div key={item.id} className="flex items-center gap-2"><input aria-label={`${label} ${index + 1}`} value={item.description} onChange={(event) => onChange(items.map((candidate) => candidate.id === item.id ? { ...candidate, description: event.target.value } : candidate))} className="goal-accent-focus min-w-0 flex-1 rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 outline-none" /><button type="button" onClick={() => onChange(items.filter((candidate) => candidate.id !== item.id))} className="rounded-lg px-2 py-2 text-xs font-medium text-gray-500 hover:bg-red-50 hover:text-red-600" aria-label={`Remove ${label} ${index + 1}`}>Remove</button></div>)}<div className="flex items-center gap-2"><input aria-label={inputLabel} value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && draft.trim()) { event.preventDefault(); onChange([...items, { id: `${label.replace(/\s/g, "-")}-${crypto.randomUUID()}`, description: draft.trim() }]); setDraft(""); } }} className="goal-accent-focus min-w-0 flex-1 rounded-xl border border-dashed border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 outline-none" placeholder={`Add ${label}…`} /><button type="button" disabled={!draft.trim()} onClick={() => { if (!draft.trim()) return; onChange([...items, { id: `${label.replace(/\s/g, "-")}-${crypto.randomUUID()}`, description: draft.trim() }]); setDraft(""); }} className="rounded-lg bg-gray-100 px-3 py-2 text-xs font-medium text-gray-700 disabled:opacity-40">Add</button></div></div>;
}

function Recommended() {
  return <span className="goal-accent-soft rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide">Recommended</span>;
}
