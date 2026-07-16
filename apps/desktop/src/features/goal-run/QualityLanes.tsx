import { useMemo, useState } from "react";
import type { ModelDescriptor } from "@conduit/shared";
import { useAppStore } from "@/stores/app-store";
import { ModelPicker } from "@/features/model-picker/ModelPicker";
import { resolveQualityLanes } from "@/lib/quality-lanes";
import { PopoverScope, usePopover } from "@/lib/popover";

export function GoalModelSetup() {
  const models = useAppStore((state) => state.models);
  const codingModelId = useAppStore((state) => state.codingModelId);
  const judgeModelId = useAppStore((state) => state.judgeModelId);
  const maxIterations = useAppStore((state) => state.maxIterations);
  const setCodingModelId = useAppStore((state) => state.setCodingModelId);
  const setJudgeModelId = useAppStore((state) => state.setJudgeModelId);
  const setMaxIterations = useAppStore((state) => state.setMaxIterations);
  const settings = useAppStore((state) => state.settings);
  const [open, setOpen] = useState(false);
  const popover = usePopover({ open, onClose: () => setOpen(false) });

  const lanes = useMemo(
    () => resolveQualityLanes(models, settings.qualityLaneDefaults, settings.defaultCodingModelId, settings.defaultJudgeModelId),
    [models, settings.defaultCodingModelId, settings.defaultJudgeModelId, settings.qualityLaneDefaults]
  );

  const activeLane = lanes.find((lane) => lane.codingModelId === codingModelId && lane.judgeModelId === judgeModelId && lane.iterations === maxIterations);
  const workerName = displayName(models, codingModelId);
  const judgeName = displayName(models, judgeModelId);

  if (!lanes.length) return null;

  return (
    <PopoverScope popover={popover}>
    <div ref={popover.setBoundary} className="relative">
      <button
        onClick={() => setOpen((value) => !value)}
        className="flex items-center gap-2 max-w-[430px] px-3 py-1.5 text-xs bg-gray-100 hover:bg-gray-200 text-gray-600 rounded-full transition-colors font-medium"
        title="Choose an agent setup"
      >
        <svg className="w-3.5 h-3.5 text-gray-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="m12 3 2.2 4.5L19 8.2l-3.5 3.4.8 4.8-4.3-2.3-4.3 2.3.8-4.8L5 8.2l4.8-.7L12 3Z" /></svg>
        <span className="shrink-0">{activeLane?.title ?? "Custom"}</span>
        <span className="w-px h-3 bg-gray-300" />
        <span className="min-w-0 truncate text-gray-500">{workerName}</span>
        <span className="text-gray-400">→</span>
        <span className="min-w-0 truncate text-gray-500">{judgeName}</span>
        <svg className="w-3 h-3 text-gray-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m19 9-7 7-7-7" /></svg>
      </button>

      {open && (
        <div className="absolute z-50 right-0 bottom-full mb-2 w-[390px] bg-white border border-gray-200 rounded-2xl shadow-xl p-1.5">
          <div className="px-2.5 py-2 text-[10px] uppercase tracking-[0.12em] font-semibold text-gray-400">Agent setup</div>
          {lanes.map((lane) => {
            const active = lane.id === activeLane?.id;
            return (
              <button
                key={lane.id}
                onClick={() => {
                  setCodingModelId(lane.codingModelId);
                  setJudgeModelId(lane.judgeModelId);
                  setMaxIterations(lane.iterations);
                  setOpen(false);
                }}
                className={`w-full flex items-start gap-2.5 rounded-xl px-2.5 py-2.5 text-left transition-colors ${active ? "bg-gray-100" : "hover:bg-gray-50"}`}
              >
                <span className={`mt-1 w-1.5 h-1.5 rounded-full shrink-0 ${active ? "bg-gray-900" : lane.id === "fast" ? "bg-emerald-400" : lane.id === "confidence" ? "bg-indigo-400" : "bg-amber-400"}`} />
                <span className="min-w-0 flex-1"><span className="block text-xs font-semibold text-gray-800">{lane.title}</span><span className="block mt-0.5 text-[11px] leading-snug text-gray-500">{lane.description}</span><span className="block mt-1 text-[10px] text-gray-400 truncate">{displayName(models, lane.codingModelId)} → {displayName(models, lane.judgeModelId)}</span></span>
                <span className="mt-0.5 text-[10px] text-gray-400 shrink-0">{lane.iterations}×</span>
              </button>
            );
          })}
          <div className="mx-2 my-1.5 border-t border-gray-100" />
          <div className="px-2.5 pt-1.5 pb-2 text-[10px] uppercase tracking-[0.12em] font-semibold text-gray-400">Tune manually</div>
          <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] gap-2 px-1.5 pb-1.5 items-end">
            <ModelPicker label="Worker" value={codingModelId} onChange={setCodingModelId} compact />
            <ModelPicker label="Judge" value={judgeModelId} onChange={setJudgeModelId} compact isJudgePicker />
            <label className="text-[10px] text-gray-400">Loops<input type="number" min={1} max={10} value={maxIterations} onChange={(event) => setMaxIterations(parseInt(event.target.value) || 3)} className="mt-1 block w-12 px-2 py-1.5 text-xs text-gray-700 bg-gray-50 border border-gray-200 rounded-lg outline-none" /></label>
          </div>
        </div>
      )}
    </div>
    </PopoverScope>
  );
}

function displayName(models: ModelDescriptor[], modelId: string): string {
  return models.find((model) => model.id === modelId)?.displayName ?? modelId.split("/").slice(-2).join("/");
}
