import { useEffect } from "react";
import { useAppStore } from "@/stores/app-store";
import { TopBar } from "@/features/project/TopBar";
import { ChatTimeline } from "@/features/goal-run/ExecutionTimeline";
import { ChatInput } from "@/features/chat/ChatInput";
import { SettingsPanel } from "@/features/settings/SettingsPanel";
import { LeftSidebar } from "@/features/sidebar/LeftSidebar";
import { RightSidebar } from "@/features/sidebar/RightSidebar";

export default function App() {
  const initProviders = useAppStore((s) => s.initProviders);
  const loadModels = useAppStore((s) => s.loadModels);
  const settings = useAppStore((s) => s.settings);

  useEffect(() => {
    initProviders();
    if (settings.openRouterApiKey) {
      loadModels();
    }
  }, []);

  return (
    <div className="h-full flex flex-col bg-white text-gray-900 overflow-hidden">
      <TopBar />
      <div className="flex-1 flex min-h-0 overflow-hidden">
        <LeftSidebar />
        <main className="flex-1 flex flex-col min-h-0">
          <ChatTimeline />
          <ChatInput />
        </main>
        <RightSidebar />
      </div>
      <SettingsPanel />
    </div>
  );
}
