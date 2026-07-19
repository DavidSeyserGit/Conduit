import type {
  EvidenceItem,
  EvidenceRequest,
  GoalAnswer,
  GoalDefinition,
  GoalDrivenRunRecord,
  GoalQuestion,
  GoalReport,
  GoalVersion,
  GoalWorkflowEvent,
  ReviewFinding,
  ReviewResult,
} from "@conduit/cgs/legacy";
import type { GoalRunEvent, GoalRunState } from "./schemas.js";

export interface GoalStorageStatus {
  available: boolean;
  schemaVersion?: number;
  databasePath?: string;
  artifactRoot?: string;
  error?: string;
}

export interface GoalArtifactMetadata {
  id: string;
  runId: string;
  relativePath: string;
  sha256: string;
  size: number;
  contentType: string;
  createdAt: string;
}

export interface GoalArtifactContent {
  metadata: GoalArtifactMetadata;
  content: string;
}

export interface GoalRunSnapshot {
  run: GoalDrivenRunRecord | GoalRunState;
  goal: GoalDefinition | null;
  versions: GoalVersion[];
  questions: GoalQuestion[];
  answers: GoalAnswer[];
  events: Array<GoalWorkflowEvent | GoalRunEvent>;
  reviews: ReviewResult[];
  findings: ReviewFinding[];
  evidenceRequests: EvidenceRequest[];
  evidence: EvidenceItem[];
  report: GoalReport | null;
}

/** Provider-neutral persistence port used by the runtime and desktop adapters. */
export interface GoalPersistenceRepository {
  status(): Promise<GoalStorageStatus>;
  saveGoal(goal: GoalDefinition): Promise<void>;
  saveGoalVersion(version: GoalVersion): Promise<void>;
  replaceQuestions(goalId: string, goalVersion: number, questions: GoalQuestion[]): Promise<void>;
  saveAnswer(goalId: string, answer: GoalAnswer): Promise<void>;
  saveRun(run: GoalDrivenRunRecord): Promise<void>;
  appendEvent(event: GoalWorkflowEvent): Promise<number>;
  saveReview(runId: string, review: ReviewResult): Promise<void>;
  saveEvidenceRequest(runId: string, request: EvidenceRequest): Promise<void>;
  saveEvidence(runId: string, evidence: EvidenceItem): Promise<void>;
  saveReport(report: GoalReport): Promise<void>;
  deleteRun(runId: string): Promise<void>;
  deleteGoal(goalId: string): Promise<void>;
  importLegacyRun(run: GoalRunState, events: GoalRunEvent[]): Promise<void>;
  getGoal(id: string): Promise<GoalDefinition | null>;
  restoreRun(runId: string): Promise<GoalRunSnapshot | null>;
  listRuns(phases?: string[]): Promise<Array<GoalDrivenRunRecord | GoalRunState>>;
  writeArtifact(runId: string, content: string, contentType?: string): Promise<GoalArtifactMetadata>;
  readArtifact(artifactId: string): Promise<GoalArtifactContent>;
  cleanupArtifacts(olderThanSeconds?: number): Promise<number>;
}
