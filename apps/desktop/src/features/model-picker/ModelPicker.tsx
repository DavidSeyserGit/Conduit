import { useMemo, useState } from "react";
import type { ModelDescriptor } from "@loopkit/shared";
import { isRecommendedJudgeModel } from "@loopkit/agent-runtime";
import { useAppStore } from "@/stores/app-store";

interface ModelPickerProps {
  label: string;
  value: string;
  onChange: (id: string) => void;
  compact?: boolean;
  isJudgePicker?: boolean;
}

export function ModelPicker({ label, value, onChange, compact, isJudgePicker }: ModelPickerProps) {
  const models = useAppStore((s) => s.models);
  const codingModelId = useAppStore((s) => s.codingModelId);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [provider, setProvider] = useState("all");
  const providers = useMemo(() => Array.from(new Set(models.map((model) => model.provider))), [models]);
  const filtered = useMemo(() => {
    const scoped = provider === "all" ? models : models.filter((model) => model.provider === provider);
    if (!search) return scoped;
    const query = search.toLowerCase();
    return scoped.filter((model) => `${model.displayName} ${model.id} ${model.provider}`.toLowerCase().includes(query));
  }, [models, provider, search]);
  const selected = models.find((model) => model.id === value);

  return (
    <div className="relative">
      {!compact && <label className="block text-xs text-gray-500 mb-1 font-medium">{label}</label>}
      <button onClick={() => setOpen(!open)} className={compact ? "flex items-center gap-1 px-3 py-1.5 text-xs bg-gray-100 hover:bg-gray-200 text-gray-600 rounded-full transition-colors font-medium" : "w-full flex items-center justify-between text-left px-3 py-1.5 text-sm bg-gray-50 border border-gray-200 rounded-lg hover:border-gray-300 transition-colors truncate text-gray-700"}>
        <span className="truncate">{selected?.displayName ?? (compact ? "Model" : "Select model...")}</span>
        <svg className="w-3 h-3 text-gray-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="m19 9-7 7-7-7" /></svg>
      </button>

      {open && <div className={`absolute z-50 w-[430px] h-[360px] overflow-hidden bg-white border border-gray-200 rounded-2xl shadow-xl flex ${compact ? "bottom-full mb-2 right-0" : "top-full mt-2 left-0"}`}>
        <aside className="w-12 shrink-0 border-r border-gray-100 bg-gray-50/70 flex flex-col items-center py-2 gap-1">
          <ProviderTab active={provider === "all"} label="All models" onClick={() => setProvider("all")}><span>★</span></ProviderTab>
          {providers.map((name) => <ProviderTab key={name} active={provider === name} label={name} onClick={() => setProvider(name)}><ProviderIcon provider={name} /></ProviderTab>)}
        </aside>
        <div className="min-w-0 flex-1 flex flex-col">
          <div className="h-12 px-3 border-b border-gray-100 flex items-center gap-2">
            <svg className="w-4 h-4 text-gray-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></svg>
            <input autoFocus value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search models..." className="flex-1 min-w-0 text-sm text-gray-900 placeholder-gray-400 outline-none" />
            <span className="text-[11px] text-gray-400">{filtered.length}</span>
          </div>
          <div className="overflow-y-auto flex-1 p-1.5">
            {filtered.length === 0 ? <div className="p-6 text-sm text-gray-500 text-center">{models.length === 0 ? "No models loaded" : "No models found"}</div> : filtered.map((model) => <ModelOption key={model.id} model={model} selected={model.id === value} onSelect={() => { onChange(model.id); setOpen(false); setSearch(""); }} isJudgePicker={isJudgePicker} codingModelId={codingModelId} />)}
          </div>
        </div>
      </div>}
    </div>
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

function ModelOption({ model, selected, onSelect, isJudgePicker, codingModelId }: { model: ModelDescriptor; selected: boolean; onSelect: () => void; isJudgePicker?: boolean; codingModelId: string }) {
  const isCodex = model.provider === "codex";
  const isRecommendedJudge = isJudgePicker && codingModelId && isRecommendedJudgeModel(codingModelId, model.id);

  return <button onClick={onSelect} className={`w-full text-left px-3 py-2.5 rounded-xl hover:bg-gray-50 transition-colors ${selected ? "bg-fuchsia-50" : ""}`}>
    <div className="flex items-center gap-2">
      <span className="w-6 h-6 rounded-md bg-gray-50 text-gray-500 flex items-center justify-center shrink-0"><ProviderIcon provider={model.provider} /></span>
      <span className="text-sm text-gray-900 truncate font-medium flex-1">{model.displayName}</span>
      {isRecommendedJudge && <span className="text-[10px] text-emerald-700 bg-emerald-50 border border-emerald-200 px-1.5 py-0.5 rounded font-medium">Recommended judge</span>}
      {isCodex && <span className="text-[10px] text-indigo-700 bg-indigo-50 border border-indigo-200 px-1.5 py-0.5 rounded font-medium">Subscription</span>}
      {selected && <span className="text-fuchsia-600 text-xs">✓</span>}
    </div>
    <div className="flex items-center gap-2 mt-1 pl-8">
      <span className="text-[11px] text-gray-400">{model.provider}</span>
      {model.contextLength && <span className="text-[11px] text-gray-400">{(model.contextLength / 1000).toFixed(0)}k ctx</span>}
      {model.supportsTools && <span className="text-[11px] text-emerald-600">tools</span>}
      {model.inputPrice !== undefined && <span className="text-[11px] text-gray-400">${model.inputPrice.toFixed(2)}/M</span>}
    </div>
  </button>;
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
