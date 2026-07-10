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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-full max-w-md bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl">
        <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-800">
          <h2 className="text-sm font-semibold text-zinc-100">Settings</h2>
          <button
            onClick={() => setShowSettings(false)}
            className="p-1 text-zinc-400 hover:text-zinc-200 transition-colors"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="p-4 space-y-4">
          <div>
            <label className="block text-xs text-zinc-500 mb-1.5">
              OpenRouter API Key
            </label>
            <input
              type="password"
              value={settings.openRouterApiKey ?? ""}
              onChange={(e) =>
                updateSettings({ openRouterApiKey: e.target.value })
              }
              placeholder="sk-or-..."
              className="w-full px-3 py-2 text-sm bg-zinc-800 border border-zinc-700 rounded-lg text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-indigo-500"
            />
            <button
              onClick={handleSaveApiKey}
              className="mt-2 px-3 py-1.5 text-xs bg-indigo-600 hover:bg-indigo-500 text-white rounded-md transition-colors"
            >
              Save & Load Models
            </button>
          </div>

          <div>
            <label className="block text-xs text-zinc-500 mb-1.5">
              Command Permission Mode
            </label>
            <select
              value={settings.commandPermissionMode}
              onChange={(e) =>
                updateSettings({
                  commandPermissionMode: e.target.value as CommandPermissionMode,
                })
              }
              className="w-full px-3 py-2 text-sm bg-zinc-800 border border-zinc-700 rounded-lg text-zinc-200 focus:outline-none focus:border-indigo-500"
            >
              <option value="ask_every_time">Ask every time</option>
              <option value="auto_approve_safe">Auto-approve safe commands</option>
              <option value="auto_approve_all">Auto-approve all commands</option>
            </select>
          </div>

          <div>
            <label className="block text-xs text-zinc-500 mb-1.5">
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
              className="w-20 px-3 py-2 text-sm bg-zinc-800 border border-zinc-700 rounded-lg text-zinc-200 focus:outline-none focus:border-indigo-500"
            />
          </div>
        </div>

        <div className="px-4 py-3 border-t border-zinc-800 text-xs text-zinc-500">
          API keys are stored locally. OpenRouter is the primary model provider.
        </div>
      </div>
    </div>
  );
}
