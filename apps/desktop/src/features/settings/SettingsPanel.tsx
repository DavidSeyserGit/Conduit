import { useAppStore } from "@/stores/app-store";
import type { CommandPermissionMode } from "@loopkit/shared";

const GLOW_COLORS = [
  { name: "Blue", value: "#3b82f6" },
  { name: "Purple", value: "#8b5cf6" },
  { name: "Pink", value: "#ec4899" },
  { name: "Orange", value: "#f97316" },
  { name: "Green", value: "#10b981" },
  { name: "Cyan", value: "#06b6d4" },
];

export function SettingsPanel() {
  const showSettings = useAppStore((s) => s.showSettings);
  const setShowSettings = useAppStore((s) => s.setShowSettings);
  const settings = useAppStore((s) => s.settings);
  const updateSettings = useAppStore((s) => s.updateSettings);
  const refreshModels = useAppStore((s) => s.refreshModels);
  const saveOpenRouterKey = useAppStore((s) => s.saveOpenRouterKey);
  const initProviders = useAppStore((s) => s.initProviders);

  if (!showSettings) return null;

  const handleSaveApiKey = async () => {
    await saveOpenRouterKey(settings.openRouterApiKey ?? "");
    initProviders();
    await refreshModels();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="w-full max-w-md bg-white rounded-2xl shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
          <h2 className="text-base font-semibold text-gray-900">Settings</h2>
          <button
            onClick={() => setShowSettings(false)}
            className="p-1.5 text-gray-400 hover:text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="p-5 space-y-5">
          <div>
            <label className="block text-xs text-gray-700 mb-2 font-medium">
              Input Glow Color
            </label>
            <div className="flex items-center gap-3">
              {GLOW_COLORS.map((color) => (
                <button
                  key={color.value}
                  type="button"
                  title={color.name}
                  aria-label={`${color.name} input glow`}
                  onClick={() => updateSettings({ inputGlowColor: color.value })}
                  className={`w-8 h-8 rounded-full transition-transform hover:scale-110 ${
                    (settings.inputGlowColor ?? "#3b82f6") === color.value
                      ? "ring-2 ring-gray-900 ring-offset-2"
                      : "ring-1 ring-black/10"
                  }`}
                  style={{ backgroundColor: color.value }}
                />
              ))}
            </div>
          </div>

          <div>
            <label className="block text-xs text-gray-700 mb-2 font-medium">
              OpenRouter API Key
            </label>
            <input
              type="password"
              value={settings.openRouterApiKey ?? ""}
              onChange={(e) =>
                updateSettings({ openRouterApiKey: e.target.value })
              }
              placeholder="sk-or-..."
              className="w-full px-3.5 py-2.5 text-sm bg-gray-50 border border-gray-200 rounded-xl text-gray-900 placeholder-gray-400 focus:outline-none focus:border-indigo-400 focus:bg-white focus:ring-2 focus:ring-indigo-100 transition-all"
            />
            <button
              onClick={handleSaveApiKey}
              className="mt-2.5 px-4 py-2 text-sm bg-gray-900 hover:bg-gray-800 text-white rounded-lg transition-colors font-medium"
            >
              Save & Load Models
            </button>
          </div>

          <div>
            <label className="block text-xs text-gray-700 mb-2 font-medium">
              Command Permission Mode
            </label>
            <select
              value={settings.commandPermissionMode}
              onChange={(e) =>
                updateSettings({
                  commandPermissionMode: e.target.value as CommandPermissionMode,
                })
              }
              className="w-full px-3.5 py-2.5 text-sm bg-gray-50 border border-gray-200 rounded-xl text-gray-900 focus:outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 transition-all"
            >
              <option value="ask_every_time">Ask every time</option>
              <option value="auto_approve_safe">Auto-approve safe commands</option>
              <option value="auto_approve_all">Auto-approve all commands</option>
            </select>
          </div>

          <div>
            <label className="block text-xs text-gray-700 mb-2 font-medium">
              Default Max Iterations
            </label>
            <input
              type="number"
              min={1}
              max={10}
              value={settings.defaultMaxIterations}
              onChange={(e) =>
                updateSettings({
                  defaultMaxIterations: parseInt(e.target.value) || 3,
                })
              }
              className="w-24 px-3.5 py-2.5 text-sm bg-gray-50 border border-gray-200 rounded-xl text-gray-900 focus:outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 transition-all"
            />
          </div>
        </div>

        <div className="px-5 py-3.5 border-t border-gray-100 bg-gray-50 text-xs text-gray-500 space-y-1.5">
          <div>OpenRouter keys are stored in the system keychain in the desktop app and browser storage in preview mode.</div>
          <div className="text-gray-400">
            <span className="font-medium text-indigo-600">Tip:</span> Use your ChatGPT subscription for coding — select <span className="font-medium">Codex (ChatGPT subscription)</span> as the coding model after running <code className="bg-gray-200 px-1 rounded">codex login</code> in your terminal.
          </div>
        </div>
      </div>
    </div>
  );
}
