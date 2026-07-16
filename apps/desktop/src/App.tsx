import { useEffect, useRef, useState } from "react";
import { useAppStore } from "@/stores/app-store";
import { ChatHeader } from "@/features/chat/ChatHeader";
import { ChatTimeline } from "@/features/goal-run/ExecutionTimeline";
import { ChatInput } from "@/features/chat/ChatInput";
import { SettingsPanel } from "@/features/settings/SettingsPanel";
import { LeftSidebar } from "@/features/sidebar/LeftSidebar";
import { GitDiffPanel } from "@/features/git/GitDiffPanel";

export default function App() {
  const initProviders = useAppStore((s) => s.initProviders);
  const loadModels = useAppStore((s) => s.loadModels);
  const hydrateOpenRouterKey = useAppStore((s) => s.hydrateOpenRouterKey);
  const theme = useAppStore((s) => s.settings.theme ?? "light");
  const settings = useAppStore((s) => s.settings);
  const updateSettings = useAppStore((s) => s.updateSettings);
  const isRunning = useAppStore((s) => s.isRunning);
  const pendingApproval = useAppStore((s) => s.pendingApproval);
  const currentRun = useAppStore((s) => s.currentRun);
  const previousRunning = useRef(false);
  const previousApprovalId = useRef<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [updateNotice, setUpdateNotice] = useState<{ version: string; body?: string } | null>(null);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
  }, [theme]);

  useEffect(() => {
    void (async () => {
      await hydrateOpenRouterKey();
      initProviders();
      await loadModels();
    })();
  }, []);

  useEffect(() => {
    if (settings.autoCheckUpdates === false) return;
    const isTauri = Boolean((window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
    if (!isTauri && window.location.hostname === "localhost") return;
    const last = settings.lastUpdateCheckAt ? new Date(settings.lastUpdateCheckAt).getTime() : 0;
    if (Date.now() - last < 60 * 60 * 1000) return;
    void (async () => {
      try {
        const { checkForUpdates } = await import("@/lib/updater");
        const info = await checkForUpdates();
        updateSettings({ lastUpdateCheckAt: new Date().toISOString() });
        if (info?.available) setUpdateNotice({ version: info.latestVersion, body: info.body });
      } catch {}
    })();
  }, []);

  useEffect(() => {
    const showNotice = (message: string) => {
      setNotice(message);
      if ("Notification" in window && Notification.permission === "granted") {
        new Notification("Conduit", { body: message });
      }
    };

    document.title = pendingApproval ? "Approval needed · Conduit" : isRunning ? "Working · Conduit" : "Conduit";
    if (pendingApproval && pendingApproval.requestId !== previousApprovalId.current) {
      showNotice("Approval needed to continue the run.");
    }
    if (previousRunning.current && !isRunning && currentRun) {
      showNotice(currentRun.status === "completed" ? "Run complete." : "Run stopped. Review the result when ready.");
    }
    previousRunning.current = isRunning;
    previousApprovalId.current = pendingApproval?.requestId ?? null;
  }, [currentRun, isRunning, pendingApproval]);

  useEffect(() => {
    if (!notice) return;
    const timeout = window.setTimeout(() => setNotice(null), 5_000);
    return () => window.clearTimeout(timeout);
  }, [notice]);

  return (
    <div className="h-full flex bg-white text-gray-900 overflow-hidden">
      <LeftSidebar />
      <main className="flex-1 flex flex-col min-h-0">
        <ChatHeader />
        <ChatTimeline />
      <ChatInput />
      </main>
      <SettingsPanel />
      <GitDiffPanel />
      {notice && <div role="status" className="fixed right-5 bottom-5 z-[60] rounded-xl border border-gray-200 bg-white px-4 py-3 text-sm text-gray-700 shadow-xl">{notice}</div>}
      {updateNotice && <div className="fixed left-1/2 -translate-x-1/2 bottom-6 z-[70] flex items-center gap-3 rounded-xl bg-gray-900 text-white px-4 py-3 shadow-2xl text-sm">
        <span>Update available: v{updateNotice.version}</span>
        <button onClick={() => { setUpdateNotice(null); useAppStore.getState().setShowSettings(true); }} className="px-3 py-1 bg-white text-gray-900 rounded-lg text-xs font-medium">View</button>
        <button onClick={() => setUpdateNotice(null)} className="p-1 text-white/60 hover:text-white">✕</button>
      </div>}
    </div>
  );
}
