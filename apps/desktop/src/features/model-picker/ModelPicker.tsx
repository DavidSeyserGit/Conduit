import { useState, useMemo } from "react";
import type { ModelDescriptor } from "@loopkit/shared";
import { useAppStore } from "@/stores/app-store";

interface ModelPickerProps {
  label: string;
  value: string;
  onChange: (id: string) => void;
}

export function ModelPicker({ label, value, onChange }: ModelPickerProps) {
  const models = useAppStore((s) => s.models);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");

  const filtered = useMemo(() => {
    if (!search) return models;
    const q = search.toLowerCase();
    return models.filter(
      (m) =>
        m.displayName.toLowerCase().includes(q) ||
        m.id.toLowerCase().includes(q) ||
        m.provider.toLowerCase().includes(q)
    );
  }, [models, search]);

  const selected = models.find((m) => m.id === value);

  return (
    <div className="relative">
      <label className="block text-xs text-zinc-500 mb-1">{label}</label>
      <button
        onClick={() => setOpen(!open)}
        className="w-full text-left px-3 py-1.5 text-sm bg-zinc-800 border border-zinc-700 rounded-md hover:border-zinc-600 transition-colors truncate"
      >
        {selected ? (
          <span className="text-zinc-200">{selected.displayName}</span>
        ) : (
          <span className="text-zinc-500">Select model...</span>
        )}
      </button>

      {open && (
        <div className="absolute z-50 bottom-full mb-1 w-80 max-h-64 overflow-hidden bg-zinc-900 border border-zinc-700 rounded-lg shadow-xl">
          <div className="p-2 border-b border-zinc-800">
            <input
              type="text"
              placeholder="Search models..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full px-2 py-1 text-sm bg-zinc-800 border border-zinc-700 rounded text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-indigo-500"
              autoFocus
            />
          </div>
          <div className="overflow-y-auto max-h-48">
            {filtered.length === 0 ? (
              <div className="p-3 text-sm text-zinc-500 text-center">
                {models.length === 0 ? "Configure API key in settings" : "No models found"}
              </div>
            ) : (
              filtered.map((model) => (
                <ModelOption
                  key={model.id}
                  model={model}
                  selected={model.id === value}
                  onSelect={() => {
                    onChange(model.id);
                    setOpen(false);
                    setSearch("");
                  }}
                />
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function ModelOption({
  model,
  selected,
  onSelect,
}: {
  model: ModelDescriptor;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      onClick={onSelect}
      className={`w-full text-left px-3 py-2 hover:bg-zinc-800 transition-colors ${
        selected ? "bg-indigo-500/10" : ""
      }`}
    >
      <div className="flex items-center justify-between">
        <span className="text-sm text-zinc-200 truncate">{model.displayName}</span>
        <span className="text-xs text-zinc-500 ml-2 shrink-0">{model.provider}</span>
      </div>
      <div className="flex items-center gap-2 mt-0.5">
        {model.contextLength && (
          <span className="text-xs text-zinc-600">
            {(model.contextLength / 1000).toFixed(0)}k ctx
          </span>
        )}
        {model.supportsTools && (
          <span className="text-xs text-zinc-600">tools</span>
        )}
        {model.inputPrice !== undefined && (
          <span className="text-xs text-zinc-600">
            ${model.inputPrice.toFixed(2)}/M in
          </span>
        )}
      </div>
    </button>
  );
}

export function ModelSelectors() {
  const codingModelId = useAppStore((s) => s.codingModelId);
  const judgeModelId = useAppStore((s) => s.judgeModelId);
  const maxIterations = useAppStore((s) => s.maxIterations);
  const mode = useAppStore((s) => s.mode);
  const setCodingModelId = useAppStore((s) => s.setCodingModelId);
  const setJudgeModelId = useAppStore((s) => s.setJudgeModelId);
  const setMaxIterations = useAppStore((s) => s.setMaxIterations);

  return (
    <div className="flex items-end gap-3 flex-wrap">
      <div className="w-48">
        <ModelPicker
          label={mode === "goal" ? "Coding model" : "Model"}
          value={codingModelId}
          onChange={setCodingModelId}
        />
      </div>
      {mode === "goal" && (
        <>
          <div className="w-48">
            <ModelPicker
              label="Judge model"
              value={judgeModelId}
              onChange={setJudgeModelId}
            />
          </div>
          <div>
            <label className="block text-xs text-zinc-500 mb-1">Max iterations</label>
            <input
              type="number"
              min={1}
              max={10}
              value={maxIterations}
              onChange={(e) => setMaxIterations(parseInt(e.target.value) || 3)}
              className="w-16 px-2 py-1.5 text-sm bg-zinc-800 border border-zinc-700 rounded-md text-zinc-200 focus:outline-none focus:border-indigo-500"
            />
          </div>
        </>
      )}
    </div>
  );
}
