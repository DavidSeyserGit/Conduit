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
  const isRunning = useAppStore((s) => s.isRunning);
  const pendingApproval = useAppStore((s) => s.pendingApproval);
  const currentRun = useAppStore((s) => s.currentRun);
  const previousRunning = useRef(false);
  const previousApprovalId = useRef<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

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
    </div>
  );
}
