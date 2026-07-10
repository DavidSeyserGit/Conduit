import { create } from "zustand";
import { persist } from "zustand/middleware";
import type {
  AppSettings,
  ChatMessage,
  ChatMode,
  GoalRunEvent,
  GoalRunState,
  ModelDescriptor,
} from "@loopkit/shared";
import {
  DefaultProviderRegistry,
  OpenRouterProvider,
  ACPAgentProvider,
} from "@loopkit/model-providers";
import { GoalLoopRunner, AskChatRunner } from "@loopkit/agent-runtime";
import { createTauriToolExecutor } from "@/lib/tauri-tools";

interface AppState {
  // Project
  workspacePath: string;
  setWorkspacePath: (path: string) => void;

  // Settings
  settings: AppSettings;
  updateSettings: (partial: Partial<AppSettings>) => void;

  // Models
  models: ModelDescriptor[];
  modelsLoading: boolean;
  loadModels: () => Promise<void>;

  // Chat
  mode: ChatMode;
  setMode: (mode: ChatMode) => void;
  messages: ChatMessage[];
  addMessage: (message: ChatMessage) => void;
  updateMessage: (id: string, content: string) => void;
  clearMessages: () => void;

  // Model selection
  codingModelId: string;
  judgeModelId: string;
  maxIterations: number;
  setCodingModelId: (id: string) => void;
  setJudgeModelId: (id: string) => void;
  setMaxIterations: (n: number) => void;

  // Chat input (controllable from outside)
  setInputText?: (text: string) => void;

  // Goal run
  currentRun: GoalRunState | null;
  runEvents: GoalRunEvent[];
  isRunning: boolean;
  goalRunner: GoalLoopRunner | null;

  // UI
  showSettings: boolean;
  setShowSettings: (show: boolean) => void;
  pendingApproval: { requestId: string; command: string } | null;

  // Actions
  sendMessage: (content: string) => Promise<void>;
  startGoalRun: (goal: string) => Promise<void>;
  cancelRun: () => void;
  approveCommand: () => void;
  rejectCommand: () => void;
  initProviders: () => void;
}

const defaultSettings: AppSettings = {
  commandPermissionMode: "auto_approve_safe",
  defaultMaxIterations: 3,
};

let providerRegistry: DefaultProviderRegistry | null = null;
let openRouterProvider: OpenRouterProvider | null = null;

function getRegistry(): DefaultProviderRegistry {
  if (!providerRegistry) {
    providerRegistry = new DefaultProviderRegistry();
  }
  return providerRegistry;
}

export const useAppStore = create<AppState>()(
  persist(
    (set, get) => ({
      workspacePath: "",
      setWorkspacePath: (path) => set({ workspacePath: path }),

      settings: defaultSettings,
      updateSettings: (partial) => {
        set((s) => ({ settings: { ...s.settings, ...partial } }));
        if (partial.openRouterApiKey !== undefined) {
          get().initProviders();
        }
      },

      models: [],
      modelsLoading: false,
      loadModels: async () => {
        set({ modelsLoading: true });
        try {
          const registry = getRegistry();
          const models = await registry.listAllModels();
          set({ models });
        } catch {
          // models stay empty
        } finally {
          set({ modelsLoading: false });
        }
      },

      mode: "ask",
      setMode: (mode) => set({ mode }),
      messages: [],
      addMessage: (message) =>
        set((s) => ({ messages: [...s.messages, message] })),
      updateMessage: (id, content) =>
        set((s) => ({
          messages: s.messages.map((m) =>
            m.id === id ? { ...m, content, isStreaming: false } : m
          ),
        })),
      clearMessages: () => set({ messages: [], currentRun: null, runEvents: [] }),

      codingModelId: "",
      judgeModelId: "",
      maxIterations: 3,
      setCodingModelId: (id) => set({ codingModelId: id }),
      setJudgeModelId: (id) => set({ judgeModelId: id }),
      setMaxIterations: (n) => set({ maxIterations: Math.min(10, Math.max(1, n)) }),

      currentRun: null,
      runEvents: [],
      isRunning: false,
      goalRunner: null,
      pendingApproval: null,

      showSettings: false,
      setShowSettings: (show) => set({ showSettings: show }),

      initProviders: () => {
        const { settings } = get();
        const registry = getRegistry();

        if (settings.openRouterApiKey) {
          if (!openRouterProvider) {
            openRouterProvider = new OpenRouterProvider(settings.openRouterApiKey);
            registry.register(openRouterProvider);
          } else {
            openRouterProvider.updateApiKey(settings.openRouterApiKey);
          }
        }

        const acpProvider = new ACPAgentProvider(settings.acpAgents ?? []);
        registry.register(acpProvider);
      },

      sendMessage: async (content) => {
        const state = get();
        if (!state.workspacePath || !state.codingModelId) return;

        const userMessage: ChatMessage = {
          id: crypto.randomUUID(),
          role: "user",
          content,
          timestamp: new Date().toISOString(),
        };
        state.addMessage(userMessage);

        const assistantId = crypto.randomUUID();
        state.addMessage({
          id: assistantId,
          role: "assistant",
          content: "",
          timestamp: new Date().toISOString(),
          isStreaming: true,
        });

        set({ isRunning: true });

        try {
          const registry = getRegistry();
          const providerInfo = registry
            .list()
            .find((p) => state.codingModelId.startsWith(p.id));

          if (!providerInfo) throw new Error("Provider not found");

          const toolExecutor = createTauriToolExecutor(() => get().workspacePath);

          const runner = new AskChatRunner();
          const result = await runner.run({
            workspacePath: state.workspacePath,
            modelId: state.codingModelId,
            provider: providerInfo,
            toolExecutor,
            messages: state.messages.filter((m) => m.id !== assistantId),
            userMessage: content,
            onStream: (delta) => {
              const current = get().messages.find((m) => m.id === assistantId);
              if (current) {
                get().updateMessage(assistantId, current.content + delta);
              }
            },
          });

          get().updateMessage(assistantId, result.message.content);
        } catch (err) {
          get().updateMessage(
            assistantId,
            `Error: ${err instanceof Error ? err.message : String(err)}`
          );
        } finally {
          set({ isRunning: false });
        }
      },

      startGoalRun: async (goal) => {
        const state = get();
        if (!state.workspacePath || !state.codingModelId || !state.judgeModelId) return;

        const userMessage: ChatMessage = {
          id: crypto.randomUUID(),
          role: "user",
          content: goal,
          timestamp: new Date().toISOString(),
        };
        state.addMessage(userMessage);

        const runner = new GoalLoopRunner(getRegistry());
        const toolExecutor = createTauriToolExecutor(
          () => get().workspacePath,
          {
            onApprovalRequired: (requestId, command) => {
              set({ pendingApproval: { requestId, command } });
            },
          }
        );

        set({
          isRunning: true,
          goalRunner: runner,
          runEvents: [],
          currentRun: null,
        });

        try {
          await runner.run(
            {
              goal,
              workspacePath: state.workspacePath,
              codingModelId: state.codingModelId,
              judgeModelId: state.judgeModelId,
              maxIterations: state.maxIterations,
            },
            toolExecutor,
            {
              onApprovalRequired: (requestId, command) => {
                set({ pendingApproval: { requestId, command } });
              },
            },
            (event) => {
              set((s) => ({ runEvents: [...s.runEvents, event] }));

              if (event.type === "approval_required") {
                set({
                  pendingApproval: {
                    requestId: event.requestId,
                    command: event.command,
                  },
                });
              }

              if (event.type === "run_completed") {
                set({
                  currentRun: event.result.state,
                  isRunning: false,
                  goalRunner: null,
                  pendingApproval: null,
                });
              }

              if (event.type === "run_failed") {
                set({ isRunning: false, goalRunner: null });
              }
            }
          );
        } catch (err) {
          state.addMessage({
            id: crypto.randomUUID(),
            role: "assistant",
            content: `Goal run failed: ${err instanceof Error ? err.message : String(err)}`,
            timestamp: new Date().toISOString(),
          });
          set({ isRunning: false, goalRunner: null });
        }
      },

      cancelRun: () => {
        const { goalRunner } = get();
        goalRunner?.cancel();
        set({ isRunning: false, goalRunner: null });
      },

      approveCommand: () => {
        const { goalRunner, pendingApproval } = get();
        if (goalRunner && pendingApproval) {
          goalRunner.approveCommand(pendingApproval.requestId);
          set({ pendingApproval: null });
        }
      },

      rejectCommand: () => {
        const { goalRunner, pendingApproval } = get();
        if (goalRunner && pendingApproval) {
          goalRunner.rejectCommand(pendingApproval.requestId);
          set({ pendingApproval: null });
        }
      },
    }),
    {
      name: "loopkit-app",
      partialize: (state) => ({
        workspacePath: state.workspacePath,
        settings: state.settings,
        codingModelId: state.codingModelId,
        judgeModelId: state.judgeModelId,
        maxIterations: state.maxIterations,
        mode: state.mode,
      }),
    }
  )
);
