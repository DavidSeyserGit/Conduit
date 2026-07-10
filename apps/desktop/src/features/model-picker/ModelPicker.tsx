import { useState, useMemo } from "react";
import type { ModelDescriptor } from "@loopkit/shared";
import { useAppStore } from "@/stores/app-store";

interface ModelPickerProps {
  label: string;
  value: string;
  onChange: (id: string) => void;
  compact?: boolean;
}

export function ModelPicker({ label, value, onChange, compact }: ModelPickerProps) {
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
      {!compact && <label className="block text-xs text-gray-500 mb-1 font-medium">{label}</label>}
      <button
        onClick={() => setOpen(!open)}
        className={compact
          ? "flex items-center gap-1 px-3 py-1.5 text-xs bg-gray-100 hover:bg-gray-200 text-gray-600 rounded-full transition-colors font-medium"
          : "w-full text-left px-3 py-1.5 text-sm bg-gray-50 border border-gray-200 rounded-lg hover:border-gray-300 transition-colors truncate text-gray-700"
        }
      >
        {selected ? (
          <span className={compact ? "truncate" : ""}>{selected.displayName}</span>
        ) : (
          <span className={compact ? "text-gray-400" : "text-gray-500"}>{compact ? "Model" : "Select model..."}</span>
        )}
        <svg className={`w-3 h-3 ${compact ? "text-gray-400" : "text-gray-400"}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div className="absolute z-50 bottom-full mb-2 w-72 max-h-72 overflow-hidden bg-white border border-gray-200 rounded-xl shadow-xl">
          <div className="p-2 border-b border-gray-100">
            <input
              type="text"
              placeholder="Search models..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full px-2.5 py-1.5 text-sm bg-gray-50 border border-gray-200 rounded-lg text-gray-900 placeholder-gray-400 focus:outline-none focus:border-indigo-400 focus:bg-white"
              autoFocus
            />
          </div>
          <div className="overflow-y-auto max-h-56">
            {filtered.length === 0 ? (
              <div className="p-4 text-sm text-gray-500 text-center">
                {models.length === 0 ? (
                  <div>
                    <div className="font-medium mb-1">No models loaded</div>
                    <div className="text-xs">Configure API key in settings</div>
                  </div>
                ) : (
                  "No models found"
                )}
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
      className={`w-full text-left px-3 py-2.5 hover:bg-gray-50 transition-colors border-l-2 ${
        selected ? "bg-indigo-50/60 border-l-indigo-500" : "border-l-transparent"
      }`}
    >
      <div className="flex items-center justify-between">
        <span className="text-sm text-gray-900 truncate font-medium">{model.displayName}</span>
        <span className="text-xs text-gray-400 ml-2 shrink-0 bg-gray-100 px-1.5 py-0.5 rounded">{model.provider}</span>
      </div>
      <div className="flex items-center gap-2 mt-0.5">
        {model.contextLength && (
          <span className="text-xs text-gray-400">
            {(model.contextLength / 1000).toFixed(0)}k ctx
          </span>
        )}
        {model.supportsTools && (
          <span className="text-xs text-emerald-600 bg-emerald-50 px-1 rounded">tools</span>
        )}
        {model.inputPrice !== undefined && (
          <span className="text-xs text-gray-400">
            ${model.inputPrice.toFixed(2)}/M
          </span>
        )}
      </div>
    </button>
  );
}

interface ModelSelectorsProps {
  compact?: boolean;
}

export function ModelSelectors({ compact }: ModelSelectorsProps) {
  const codingModelId = useAppStore((s) => s.codingModelId);
  const judgeModelId = useAppStore((s) => s.judgeModelId);
  const maxIterations = useAppStore((s) => s.maxIterations);
  const mode = useAppStore((s) => s.mode);
  const setCodingModelId = useAppStore((s) => s.setCodingModelId);
  const setJudgeModelId = useAppStore((s) => s.setJudgeModelId);
  const setMaxIterations = useAppStore((s) => s.setMaxIterations);

  if (compact) {
    return (
      <div className="flex items-center gap-1.5">
        <ModelPicker
          label={mode === "goal" ? "Coding model" : "Model"}
          value={codingModelId}
          onChange={setCodingModelId}
          compact
        />
        {mode === "goal" && (
          <ModelPicker
            label="Judge model"
            value={judgeModelId}
            onChange={setJudgeModelId}
            compact
          />
        )}
      </div>
    );
  }

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
            <label className="block text-xs text-gray-500 mb-1 font-medium">Max iterations</label>
            <input
              type="number"
              min={1}
              max={10}
              value={maxIterations}
              onChange={(e) => setMaxIterations(parseInt(e.target.value) || 3)}
              className="w-16 px-2 py-1.5 text-sm bg-gray-50 border border-gray-200 rounded-lg text-gray-900 focus:outline-none focus:border-indigo-400"
            />
          </div>
        </>
      )}
    </div>
  );
}
