import {
  CGS_VERSION, EvidenceArtifactSchema, parseEvidenceRequest,
  type EvidenceArtifact, type EvidenceRequest, type GoalPermissions, type RepositoryStateReference,
} from "@conduit/cgs";

const COMMAND_TYPES = new Set<EvidenceRequest["type"]>(["command", "test", "build", "lint", "benchmark", "coverage"]);
const CODE_DEPENDENT_TYPES = new Set<EvidenceArtifact["type"]>(["command_result", "test_result", "build_result", "lint_result", "benchmark_result", "coverage_result", "dependency_report", "git_diff"]);

export interface EvidenceContext {
  permissions: GoalPermissions;
  repositoryState?: RepositoryStateReference;
  signal?: AbortSignal;
  authorize?: (request: EvidenceRequest) => Promise<boolean>;
}

export interface EvidenceExecutionAdapter {
  execute(request: EvidenceRequest, context: EvidenceContext): Promise<EvidenceArtifact>;
}

/** Executes reviewer requests only through an injected permission/tool adapter. */
export class EvidenceCoordinator {
  constructor(private adapter: EvidenceExecutionAdapter) {}

  async collect(input: EvidenceRequest, context: EvidenceContext): Promise<EvidenceArtifact> {
    const request = parseEvidenceRequest(input);
    if (context.signal?.aborted) throw new Error("Evidence collection cancelled");
    if (COMMAND_TYPES.has(request.type) && !context.permissions.allowCommandExecution) return unavailable(request, "Command execution is outside the approved goal permissions", context.repositoryState);
    if (COMMAND_TYPES.has(request.type) && context.authorize && !await context.authorize(request)) return unavailable(request, "User denied the evidence operation", context.repositoryState);
    const artifact = EvidenceArtifactSchema.parse(await this.adapter.execute(request, context));
    if (artifact.requestId !== request.id || artifact.runId !== request.runId || artifact.goalId !== request.goalId) throw new Error("Evidence artifact does not match its request");
    return artifact;
  }
}

export function invalidateEvidenceAfterImplementation(artifacts: EvidenceArtifact[], reason = "Implementation changed after evidence collection"): EvidenceArtifact[] {
  return artifacts.map((artifact) => CODE_DEPENDENT_TYPES.has(artifact.type)
    ? EvidenceArtifactSchema.parse({ ...artifact, stale: true, updatedAt: new Date().toISOString(), staleReason: reason })
    : artifact);
}

function unavailable(request: EvidenceRequest, summary: string, repositoryState?: RepositoryStateReference): EvidenceArtifact {
  const timestamp = new Date().toISOString();
  return EvidenceArtifactSchema.parse({
    cgsVersion: CGS_VERSION, kind: "evidence-artifact", id: `evidence_${crypto.randomUUID()}`, createdAt: timestamp,
    runId: request.runId, goalId: request.goalId, requestId: request.id, type: artifactType(request.type), status: "unavailable",
    summary, payload: { reason: summary }, repositoryState, producedAt: timestamp,
  });
}

function artifactType(type: EvidenceRequest["type"]): EvidenceArtifact["type"] {
  if (type === "test") return "test_result"; if (type === "build") return "build_result"; if (type === "lint") return "lint_result";
  if (type === "benchmark") return "benchmark_result"; if (type === "coverage") return "coverage_result"; if (type === "file_excerpt") return "file_excerpt";
  if (type === "dependency_analysis") return "dependency_report"; if (type === "git_diff") return "git_diff"; if (type === "user_confirmation") return "user_answer";
  return "command_result";
}
