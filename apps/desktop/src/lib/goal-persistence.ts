import { invoke } from "@tauri-apps/api/core";
import { CgsArtifactUnionSchema, type CgsArtifactValue } from "@conduit/cgs";
import type { CgsArtifactRepository } from "@conduit/runtime";
import {
  CompatiblePersistedRunSchema,
  EvidenceItemSchema,
  EvidenceRequestSchema,
  GoalAnswerSchema,
  GoalDefinitionSchema,
  GoalDrivenRunRecordSchema,
  GoalQuestionSchema,
  GoalReportSchema,
  GoalVersionSchema,
  GoalWorkflowEventSchema,
  ReviewFindingSchema,
  ReviewResultSchema,
  type EvidenceItem,
  type EvidenceRequest,
  type GoalAnswer,
  type GoalDefinition,
  type GoalDrivenRunRecord,
  type GoalQuestion,
  type GoalReport,
  type GoalVersion,
  type GoalWorkflowEvent,
  type ReviewResult,
} from "@conduit/cgs/legacy";
import type {
  GoalArtifactContent,
  GoalArtifactMetadata,
  GoalPersistenceRepository,
  GoalRunSnapshot,
  GoalRunEvent,
  GoalRunState,
  GoalStorageStatus,
} from "@conduit/shared";

type InvokeFn = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

export interface LegacyMigrationResult {
  imported: number;
  skipped: number;
  alreadyCompleted: boolean;
}

export class TauriGoalPersistenceRepository implements GoalPersistenceRepository, CgsArtifactRepository {
  constructor(private readonly invokeCommand: InvokeFn = invoke) {}

  status(): Promise<GoalStorageStatus> {
    return this.invokeCommand("goal_storage_status");
  }

  async saveCgsArtifact(artifact: CgsArtifactValue): Promise<void> {
    await this.write({ operation: "upsert_cgs_artifact", artifact: CgsArtifactUnionSchema.parse(artifact) });
  }

  async getCgsArtifact(id: string): Promise<CgsArtifactValue | null> {
    const value = await this.read({ query: "cgs_artifact", id });
    return value === null ? null : CgsArtifactUnionSchema.parse(value);
  }

  async saveGoal(goal: GoalDefinition): Promise<void> {
    await this.write({ operation: "upsert_goal", goal: GoalDefinitionSchema.parse(goal) });
  }

  async saveGoalVersion(version: GoalVersion): Promise<void> {
    await this.write({ operation: "insert_goal_version", version: GoalVersionSchema.parse(version) });
  }

  async replaceQuestions(goalId: string, goalVersion: number, questions: GoalQuestion[]): Promise<void> {
    const parsed = questions.map((question) => GoalQuestionSchema.parse(question));
    await this.write({ operation: "replace_questions", goal_id: goalId, goal_version: goalVersion, questions: parsed });
  }

  async saveAnswer(goalId: string, answer: GoalAnswer): Promise<void> {
    await this.write({ operation: "upsert_answer", goal_id: goalId, answer: GoalAnswerSchema.parse(answer) });
  }

  async saveRun(run: GoalDrivenRunRecord): Promise<void> {
    await this.write({ operation: "upsert_run", run: GoalDrivenRunRecordSchema.parse(run) });
  }

  async appendEvent(event: GoalWorkflowEvent): Promise<number> {
    const result = await this.write({ operation: "append_event", event: GoalWorkflowEventSchema.parse(event) });
    return requiredNumber(result, "sequence");
  }

  async saveReview(runId: string, review: ReviewResult): Promise<void> {
    await this.write({ operation: "upsert_review", run_id: runId, review: ReviewResultSchema.parse(review) });
  }

  async saveEvidenceRequest(runId: string, request: EvidenceRequest): Promise<void> {
    await this.write({ operation: "upsert_evidence_request", run_id: runId, request: EvidenceRequestSchema.parse(request) });
  }

  async saveEvidence(runId: string, evidence: EvidenceItem): Promise<void> {
    await this.write({ operation: "upsert_evidence_item", run_id: runId, evidence: EvidenceItemSchema.parse(evidence) });
  }

  async saveReport(report: GoalReport): Promise<void> {
    await this.write({ operation: "upsert_report", report: GoalReportSchema.parse(report) });
  }

  async deleteRun(runId: string): Promise<void> {
    await this.write({ operation: "delete_run", run_id: runId });
  }

  async deleteGoal(goalId: string): Promise<void> {
    await this.write({ operation: "delete_goal", goal_id: goalId });
  }

  async importLegacyRun(run: GoalRunState, events: GoalRunEvent[]): Promise<void> {
    const parsed = CompatiblePersistedRunSchema.parse(run);
    if ("formatVersion" in parsed) throw new Error("Expected a legacy v0.2 run record");
    await this.write({ operation: "import_legacy_run", run: parsed, events });
  }

  async getGoal(id: string): Promise<GoalDefinition | null> {
    const value = await this.read({ query: "goal", id });
    return value === null ? null : GoalDefinitionSchema.parse(value);
  }

  async restoreRun(runId: string): Promise<GoalRunSnapshot | null> {
    const value = await this.read({ query: "run_snapshot", run_id: runId });
    if (value === null) return null;
    return parseSnapshot(value);
  }

  async listRuns(phases?: string[]): Promise<Array<GoalDrivenRunRecord | GoalRunState>> {
    const value = await this.read({ query: "runs", phases });
    if (!Array.isArray(value)) throw new Error("Goal storage returned an invalid run list");
    return value.map((run) => CompatiblePersistedRunSchema.parse(run) as GoalDrivenRunRecord | GoalRunState);
  }

  writeArtifact(runId: string, content: string, contentType = "text/plain"): Promise<GoalArtifactMetadata> {
    return this.invokeCommand("goal_artifact_write", { runId, content, contentType });
  }

  readArtifact(artifactId: string): Promise<GoalArtifactContent> {
    return this.invokeCommand("goal_artifact_read", { artifactId });
  }

  cleanupArtifacts(olderThanSeconds?: number): Promise<number> {
    return this.invokeCommand("goal_artifact_cleanup", { olderThanSeconds });
  }

  private write(operation: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.invokeCommand("goal_storage_write", { operation });
  }

  private read(query: Record<string, unknown>): Promise<unknown> {
    return this.invokeCommand("goal_storage_read", { query });
  }
}

export async function migrateLegacyRunHistoryFromLocalStorage(
  repository: GoalPersistenceRepository,
  storage: Pick<Storage, "getItem" | "setItem"> = localStorage,
): Promise<LegacyMigrationResult> {
  const marker = "conduit-goal-storage-migrated-v1";
  if (storage.getItem(marker) === "complete") return { imported: 0, skipped: 0, alreadyCompleted: true };

  const raw = storage.getItem("loopkit-app");
  if (!raw) {
    storage.setItem(marker, "complete");
    return { imported: 0, skipped: 0, alreadyCompleted: false };
  }

  let persisted: unknown;
  try {
    persisted = JSON.parse(raw);
  } catch {
    throw new Error("Existing Conduit run history is not valid JSON; it was left untouched");
  }

  const candidates = collectLegacyRuns(persisted);
  let imported = 0;
  let skipped = 0;
  for (const candidate of candidates.values()) {
    const parsed = CompatiblePersistedRunSchema.safeParse(candidate.run);
    if (!parsed.success || "formatVersion" in parsed.data) {
      skipped += 1;
      continue;
    }
    if (!candidate.events.every(isRecord)) {
      skipped += 1;
      continue;
    }
    await repository.importLegacyRun(parsed.data as GoalRunState, candidate.events as GoalRunEvent[]);
    imported += 1;
  }
  storage.setItem(marker, "complete");
  return { imported, skipped, alreadyCompleted: false };
}

function collectLegacyRuns(value: unknown): Map<string, { run: unknown; events: unknown[] }> {
  const candidates = new Map<string, { run: unknown; events: unknown[] }>();
  if (!isRecord(value)) return candidates;
  const state = isRecord(value.state) ? value.state : value;

  addHistory(candidates, state.runHistory);
  addCurrent(candidates, state.currentRun, state.runEvents);

  if (isRecord(state.sessions)) {
    for (const sessions of Object.values(state.sessions)) {
      if (!Array.isArray(sessions)) continue;
      for (const session of sessions) {
        if (!isRecord(session)) continue;
        addHistory(candidates, session.runHistory);
        addCurrent(candidates, session.currentRun, session.runEvents);
      }
    }
  }
  return candidates;
}

function addHistory(target: Map<string, { run: unknown; events: unknown[] }>, history: unknown): void {
  if (!Array.isArray(history)) return;
  for (const entry of history) {
    if (!isRecord(entry) || !isRecord(entry.run) || typeof entry.run.id !== "string") continue;
    target.set(entry.run.id, { run: entry.run, events: Array.isArray(entry.events) ? entry.events : [] });
  }
}

function addCurrent(target: Map<string, { run: unknown; events: unknown[] }>, run: unknown, events: unknown): void {
  if (!isRecord(run) || typeof run.id !== "string" || target.has(run.id)) return;
  target.set(run.id, { run, events: Array.isArray(events) ? events : [] });
}

function parseSnapshot(value: unknown): GoalRunSnapshot {
  if (!isRecord(value)) throw new Error("Goal storage returned an invalid run snapshot");
  const run = CompatiblePersistedRunSchema.parse(value.run) as GoalDrivenRunRecord | GoalRunState;
  const goal = value.goal === null ? null : GoalDefinitionSchema.parse(value.goal);
  const versions = parseArray(value.versions, GoalVersionSchema.parse);
  const questions = parseArray(value.questions, GoalQuestionSchema.parse);
  const answers = parseArray(value.answers, GoalAnswerSchema.parse);
  const events = parseEvents(value.events, "formatVersion" in run);
  return {
    run,
    goal,
    versions,
    questions,
    answers,
    events,
    reviews: parseArray(value.reviews, ReviewResultSchema.parse),
    findings: parseArray(value.findings, ReviewFindingSchema.parse),
    evidenceRequests: parseArray(value.evidenceRequests, EvidenceRequestSchema.parse),
    evidence: parseArray(value.evidence, EvidenceItemSchema.parse),
    report: value.report === null ? null : GoalReportSchema.parse(value.report),
  };
}

function parseEvents(value: unknown, current: boolean): Array<GoalWorkflowEvent | GoalRunEvent> {
  if (!Array.isArray(value)) throw new Error("Goal storage returned invalid run events");
  return current ? value.map((event) => GoalWorkflowEventSchema.parse(event)) : value as GoalRunEvent[];
}

function parseArray<T>(value: unknown, parse: (item: unknown) => T): T[] {
  if (!Array.isArray(value)) throw new Error("Goal storage returned an invalid collection");
  return value.map((item) => parse(item));
}

function requiredNumber(value: Record<string, unknown>, key: string): number {
  const result = value[key];
  if (typeof result !== "number") throw new Error(`Goal storage response is missing ${key}`);
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
