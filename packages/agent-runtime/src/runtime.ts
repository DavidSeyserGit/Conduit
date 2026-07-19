import {
  CGS_VERSION, ConduitRunSchema, GoalSpecificationSchema, parseAnswerBatch, parseGoalSpecification,
  parseGoalReport, parseQuestionBatch, validateAnswersForBatch,
  type AnswerBatch, type ConduitRun, type EvidenceArtifact, type EvidenceRequest, type GoalReport,
  type GoalSpecification, type QuestionBatch, type ReviewResult,
} from "@conduit/cgs";
import type { RepositoryContext } from "@conduit/cgs/legacy";

import { CONDUIT_RUNTIME_VERSION } from "./version.js";

export interface CreateGoalInput {
  request: string;
  title?: string;
  permissions?: Partial<GoalSpecification["permissions"]>;
  metadata?: GoalSpecification["metadata"];
}

export interface GoalAnalysisResult {
  goal: GoalSpecification;
  questionBatches: QuestionBatch[];
}

export interface RunOptions {
  conduitDesktopVersion?: string;
  metadata?: Record<string, unknown>;
}

export interface PermissionDecision { approved: boolean; reason?: string }
export type Unsubscribe = () => void;

export interface RuntimeError {
  code: string;
  message: string;
  recoverable: boolean;
}

export type RuntimeEvent =
  | { type: "run.updated"; run: ConduitRun }
  | { type: "goal.updated"; goal: GoalSpecification }
  | { type: "questions.requested"; batch: QuestionBatch }
  | { type: "review.completed"; result: ReviewResult }
  | { type: "evidence.requested"; request: EvidenceRequest }
  | { type: "evidence.completed"; artifact: EvidenceArtifact }
  | { type: "report.generated"; report: GoalReport }
  | { type: "runtime.error"; error: RuntimeError };

export interface ConduitRunHandle {
  readonly runId: string;
  subscribe(listener: (event: RuntimeEvent) => void): Unsubscribe;
  submitAnswers(answers: AnswerBatch): Promise<void>;
  approvePermission(requestId: string, decision: PermissionDecision): Promise<void>;
  cancel(): Promise<void>;
  getSnapshot(): Promise<ConduitRun>;
}

export interface ConduitRuntime {
  createGoal(input: CreateGoalInput): Promise<GoalSpecification>;
  analyzeGoal(goal: GoalSpecification, context: RepositoryContext): Promise<GoalAnalysisResult>;
  applyAnswers(goal: GoalSpecification, answers: AnswerBatch): Promise<GoalSpecification>;
  approveGoal(goal: GoalSpecification): Promise<GoalSpecification>;
  startRun(goal: GoalSpecification, options?: RunOptions): Promise<ConduitRunHandle>;
}

export interface RuntimeExecutionContext {
  signal: AbortSignal;
  emit(event: RuntimeEvent): void;
  updateRun(patch: Partial<ConduitRun>): void;
}

export interface RuntimeDependencies {
  analyzeGoal(goal: GoalSpecification, context: RepositoryContext): Promise<GoalAnalysisResult>;
  applyAnswers(goal: GoalSpecification, batch: QuestionBatch, answers: AnswerBatch): Promise<GoalSpecification>;
  execute(goal: GoalSpecification, run: ConduitRun, options: RunOptions, context: RuntimeExecutionContext): Promise<GoalReport>;
  approvePermission?(requestId: string, decision: PermissionDecision): Promise<void>;
  now?: () => Date;
  id?: (prefix: string) => string;
}

/** Headless CGS orchestration boundary used by Desktop and future clients. */
export class DefaultConduitRuntime implements ConduitRuntime {
  private questionBatches = new Map<string, QuestionBatch>();

  constructor(private dependencies: RuntimeDependencies) {}

  async createGoal(input: CreateGoalInput): Promise<GoalSpecification> {
    const request = input.request.trim();
    if (!request) throw new Error("A rough goal request is required");
    const now = this.timestamp();
    return GoalSpecificationSchema.parse({
      cgsVersion: CGS_VERSION, kind: "goal", id: this.id("goal"), createdAt: now, updatedAt: now,
      title: input.title?.trim() || request.split(/\n|\./, 1)[0]?.slice(0, 120) || "Untitled goal",
      description: request, originalRequest: request, successCriteria: [], constraints: [], deliverables: [], assumptions: [],
      permissions: {
        allowFileReads: true, allowFileWrites: false, allowCommandExecution: false, allowNetworkAccess: false,
        allowDependencyChanges: false, allowGitOperations: false, ...input.permissions,
      },
      clarificationHistory: [],
      reviewPipeline: { generalReviewer: { reviewerId: "conduit.general", required: true }, specialistReviewers: [], routingMode: "hybrid", completionPolicy: "all_required_approve" },
      metadata: input.metadata, status: "draft", revision: 1,
    });
  }

  async analyzeGoal(input: GoalSpecification, context: RepositoryContext): Promise<GoalAnalysisResult> {
    const goal = parseGoalSpecification(input);
    const result = await this.dependencies.analyzeGoal(goal, context);
    const analyzedGoal = parseGoalSpecification(result.goal);
    if (analyzedGoal.id !== goal.id) throw new Error("Goal analysis cannot replace the stable goal ID");
    const questionBatches = result.questionBatches.map((batch) => parseQuestionBatch(batch));
    for (const batch of questionBatches) {
      if (batch.goalId !== goal.id) throw new Error("Question batch references a different goal");
      this.questionBatches.set(batch.id, batch);
    }
    return { goal: analyzedGoal, questionBatches };
  }

  async applyAnswers(input: GoalSpecification, inputAnswers: AnswerBatch): Promise<GoalSpecification> {
    const goal = parseGoalSpecification(input);
    const answers = parseAnswerBatch(inputAnswers);
    const batch = this.questionBatches.get(answers.questionBatchId);
    if (!batch) throw new Error(`Unknown question batch: ${answers.questionBatchId}`);
    const validation = validateAnswersForBatch(batch, answers);
    if (!validation.valid) throw new Error(validation.errors.map((error) => error.message).join("; "));
    const revised = parseGoalSpecification(await this.dependencies.applyAnswers(goal, batch, answers));
    if (revised.id !== goal.id || revised.revision <= goal.revision) throw new Error("Applying answers must create a newer revision of the same goal");
    return revised;
  }

  async approveGoal(input: GoalSpecification): Promise<GoalSpecification> {
    const goal = parseGoalSpecification({ ...input, status: "approved", updatedAt: this.timestamp() });
    return goal;
  }

  async startRun(input: GoalSpecification, options: RunOptions = {}): Promise<ConduitRunHandle> {
    const goal = parseGoalSpecification(input);
    if (goal.status !== "approved") throw new Error("Only an explicitly approved CGS goal can start a run");
    const timestamp = this.timestamp();
    const run = ConduitRunSchema.parse({
      cgsVersion: CGS_VERSION, kind: "run", id: this.id("run"), createdAt: timestamp, updatedAt: timestamp,
      goalId: goal.id, goalRevision: goal.revision, conduitDesktopVersion: options.conduitDesktopVersion,
      conduitRuntimeVersion: CONDUIT_RUNTIME_VERSION, status: "created", implementationAttempts: [], reviewResultIds: [], evidenceArtifactIds: [],
    });
    const handle = new RuntimeRunHandle(run, goal, options, this.dependencies);
    handle.begin();
    return handle;
  }

  private timestamp(): string { return (this.dependencies.now?.() ?? new Date()).toISOString(); }
  private id(prefix: string): string { return this.dependencies.id?.(prefix) ?? `${prefix}_${crypto.randomUUID()}`; }
}

class RuntimeRunHandle implements ConduitRunHandle {
  readonly runId: string;
  private listeners = new Set<(event: RuntimeEvent) => void>();
  private abortController = new AbortController();
  private run: ConduitRun;

  constructor(run: ConduitRun, private goal: GoalSpecification, private options: RunOptions, private dependencies: RuntimeDependencies) {
    this.run = run; this.runId = run.id;
  }

  begin(): void {
    queueMicrotask(() => void this.execute());
  }
  subscribe(listener: (event: RuntimeEvent) => void): Unsubscribe { this.listeners.add(listener); listener({ type: "run.updated", run: this.run }); return () => this.listeners.delete(listener); }
  async submitAnswers(_answers: AnswerBatch): Promise<void> { throw new Error("This run is not awaiting answers"); }
  async approvePermission(requestId: string, decision: PermissionDecision): Promise<void> {
    if (!this.dependencies.approvePermission) throw new Error("This runtime has no permission coordinator");
    await this.dependencies.approvePermission(requestId, decision);
  }
  async cancel(): Promise<void> { this.abortController.abort(); this.update({ status: "cancelled", completedAt: new Date().toISOString() }); }
  async getSnapshot(): Promise<ConduitRun> { return structuredClone(this.run); }

  private async execute(): Promise<void> {
    this.update({ status: "planning", startedAt: new Date().toISOString() });
    try {
      const report = parseGoalReport(await this.dependencies.execute(this.goal, this.run, this.options, {
        signal: this.abortController.signal, emit: (event) => this.emit(event), updateRun: (patch) => this.update(patch),
      }));
      if (this.abortController.signal.aborted) return;
      this.emit({ type: "report.generated", report });
      this.update({ status: "completed", completedAt: new Date().toISOString() });
    } catch (error) {
      if (this.abortController.signal.aborted) return;
      const message = error instanceof Error ? error.message : String(error);
      this.update({ status: "failed", completedAt: new Date().toISOString(), failure: { code: "execution_failed", message } });
      this.emit({ type: "runtime.error", error: { code: "execution_failed", message, recoverable: false } });
    }
  }
  private update(patch: Partial<ConduitRun>): void { this.run = ConduitRunSchema.parse({ ...this.run, ...patch, updatedAt: new Date().toISOString() }); this.emit({ type: "run.updated", run: this.run }); }
  private emit(event: RuntimeEvent): void { for (const listener of this.listeners) listener(event); }
}
