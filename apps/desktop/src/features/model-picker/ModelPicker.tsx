import { useMemo, useState } from "react";
import type { ModelDescriptor, ModelReasoningLevel } from "@loopkit/shared";
import { isRecommendedJudgeModel } from "@loopkit/agent-runtime";
import { useAppStore } from "@/stores/app-store";
import { PopoverScope, usePopover } from "@/lib/popover";

interface ModelPickerProps {
  label: string;
  value: string;
  onChange: (id: string) => void;
  compact?: boolean;
  isJudgePicker?: boolean;
}

type PickerView = "models" | "reasoning";

export function ModelPicker({ label, value, onChange, compact, isJudgePicker }: ModelPickerProps) {
  const models = useAppStore((s) => s.models);
  const codingModelId = useAppStore((s) => s.codingModelId);
  const codexReasoningEfforts = useAppStore((s) => s.codexReasoningEfforts);
  const setCodexReasoningEffort = useAppStore((s) => s.setCodexReasoningEffort);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [provider, setProvider] = useState("all");
  const [view, setView] = useState<PickerView>("models");
  const [reasoningModelId, setReasoningModelId] = useState<string | null>(null);
  const providers = useMemo(() => Array.from(new Set(models.map((model) => model.provider))), [models]);
  const filtered = useMemo(() => {
    const scoped = provider === "all" ? models : models.filter((model) => model.provider === provider);
    if (!search) return scoped;
    const query = search.toLowerCase();
    return scoped.filter((model) => `${model.displayName} ${model.id} ${model.provider}`.toLowerCase().includes(query));
  }, [models, provider, search]);
  const selected = models.find((model) => model.id === value);
  const reasoningModel = models.find((model) => model.id === reasoningModelId);
  const selectedCodexReasoningModel = selected && supportsCodexReasoning(selected) ? selected : undefined;
  const isReasoningView = view === "reasoning" && reasoningModel && supportsCodexReasoning(reasoningModel);

  const close = () => {
    setOpen(false);
    setSearch("");
    setView("models");
    setReasoningModelId(null);
  };
  const popover = usePopover({ open, onClose: close });

  const openReasoning = (model: ModelDescriptor) => {
    setReasoningModelId(model.id);
    setView("reasoning");
  };

  const selectModel = (model: ModelDescriptor) => {
    onChange(model.id);
    if (supportsCodexReasoning(model)) {
      openReasoning(model);
      return;
    }
    close();
  };

  const toggleOpen = () => {
    if (open) {
      close();
      return;
    }
    setOpen(true);
    setSearch("");
    setView("models");
    setReasoningModelId(null);
  };

  return (
    <PopoverScope popover={popover}>
    <div ref={popover.setBoundary} className="relative min-w-0">
      {!compact && <label className="block text-xs text-gray-500 mb-1 font-medium">{label}</label>}
      <button onClick={toggleOpen} className={compact ? "flex min-w-0 max-w-full items-center gap-1 px-3 py-1.5 text-xs bg-gray-100 hover:bg-gray-200 text-gray-600 rounded-full transition-colors font-medium" : "w-full flex min-w-0 items-center justify-between text-left px-3 py-1.5 text-sm bg-gray-50 border border-gray-200 rounded-lg hover:border-gray-300 transition-colors text-gray-700"}>
        <span className="min-w-0 truncate">{selected?.displayName ?? (compact ? "Model" : "Select model...")}</span>
        <svg className="w-3 h-3 text-gray-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="m19 9-7 7-7-7" /></svg>
      </button>

      {open && <div className={`absolute z-50 w-[430px] h-[360px] overflow-hidden bg-white border border-gray-200 rounded-2xl shadow-xl flex ${compact ? "bottom-full mb-2 right-0" : "top-full mt-2 left-0"}`}>
        <aside className="w-12 shrink-0 border-r border-gray-100 bg-gray-50/70 flex flex-col items-center py-2 gap-1">
          <ProviderTab active={provider === "all" && !isReasoningView} label="All models" onClick={() => { setProvider("all"); setView("models"); }}><span>★</span></ProviderTab>
          {providers.map((name) => <ProviderTab key={name} active={provider === name && !isReasoningView} label={name} onClick={() => { setProvider(name); setView("models"); }}><ProviderIcon provider={name} /></ProviderTab>)}
        </aside>
        <div className="min-w-0 flex-1 flex flex-col">
          {isReasoningView ? (
            <ReasoningPanel
              model={reasoningModel}
              value={resolveReasoningEffort(reasoningModel, codexReasoningEfforts)}
              onBack={() => setView("models")}
              onChange={(effort) => {
                setCodexReasoningEffort(reasoningModel.id, effort);
                close();
              }}
            />
          ) : <>
            <div className="h-12 px-3 border-b border-gray-100 flex items-center gap-2">
              <svg className="w-4 h-4 text-gray-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></svg>
              <input autoFocus value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search models..." className="flex-1 min-w-0 text-sm text-gray-900 placeholder-gray-400 outline-none" />
              <span className="text-[11px] text-gray-400">{filtered.length}</span>
            </div>
            {selectedCodexReasoningModel && <button type="button" onClick={() => openReasoning(selectedCodexReasoningModel)} data-testid="codex-reasoning-button" className="mx-2 mt-2 px-2.5 py-2 rounded-xl bg-indigo-50 border border-indigo-100 hover:border-indigo-200 text-left flex items-center gap-2 transition-colors">
              <span className="w-6 h-6 rounded-lg bg-white text-indigo-600 flex items-center justify-center shrink-0">
                <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M9.5 3.5a7.5 7.5 0 1 0 5 13.1L18 20l2-2-3.4-3.4A7.5 7.5 0 0 0 9.5 3.5Z"/><path strokeLinecap="round" strokeLinejoin="round" d="M7.5 10h4M9.5 8v4"/></svg>
              </span>
              <span className="min-w-0 flex-1"><span className="block text-[11px] text-indigo-700 font-medium">Reasoning effort</span><span className="block text-xs text-indigo-950 font-semibold">{formatReasoningEffort(resolveReasoningEffort(selectedCodexReasoningModel, codexReasoningEfforts))}</span></span>
              <svg className="w-3.5 h-3.5 text-indigo-400 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="m9 18 6-6-6-6"/></svg>
            </button>}
            <div className="overflow-y-auto flex-1 p-1.5">
              {filtered.length === 0 ? <div className="p-6 text-sm text-gray-500 text-center">{models.length === 0 ? "No models loaded" : "No models found"}</div> : filtered.map((model) => <ModelOption key={model.id} model={model} selected={model.id === value} onSelect={() => selectModel(model)} isJudgePicker={isJudgePicker} codingModelId={codingModelId} reasoningEffort={supportsCodexReasoning(model) ? resolveReasoningEffort(model, codexReasoningEfforts) : undefined} />)}
            </div>
          </>}
        </div>
      </div>}
    </div>
    </PopoverScope>
  );
}

function ProviderTab({ active, label, onClick, children }: { active: boolean; label: string; onClick: () => void; children: React.ReactNode }) {
  return <button onClick={onClick} title={label} aria-label={label} className={`w-9 h-9 rounded-lg flex items-center justify-center transition-colors ${active ? "bg-white text-fuchsia-600 shadow-sm" : "text-gray-400 hover:bg-white/80 hover:text-gray-700"}`}>{children}</button>;
}

function ProviderIcon({ provider }: { provider: string }) {
  if (provider === "codex") return <span className="text-base">✦</span>;
  if (provider === "openrouter") return <span className="text-sm font-bold">O</span>;
  return <span className="text-xs font-semibold">{provider.slice(0, 2).toUpperCase()}</span>;
}

function ModelOption({ model, selected, onSelect, isJudgePicker, codingModelId, reasoningEffort }: { model: ModelDescriptor; selected: boolean; onSelect: () => void; isJudgePicker?: boolean; codingModelId: string; reasoningEffort?: string }) {
  const isCodex = model.provider === "codex";
  const isRecommendedJudge = isJudgePicker && codingModelId && isRecommendedJudgeModel(codingModelId, model.id);
  const supportsCodingTools = isJudgePicker || model.supportsTools;

  return <button onClick={onSelect} disabled={!supportsCodingTools} className={`w-full text-left px-3 py-2.5 rounded-xl transition-colors ${selected ? "bg-fuchsia-50" : supportsCodingTools ? "hover:bg-gray-50" : "opacity-50 cursor-not-allowed"}`}>
    <div className="flex items-center gap-2">
      <span className="w-6 h-6 rounded-md bg-gray-50 text-gray-500 flex items-center justify-center shrink-0"><ProviderIcon provider={model.provider} /></span>
      <span className="text-sm text-gray-900 truncate font-medium flex-1">{model.displayName}</span>
      {isRecommendedJudge && <span className="text-[10px] text-emerald-700 bg-emerald-50 border border-emerald-200 px-1.5 py-0.5 rounded font-medium">Recommended judge</span>}
      {isCodex && <span className="text-[10px] text-indigo-700 bg-indigo-50 border border-indigo-200 px-1.5 py-0.5 rounded font-medium">Subscription</span>}
      {!supportsCodingTools && <span className="text-[10px] text-gray-500 bg-gray-100 border border-gray-200 px-1.5 py-0.5 rounded font-medium">No tools</span>}
      {selected && <span className="text-fuchsia-600 text-xs">✓</span>}
    </div>
    <div className="flex items-center gap-2 mt-1 pl-8">
      <span className="text-[11px] text-gray-400">{model.provider}</span>
      {model.contextLength && <span className="text-[11px] text-gray-400">{(model.contextLength / 1000).toFixed(0)}k ctx</span>}
      {model.supportsTools && <span className="text-[11px] text-emerald-600">tools</span>}
      {reasoningEffort && <span className="text-[11px] text-indigo-600">{formatReasoningEffort(reasoningEffort)} reasoning</span>}
      {model.inputPrice !== undefined && <span className="text-[11px] text-gray-400">${model.inputPrice.toFixed(2)}/M</span>}
    </div>
  </button>;
}

function ReasoningPanel({ model, value, onBack, onChange }: { model: ModelDescriptor; value: string; onBack: () => void; onChange: (effort: string) => void }) {
  const levels = model.supportedReasoningLevels ?? [];

  return <>
    <div className="h-14 px-3 border-b border-gray-100 flex items-center gap-2">
      <button type="button" onClick={onBack} aria-label="Back to models" className="w-7 h-7 rounded-lg flex items-center justify-center text-gray-500 hover:bg-gray-100 hover:text-gray-800 transition-colors">
        <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="m15 18-6-6 6-6"/></svg>
      </button>
      <div className="min-w-0"><div className="text-sm font-semibold text-gray-900">Reasoning effort</div><div className="text-[11px] text-gray-400 truncate">{model.displayName}</div></div>
    </div>
    <div className="overflow-y-auto flex-1 p-3">
      <div className="text-xs text-gray-500 mb-3">Choose how deeply Codex should reason before it acts.</div>
      <div className="space-y-2" role="radiogroup" aria-label={`${model.displayName} reasoning effort`}>
        {levels.map((level) => <ReasoningOption key={level.effort} level={level} selected={level.effort === value} isDefault={level.effort === model.defaultReasoningLevel} onSelect={() => onChange(level.effort)} />)}
      </div>
    </div>
  </>;
}

function ReasoningOption({ level, selected, isDefault, onSelect }: { level: ModelReasoningLevel; selected: boolean; isDefault: boolean; onSelect: () => void }) {
  return <button type="button" role="radio" aria-checked={selected} data-testid={`codex-reasoning-option-${level.effort}`} onClick={onSelect} className={`w-full text-left px-3 py-2.5 rounded-xl border transition-colors ${selected ? "border-indigo-400 bg-indigo-50" : "border-gray-200 hover:border-gray-300 hover:bg-gray-50"}`}>
    <div className="flex items-center gap-2"><span className={`w-4 h-4 rounded-full border flex items-center justify-center shrink-0 ${selected ? "border-indigo-600" : "border-gray-300"}`}>{selected && <span className="w-2 h-2 rounded-full bg-indigo-600" />}</span><span className="text-sm font-medium text-gray-900 flex-1">{formatReasoningEffort(level.effort)}</span>{isDefault && <span className="text-[10px] text-gray-500 bg-white border border-gray-200 px-1.5 py-0.5 rounded font-medium">Default</span>}</div>
    {level.description && <div className="mt-1 pl-6 text-[11px] leading-snug text-gray-500">{level.description}</div>}
  </button>;
}

function supportsCodexReasoning(model: ModelDescriptor): boolean {
  return model.provider === "codex" && Boolean(model.supportedReasoningLevels?.length);
}

function resolveReasoningEffort(model: ModelDescriptor, configuredEfforts: Record<string, string>): string {
  const levels = model.supportedReasoningLevels ?? [];
  const configured = configuredEfforts[model.id];
  if (configured && levels.some((level) => level.effort === configured)) return configured;
  if (model.defaultReasoningLevel && levels.some((level) => level.effort === model.defaultReasoningLevel)) return model.defaultReasoningLevel;
  return levels[0]?.effort ?? "";
}

function formatReasoningEffort(effort: string): string {
  if (effort === "xhigh") return "Extra high";
  return effort.replace(/[-_]/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

interface ModelSelectorsProps { compact?: boolean; }

export function ModelSelectors({ compact }: ModelSelectorsProps) {
  const codingModelId = useAppStore((s) => s.codingModelId);
  const judgeModelId = useAppStore((s) => s.judgeModelId);
  const maxIterations = useAppStore((s) => s.maxIterations);
  const mode = useAppStore((s) => s.mode);
  const setCodingModelId = useAppStore((s) => s.setCodingModelId);
  const setJudgeModelId = useAppStore((s) => s.setJudgeModelId);
  const setMaxIterations = useAppStore((s) => s.setMaxIterations);

  if (compact) return <div className="flex items-center gap-1.5"><ModelPicker label={mode === "goal" ? "Coding model" : "Model"} value={codingModelId} onChange={setCodingModelId} compact />{mode === "goal" && <ModelPicker label="Judge model" value={judgeModelId} onChange={setJudgeModelId} compact isJudgePicker />}</div>;

  return <div className="flex items-end gap-3 flex-wrap">
    <div className="w-48"><ModelPicker label={mode === "goal" ? "Coding model" : "Model"} value={codingModelId} onChange={setCodingModelId} /></div>
    {mode === "goal" && <><div className="w-48"><ModelPicker label="Judge model" value={judgeModelId} onChange={setJudgeModelId} isJudgePicker /></div><div><label className="block text-xs text-gray-500 mb-1 font-medium">Max iterations</label><input type="number" min={1} max={10} value={maxIterations} onChange={(e) => setMaxIterations(parseInt(e.target.value) || 3)} className="w-16 px-2 py-1.5 text-sm bg-gray-50 border border-gray-200 rounded-lg text-gray-900 focus:outline-none focus:border-indigo-400" /></div></>}
  </div>;
}
