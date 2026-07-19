import {
  parseReviewResult, validateReviewAgainstRequest,
  type EvidenceArtifact, type GoalSpecification, type ReviewRequest, type ReviewResult,
} from "@conduit/cgs";

export const BUILT_IN_REVIEWER_IDS = [
  "conduit.general", "conduit.testing", "conduit.security", "conduit.code-quality",
  "conduit.architecture", "conduit.documentation", "conduit.performance",
] as const;

export interface ReviewerExecutionContext {
  goal: GoalSpecification;
  availableEvidence: EvidenceArtifact[];
  signal?: AbortSignal;
}

export interface Reviewer {
  readonly id: string;
  readonly version: string;
  review(request: ReviewRequest, context: ReviewerExecutionContext): Promise<ReviewResult>;
}

/** Runtime registry for built-in and future externally supplied CGS reviewers. */
export class CgsReviewerRegistry {
  private reviewers = new Map<string, Reviewer>();

  register(reviewer: Reviewer): this {
    if (!reviewer.id.trim()) throw new Error("Reviewer ID is required");
    if (!reviewer.version.trim()) throw new Error(`Reviewer ${reviewer.id} has no version`);
    if (this.reviewers.has(reviewer.id)) throw new Error(`Reviewer already registered: ${reviewer.id}`);
    this.reviewers.set(reviewer.id, reviewer);
    return this;
  }

  get(id: string): Reviewer | undefined { return this.reviewers.get(id); }
  ids(): string[] { return [...this.reviewers.keys()]; }

  async review(request: ReviewRequest, context: ReviewerExecutionContext): Promise<ReviewResult> {
    const reviewer = this.get(request.reviewerId);
    if (!reviewer) throw new Error(`Reviewer is not registered: ${request.reviewerId}`);
    const result = parseReviewResult(await reviewer.review(request, context));
    const validation = validateReviewAgainstRequest(result, request, context.goal);
    if (!validation.valid) throw new Error(validation.errors.map((error) => error.message).join("; "));
    return result;
  }
}
