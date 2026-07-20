import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAppStore } from "@/stores/app-store";
import { ChatHeader } from "@/features/chat/ChatHeader";
import { ChatTimeline } from "@/features/goal-run/ExecutionTimeline";
import { ChatInput } from "@/features/chat/ChatInput";
import { SettingsPanel } from "@/features/settings/SettingsPanel";
import { LeftSidebar } from "@/features/sidebar/LeftSidebar";
import { GitDiffPanel } from "@/features/git/GitDiffPanel";
import { UpdatePill } from "@/features/update/UpdatePill";
import { WhatsNewDialog } from "@/features/update/WhatsNewDialog";
import { SupportBubble } from "@/features/support/SupportBubble";
import { shouldShowChangelog, shouldShowUpdatePopup, type ReleaseChangelog } from "@/lib/update-prompts";
import { shouldShowSupportPrompt, summarizeSupportUsage } from "@/lib/support-prompt";
import { seedGoalBuilderDemo, useGoalBuilderStore } from "@/stores/goal-builder-store";
import { GoalBuilderErrorBoundary } from "@/features/goal-builder/GoalBuilderErrorBoundary";
import { configureAnonymousAnalytics, recordAnonymousEvent } from "@/lib/anonymous-analytics";

export default function App() {
  const forceSupportBubble = import.meta.env.DEV && import.meta.env.VITE_SHOW_SUPPORT_BUBBLE === "true";
  const initProviders = useAppStore((s) => s.initProviders);
  const loadModels = useAppStore((s) => s.loadModels);
  const hydrateOpenRouterKey = useAppStore((s) => s.hydrateOpenRouterKey);
  const theme = useAppStore((s) => s.settings.theme ?? "light");
  const settings = useAppStore((s) => s.settings);
  const updateSettings = useAppStore((s) => s.updateSettings);
  const isRunning = useAppStore((s) => s.isRunning);
  const pendingApproval = useAppStore((s) => s.pendingApproval);
  const currentRun = useAppStore((s) => s.currentRun);
  const sessions = useAppStore((s) => s.sessions);
  const showSettings = useAppStore((s) => s.showSettings);
  const previousRunning = useRef(false);
  const previousApprovalId = useRef<string | null>(null);
  const analyticsStarted = useRef(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [updateNotice, setUpdateNotice] = useState<{ version: string; body?: string } | null>(null);
  const [updateInstalling, setUpdateInstalling] = useState(false);
  const [updateProgress, setUpdateProgress] = useState<number | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [whatsNew, setWhatsNew] = useState<ReleaseChangelog | null>(null);
  const [showSupportBubble, setShowSupportBubble] = useState(forceSupportBubble);
  const supportUsage = useMemo(() => summarizeSupportUsage(Object.values(sessions).flat()), [sessions]);
  const closeSupportBubble = useCallback(() => setShowSupportBubble(false), []);
  const restoreGoalBuilder = useGoalBuilderStore((state) => state.restore);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
  }, [theme]);

  useEffect(() => {
    const enabled = settings.anonymousAnalyticsEnabled === true;
    configureAnonymousAnalytics(enabled);
    if (enabled && !analyticsStarted.current) {
      analyticsStarted.current = true;
      recordAnonymousEvent("app_opened");
    }
    if (!enabled) analyticsStarted.current = false;
  }, [settings.anonymousAnalyticsEnabled]);

  useEffect(() => {
    void import("@/lib/oauth").then(({ initializeOAuthDeepLinks }) => initializeOAuthDeepLinks()).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const demo = new URLSearchParams(window.location.search).get("goal-builder-demo");
    if (demo === "questions" || demo === "preview" || demo === "execution") {
      useAppStore.getState().setMode("goal");
      seedGoalBuilderDemo(demo);
    }
  }, []);

  useEffect(() => {
    const isTauri = Boolean((window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
    if (!isTauri) return;
    void (async () => {
      try {
        const { TauriGoalPersistenceRepository, migrateLegacyRunHistoryFromLocalStorage } = await import("@/lib/goal-persistence");
        const repository = new TauriGoalPersistenceRepository();
        const status = await repository.status();
        if (!status.available) {
          setNotice(`Goal history storage is unavailable: ${status.error || "unknown error"}`);
          return;
        }
        const migration = await migrateLegacyRunHistoryFromLocalStorage(repository);
        if (migration.skipped > 0) {
          setNotice(`${migration.skipped} existing goal run${migration.skipped === 1 ? "" : "s"} could not be migrated and remain in local storage.`);
        }
      } catch (error) {
        setNotice(`Goal history migration failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    })();
  }, []);

  useEffect(() => {
    void (async () => {
      await hydrateOpenRouterKey();
      initProviders();
      await loadModels();
      if (import.meta.env.DEV && new URLSearchParams(window.location.search).has("goal-builder-demo")) return;
      await restoreGoalBuilder();
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
      if (currentRun.status === "completed") recordAnonymousEvent("goal_completed");
    }
    previousRunning.current = isRunning;
    previousApprovalId.current = pendingApproval?.requestId ?? null;
  }, [currentRun, isRunning, pendingApproval]);

  useEffect(() => {
    if (!notice) return;
    const timeout = window.setTimeout(() => setNotice(null), 5_000);
    return () => window.clearTimeout(timeout);
  }, [notice]);

  useEffect(() => {
    if (showSupportBubble || notice || updateNotice || whatsNew || showSettings) return;
    if (!shouldShowSupportPrompt({
      ...supportUsage,
      lastShownAt: settings.supportPromptLastShownAt,
      dismissedAt: settings.supportPromptDismissedAt,
    })) return;
    setShowSupportBubble(true);
    updateSettings({ supportPromptLastShownAt: new Date().toISOString() });
  }, [notice, settings.supportPromptDismissedAt, settings.supportPromptLastShownAt, showSettings, showSupportBubble, supportUsage, updateNotice, updateSettings, whatsNew]);

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
        <GoalBuilderErrorBoundary><ChatTimeline /></GoalBuilderErrorBoundary>
      <ChatInput />
      </main>
      <SettingsPanel />
      <GitDiffPanel />
      {notice && <div role="status" className="fixed right-5 bottom-5 z-[60] rounded-xl border border-gray-200 bg-white px-4 py-3 text-sm text-gray-700 shadow-xl">{notice}</div>}
      {updateNotice && shouldShowUpdatePopup({ available: true, latestVersion: updateNotice.version }, settings.skippedUpdateVersion) && (
        <UpdatePill
          version={updateNotice.version}
          installing={updateInstalling}
          progress={updateProgress}
          error={updateError}
          onUpdate={() => void handleUpdateNow()}
          onDismiss={() => setUpdateNotice(null)}
          onSkip={() => { updateSettings({ skippedUpdateVersion: updateNotice.version }); setUpdateNotice(null); }}
        />
      )}
      {whatsNew && <WhatsNewDialog version={whatsNew.version} body={whatsNew.body} publishedAt={whatsNew.publishedAt} onClose={() => setWhatsNew(null)} />}
      {showSupportBubble && !notice && !updateNotice && !whatsNew && !showSettings && (
        <SupportBubble
          onClose={closeSupportBubble}
          onDismiss={() => {
            updateSettings({ supportPromptDismissedAt: new Date().toISOString() });
            closeSupportBubble();
          }}
        />
      )}
    </div>
  );
}
