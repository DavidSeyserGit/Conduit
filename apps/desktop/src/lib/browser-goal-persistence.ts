import type {
  EvidenceItem,
  EvidenceRequest,
  GoalAnswer,
  GoalDefinition,
  GoalDrivenRunRecord,
  GoalPersistenceRepository,
  GoalQuestion,
  GoalReport,
  GoalRunEvent,
  GoalRunSnapshot,
  GoalRunState,
  GoalVersion,
  GoalWorkflowEvent,
  ReviewResult,
} from "@conduit/shared";

interface BrowserGoalStorage {
  goals: Record<string, GoalDefinition>;
  versions: Record<string, GoalVersion[]>;
  questions: Record<string, GoalQuestion[]>;
  answers: Record<string, GoalAnswer[]>;
  runs: Record<string, GoalDrivenRunRecord | GoalRunState>;
  events: Record<string, Array<GoalWorkflowEvent | GoalRunEvent>>;
  reviews: Record<string, ReviewResult[]>;
  evidenceRequests: Record<string, EvidenceRequest[]>;
  evidence: Record<string, EvidenceItem[]>;
  reports: Record<string, GoalReport>;
  artifacts: Record<string, { runId: string; content: string; contentType: string; createdAt: string }>;
}

const STORAGE_KEY = "conduit-goal-runtime-browser-v1";

function emptyStorage(): BrowserGoalStorage {
  return { goals: {}, versions: {}, questions: {}, answers: {}, runs: {}, events: {}, reviews: {}, evidenceRequests: {}, evidence: {}, reports: {}, artifacts: {} };
}

/** Browser-development persistence with the same port as the native SQLite adapter. */
export class BrowserGoalPersistenceRepository implements GoalPersistenceRepository {
  private read(): BrowserGoalStorage {
    try {
      const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null") as BrowserGoalStorage | null;
      return parsed && parsed.goals && parsed.runs ? parsed : emptyStorage();
    } catch {
      return emptyStorage();
    }
  }

  private update(mutator: (storage: BrowserGoalStorage) => void): void {
    const storage = this.read();
    mutator(storage);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(storage));
  }

  async status() { return { available: true, schemaVersion: 1, databasePath: "browser-local-storage", artifactRoot: "browser-local-storage" }; }
  async saveGoal(goal: GoalDefinition) { this.update((storage) => { storage.goals[goal.id] = goal; }); }
  async saveGoalVersion(version: GoalVersion) {
    this.update((storage) => {
      storage.versions[version.goalId] = [...(storage.versions[version.goalId] ?? []).filter((item) => item.version !== version.version), version]
        .sort((a, b) => a.version - b.version);
    });
  }
  async replaceQuestions(goalId: string, goalVersion: number, questions: GoalQuestion[]) { this.update((storage) => { storage.questions[`${goalId}:${goalVersion}`] = questions; }); }
  async saveAnswer(goalId: string, answer: GoalAnswer) { this.update((storage) => { storage.answers[goalId] = [...(storage.answers[goalId] ?? []), answer]; }); }
  async saveRun(run: GoalDrivenRunRecord) { this.update((storage) => { storage.runs[run.id] = run; }); }
  async appendEvent(event: GoalWorkflowEvent) {
    let sequence = 0;
    this.update((storage) => {
      storage.events[event.runId] = [...(storage.events[event.runId] ?? []), event];
      sequence = storage.events[event.runId].length;
    });
    return sequence;
  }
  async saveReview(runId: string, review: ReviewResult) { this.update((storage) => { storage.reviews[runId] = [...(storage.reviews[runId] ?? []).filter((item) => item.id !== review.id), review]; }); }
  async saveEvidenceRequest(runId: string, request: EvidenceRequest) { this.update((storage) => { storage.evidenceRequests[runId] = [...(storage.evidenceRequests[runId] ?? []).filter((item) => item.id !== request.id), request]; }); }
  async saveEvidence(runId: string, evidence: EvidenceItem) { this.update((storage) => { storage.evidence[runId] = [...(storage.evidence[runId] ?? []).filter((item) => item.id !== evidence.id), evidence]; }); }
  async saveReport(report: GoalReport) { this.update((storage) => { storage.reports[report.runId] = report; }); }
  async deleteRun(runId: string) { this.update((storage) => { delete storage.runs[runId]; delete storage.events[runId]; delete storage.reviews[runId]; delete storage.evidenceRequests[runId]; delete storage.evidence[runId]; delete storage.reports[runId]; }); }
  async deleteGoal(goalId: string) { this.update((storage) => { delete storage.goals[goalId]; delete storage.versions[goalId]; delete storage.answers[goalId]; for (const key of Object.keys(storage.questions)) if (key.startsWith(`${goalId}:`)) delete storage.questions[key]; }); }
  async importLegacyRun(run: GoalRunState, events: GoalRunEvent[]) { this.update((storage) => { storage.runs[run.id] = run; storage.events[run.id] = events; }); }
  async getGoal(id: string) { return this.read().goals[id] ?? null; }
  async restoreRun(runId: string): Promise<GoalRunSnapshot | null> {
    const storage = this.read();
    const run = storage.runs[runId];
    if (!run) return null;
    const goalId = "goalId" in run ? run.goalId : undefined;
    return {
      run,
      goal: goalId ? storage.goals[goalId] ?? null : null,
      versions: goalId ? storage.versions[goalId] ?? [] : [],
      questions: goalId ? Object.entries(storage.questions).filter(([key]) => key.startsWith(`${goalId}:`)).flatMap(([, questions]) => questions) : [],
      answers: goalId ? storage.answers[goalId] ?? [] : [],
      events: storage.events[runId] ?? [],
      reviews: storage.reviews[runId] ?? [],
      findings: (storage.reviews[runId] ?? []).flatMap((review) => review.findings),
      evidenceRequests: storage.evidenceRequests[runId] ?? [],
      evidence: storage.evidence[runId] ?? [],
      report: storage.reports[runId] ?? null,
    };
  }
  async listRuns(phases?: string[]) {
    return Object.values(this.read().runs).filter((run) => !phases || !("workflowPhase" in run) || phases.includes(run.workflowPhase));
  }
  async writeArtifact(runId: string, content: string, contentType = "text/plain") {
    const id = `browser-artifact-${crypto.randomUUID()}`;
    const createdAt = new Date().toISOString();
    this.update((storage) => { storage.artifacts[id] = { runId, content, contentType, createdAt }; });
    return { id, runId, relativePath: id, sha256: "browser-development", size: content.length, contentType, createdAt };
  }
  async readArtifact(artifactId: string) {
    const artifact = this.read().artifacts[artifactId];
    if (!artifact) throw new Error(`Unknown browser artifact: ${artifactId}`);
    return {
      metadata: { id: artifactId, runId: artifact.runId, relativePath: artifactId, sha256: "browser-development", size: artifact.content.length, contentType: artifact.contentType, createdAt: artifact.createdAt },
      content: artifact.content,
    };
  }
  async cleanupArtifacts() { return 0; }
}
