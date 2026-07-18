import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";
import type {
  GoalAnswerValue,
  GoalDefinition,
  GoalQuestion,
  GoalQuestionBatch,
  GoalWorkflowPhase,
} from "@conduit/shared";
import { GoalDefinitionRuntime, type GoalDefinitionPatch } from "@conduit/agent-runtime";
import { findProviderForModel } from "@conduit/model-providers";
import type { GoalPersistenceRepository } from "@conduit/shared";
import { createTauriToolExecutor } from "../lib/tauri-tools.js";
import { TauriGoalPersistenceRepository } from "../lib/goal-persistence.js";
import { BrowserGoalPersistenceRepository } from "../lib/browser-goal-persistence.js";
import { getProviderRegistry, useAppStore } from "./app-store.js";
import { GoalBuilderOperationCoordinator, handoffImplementation } from "./goal-builder-operations.js";

export type GoalBuilderPhase = "idle" | "analyzing" | "questions" | "preview" | "approving" | "execution_question" | "error";

export interface GoalBuilderState {
  phase: GoalBuilderPhase;
  runId: string | null;
  workspacePath: string;
  initialRequest: string;
  goal: GoalDefinition | null;
  batches: GoalQuestionBatch[];
  batchIndex: number;
  answers: Record<string, GoalAnswerValue | undefined>;
  defaultAnswerIds: string[];
  revisionMode: boolean;
  statusMessage: string | null;
  error: string | null;
  start: (request: string) => Promise<void>;
  restore: () => Promise<void>;
  setAnswer: (questionId: string, value: GoalAnswerValue) => void;
  useRecommendedDefaults: () => void;
  setBatchIndex: (index: number) => void;
  submitAnswers: () => Promise<void>;
  reviseAnswers: () => void;
  returnToPreview: () => void;
  editGoal: (patch: GoalDefinitionPatch) => Promise<void>;
  regenerate: () => Promise<void>;
  approveAndStart: () => Promise<void>;
  answerExecutionQuestion: () => Promise<void>;
  cancel: () => Promise<void>;
  reset: () => void;
}

const browserRepository = new BrowserGoalPersistenceRepository();
const tauriRepository = new TauriGoalPersistenceRepository();
const operations = new GoalBuilderOperationCoordinator<GoalDefinitionRuntime>();

function inTauri(): boolean {
  return Boolean((window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
}

function repository(): GoalPersistenceRepository {
  return inTauri() ? tauriRepository : browserRepository;
}

function runtime(): GoalDefinitionRuntime {
  const app = useAppStore.getState();
  app.initProviders();
  const found = findProviderForModel(getProviderRegistry(), app.judgeModelId);
  if (!found) throw new Error("Choose an available reviewer model before defining a goal");
  const tools = createTauriToolExecutor(
    () => useAppStore.getState().workspacePath,
    {},
    () => useAppStore.getState().settings.commandPermissionMode,
  );
  return new GoalDefinitionRuntime(found.provider, app.judgeModelId, tools, repository());
}

function valuesFromGoal(goal: GoalDefinition | null, batches: GoalQuestionBatch[]): Record<string, GoalAnswerValue | undefined> {
  const values: Record<string, GoalAnswerValue | undefined> = {};
  for (const answer of goal?.answers ?? []) values[answer.questionId] = answer.value;
  for (const question of batches.flatMap((batch) => batch.questions)) {
    if (!(question.id in values) && "defaultValue" in question) values[question.id] = question.defaultValue;
  }
  return values;
}

function defaultIds(batches: GoalQuestionBatch[], goal: GoalDefinition | null): string[] {
  const userAnswered = new Set((goal?.answers ?? []).filter((answer) => answer.answeredBy === "user").map((answer) => answer.questionId));
  return batches.flatMap((batch) => batch.questions)
    .filter((question) => "defaultValue" in question && question.defaultValue !== undefined && !userAnswered.has(question.id))
    .map((question) => question.id);
}

function batchesFromQuestions(questions: GoalQuestion[], title = "Questions"): GoalQuestionBatch[] {
  const unique = [...new Map(questions.map((question) => [question.id, question])).values()];
  const batches: GoalQuestionBatch[] = [];
  for (let index = 0; index < unique.length; index += 5) {
    batches.push({ id: `restored-${index / 5}`, title, position: index / 5, questions: unique.slice(index, index + 5) });
  }
  return batches;
}

function phaseFor(workflowPhase: GoalWorkflowPhase): GoalBuilderPhase {
  if (workflowPhase === "awaiting_user_input") return "execution_question";
  if (workflowPhase === "awaiting_goal_answers") return "questions";
  if (workflowPhase === "awaiting_goal_approval") return "preview";
  if (workflowPhase === "analyzing_goal" || workflowPhase === "building_goal") return "analyzing";
  return "idle";
}

const initialState = {
  phase: "idle" as GoalBuilderPhase,
  runId: null,
  workspacePath: "",
  initialRequest: "",
  goal: null,
  batches: [] as GoalQuestionBatch[],
  batchIndex: 0,
  answers: {} as Record<string, GoalAnswerValue | undefined>,
  defaultAnswerIds: [] as string[],
  revisionMode: false,
  statusMessage: null,
  error: null,
};

const memoryValues = new Map<string, string>();
const fallbackStorage: StateStorage = {
  getItem: (name) => memoryValues.get(name) ?? null,
  setItem: (name, value) => { memoryValues.set(name, value); },
  removeItem: (name) => { memoryValues.delete(name); },
};

export const useGoalBuilderStore = create<GoalBuilderState>()(persist((set, get) => ({
  ...initialState,
  start: async (request) => {
    const app = useAppStore.getState();
    if (!app.workspacePath) {
      set({ phase: "error", error: "Select a project first" });
      return;
    }
    let operation;
    try {
      operation = operations.begin(runtime);
      if (!operation) return;
      set({ ...initialState, phase: "analyzing", initialRequest: request, workspacePath: app.workspacePath, statusMessage: "Inspecting the repository…" });
      const result = await operation.runtime.start({ initialRequest: request, workspacePath: app.workspacePath });
      if (!operations.isCurrent(operation)) return;
      const batches = result.analysis.questionBatches;
      set({
        phase: result.questions.length > 0 ? "questions" : "preview",
        runId: result.run.id,
        goal: result.goal,
        batches,
        batchIndex: 0,
        answers: valuesFromGoal(result.goal, batches),
        defaultAnswerIds: defaultIds(batches, result.goal),
        statusMessage: null,
        error: null,
      });
    } catch (error) {
      if (!operation || operations.isCurrent(operation)) {
        set({ phase: "error", statusMessage: null, error: error instanceof Error ? error.message : String(error) });
      }
    } finally {
      if (operation) operations.finish(operation);
    }
  },
  restore: async () => {
    if (get().phase !== "idle" || operations.busy) return;
    try {
      const runs = (await repository().listRuns(["analyzing_goal", "awaiting_goal_answers", "building_goal", "awaiting_goal_approval", "awaiting_user_input"]))
        .filter((run): run is import("@conduit/shared").GoalDrivenRunRecord => "workflowPhase" in run)
        .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
      const run = runs[0];
      if (!run) return;
      const snapshot = await repository().restoreRun(run.id);
      if (!snapshot?.goal) return;
      const execution = run.workflowPhase === "awaiting_user_input";
      const questions = execution ? snapshot.questions.slice(-1) : snapshot.questions;
      const batches = batchesFromQuestions(questions, execution ? "Decision needed" : "Clarification questions");
      const interrupted = run.workflowPhase === "analyzing_goal" || run.workflowPhase === "building_goal";
      if (get().phase !== "idle" || operations.busy) return;
      set({
        phase: interrupted ? "error" : phaseFor(run.workflowPhase),
        runId: run.id,
        workspacePath: run.workspacePath,
        initialRequest: snapshot.goal.originalRequest,
        goal: snapshot.goal,
        batches,
        batchIndex: 0,
        answers: valuesFromGoal(snapshot.goal, batches),
        defaultAnswerIds: defaultIds(batches, snapshot.goal),
        statusMessage: null,
        error: interrupted ? "Goal analysis was interrupted when Conduit closed. Retry to inspect the repository again." : null,
      });
    } catch (error) {
      set({ phase: "error", error: error instanceof Error ? error.message : String(error) });
    }
  },
  setAnswer: (questionId, value) => set((state) => ({
    answers: { ...state.answers, [questionId]: value },
    defaultAnswerIds: state.defaultAnswerIds.filter((id) => id !== questionId),
    error: null,
  })),
  useRecommendedDefaults: () => set((state) => {
    const answers = { ...state.answers };
    const ids = new Set(state.defaultAnswerIds);
    for (const question of state.batches.flatMap((batch) => batch.questions)) {
      if ("defaultValue" in question && question.defaultValue !== undefined) {
        answers[question.id] = question.defaultValue;
        ids.add(question.id);
      }
    }
    return { answers, defaultAnswerIds: [...ids] };
  }),
  setBatchIndex: (index) => set((state) => ({ batchIndex: Math.max(0, Math.min(index, state.batches.length - 1)), error: null })),
  submitAnswers: async () => {
    const state = get();
    if (!state.runId || !state.goal) return;
    const operation = operations.begin(runtime);
    if (!operation) return;
    set({ statusMessage: state.revisionMode ? "Regenerating from revised answers…" : "Building your goal…", error: null });
    try {
      const questions = state.batches.flatMap((batch) => batch.questions);
      if (state.revisionMode) {
        const previous = new Map(state.goal.answers.map((answer) => [answer.questionId, answer.value]));
        const changed = questions.filter((question) => JSON.stringify(previous.get(question.id)) !== JSON.stringify(state.answers[question.id]));
        let result = null;
        for (const question of changed) {
          const value = state.answers[question.id];
          if (value !== undefined) result = await operation.runtime.reviseAnswer(state.runId, question.id, value);
          if (!operations.isCurrent(operation)) return;
        }
        if (!result) {
          set({ phase: "preview", revisionMode: false, statusMessage: null });
          return;
        }
        const batches = result.analysis.questionBatches.length ? result.analysis.questionBatches : state.batches;
        set({ phase: result.questions.length ? "questions" : "preview", goal: result.goal, batches, batchIndex: 0, answers: valuesFromGoal(result.goal, batches), defaultAnswerIds: defaultIds(batches, result.goal), revisionMode: false, statusMessage: null });
        return;
      }
      const result = await operation.runtime.submitAnswers(state.runId, questions.map((question) => ({
        questionId: question.id,
        ...(state.defaultAnswerIds.includes(question.id) ? { useDefault: true } : { value: state.answers[question.id] }),
      })));
      if (!operations.isCurrent(operation)) return;
      const batches = result.analysis.questionBatches.length ? result.analysis.questionBatches : state.batches;
      set({ phase: result.questions.length ? "questions" : "preview", goal: result.goal, batches, batchIndex: 0, answers: valuesFromGoal(result.goal, batches), defaultAnswerIds: defaultIds(batches, result.goal), statusMessage: null });
    } catch (error) {
      if (operations.isCurrent(operation)) set({ statusMessage: null, error: error instanceof Error ? error.message : String(error) });
    } finally {
      operations.finish(operation);
    }
  },
  reviseAnswers: () => set((state) => ({ phase: "questions", revisionMode: true, batchIndex: 0, answers: valuesFromGoal(state.goal, state.batches), error: null })),
  returnToPreview: () => set({ phase: "preview", revisionMode: false, error: null, statusMessage: null }),
  editGoal: async (patch) => {
    const state = get();
    if (!state.runId) return;
    const operation = operations.begin(runtime);
    if (!operation) return;
    set({ statusMessage: "Saving goal edits…", error: null });
    try {
      const goal = await operation.runtime.revise(state.runId, patch);
      if (!operations.isCurrent(operation)) return;
      set({ phase: "preview", goal, statusMessage: null });
    } catch (error) {
      if (operations.isCurrent(operation)) set({ statusMessage: null, error: error instanceof Error ? error.message : String(error) });
    } finally {
      operations.finish(operation);
    }
  },
  regenerate: async () => {
    const state = get();
    if (!state.runId) return;
    const operation = operations.begin(runtime);
    if (!operation) return;
    set({ phase: "analyzing", statusMessage: "Regenerating the goal…", error: null });
    try {
      const result = await operation.runtime.regenerate(state.runId);
      if (!operations.isCurrent(operation)) return;
      const batches = result.analysis.questionBatches.length ? result.analysis.questionBatches : state.batches;
      set({ phase: result.questions.length ? "questions" : "preview", goal: result.goal, batches, batchIndex: 0, answers: valuesFromGoal(result.goal, batches), defaultAnswerIds: defaultIds(batches, result.goal), statusMessage: null });
    } catch (error) {
      if (operations.isCurrent(operation)) set({ phase: "error", statusMessage: null, error: error instanceof Error ? error.message : String(error) });
    } finally {
      operations.finish(operation);
    }
  },
  approveAndStart: async () => {
    const state = get();
    if (!state.runId || !state.goal) return;
    const operation = operations.begin(runtime);
    if (!operation) return;
    let handedOff = false;
    set({ phase: "approving", statusMessage: "Approving the execution contract…", error: null });
    try {
      const approved = await operation.runtime.approve(state.runId, state.goal.version);
      if (!operations.isCurrent(operation)) return;
      set({ goal: approved, statusMessage: "Starting implementation…" });
      await handoffImplementation(
        () => useAppStore.getState().startGoalRun(approved.originalRequest, undefined, approved, state.workspacePath, state.runId ?? undefined),
        () => {
          if (operations.isCurrent(operation)) {
            handedOff = true;
            set({ ...initialState });
          }
        },
      );
    } catch (error) {
      if (operations.isCurrent(operation) && !handedOff) set({ phase: "preview", statusMessage: null, error: error instanceof Error ? error.message : String(error) });
    } finally {
      operations.finish(operation);
    }
  },
  answerExecutionQuestion: async () => {
    const state = get();
    const question = state.batches[0]?.questions[0];
    if (!state.runId || !question) return;
    const value = state.answers[question.id];
    if (value === undefined) {
      set({ error: "Answer the question before continuing" });
      return;
    }
    const operation = operations.begin(runtime);
    if (!operation) return;
    set({ statusMessage: "Resuming the run…", error: null });
    try {
      const goal = await operation.runtime.answerExecutionQuestion(state.runId, question.id, value);
      if (operations.isCurrent(operation)) set({ ...initialState, goal });
    } catch (error) {
      if (operations.isCurrent(operation)) set({ statusMessage: null, error: error instanceof Error ? error.message : String(error) });
    } finally {
      operations.finish(operation);
    }
  },
  cancel: async () => {
    const { runId, phase } = get();
    set({ ...initialState });
    if (phase === "approving") useAppStore.getState().cancelRun();
    await operations.cancel(runId, runtime).catch(() => undefined);
  },
  reset: () => {
    operations.reset();
    set({ ...initialState });
  },
}), {
  name: "conduit-goal-builder-ui-v1",
  storage: createJSONStorage(() => typeof localStorage === "undefined" ? fallbackStorage : localStorage),
  partialize: (state) => ({
    phase: state.phase, runId: state.runId, workspacePath: state.workspacePath, initialRequest: state.initialRequest, goal: state.goal,
    batches: state.batches, batchIndex: state.batchIndex, answers: state.answers,
    defaultAnswerIds: state.defaultAnswerIds, revisionMode: state.revisionMode,
  }),
}));

export function seedGoalBuilderDemo(kind: "questions" | "preview" | "execution"): void {
  const now = new Date().toISOString();
  const batches: GoalQuestionBatch[] = [
    { id: "behavior", title: "Required behavior", position: 0, questions: [
      { id: "integration", type: "single_select", title: "How should the new authentication method be integrated?", description: "The repository already supports email and Google authentication.", required: true, sourceReason: "Adding or replacing a provider is a product decision", options: [{ id: "alongside", label: "Add it alongside existing methods", description: "Preserves email and Google login", recommended: true }, { id: "replace-google", label: "Replace Google authentication" }], defaultValue: "alongside", allowCustomAnswer: true },
      { id: "deliverables", type: "multi_select", title: "Which deliverables are required?", required: true, options: [{ id: "implementation", label: "Implementation", recommended: true }, { id: "unit-tests", label: "Unit tests", recommended: true }, { id: "integration-tests", label: "Integration tests" }, { id: "documentation", label: "Documentation" }], defaultValue: ["implementation", "unit-tests"] },
      { id: "dependencies", type: "confirmation", title: "May the agent install an additional dependency if needed?", required: true, defaultValue: false, sourceReason: "Dependency changes require your permission" },
    ] },
    { id: "details", title: "References and success", position: 1, questions: [
      { id: "conventions", type: "text", title: "Are there additional product conventions to follow?", required: false },
      { id: "reference", type: "repository_reference", title: "Which existing implementation should be the primary reference?", required: true, options: [{ id: "src/auth/google.ts", label: "src/auth/google.ts", description: "Existing OAuth provider", recommended: true }, { id: "src/auth/email.ts", label: "src/auth/email.ts" }], defaultValue: "src/auth/google.ts" },
      { id: "constraints", type: "constraint_editor", title: "Review the implementation constraints", required: false, defaultValue: [{ id: "constraint-schema", description: "Do not modify the database schema", source: "repository" }] },
      { id: "criteria", type: "success_criteria_editor", title: "Review the success criteria", required: true, defaultValue: [{ id: "criterion-login", description: "Users can authenticate through the new provider", required: true }] },
    ] },
  ];
  const goal: GoalDefinition = {
    schemaVersion: 1,
    id: "demo-goal",
    originalRequest: "Add GitHub authentication",
    title: "Add GitHub authentication",
    description: "Add GitHub as an authentication provider alongside the existing email and Google methods.",
    successCriteria: [{ id: "criterion-login", description: "Users can authenticate through GitHub", required: true }, { id: "criterion-existing", description: "Existing login methods continue to work", required: true }],
    constraints: [{ id: "constraint-schema", description: "Do not modify the database schema", source: "repository" }],
    deliverables: [{ id: "implementation", type: "implementation", description: "GitHub authentication implementation", required: true }, { id: "tests", type: "integration_tests", description: "Authentication integration tests", required: true }],
    assumptions: [{ id: "assumption-oauth", description: "The existing OAuth callback architecture remains the reference", confirmed: false }],
    answers: [],
    status: "awaiting_approval",
    version: 3,
    createdAt: now,
    updatedAt: now,
  };
  const selectedBatches = kind === "execution" ? [{ id: "execution", title: "Decision needed", position: 0, questions: [{ id: "account-linking", type: "single_select" as const, title: "An email already belongs to an existing account. How should account linking behave?", required: true, sourceReason: "This affects account ownership and cannot be inferred safely", options: [{ id: "confirm", label: "Require explicit confirmation", recommended: true }, { id: "reject", label: "Reject the login" }], defaultValue: "confirm" }] }] : batches;
  useGoalBuilderStore.setState({
    phase: kind === "preview" ? "preview" : kind === "execution" ? "execution_question" : "questions",
    runId: "demo-run",
    workspacePath: "/demo/repository",
    initialRequest: goal.originalRequest,
    goal,
    batches: selectedBatches,
    batchIndex: 0,
    answers: valuesFromGoal(goal, selectedBatches),
    defaultAnswerIds: defaultIds(selectedBatches, goal),
    revisionMode: false,
    statusMessage: null,
    error: null,
  });
}
