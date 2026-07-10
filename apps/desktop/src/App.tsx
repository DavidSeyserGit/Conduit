import { useEffect } from "react";
import { useAppStore } from "@/stores/app-store";
import { ProjectBar } from "@/features/project/ProjectBar";
import { ChatTimeline } from "@/features/goal-run/ExecutionTimeline";
import { ChatInput } from "@/features/chat/ChatInput";
import { SettingsPanel } from "@/features/settings/SettingsPanel";

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
    <div className="h-full flex flex-col bg-zinc-950 overflow-hidden">
      <ProjectBar />
      <ChatTimeline />
      <ChatInput />
      <SettingsPanel />
    </div>
  );
}
