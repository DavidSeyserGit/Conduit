import { useEffect, useState } from "react";
import { useAppStore } from "@/stores/app-store";
import { HARNESS_DEFINITIONS } from "@conduit/model-providers";
import { harnessStatusView, type HarnessHealthMap } from "@/lib/harness-health";
import type { CommandPermissionMode } from "@conduit/shared";
import { DEFAULT_GOAL_COLOR, getModeColor } from "@/lib/mode-colors";
import { ModelPicker, ProviderIcon } from "@/features/model-picker/ModelPicker";
import { resolveQualityLanes } from "@/lib/quality-lanes";
import type { QualityLaneId } from "@conduit/shared";
import { PopoverScope, usePopover } from "@/lib/popover";

const COLORS = [
  { name: "Blue", value: "#3b82f6" },
  { name: "Purple", value: "#8b5cf6" },
  { name: "Pink", value: "#ec4899" },
  { name: "Orange", value: "#f97316" },
  { name: "Green", value: "#10b981" },
  { name: "Cyan", value: "#06b6d4" },
];

type SettingsTab = "model" | "color" | "permission" | "defaults" | "updates";

export function SettingsPanel() {
  const showSettings = useAppStore((s) => s.showSettings);
  const setShowSettings = useAppStore((s) => s.setShowSettings);
  const settings = useAppStore((s) => s.settings);
  const updateSettings = useAppStore((s) => s.updateSettings);
  const refreshModels = useAppStore((s) => s.refreshModels);
  const saveOpenRouterKey = useAppStore((s) => s.saveOpenRouterKey);
  const initProviders = useAppStore((s) => s.initProviders);
  const models = useAppStore((s) => s.models);
  const providerErrors = useAppStore((s) => s.providerErrors);
  const codingModelId = useAppStore((s) => s.codingModelId);
  const judgeModelId = useAppStore((s) => s.judgeModelId);
  const setCodingModelId = useAppStore((s) => s.setCodingModelId);
  const setJudgeModelId = useAppStore((s) => s.setJudgeModelId);
  const setMaxIterations = useAppStore((s) => s.setMaxIterations);
  const [tab, setTab] = useState<SettingsTab>("model");
  const [keyError, setKeyError] = useState<string | null>(null);
  const harnessHealth = useAppStore((s) => s.harnessHealth);
  const refreshHarnessHealth = useAppStore((s) => s.refreshHarnessHealth);
  const popover = usePopover({ open: showSettings, onClose: () => setShowSettings(false) });

  useEffect(() => {
    if (showSettings) void refreshHarnessHealth();
  }, [showSettings, refreshHarnessHealth]);

  if (!showSettings) return null;

  const handleSaveApiKey = async () => {
    setKeyError(null);
    try {
      await saveOpenRouterKey(settings.openRouterApiKey ?? "");
    } catch (error) {
      setKeyError(error instanceof Error ? error.message : String(error));
      return;
    }
    initProviders();
    await refreshModels();
  };

  const askColor = getModeColor(settings, "ask");
  const goalColor = settings.goalModeColor ?? DEFAULT_GOAL_COLOR;

  return (
    <PopoverScope popover={popover}>
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
      <div ref={popover.setBoundary} className="w-[min(92vw,560px)] h-[min(680px,calc(100vh-32px))] min-h-0 flex flex-col bg-white rounded-2xl shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100 shrink-0">
          <div>
            <h2 className="text-base font-semibold text-gray-900">Settings</h2>
            <p className="text-xs text-gray-400 mt-0.5">Make Conduit feel like yours</p>
          </div>
          <button onClick={() => setShowSettings(false)} className="p-1.5 text-gray-400 hover:text-gray-700 hover:bg-gray-100 rounded-lg transition-colors" aria-label="Close settings">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>

        <div className="px-3 pt-3 border-b border-gray-100 shrink-0">
          <div className="grid grid-cols-5 gap-1 bg-gray-50 rounded-xl p-1">
            {(["model", "color", "permission", "defaults", "updates"] as SettingsTab[]).map((item) => (
              <button key={item} onClick={() => setTab(item)} className={`px-1.5 py-2 text-[11px] rounded-lg transition-colors ${tab === item ? "bg-white text-gray-900 shadow-sm font-medium" : "text-gray-500 hover:text-gray-800"}`}>
                {item[0].toUpperCase() + item.slice(1)}
              </button>
            ))}
          </div>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto bg-white p-5 pb-8">
          {tab === "model" && <ModelSettings settings={settings} openRouterKey={settings.openRouterApiKey ?? ""} keyError={keyError} health={harnessHealth} providerErrors={providerErrors} onOpenRouterKeyChange={(value) => updateSettings({ openRouterApiKey: value })} onToggleHarness={(id, enabled) => { updateSettings({ enabledHarnesses: { ...settings.enabledHarnesses, [id]: enabled } }); initProviders(); void refreshModels(); }} onSaveKey={() => void handleSaveApiKey()} />}
          {tab === "color" && <ColorSettings askColor={askColor} goalColor={goalColor} onAskColor={(value) => updateSettings({ askModeColor: value, inputGlowColor: value })} onGoalColor={(value) => updateSettings({ goalModeColor: value })} />}
          {tab === "permission" && <PermissionSettings value={settings.commandPermissionMode} onChange={(value) => updateSettings({ commandPermissionMode: value })} />}
          {tab === "defaults" && <DefaultsSettings settings={settings} models={models} currentCodingModelId={codingModelId} currentJudgeModelId={judgeModelId} updateSettings={updateSettings} onApply={() => { if (settings.defaultCodingModelId) setCodingModelId(settings.defaultCodingModelId); if (settings.defaultJudgeModelId) setJudgeModelId(settings.defaultJudgeModelId); setMaxIterations(settings.defaultMaxIterations); }} />}
          {tab === "updates" && <UpdatesSettings />}
        </div>

        <div className="px-5 py-3 border-t border-gray-100 bg-gray-50 text-xs text-gray-500 shrink-0">
          OpenRouter keys are stored in the system keychain in the desktop app and browser storage in preview mode.
        </div>
      </div>
    </div>
    </PopoverScope>
  );
}

function ModelSettings({ settings, openRouterKey, keyError, health, providerErrors, onOpenRouterKeyChange, onToggleHarness, onSaveKey }: { settings: ReturnType<typeof useAppStore.getState>["settings"]; openRouterKey: string; keyError: string | null; health: HarnessHealthMap | null; providerErrors: Record<string, string>; onOpenRouterKeyChange: (value: string) => void; onToggleHarness: (id: "openrouter" | "codex" | "acp" | "kilo" | "kimi", enabled: boolean) => void; onSaveKey: () => void }) {
  return <div className="space-y-5">
    <SectionTitle title="Model providers" description="Choose which harnesses are available in the model picker." />
    <div className="space-y-2">
      {HARNESS_DEFINITIONS.map((harness) => {
        const enabled = settings.enabledHarnesses?.[harness.id] ?? (harness.id === "openrouter" ? Boolean(openRouterKey) : harness.available);
        const status = (harness.id === "codex" || harness.id === "kilo" || harness.id === "kimi") ? harnessStatusView(harness.id, health, harness.installHint) : null;
        return <div key={harness.id} className={`flex items-center gap-3 p-3 min-h-[62px] rounded-xl border ${harness.available ? "border-gray-200" : "border-gray-100 bg-gray-50"}`}>
          <div className="w-8 h-8 rounded-lg bg-gray-100 flex items-center justify-center text-xs font-semibold text-gray-500">{harness.id === "kilo" ? <ProviderIcon provider={harness.id} /> : harness.name.slice(0, 1)}</div>
          <div className="min-w-0 flex-1"><div className="text-sm font-medium text-gray-800">{harness.name}</div><div className="text-xs text-gray-400 truncate">{harness.description}{!harness.available ? " · Coming later" : ""}</div>{status && <div className={`text-xs truncate ${status.tone === "warn" ? "text-amber-700" : status.tone === "ok" ? "text-emerald-600" : "text-gray-400"}`}>{status.text}</div>}</div>
          <button disabled={!harness.available} onClick={() => onToggleHarness(harness.id as "openrouter" | "codex" | "acp" | "kilo" | "kimi", !enabled)} className={`relative w-10 h-6 shrink-0 rounded-full transition-colors ${!harness.available ? "bg-gray-200 cursor-not-allowed" : enabled ? "bg-emerald-500" : "bg-gray-300"}`} aria-label={`${enabled ? "Disable" : "Enable"} ${harness.name}`}><span className={`absolute left-1 top-1 w-4 h-4 rounded-full bg-white shadow-sm transition-transform ${enabled ? "translate-x-4" : "translate-x-0"}`} /></button>
        </div>;
      })}
    </div>
    {Object.keys(providerErrors).length > 0 && (
      <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 space-y-1">
        <div className="text-xs font-medium text-amber-800">Some providers failed to load</div>
        {Object.entries(providerErrors).map(([id, error]) => (
          <div key={id} className="text-xs text-amber-800 break-words">{id}: {error}</div>
        ))}
      </div>
    )}
    <div><label className="block text-xs text-gray-700 mb-2 font-medium">OpenRouter API key</label><input type="password" value={openRouterKey} onChange={(e) => onOpenRouterKeyChange(e.target.value)} placeholder="sk-or-..." className="w-full px-3.5 py-2.5 text-sm bg-gray-50 border border-gray-200 rounded-xl text-gray-900 placeholder-gray-400 focus:outline-none focus:border-indigo-400" /><button onClick={onSaveKey} className="mt-2.5 px-4 py-2 text-sm bg-gray-900 hover:bg-gray-800 text-white rounded-lg transition-colors font-medium">Save & Load Models</button>{keyError && <p className="mt-2 text-xs text-red-500">{keyError}</p>}</div>
  </div>;
}

function ColorSettings({ askColor, goalColor, onAskColor, onGoalColor }: { askColor: string; goalColor: string; onAskColor: (value: string) => void; onGoalColor: (value: string) => void }) {
  return <div className="space-y-6"><SectionTitle title="Mode colors" description="Each mode gets its own accent, so you always know where you are." /><ColorChoice label="Ask" color={askColor} otherColor={goalColor} onChange={onAskColor} /><ColorChoice label="Goal" color={goalColor} otherColor={askColor} onChange={onGoalColor} /></div>;
}

function ColorChoice({ label, color, otherColor, onChange }: { label: string; color: string; otherColor: string; onChange: (value: string) => void }) {
  return <div><label className="block text-xs text-gray-700 mb-2 font-medium">{label} mode</label><div className="flex items-center gap-3">{COLORS.map((item) => { const selected = color === item.value; const unavailable = !selected && otherColor === item.value; return <button key={item.value} disabled={unavailable} type="button" title={unavailable ? `${item.name} is used by the other mode` : item.name} onClick={() => onChange(item.value)} className={`w-8 h-8 rounded-full transition-transform ${unavailable ? "opacity-20 cursor-not-allowed" : "hover:scale-110"} ${selected ? "ring-2 ring-gray-900 ring-offset-2" : "ring-1 ring-black/10"}`} style={{ backgroundColor: item.value }} />; })}</div></div>;
}

function PermissionSettings({ value, onChange }: { value: CommandPermissionMode; onChange: (value: CommandPermissionMode) => void }) {
  return <div className="space-y-5"><SectionTitle title="Permissions" description="Control how much autonomy coding harnesses have when running commands." /><select value={value} onChange={(e) => onChange(e.target.value as CommandPermissionMode)} className="w-full px-3.5 py-2.5 text-sm bg-gray-50 border border-gray-200 rounded-xl text-gray-900 focus:outline-none focus:border-indigo-400"><option value="ask_every_time">Ask every time</option><option value="auto_approve_safe">Auto-approve safe commands</option><option value="auto_approve_all">Auto-approve all commands</option></select></div>;
}

function DefaultsSettings({ settings, models, currentCodingModelId, currentJudgeModelId, updateSettings, onApply }: { settings: ReturnType<typeof useAppStore.getState>["settings"]; models: Parameters<typeof resolveQualityLanes>[0]; currentCodingModelId: string; currentJudgeModelId: string; updateSettings: (partial: Parameters<ReturnType<typeof useAppStore.getState>["updateSettings"]>[0]) => void; onApply: () => void }) {
  const lanes = resolveQualityLanes(models, settings.qualityLaneDefaults, settings.defaultCodingModelId, settings.defaultJudgeModelId);
  const defaultCoding = settings.defaultCodingModelId || currentCodingModelId;
  const defaultJudge = settings.defaultJudgeModelId || currentJudgeModelId;
  const updateLane = (id: QualityLaneId, patch: { codingModelId?: string; judgeModelId?: string; maxIterations?: number }) => updateSettings({ qualityLaneDefaults: { ...settings.qualityLaneDefaults, [id]: { ...settings.qualityLaneDefaults?.[id], ...patch } } });

  return <div className="space-y-5"><SectionTitle title="Quality lane defaults" description="Each lane is a fixed worker, judge, and repair budget. Choosing it in Agent setup always applies this configuration." />{lanes.map((lane) => <div key={lane.id} className="rounded-xl border border-gray-200 p-3.5 space-y-3"><div className="flex items-start justify-between gap-3"><div><div className="text-sm font-semibold text-gray-800">{lane.title}</div><div className="mt-0.5 text-xs text-gray-500">{lane.description}</div></div><span className="text-[10px] font-medium text-gray-400 bg-gray-50 border border-gray-100 rounded-md px-1.5 py-0.5">{lane.iterations} loops</span></div><div className="grid grid-cols-2 gap-3"><ModelPicker label="Worker" value={lane.codingModelId} onChange={(id) => updateLane(lane.id, { codingModelId: id })} /><ModelPicker label="Judge" value={lane.judgeModelId} onChange={(id) => updateLane(lane.id, { judgeModelId: id })} isJudgePicker /></div><label className="block text-xs text-gray-700 font-medium">Repair loops<input type="number" min={1} max={10} value={lane.iterations} onChange={(event) => updateLane(lane.id, { maxIterations: Math.min(10, Math.max(1, parseInt(event.target.value) || 3)) })} className="mt-1.5 block w-20 px-3 py-2 text-sm bg-gray-50 border border-gray-200 rounded-lg text-gray-900 outline-none focus:border-indigo-400" /></label></div>)}<div className="pt-1 border-t border-gray-100"><div className="text-xs font-medium text-gray-700 mb-2">Custom setup fallback</div><div className="grid grid-cols-2 gap-3"><ModelPicker label="Default worker" value={defaultCoding} onChange={(id) => updateSettings({ defaultCodingModelId: id })} /><ModelPicker label="Default judge" value={defaultJudge} onChange={(id) => updateSettings({ defaultJudgeModelId: id })} isJudgePicker /></div><div className="mt-3 flex items-center justify-between gap-3"><label className="text-xs text-gray-700 font-medium">Default loops<input type="number" min={1} max={10} value={settings.defaultMaxIterations} onChange={(e) => updateSettings({ defaultMaxIterations: Math.min(10, Math.max(1, parseInt(e.target.value) || 3)) })} className="mt-1.5 block w-20 px-3 py-2 text-sm bg-gray-50 border border-gray-200 rounded-lg text-gray-900 outline-none focus:border-indigo-400" /></label><button onClick={onApply} disabled={!defaultCoding || !defaultJudge} className="self-end shrink-0 px-3 py-1.5 text-xs font-medium text-white bg-gray-900 hover:bg-gray-800 disabled:bg-gray-300 rounded-lg transition-colors">Use custom now</button></div></div></div>;
}

function UpdatesSettings() {
  const settings = useAppStore((s) => s.settings);
  const updateSettings = useAppStore((s) => s.updateSettings);
  const [checking, setChecking] = useState(false);
  const [info, setInfo] = useState<{ available: boolean; currentVersion: string; latestVersion: string; body?: string } | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const isTauri = Boolean((window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);

  const handleCheck = async () => {
    setChecking(true); setError(null);
    try {
      const { checkForUpdates } = await import("@/lib/updater");
      const result = await checkForUpdates();
      setInfo(result);
      updateSettings({ lastUpdateCheckAt: new Date().toISOString() });
      if (!result?.available) setProgress(null);
    } catch (e) { setError(String(e)); }
    finally { setChecking(false); }
  };

  const handleUpdate = async () => {
    setError(null); setProgress(0);
    try {
      const { downloadAndInstallUpdate } = await import("@/lib/updater");
      await downloadAndInstallUpdate((ev) => {
        if (ev.event === "progress") {
          const d = ev.data as { downloaded: number; total: number };
          if (d.total > 0) setProgress(Math.round((d.downloaded / d.total) * 100));
        }
      });
    } catch (e) { setError(String(e)); setProgress(null); }
  };

  return <div className="space-y-5">
    <SectionTitle title="Updates" description={isTauri ? "Tauri auto-updater checks GitHub releases and verifies Ed25519 signatures." : "Web preview shows latest GitHub release. Use the desktop app for auto-update."} />
    <div className="rounded-xl border border-gray-200 p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div><div className="text-sm font-medium text-gray-900">Automatic checks</div><div className="text-xs text-gray-500">Check on startup</div></div>
        <button onClick={() => updateSettings({ autoCheckUpdates: !settings.autoCheckUpdates })} className={`relative w-10 h-6 rounded-full transition-colors ${settings.autoCheckUpdates ?? true ? "bg-emerald-500" : "bg-gray-300"}`}><span className={`absolute left-1 top-1 w-4 h-4 rounded-full bg-white transition-transform ${settings.autoCheckUpdates ?? true ? "translate-x-4" : ""}`} /></button>
      </div>
      {settings.lastUpdateCheckAt && <div className="text-xs text-gray-400">Last check: {new Date(settings.lastUpdateCheckAt).toLocaleString()}</div>}
      <div className="flex gap-2">
        <button onClick={() => void handleCheck()} disabled={checking} className="px-4 py-2 text-sm bg-gray-900 text-white rounded-lg disabled:opacity-50">{checking ? "Checking..." : "Check for updates"}</button>
        {info?.available && <button onClick={() => void handleUpdate()} disabled={progress !== null} className="px-4 py-2 text-sm bg-indigo-600 text-white rounded-lg disabled:opacity-50">{progress !== null ? `${progress}%` : `Update to ${info.latestVersion}`}</button>}
      </div>
      {info && !info.available && <div className="text-xs text-emerald-600 bg-emerald-50 border border-emerald-100 rounded-lg p-2.5">You are on the latest version ({info.currentVersion})</div>}
      {info?.available && <div className="text-xs border rounded-lg p-3 bg-indigo-50 border-indigo-100"><div className="font-medium text-indigo-900">{info.currentVersion} → {info.latestVersion}</div>{info.body && <div className="mt-1 text-indigo-800 whitespace-pre-wrap max-h-32 overflow-y-auto">{info.body.slice(0, 500)}</div>}</div>}
      {error && <div className="text-xs text-red-600 bg-red-50 border border-red-100 rounded-lg p-2.5">{error}</div>}
      {progress !== null && <div className="w-full h-2 bg-gray-100 rounded-full overflow-hidden"><div className="h-full bg-indigo-500 transition-all" style={{ width: `${progress}%` }} /></div>}
    </div>
    <div className="text-[11px] text-gray-400">Public key: <code className="bg-gray-50 px-1 rounded">GgxsqVp5bo...</code> · Endpoint: <code className="bg-gray-50 px-1 rounded">releases/latest/download/latest.json</code></div>
  </div>;
}

function SectionTitle({ title, description }: { title: string; description: string }) {
  return <div><h3 className="text-sm font-semibold text-gray-900">{title}</h3><p className="text-xs text-gray-500 mt-1">{description}</p></div>;
}
