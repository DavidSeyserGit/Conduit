import { useAppStore } from "@/stores/app-store";
import type { CommandPermissionMode } from "@loopkit/shared";

export function SettingsPanel() {
  const showSettings = useAppStore((s) => s.showSettings);
  const setShowSettings = useAppStore((s) => s.setShowSettings);
  const settings = useAppStore((s) => s.settings);
  const updateSettings = useAppStore((s) => s.updateSettings);
  const loadModels = useAppStore((s) => s.loadModels);
  const initProviders = useAppStore((s) => s.initProviders);

  if (!showSettings) return null;

  const handleSaveApiKey = async () => {
    initProviders();
    await loadModels();
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

        <div className="px-5 py-3.5 border-t border-gray-100 bg-gray-50 text-xs text-gray-500">
          API keys are stored locally. OpenRouter is the primary model provider.
        </div>
      </div>
    </div>
  );
}
