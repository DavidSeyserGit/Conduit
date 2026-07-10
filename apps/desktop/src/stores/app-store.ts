import { create } from "zustand";
import { persist } from "zustand/middleware";
import { invoke } from "@tauri-apps/api/core";
import type {
  AppSettings,
  ChatMessage,
  ChatMode,
  GoalRunEvent,
  GoalRunState,
  ModelDescriptor,
  SessionUsage,
  TokenUsage,
} from "@loopkit/shared";
import {
  DefaultProviderRegistry,
  OpenRouterProvider,
  ACPAgentProvider,
  CodexProvider,
} from "@loopkit/model-providers";
import { GoalLoopRunner, AskChatRunner } from "@loopkit/agent-runtime";
import { createTauriToolExecutor } from "@/lib/tauri-tools";
import { createChatWorktree, removeChatWorktree } from "@/lib/git-workflow";

export interface Project {
  name: string;
  path: string;
  remote?: string;
}

export interface RunHistoryEntry {
  run: GoalRunState;
  events: GoalRunEvent[];
  updatedAt: string;
}

export interface ChatSession {
  id: string;
  title: string;
  workspacePath?: string;
  branch?: string;
  worktreePath?: string;
  usage: SessionUsage;
  messages: ChatMessage[];
  currentRun: GoalRunState | null;
  runEvents: GoalRunEvent[];
  runHistory: RunHistoryEntry[];
  updatedAt: string;
}

interface AppState {
  // Project
  workspacePath: string;
  activeProjectPath: string;
  setWorkspacePath: (path: string) => void;
  projects: Project[];
  addProject: (project: Project) => void;
  sessions: Record<string, ChatSession[]>;
  activeSessionId: string;
  openSession: (workspacePath: string, sessionId: string) => void;
  newChat: () => void;
  deleteChat: (workspacePath: string, sessionId: string) => void;
  createWorktree: () => Promise<void>;
  removeWorktree: () => Promise<void>;

  // Settings
  settings: AppSettings;
  updateSettings: (partial: Partial<AppSettings>) => void;

  // Models
  models: ModelDescriptor[];
  modelsCachedAt: number | null;
  modelsLoading: boolean;
  loadModels: () => Promise<void>;
  refreshModels: () => Promise<void>;
  hydrateOpenRouterKey: () => Promise<void>;
  saveOpenRouterKey: (key: string) => Promise<void>;

  // Chat
  mode: ChatMode;
  setMode: (mode: ChatMode) => void;
  messages: ChatMessage[];
  addMessage: (message: ChatMessage) => void;
  updateMessage: (id: string, content: string) => void;
  clearMessages: () => void;
  goalDraft: string;
  setGoalDraft: (draft: string) => void;

  // Model selection
  codingModelId: string;
  judgeModelId: string;
  maxIterations: number;
  setCodingModelId: (id: string) => void;
  setJudgeModelId: (id: string) => void;
  setMaxIterations: (n: number) => void;

  // Goal run
  currentRun: GoalRunState | null;
  runEvents: GoalRunEvent[];
  runHistory: RunHistoryEntry[];
  sessionUsage: SessionUsage;
  isRunning: boolean;
  goalRunner: GoalLoopRunner | null;

  // UI
  showSettings: boolean;
  setShowSettings: (show: boolean) => void;
  gitDiff: string;
  gitDiffLoading: boolean;
  showGitDiff: boolean;
  openGitDiff: () => Promise<void>;
  closeGitDiff: () => void;
  pendingApproval: { requestId: string; command: string } | null;

  // Actions
  sendMessage: (content: string) => Promise<void>;
  startGoalRun: (goal: string, resumeState?: GoalRunState) => Promise<void>;
  openRun: (runId: string) => void;
  resumeRun: (runId: string) => Promise<void>;
  cancelRun: () => void;
  approveCommand: () => void;
  rejectCommand: () => void;
  initProviders: () => void;
}

const defaultSettings: AppSettings = {
  inputGlowColor: "#3b82f6",
  commandPermissionMode: "auto_approve_safe",
  defaultMaxIterations: 3,
};

const MODEL_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const inTauri = () => Boolean((window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);

let providerRegistry: DefaultProviderRegistry | null = null;
let openRouterProvider: OpenRouterProvider | null = null;

function getRegistry(): DefaultProviderRegistry {
  if (!providerRegistry) {
    providerRegistry = new DefaultProviderRegistry();
  }
  return providerRegistry;
}

function createChatSession(): ChatSession {
  return {
    id: crypto.randomUUID(),
    title: "New chat",
    messages: [],
    currentRun: null,
    runEvents: [],
    runHistory: [],
    usage: emptySessionUsage(),
    updatedAt: new Date().toISOString(),
  };
}

function emptySessionUsage(): SessionUsage {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalCost: 0 };
}

function addSessionUsage(current: SessionUsage, usage: TokenUsage | undefined, cost = 0): SessionUsage {
  if (!usage) return { ...current, totalCost: current.totalCost + cost };
  return {
    promptTokens: current.promptTokens + usage.promptTokens,
    completionTokens: current.completionTokens + usage.completionTokens,
    totalTokens: current.totalTokens + usage.totalTokens,
    cacheReadTokens: current.cacheReadTokens + (usage.cacheReadTokens || 0),
    cacheWriteTokens: current.cacheWriteTokens + (usage.cacheWriteTokens || 0),
    totalCost: current.totalCost + cost,
  };
}

function subtractUsage(total: TokenUsage | undefined, base: TokenUsage | undefined): TokenUsage | undefined {
  if (!total) return undefined;
  return {
    promptTokens: Math.max(0, total.promptTokens - (base?.promptTokens || 0)),
    completionTokens: Math.max(0, total.completionTokens - (base?.completionTokens || 0)),
    totalTokens: Math.max(0, total.totalTokens - (base?.totalTokens || 0)),
    cacheReadTokens: Math.max(0, (total.cacheReadTokens || 0) - (base?.cacheReadTokens || 0)),
    cacheWriteTokens: Math.max(0, (total.cacheWriteTokens || 0) - (base?.cacheWriteTokens || 0)),
  };
}

function estimateModelCost(usage: TokenUsage | undefined, model: ModelDescriptor | undefined): number {
  if (!usage || !model) return 0;
  const billablePromptTokens = Math.max(0, usage.promptTokens - (usage.cacheReadTokens || 0));
  return (billablePromptTokens / 1_000_000) * (model.inputPrice || 0)
    + (usage.completionTokens / 1_000_000) * (model.outputPrice || 0)
    + ((usage.cacheReadTokens || 0) / 1_000_000) * (model.inputPrice || 0)
    + ((usage.cacheWriteTokens || 0) / 1_000_000) * (model.inputPrice || 0);
}

function snapshotSession(state: AppState): ChatSession {
  const existing = state.sessions[state.activeProjectPath]?.find((session) => session.id === state.activeSessionId);
  const firstUserMessage = state.messages.find((message) => message.role === "user")?.content.trim();
  return {
    id: state.activeSessionId,
    title: existing?.title !== "New chat" ? existing?.title || "New chat" : firstUserMessage?.slice(0, 60) || "New chat",
    workspacePath: state.workspacePath,
    branch: existing?.branch,
    worktreePath: existing?.worktreePath,
    usage: state.sessionUsage,
    messages: state.messages,
    currentRun: state.currentRun,
    runEvents: state.runEvents,
    runHistory: state.runHistory,
    updatedAt: new Date().toISOString(),
  };
}

function upsertActiveSession(state: AppState, session: ChatSession): Record<string, ChatSession[]> {
  if (!state.activeProjectPath || !state.activeSessionId) return state.sessions;
  return {
    ...state.sessions,
    [state.activeProjectPath]: [
      session,
      ...(state.sessions[state.activeProjectPath] || []).filter((item) => item.id !== session.id),
    ],
  };
}

export const useAppStore = create<AppState>()(
  persist(
    (set, get) => ({
      workspacePath: "",
      activeProjectPath: "",
      setWorkspacePath: (path) => {
        const state = get();
        if (state.isRunning) return;
        if (path === state.workspacePath) return;
        const currentSession = state.workspacePath ? snapshotSession(state) : null;
        const projectSessions = state.sessions[path] || [];
        const nextSession = projectSessions[0] || createChatSession();
        set({
          workspacePath: nextSession.workspacePath || path,
          activeProjectPath: path,
          activeSessionId: nextSession.id,
          messages: nextSession.messages,
          currentRun: nextSession.currentRun,
          runEvents: nextSession.runEvents,
          runHistory: nextSession.runHistory,
          sessionUsage: nextSession.usage || emptySessionUsage(),
          sessions: {
            ...state.sessions,
            ...(currentSession ? {
              [state.activeProjectPath]: [
                currentSession,
                ...(state.sessions[state.activeProjectPath] || []).filter((session) => session.id !== currentSession.id),
              ],
            } : {}),
            [path]: projectSessions.length ? projectSessions : [nextSession],
          },
        });
      },
      openSession: (path, sessionId) => {
        const state = get();
        if (state.isRunning) return;
        const nextSession = state.sessions[path]?.find((session) => session.id === sessionId);
        if (!nextSession) return;
        const currentSession = state.workspacePath ? snapshotSession(state) : null;
        set({
          workspacePath: nextSession.workspacePath || path,
          activeProjectPath: path,
          activeSessionId: nextSession.id,
          messages: nextSession.messages,
          currentRun: nextSession.currentRun,
          runEvents: nextSession.runEvents,
          runHistory: nextSession.runHistory,
          sessionUsage: nextSession.usage || emptySessionUsage(),
          sessions: currentSession && state.activeSessionId !== sessionId
            ? {
                ...state.sessions,
                [state.activeProjectPath]: [
                  currentSession,
                  ...(state.sessions[state.activeProjectPath] || []).filter((session) => session.id !== currentSession.id),
                ],
              }
            : state.sessions,
        });
      },
      projects: [],
      addProject: (project) => {
        const state = get();
        const projectSessions = state.sessions[project.path]?.length
          ? state.sessions[project.path]
          : [{ ...createChatSession(), workspacePath: project.path }];
        const nextSession = projectSessions[0];
        const currentSession = state.workspacePath ? snapshotSession(state) : null;
        set({
          projects: [...state.projects.filter((p) => p.path !== project.path), project],
          workspacePath: nextSession.workspacePath || project.path,
          activeProjectPath: project.path,
          activeSessionId: nextSession.id,
          messages: nextSession.messages,
          currentRun: nextSession.currentRun,
          runEvents: nextSession.runEvents,
          runHistory: nextSession.runHistory,
          sessionUsage: nextSession.usage || emptySessionUsage(),
          sessions: {
            ...state.sessions,
            ...(currentSession && state.activeProjectPath !== project.path ? {
              [state.activeProjectPath]: [
                currentSession,
                ...(state.sessions[state.activeProjectPath] || []).filter((session) => session.id !== currentSession.id),
              ],
            } : {}),
            [project.path]: projectSessions,
          },
        });
      },
      sessions: {},
      activeSessionId: "",
      newChat: () => {
        const state = get();
        if (!state.workspacePath || state.isRunning) return;
        const currentSession = snapshotSession(state);
        const nextSession = { ...createChatSession(), workspacePath: state.activeProjectPath };
        set({
          activeSessionId: nextSession.id,
          messages: [],
          currentRun: null,
          runEvents: [],
          runHistory: [],
          sessionUsage: emptySessionUsage(),
          sessions: {
            ...state.sessions,
            [state.activeProjectPath]: [
              currentSession,
              ...(state.sessions[state.activeProjectPath] || []).filter((session) => session.id !== currentSession.id),
              nextSession,
            ],
          },
        });
      },
      deleteChat: (path, sessionId) => {
        const state = get();
        if (state.isRunning) return;
        const existingSessions = state.sessions[path] || [];
        const currentSession = path === state.activeProjectPath ? snapshotSession(state) : null;
        const sessions = currentSession
          ? [currentSession, ...existingSessions.filter((session) => session.id !== currentSession.id)]
          : existingSessions;
        const remaining = sessions.filter((session) => session.id !== sessionId);
        if (path !== state.activeProjectPath) {
          set({ sessions: { ...state.sessions, [path]: remaining } });
          return;
        }

        const nextSession = remaining[0] || { ...createChatSession(), workspacePath: path };
        set({
          workspacePath: nextSession.workspacePath || path,
          activeProjectPath: path,
          activeSessionId: nextSession.id,
          messages: nextSession.messages,
          currentRun: nextSession.currentRun,
          runEvents: nextSession.runEvents,
          runHistory: nextSession.runHistory,
          sessionUsage: nextSession.usage || emptySessionUsage(),
          sessions: { ...state.sessions, [path]: remaining.length ? remaining : [nextSession] },
        });
      },
      createWorktree: async () => {
        const state = get();
        if (state.isRunning || !state.activeProjectPath || !state.activeSessionId) return;
        const current = snapshotSession(state);
        if (current.worktreePath) return;
        const branch = `loopkit/chat-${current.id.replace(/[^A-Za-z0-9]/g, "").slice(0, 12)}`;
        const result = await createChatWorktree(state.activeProjectPath, branch, current.id.replace(/[^A-Za-z0-9]/g, "").slice(0, 32));
        const updated = { ...current, workspacePath: result.path, worktreePath: result.path, branch: result.branch };
        set({
          workspacePath: result.path,
          sessions: {
            ...state.sessions,
            [state.activeProjectPath]: [updated, ...(state.sessions[state.activeProjectPath] || []).filter((session) => session.id !== current.id)],
          },
        });
      },
      removeWorktree: async () => {
        const state = get();
        if (state.isRunning || !state.activeProjectPath) return;
        const current = snapshotSession(state);
        if (!current.worktreePath) return;
        await removeChatWorktree(state.activeProjectPath, current.worktreePath);
        const updated = { ...current, workspacePath: state.activeProjectPath, worktreePath: undefined, branch: undefined };
        set({
          workspacePath: state.activeProjectPath,
          sessions: {
            ...state.sessions,
            [state.activeProjectPath]: [updated, ...(state.sessions[state.activeProjectPath] || []).filter((session) => session.id !== current.id)],
          },
        });
      },

      settings: defaultSettings,
      updateSettings: (partial) => {
        set((s) => ({ settings: { ...s.settings, ...partial } }));
      },

      models: [],
      modelsCachedAt: null,
      modelsLoading: false,
      loadModels: async () => {
        const state = get();
        const needsCapabilityRefresh = state.models.some((model) => model.provider === "openrouter" && !("supportsReasoning" in model));
        if (!needsCapabilityRefresh && state.models.length > 0 && state.modelsCachedAt && Date.now() - state.modelsCachedAt < MODEL_CACHE_TTL_MS) return;
        await get().refreshModels();
      },
      refreshModels: async () => {
        if (get().modelsLoading) return;
        set({ modelsLoading: true });
        try {
          const registry = getRegistry();
          const models = await registry.listAllModels();
          set({ models, modelsCachedAt: Date.now() });
        } catch {
          // Keep the cached catalog available when refresh fails.
        } finally {
          set({ modelsLoading: false });
        }
      },
      hydrateOpenRouterKey: async () => {
        let key = "";
        if (inTauri()) {
          const response = await invoke<{ success: boolean; result?: { key?: string | null } }>("openrouter_get_key");
          key = response.result?.key || "";
        } else {
          key = localStorage.getItem("loopkit-openrouter-api-key") || "";
        }
        const legacyKey = get().settings.openRouterApiKey || "";
        if (!key && legacyKey) {
          await get().saveOpenRouterKey(legacyKey);
          key = legacyKey;
        }
        if (key) set((state) => ({ settings: { ...state.settings, openRouterApiKey: key } }));
      },
      saveOpenRouterKey: async (key) => {
        if (inTauri()) {
          const response = await invoke<{ success: boolean; error?: string }>("openrouter_store_key", { key });
          if (!response.success) throw new Error(response.error || "Could not save OpenRouter API key");
        } else if (key.trim()) {
          localStorage.setItem("loopkit-openrouter-api-key", key);
        } else {
          localStorage.removeItem("loopkit-openrouter-api-key");
        }
        set((state) => ({ settings: { ...state.settings, openRouterApiKey: key } }));
        get().initProviders();
      },

      mode: "ask",
      setMode: (mode) => set({ mode }),
      messages: [],
      addMessage: (message) =>
        set((s) => {
          const messages = [...s.messages, message];
          return {
            messages,
            sessions: upsertActiveSession({ ...s, messages }, snapshotSession({ ...s, messages })),
          };
        }),
      updateMessage: (id, content) =>
        set((s) => {
          const messages = s.messages.map((m) =>
            m.id === id ? { ...m, content, isStreaming: false } : m
          );
          return {
            messages,
            sessions: upsertActiveSession({ ...s, messages }, snapshotSession({ ...s, messages })),
          };
        }),
      clearMessages: () => set((s) => {
        const next = { ...s, messages: [], currentRun: null, runEvents: [] };
        return {
          messages: [],
          currentRun: null,
          runEvents: [],
          sessions: upsertActiveSession(next, snapshotSession(next)),
        };
      }),
      goalDraft: "",
      setGoalDraft: (draft) => set({ goalDraft: draft }),

      codingModelId: "",
      judgeModelId: "",
      maxIterations: 3,
      setCodingModelId: (id) => set({ codingModelId: id }),
      setJudgeModelId: (id) => set({ judgeModelId: id }),
      setMaxIterations: (n) => set({ maxIterations: Math.min(10, Math.max(1, n)) }),

      currentRun: null,
      runEvents: [],
      runHistory: [],
      sessionUsage: emptySessionUsage(),
      isRunning: false,
      goalRunner: null,
      pendingApproval: null,

      showSettings: false,
      setShowSettings: (show) => set({ showSettings: show }),
      gitDiff: "",
      gitDiffLoading: false,
      showGitDiff: false,
      openGitDiff: async () => {
        const workspacePath = get().workspacePath;
        if (!workspacePath) return;
        set({ showGitDiff: true, gitDiffLoading: true });
        try {
          const result = await createTauriToolExecutor(() => get().workspacePath).execute("get_git_diff", {}, "goal");
          const diff = result.success && result.result && typeof result.result === "object"
            ? (result.result as { diff?: string }).diff || ""
            : "";
          set({ gitDiff: diff, gitDiffLoading: false });
        } catch {
          set({ gitDiff: "", gitDiffLoading: false });
        }
      },
      closeGitDiff: () => set({ showGitDiff: false }),

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
        registry.register(new CodexProvider());
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
          set((s) => {
            const usage = addSessionUsage(s.sessionUsage, result.tokenUsage, estimateModelCost(result.tokenUsage, s.models.find((model) => model.id === state.codingModelId)));
            return { sessionUsage: usage, sessions: upsertActiveSession({ ...s, sessionUsage: usage }, snapshotSession({ ...s, sessionUsage: usage })) };
          });
        } catch (err) {
          get().updateMessage(
            assistantId,
            `Error: ${err instanceof Error ? err.message : String(err)}`
          );
        } finally {
          set({ isRunning: false });
        }
      },

      startGoalRun: async (goal, resumeState) => {
        const state = get();
        const workspacePath = resumeState?.workspacePath || state.workspacePath;
        const codingModelId = resumeState?.codingModelId || state.codingModelId;
        const judgeModelId = resumeState?.judgeModelId || state.judgeModelId;
        const codingModel = state.models.find((model) => model.id === codingModelId);
        const judgeModel = state.models.find((model) => model.id === judgeModelId);
        if (!workspacePath || !codingModelId || !judgeModelId) return;

        if (!resumeState) {
          state.addMessage({
            id: crypto.randomUUID(),
            role: "user",
            content: goal,
            timestamp: new Date().toISOString(),
          });
        }

        const runner = new GoalLoopRunner(getRegistry());
        const toolExecutor = createTauriToolExecutor(
          () => get().workspacePath,
          { onApprovalRequired: (requestId, command) => set({ pendingApproval: { requestId, command } }) }
        );

        set({
          isRunning: true,
          goalRunner: runner,
          runEvents: resumeState ? get().runEvents : [],
          currentRun: resumeState || null,
          workspacePath,
          mode: "goal",
        });

        try {
          const result = await runner.run(
            {
              goal,
              workspacePath,
              codingModelId,
              judgeModelId,
              maxIterations: resumeState?.maxIterations || state.maxIterations,
              modelApiKey: state.settings.openRouterApiKey,
              resumeState,
              codingInputPrice: codingModel?.inputPrice,
              codingOutputPrice: codingModel?.outputPrice,
              judgeInputPrice: judgeModel?.inputPrice,
              judgeOutputPrice: judgeModel?.outputPrice,
              codingSupportsReasoning: codingModel?.supportsReasoning,
            },
            toolExecutor,
            { onApprovalRequired: (requestId, command) => set({ pendingApproval: { requestId, command } }) },
            (event) => {
              set((s) => ({ runEvents: [...s.runEvents, event] }));
              if (event.type === "approval_required") {
                set({ pendingApproval: { requestId: event.requestId, command: event.command } });
              }
              if (event.type === "run_completed") {
                set({ currentRun: event.result.state, pendingApproval: null });
              }
            }
          );

          set((s) => {
            const runHistory = [
              { run: result.state, events: s.runEvents, updatedAt: new Date().toISOString() },
              ...s.runHistory.filter((entry) => entry.run.id !== result.state.id),
            ].slice(0, 50);
            const codingUsage = subtractUsage(result.state.codingTokenUsage, resumeState?.codingTokenUsage);
            const judgeUsage = subtractUsage(result.state.judgeTokenUsage, resumeState?.judgeTokenUsage);
            const codingCost = Math.max(0, (result.state.codingCost?.totalCost || 0) - (resumeState?.codingCost?.totalCost || 0));
            const judgeCost = Math.max(0, (result.state.judgeCost?.totalCost || 0) - (resumeState?.judgeCost?.totalCost || 0));
            const sessionUsage = addSessionUsage(addSessionUsage(s.sessionUsage, codingUsage, codingCost), judgeUsage, judgeCost);
            const next = { ...s, currentRun: result.state, runHistory, sessionUsage };
            return {
              currentRun: result.state,
              isRunning: false,
              goalRunner: null,
              pendingApproval: null,
              runHistory,
              sessionUsage,
              sessions: upsertActiveSession(next, snapshotSession(next)),
            };
          });
        } catch (err) {
          state.addMessage({
            id: crypto.randomUUID(),
            role: "assistant",
            content: `Goal run failed: ${err instanceof Error ? err.message : String(err)}`,
            timestamp: new Date().toISOString(),
          });
          set({ isRunning: false, goalRunner: null, pendingApproval: null });
        }
      },

      openRun: (runId) => {
        const entry = get().runHistory.find((item) => item.run.id === runId);
        if (!entry) return;
        set({
          workspacePath: entry.run.workspacePath,
          currentRun: entry.run,
          runEvents: entry.events,
          mode: "goal",
          isRunning: false,
        });
      },

      resumeRun: async (runId) => {
        const entry = get().runHistory.find((item) => item.run.id === runId);
        if (!entry || entry.run.status === "completed") return;
        const resumeState: GoalRunState = {
          ...entry.run,
          maxIterations: entry.run.iteration + get().maxIterations,
        };
        set({
          workspacePath: resumeState.workspacePath,
          currentRun: resumeState,
          runEvents: entry.events,
          mode: "goal",
        });
        await get().startGoalRun(resumeState.goal, resumeState);
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
      partialize: (state) => {
        const { openRouterApiKey: _openRouterApiKey, ...safeSettings } = state.settings;
        return {
        workspacePath: state.workspacePath,
        activeProjectPath: state.activeProjectPath,
        projects: state.projects,
        settings: safeSettings,
        models: state.models,
        modelsCachedAt: state.modelsCachedAt,
        codingModelId: state.codingModelId,
        judgeModelId: state.judgeModelId,
        maxIterations: state.maxIterations,
        mode: state.mode,
        goalDraft: state.goalDraft,
        currentRun: state.currentRun,
        runEvents: state.runEvents,
        runHistory: state.runHistory,
        sessions: state.sessions,
        activeSessionId: state.activeSessionId,
        };
      },
    }
  )
);
