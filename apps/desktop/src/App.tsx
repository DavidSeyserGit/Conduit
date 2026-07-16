import { useEffect } from "react";
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
    </div>
  );
}
