import { useEffect, useRef, useState } from "react";
import { useAppStore } from "@/stores/app-store";
import { ChatHeader } from "@/features/chat/ChatHeader";
import { ChatTimeline } from "@/features/goal-run/ExecutionTimeline";
import { ChatInput } from "@/features/chat/ChatInput";
import { SettingsPanel } from "@/features/settings/SettingsPanel";
import { LeftSidebar } from "@/features/sidebar/LeftSidebar";
import { GitDiffPanel } from "@/features/git/GitDiffPanel";
import { UpdateDialog } from "@/features/update/UpdateDialog";
import { WhatsNewDialog } from "@/features/update/WhatsNewDialog";
import { shouldShowChangelog, shouldShowUpdatePopup, type ReleaseChangelog } from "@/lib/update-prompts";

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
  const [updateInstalling, setUpdateInstalling] = useState(false);
  const [updateProgress, setUpdateProgress] = useState<number | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [whatsNew, setWhatsNew] = useState<ReleaseChangelog | null>(null);

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
        if (info?.available) {
          // A fresh notice reopens the dialog: clear any previous attempt's state.
          setUpdateError(null);
          setUpdateProgress(null);
          setUpdateInstalling(false);
          setUpdateNotice({ version: info.latestVersion, body: info.body });
        }
      } catch {}
    })();
  }, []);

  useEffect(() => {
    const isTauri = Boolean((window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
    if (!isTauri) return;
    void (async () => {
      try {
        const { getVersion } = await import("@tauri-apps/api/app");
        const current = await getVersion();
        const lastSeen = useAppStore.getState().settings.lastSeenChangelogVersion;
        // A missing lastSeen also shows: users updating from pre-changelog
        // versions (and fresh installs, as a welcome card) get the notes.
        if (shouldShowChangelog(current, lastSeen)) {
          const { fetchReleaseChangelog } = await import("@/lib/update-prompts");
          const changelog = await fetchReleaseChangelog(current);
          if (changelog) {
            // Only mark as seen once the notes are shown; a failed fetch
            // (offline, rate limit) retries on the next launch.
            updateSettings({ lastSeenChangelogVersion: current });
            setWhatsNew(changelog);
          }
        }
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

  const handleUpdateNow = async () => {
    setUpdateError(null);
    setUpdateInstalling(true);
    setUpdateProgress(null);
    try {
      const { downloadAndInstallUpdate } = await import("@/lib/updater");
      await downloadAndInstallUpdate((ev) => {
        if (ev.event === "progress") {
          const data = ev.data as { downloaded: number; total: number };
          if (data.total > 0) setUpdateProgress(Math.round((data.downloaded / data.total) * 100));
        }
      });
    } catch (error) {
      setUpdateError(error instanceof Error ? error.message : String(error));
    } finally {
      // Also resets on early-return paths (e.g. the non-Tauri browser flow).
      setUpdateInstalling(false);
    }
  };

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
      {updateNotice && shouldShowUpdatePopup({ available: true, latestVersion: updateNotice.version }, settings.skippedUpdateVersion) && (
        <UpdateDialog
          version={updateNotice.version}
          body={updateNotice.body}
          installing={updateInstalling}
          progress={updateProgress}
          error={updateError}
          onUpdate={() => void handleUpdateNow()}
          onLater={() => setUpdateNotice(null)}
          onSkip={() => { updateSettings({ skippedUpdateVersion: updateNotice.version }); setUpdateNotice(null); }}
        />
      )}
      {whatsNew && <WhatsNewDialog version={whatsNew.version} body={whatsNew.body} publishedAt={whatsNew.publishedAt} onClose={() => setWhatsNew(null)} />}
    </div>
  );
}
