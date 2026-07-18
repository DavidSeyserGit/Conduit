import type {
  GoalAnalystOutput,
  GoalAnswer,
  GoalAnswerValue,
  GoalDefinition,
  GoalDrivenRunRecord,
  GoalPersistenceRepository,
  GoalQuestion,
  GoalVersion,
  GoalWorkflowEvent,
  GoalWorkflowPhase,
  RepositoryContext,
} from "@conduit/shared";
import {
  GoalAnswerSchema,
  ConstraintSchema,
  GoalDefinitionSchema,
  GoalQuestionSchema,
  SuccessCriterionSchema,
} from "@conduit/shared";
import type { ModelProvider } from "@conduit/model-providers";
import type { ToolExecutor } from "@conduit/tools";
import { GoalAnalyst } from "./goal-analyst.js";
import { prepareRepositoryContext } from "./repository-context.js";

export interface StartGoalDefinitionRequest {
  initialRequest: string;
  workspacePath: string;
  policies?: string[];
}

export interface GoalDefinitionRuntimeResult {
  run: GoalDrivenRunRecord;
  goal: GoalDefinition;
  questions: GoalQuestion[];
  analysis: GoalAnalystOutput;
  repositoryContext: RepositoryContext;
}

export interface GoalDefinitionPatch {
  title?: string;
  description?: string;
  successCriteria?: GoalDefinition["successCriteria"];
  constraints?: GoalDefinition["constraints"];
  deliverables?: GoalDefinition["deliverables"];
  assumptions?: GoalDefinition["assumptions"];
}

export interface GoalDefinitionRuntimeOptions {
  reasoningEffort?: string;
  now?: () => Date;
  createId?: (prefix: string) => string;
}

type StripEventEnvelope<T> = T extends unknown ? Omit<T, "id" | "runId" | "occurredAt"> : never;
type GoalWorkflowEventBody = StripEventEnvelope<GoalWorkflowEvent>;

export class GoalDefinitionRuntime {
  private abortController: AbortController | null = null;
  private currentRunId: string | null = null;
  private now: () => Date;
  private createId: (prefix: string) => string;

  constructor(
    private provider: ModelProvider,
    private modelId: string,
    private tools: ToolExecutor,
    private persistence: GoalPersistenceRepository,
    private options: GoalDefinitionRuntimeOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? ((prefix) => `${prefix}-${globalThis.crypto.randomUUID()}`);
  }

  async start(request: StartGoalDefinitionRequest): Promise<GoalDefinitionRuntimeResult> {
    if (!request.initialRequest.trim()) throw new Error("An initial request is required");
    this.abortController?.abort();
    this.abortController = new AbortController();
    const timestamp = this.timestamp();
    const goalId = this.createId("goal");
    const runId = this.createId("run");
    this.currentRunId = runId;
    const provisional = GoalDefinitionSchema.parse({
      schemaVersion: 1,
      id: goalId,
      originalRequest: request.initialRequest.trim(),
      title: "Analyzing goal",
      description: request.initialRequest.trim(),
      successCriteria: [{ id: this.createId("criterion"), description: "Clarify and approve the requested outcome", required: true }],
      constraints: [],
      deliverables: [{ id: this.createId("deliverable"), type: "implementation", description: "Approved implementation", required: true }],
      assumptions: [],
      answers: [],
      status: "draft",
      version: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    let run: GoalDrivenRunRecord = {
      formatVersion: 1,
      id: runId,
      goalId,
      activeGoalVersion: 1,
      workflowPhase: "analyzing_goal",
      workspacePath: request.workspacePath,
      startedAt: timestamp,
      updatedAt: timestamp,
    };
    await this.persistence.saveGoal(provisional);
    await this.persistence.saveGoalVersion(this.versionRecord(provisional, "Initial request recorded", "runtime"));
    await this.persistence.saveRun(run);
    await this.transition(run, null, "analyzing_goal", "Inspecting the repository and analyzing the request");

    try {
      const prepared = await prepareRepositoryContext(request.workspacePath, request.initialRequest, this.tools, this.now);
      await this.persistence.writeArtifact(runId, JSON.stringify(prepared, null, 2), "application/json");
      const result = await this.analyst().analyze({
        initialRequest: request.initialRequest,
        repositoryContext: prepared.context,
        excerpts: prepared.excerpts,
        policies: request.policies,
        signal: this.abortController.signal,
      });
      this.throwIfCancelled();
      const questions = result.analysis.questionBatches.flatMap((batch) => batch.questions);
      const goal = this.buildGoal(provisional, result.analysis, [], questions.length > 0 ? "awaiting_answers" : "awaiting_approval");
      run = { ...run, activeGoalVersion: goal.version, workflowPhase: questions.length > 0 ? "awaiting_goal_answers" : "awaiting_goal_approval", updatedAt: this.timestamp() };
      await this.persistRevision(run, goal, questions, result.analysis.decisionSummary, "goal_analyst");
      await this.transition(run, "analyzing_goal", run.workflowPhase, questions.length > 0 ? "Focused clarification is required" : "Structured goal preview is ready for approval");
      if (questions.length > 0) {
        for (const batch of result.analysis.questionBatches) {
          await this.event(run.id, { type: "question_batch_requested", batchId: batch.id });
        }
      }
      return { run, goal, questions, analysis: result.analysis, repositoryContext: prepared.context };
    } catch (error) {
      const cancelled = this.abortController.signal.aborted;
      const restored = await this.persistence.restoreRun(run.id);
      if (!restored || !("workflowPhase" in restored.run) || restored.run.workflowPhase !== "cancelled") {
        await this.finishRun(run, cancelled ? "cancelled" : "failed", cancelled ? "Goal analysis cancelled" : "Goal analysis failed");
      }
      throw error;
    } finally {
      this.abortController = null;
    }
  }

  async submitAnswers(runId: string, supplied: Array<{ questionId: string; value?: GoalAnswerValue; useDefault?: boolean }>): Promise<GoalDefinitionRuntimeResult> {
    const snapshot = await this.requireSnapshot(runId);
    if (!snapshot.goal) throw new Error("The run has no structured goal");
    if (snapshot.run.workflowPhase !== "awaiting_goal_answers") throw new Error("This run is not awaiting goal answers");
    this.abortController = new AbortController();
    this.currentRunId = runId;
    const currentQuestions = snapshot.questions.filter((question) => !snapshot.answers.some((answer) => answer.questionId === question.id));
    const answers = this.normalizeAnswers(currentQuestions, supplied);
    for (const answer of answers) {
      await this.persistence.saveAnswer(snapshot.goal.id, answer);
      await this.event(runId, { type: "answer_recorded", questionId: answer.questionId });
    }
    const allAnswers = [...snapshot.answers, ...answers];
    const prepared = await prepareRepositoryContext(snapshot.run.workspacePath, snapshot.goal.originalRequest, this.tools, this.now);
    const buildingRun = { ...snapshot.run, workflowPhase: "building_goal" as const, updatedAt: this.timestamp() };
    await this.persistence.saveRun(buildingRun);
    await this.transition(buildingRun, "awaiting_goal_answers", "building_goal", "Regenerating the goal from recorded answers");
    let result;
    try {
      result = await this.analyst().analyze({
        initialRequest: snapshot.goal.originalRequest,
        repositoryContext: prepared.context,
        excerpts: prepared.excerpts,
        previousAnswers: allAnswers,
        signal: this.abortController.signal,
      });
      this.throwIfCancelled();
    } catch (error) {
      const cancelled = this.abortController.signal.aborted;
      await this.finishRun(buildingRun, cancelled ? "cancelled" : "failed", cancelled ? "Goal revision cancelled" : "Goal revision failed");
      throw error;
    } finally {
      this.abortController = null;
    }
    const unanswered = result.analysis.questionBatches.flatMap((batch) => batch.questions)
      .filter((question) => !allAnswers.some((answer) => answer.questionId === question.id));
    const goal = this.buildGoal(snapshot.goal, result.analysis, allAnswers, unanswered.length > 0 ? "awaiting_answers" : "awaiting_approval");
    const run = { ...snapshot.run, activeGoalVersion: goal.version, workflowPhase: unanswered.length > 0 ? "awaiting_goal_answers" as const : "awaiting_goal_approval" as const, updatedAt: this.timestamp() };
    await this.persistRevision(run, goal, unanswered, "Goal regenerated after clarification answers", "goal_analyst");
    await this.transition(run, "building_goal", run.workflowPhase, unanswered.length > 0 ? "Additional user decisions are required" : "Structured goal preview is ready for approval");
    return { run, goal, questions: unanswered, analysis: result.analysis, repositoryContext: prepared.context };
  }

  async revise(runId: string, patch: GoalDefinitionPatch, summary = "Goal edited by user"): Promise<GoalDefinition> {
    this.currentRunId = runId;
    const snapshot = await this.requireSnapshot(runId);
    if (!snapshot.goal) throw new Error("The run has no structured goal");
    if (!["awaiting_goal_answers", "awaiting_goal_approval"].includes(snapshot.run.workflowPhase)) {
      throw new Error("Only a draft goal can be revised directly");
    }
    const updated = GoalDefinitionSchema.parse({
      ...snapshot.goal,
      ...patch,
      successCriteria: preserveIds(snapshot.goal.successCriteria, patch.successCriteria ?? snapshot.goal.successCriteria),
      constraints: preserveIds(snapshot.goal.constraints, patch.constraints ?? snapshot.goal.constraints),
      deliverables: preserveIds(snapshot.goal.deliverables, patch.deliverables ?? snapshot.goal.deliverables),
      assumptions: preserveIds(snapshot.goal.assumptions, patch.assumptions ?? snapshot.goal.assumptions),
      version: snapshot.goal.version + 1,
      status: "awaiting_approval",
      updatedAt: this.timestamp(),
    });
    const run = { ...snapshot.run, activeGoalVersion: updated.version, workflowPhase: "awaiting_goal_approval" as const, updatedAt: this.timestamp() };
    await this.persistRevision(run, updated, [], summary, "user");
    await this.transition(run, snapshot.run.workflowPhase, "awaiting_goal_approval", "Edited goal preview is ready for approval");
    return updated;
  }

  async reviseAnswer(runId: string, questionId: string, value: GoalAnswerValue): Promise<GoalDefinitionRuntimeResult> {
    this.abortController = new AbortController();
    this.currentRunId = runId;
    const snapshot = await this.requireSnapshot(runId);
    if (!snapshot.goal || !["awaiting_goal_answers", "awaiting_goal_approval"].includes(snapshot.run.workflowPhase)) {
      throw new Error("Answers can only be revised before goal approval");
    }
    const question = snapshot.questions.find((candidate) => candidate.id === questionId);
    if (!question) throw new Error(`Unknown goal question: ${questionId}`);
    validateAnswerValue(question, value);
    const answer = GoalAnswerSchema.parse({ questionId, value, answeredBy: "user", answeredAt: this.timestamp() });
    await this.persistence.saveAnswer(snapshot.goal.id, answer);
    await this.event(runId, { type: "answer_recorded", questionId });
    const latestAnswers = [...snapshot.goal.answers.filter((candidate) => candidate.questionId !== questionId), answer];
    const prepared = await prepareRepositoryContext(snapshot.run.workspacePath, snapshot.goal.originalRequest, this.tools, this.now);
    const buildingRun = { ...snapshot.run, workflowPhase: "building_goal" as const, updatedAt: this.timestamp() };
    await this.persistence.saveRun(buildingRun);
    await this.transition(buildingRun, snapshot.run.workflowPhase, "building_goal", "Regenerating the goal after an answer revision");
    try {
      const result = await this.analyst().analyze({
        initialRequest: snapshot.goal.originalRequest,
        repositoryContext: prepared.context,
        excerpts: prepared.excerpts,
        previousAnswers: latestAnswers,
        signal: this.abortController.signal,
      });
      this.throwIfCancelled();
      const unanswered = result.analysis.questionBatches.flatMap((batch) => batch.questions)
        .filter((candidate) => !latestAnswers.some((candidateAnswer) => candidateAnswer.questionId === candidate.id));
      const goal = this.buildGoal(snapshot.goal, result.analysis, latestAnswers, unanswered.length > 0 ? "awaiting_answers" : "awaiting_approval");
      const run = { ...buildingRun, activeGoalVersion: goal.version, workflowPhase: unanswered.length > 0 ? "awaiting_goal_answers" as const : "awaiting_goal_approval" as const, updatedAt: this.timestamp() };
      await this.persistRevision(run, goal, unanswered, `Answer ${questionId} revised`, "user");
      await this.transition(run, "building_goal", run.workflowPhase, unanswered.length > 0 ? "Revised goal requires more input" : "Revised goal is ready for approval");
      return { run, goal, questions: unanswered, analysis: result.analysis, repositoryContext: prepared.context };
    } catch (error) {
      const cancelled = this.abortController.signal.aborted;
      await this.finishRun(buildingRun, cancelled ? "cancelled" : "failed", cancelled ? "Answer revision cancelled" : "Answer revision failed");
      throw error;
    } finally {
      this.abortController = null;
    }
  }

  async regenerate(runId: string): Promise<GoalDefinitionRuntimeResult> {
    this.abortController = new AbortController();
    this.currentRunId = runId;
    const snapshot = await this.requireSnapshot(runId);
    if (!snapshot.goal || !["awaiting_goal_answers", "awaiting_goal_approval"].includes(snapshot.run.workflowPhase)) {
      throw new Error("Only a draft goal can be regenerated");
    }
    const prepared = await prepareRepositoryContext(snapshot.run.workspacePath, snapshot.goal.originalRequest, this.tools, this.now);
    const buildingRun = { ...snapshot.run, workflowPhase: "building_goal" as const, updatedAt: this.timestamp() };
    await this.persistence.saveRun(buildingRun);
    await this.transition(buildingRun, snapshot.run.workflowPhase, "building_goal", "Regenerating the goal preview");
    try {
      const result = await this.analyst().analyze({
        initialRequest: snapshot.goal.originalRequest,
        repositoryContext: prepared.context,
        excerpts: prepared.excerpts,
        previousAnswers: snapshot.goal.answers,
        signal: this.abortController.signal,
      });
      this.throwIfCancelled();
      const unanswered = result.analysis.questionBatches.flatMap((batch) => batch.questions)
        .filter((question) => !snapshot.goal!.answers.some((answer) => answer.questionId === question.id));
      const goal = this.buildGoal(snapshot.goal, result.analysis, snapshot.goal.answers, unanswered.length > 0 ? "awaiting_answers" : "awaiting_approval");
      const run = { ...buildingRun, activeGoalVersion: goal.version, workflowPhase: unanswered.length > 0 ? "awaiting_goal_answers" as const : "awaiting_goal_approval" as const, updatedAt: this.timestamp() };
      await this.persistRevision(run, goal, unanswered, "Goal preview regenerated", "goal_analyst");
      await this.transition(run, "building_goal", run.workflowPhase, unanswered.length > 0 ? "Regenerated goal requires more input" : "Regenerated goal is ready for approval");
      return { run, goal, questions: unanswered, analysis: result.analysis, repositoryContext: prepared.context };
    } catch (error) {
      const cancelled = this.abortController.signal.aborted;
      await this.finishRun(buildingRun, cancelled ? "cancelled" : "failed", cancelled ? "Goal regeneration cancelled" : "Goal regeneration failed");
      throw error;
    } finally {
      this.abortController = null;
    }
  }

  async approve(runId: string, version: number): Promise<GoalDefinition> {
    this.currentRunId = runId;
    const snapshot = await this.requireSnapshot(runId);
    if (!snapshot.goal || snapshot.run.workflowPhase !== "awaiting_goal_approval") throw new Error("The goal is not awaiting approval");
    if (snapshot.goal.version !== version || snapshot.run.activeGoalVersion !== version) {
      throw new Error("Cannot approve a stale goal version");
    }
    const approved = GoalDefinitionSchema.parse({ ...snapshot.goal, status: "approved", updatedAt: this.timestamp() });
    const run = { ...snapshot.run, workflowPhase: "planning" as const, updatedAt: this.timestamp() };
    await this.persistence.saveGoal(approved);
    await this.persistence.saveRun(run);
    await this.event(runId, { type: "goal_approved", goalId: approved.id, version });
    await this.transition(run, "awaiting_goal_approval", "planning", "Approved goal is ready for implementation planning");
    return approved;
  }

  async assertApprovedGoal(runId: string, version: number): Promise<GoalDefinition> {
    const snapshot = await this.requireSnapshot(runId);
    if (!snapshot.goal || snapshot.goal.status !== "approved" || snapshot.goal.version !== version || snapshot.run.activeGoalVersion !== version) {
      throw new Error("Implementation requires approval of the exact active goal version");
    }
    return snapshot.goal;
  }

  async requestExecutionQuestion(runId: string, questionInput: GoalQuestion): Promise<void> {
    const snapshot = await this.requireSnapshot(runId);
    if (!snapshot.goal || snapshot.goal.status !== "approved") throw new Error("Execution questions require an approved goal");
    if (!["planning", "implementing", "validating"].includes(snapshot.run.workflowPhase)) throw new Error("The run cannot pause for input from its current state");
    const question = GoalQuestionSchema.parse(questionInput);
    if (!question.sourceReason) throw new Error("Execution questions must explain why the decision cannot be inferred safely");
    rejectRepositoryFactQuestion(question);
    await this.persistence.replaceQuestions(snapshot.goal.id, snapshot.goal.version, [question]);
    const run = { ...snapshot.run, workflowPhase: "awaiting_user_input" as const, updatedAt: this.timestamp() };
    await this.persistence.saveRun(run);
    await this.transition(run, snapshot.run.workflowPhase, "awaiting_user_input", "Implementation paused for a decision that cannot be inferred safely");
    await this.event(runId, { type: "question_batch_requested", batchId: `execution-${question.id}` });
  }

  async answerExecutionQuestion(runId: string, questionId: string, value: GoalAnswerValue, contractPatch?: GoalDefinitionPatch): Promise<GoalDefinition> {
    this.currentRunId = runId;
    const snapshot = await this.requireSnapshot(runId);
    if (!snapshot.goal || snapshot.run.workflowPhase !== "awaiting_user_input") throw new Error("The run is not awaiting execution input");
    const question = snapshot.questions.find((candidate) => candidate.id === questionId);
    if (!question) throw new Error(`Unknown execution question: ${questionId}`);
    const pauseTransition = [...snapshot.events].reverse().find((event) =>
      "type" in event && event.type === "workflow_state_transitioned" && event.to === "awaiting_user_input"
    );
    const resumePhase = pauseTransition && "from" in pauseTransition ? pauseTransition.from : null;
    if (!resumePhase || !["planning", "implementing", "validating"].includes(resumePhase)) {
      throw new Error("The execution phase to resume could not be restored");
    }
    validateAnswerValue(question, value);
    const answer = GoalAnswerSchema.parse({ questionId, value, answeredBy: "user", answeredAt: this.timestamp() });
    await this.persistence.saveAnswer(snapshot.goal.id, answer);
    await this.event(runId, { type: "answer_recorded", questionId });
    const goal = GoalDefinitionSchema.parse({
      ...snapshot.goal,
      ...contractPatch,
      answers: [...snapshot.goal.answers, answer],
      version: snapshot.goal.version + 1,
      status: "approved",
      updatedAt: this.timestamp(),
    });
    const run = { ...snapshot.run, activeGoalVersion: goal.version, workflowPhase: resumePhase, updatedAt: this.timestamp() };
    await this.persistRevision(run, goal, [], "Execution-time decision recorded", "runtime");
    await this.transition(run, "awaiting_user_input", resumePhase, "Answer received; execution may resume");
    return goal;
  }

  async cancel(runId: string): Promise<void> {
    if (this.abortController) {
      this.abortController.abort();
      return;
    }
    const snapshot = await this.persistence.restoreRun(runId);
    if (snapshot && "workflowPhase" in snapshot.run) await this.finishRun(snapshot.run, "cancelled", "Goal definition cancelled by user");
  }

  async cancelActive(): Promise<void> {
    if (this.currentRunId) await this.cancel(this.currentRunId);
  }

  private analyst(): GoalAnalyst {
    return new GoalAnalyst(this.provider, this.modelId, this.options.reasoningEffort);
  }

  private buildGoal(previous: GoalDefinition, analysis: GoalAnalystOutput, answers: GoalAnswer[], status: GoalDefinition["status"]): GoalDefinition {
    return GoalDefinitionSchema.parse({
      ...previous,
      title: analysis.proposedTitle,
      description: analysis.proposedDescription,
      successCriteria: preserveIds(previous.successCriteria, analysis.proposedSuccessCriteria),
      constraints: preserveIds(previous.constraints, analysis.proposedConstraints),
      deliverables: preserveIds(previous.deliverables, analysis.proposedDeliverables),
      assumptions: preserveIds(previous.assumptions, analysis.proposedAssumptions),
      answers,
      status,
      version: previous.version + 1,
      updatedAt: this.timestamp(),
    });
  }

  private normalizeAnswers(questions: GoalQuestion[], supplied: Array<{ questionId: string; value?: GoalAnswerValue; useDefault?: boolean }>): GoalAnswer[] {
    const suppliedById = new Map(supplied.map((answer) => [answer.questionId, answer]));
    return questions.map((question) => {
      const suppliedAnswer = suppliedById.get(question.id);
      const hasDefault = "defaultValue" in question && question.defaultValue !== undefined;
      let value: GoalAnswerValue | undefined = suppliedAnswer?.useDefault && hasDefault ? question.defaultValue as GoalAnswerValue : suppliedAnswer?.value;
      let answeredBy: "user" | "default" = suppliedAnswer?.useDefault ? "default" : "user";
      if (value === undefined && hasDefault) {
        value = question.defaultValue as GoalAnswerValue;
        answeredBy = "default";
      }
      if (value === undefined && !question.required) value = null;
      if (value === undefined) throw new Error(`Required question ${question.id} has not been answered`);
      if (value !== null) validateAnswerValue(question, value);
      return GoalAnswerSchema.parse({ questionId: question.id, value, answeredBy, answeredAt: this.timestamp() });
    });
  }

  private async persistRevision(run: GoalDrivenRunRecord, goal: GoalDefinition, questions: GoalQuestion[], summary: string, createdBy: GoalVersion["createdBy"]): Promise<void> {
    await this.persistence.saveGoal(goal);
    await this.persistence.saveGoalVersion(this.versionRecord(goal, summary, createdBy));
    await this.persistence.replaceQuestions(goal.id, goal.version, questions);
    await this.persistence.saveRun(run);
    await this.event(run.id, { type: "goal_version_created", goalId: goal.id, version: goal.version });
  }

  private versionRecord(goal: GoalDefinition, changeSummary: string, createdBy: GoalVersion["createdBy"]): GoalVersion {
    return { goalId: goal.id, version: goal.version, definition: goal, changeSummary, createdAt: this.timestamp(), createdBy };
  }

  private async transition(run: GoalDrivenRunRecord, from: GoalWorkflowPhase | null, to: GoalWorkflowPhase, summary: string): Promise<void> {
    await this.event(run.id, { type: "workflow_state_transitioned", from, to, summary });
  }

  private async event(runId: string, body: GoalWorkflowEventBody): Promise<void> {
    await this.persistence.appendEvent({ ...body, id: this.createId("event"), runId, occurredAt: this.timestamp() } as GoalWorkflowEvent);
  }

  private async finishRun(run: GoalDrivenRunRecord, phase: "failed" | "cancelled", summary: string): Promise<void> {
    const finishedAt = this.timestamp();
    const updated = { ...run, workflowPhase: phase, updatedAt: finishedAt, finishedAt };
    await this.persistence.saveRun(updated);
    await this.transition(updated, run.workflowPhase, phase, summary);
  }

  private async requireSnapshot(runId: string) {
    const snapshot = await this.persistence.restoreRun(runId);
    if (!snapshot || !("workflowPhase" in snapshot.run)) throw new Error(`Unknown goal-driven run: ${runId}`);
    return { ...snapshot, run: snapshot.run };
  }

  private timestamp(): string { return this.now().toISOString(); }

  private throwIfCancelled(): void {
    if (this.abortController?.signal.aborted) throw new Error("Goal analysis cancelled");
  }
}

function preserveIds<T extends { id: string; description: string }>(previous: T[], next: T[]): T[] {
  const previousByDescription = new Map(previous.map((item) => [normalize(item.description), item.id]));
  return next.map((item) => ({ ...item, id: previousByDescription.get(normalize(item.description)) ?? item.id }));
}

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function validateAnswerValue(question: GoalQuestion, value: GoalAnswerValue): void {
  if (question.type === "confirmation" && typeof value !== "boolean") throw new Error(`Question ${question.id} requires a boolean answer`);
  if (question.type === "text" && typeof value !== "string") throw new Error(`Question ${question.id} requires a text answer`);
  if (question.type === "single_select" || question.type === "repository_reference") {
    if (typeof value !== "string") throw new Error(`Question ${question.id} requires one selected option`);
    if (!question.allowCustomAnswer && !question.options.some((option) => option.id === value)) throw new Error(`Question ${question.id} references an unknown option`);
  }
  if (question.type === "multi_select") {
    if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) throw new Error(`Question ${question.id} requires selected options`);
    const optionIds = new Set(question.options.map((option) => option.id));
    if (!question.allowCustomAnswer && value.some((item) => !optionIds.has(item))) throw new Error(`Question ${question.id} references an unknown option`);
  }
  if (question.type === "constraint_editor" && (!Array.isArray(value) || value.some((item) => !ConstraintSchema.safeParse(item).success))) throw new Error(`Question ${question.id} requires constraints`);
  if (question.type === "success_criteria_editor" && (!Array.isArray(value) || value.some((item) => !SuccessCriterionSchema.safeParse(item).success))) throw new Error(`Question ${question.id} requires success criteria`);
}

function rejectRepositoryFactQuestion(question: GoalQuestion): void {
  const text = `${question.title} ${question.description ?? ""}`;
  if (/\b(which|what) (?:programming )?language\b|\b(which|what) package manager\b|\b(which|what) test framework\b|\bwhere (?:is|are)\b|\bwhich file\b|\brepository structure\b/i.test(text)) {
    throw new Error(`Question ${question.id} asks for a repository fact that must be inspected`);
  }
}
