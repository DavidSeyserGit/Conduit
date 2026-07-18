import type {
  CommandPermissionMode,
  EvidenceItem,
  EvidenceRequest,
  GoalDefinition,
  GoalPersistenceRepository,
} from "@conduit/shared";
import { EvidenceItemSchema, EvidenceRequestSchema, GoalDefinitionSchema } from "@conduit/shared";
import type { ToolExecutor, ToolCallResult } from "@conduit/tools";

const COMMAND_EVIDENCE = new Set<EvidenceRequest["type"]>([
  "command", "test", "build", "lint", "typecheck", "benchmark", "coverage", "static_analysis",
]);
const EXECUTION_EVIDENCE = new Set<EvidenceItem["type"]>([
  "command", "test", "build", "lint", "typecheck", "benchmark", "coverage", "static_analysis",
]);
const DEFAULT_TIMEOUT_MS = 2 * 60 * 1_000;
const DEFAULT_SUMMARY_LIMIT = 4_000;
const FORBIDDEN_COMMAND = /(?:^|\s)(?:sudo|rm\s+-rf?|mkfs|dd\s+if=|chmod|chown|curl|wget|ssh|scp|npm\s+install|pnpm\s+install|yarn\s+add|pip\s+install|cargo\s+install)(?:\s|$)|\.\.[/\\]|(?:^|\s)~[/\\]|[`]|\$\(|\|\s*(?:sh|bash)\b|>\s*\/dev\//i;

export interface EvidenceCollectionOptions {
  runId: string;
  goal: GoalDefinition;
  workspacePath: string;
  permissionMode: CommandPermissionMode;
  existingEvidence?: EvidenceItem[];
  signal?: AbortSignal;
  timeoutMs?: number;
  summaryLimit?: number;
  requestApproval?: (request: EvidenceRequest, command: string) => Promise<boolean>;
  onProgress?: (event: EvidenceProgressEvent) => void;
}

export type EvidenceProgressEvent =
  | { type: "request_updated"; request: EvidenceRequest }
  | { type: "evidence_reused"; request: EvidenceRequest; evidence: EvidenceItem }
  | { type: "evidence_collected"; request: EvidenceRequest; evidence: EvidenceItem };

export interface EvidenceCollectionResult {
  requests: EvidenceRequest[];
  evidence: EvidenceItem[];
  collected: EvidenceItem[];
  reused: EvidenceItem[];
}

export interface CollectionPlan {
  toolName: "run_command" | "read_file" | "search_files" | "get_git_diff";
  args: Record<string, unknown>;
  command?: string;
  filePath?: string;
}

export class EvidenceCoordinator {
  constructor(
    private tools: ToolExecutor,
    private persistence?: GoalPersistenceRepository,
  ) {}

  async collect(requests: EvidenceRequest[], options: EvidenceCollectionOptions): Promise<EvidenceCollectionResult> {
    GoalDefinitionSchema.parse(options.goal);
    const evidence = [...(options.existingEvidence ?? [])];
    const collected: EvidenceItem[] = [];
    const reused: EvidenceItem[] = [];
    const resolvedRequests: EvidenceRequest[] = [];

    for (const rawRequest of requests) {
      this.throwIfCancelled(options.signal);
      let request = EvidenceRequestSchema.parse({
        ...rawRequest,
        permissionDecision: rawRequest.permissionDecision ?? "pending",
        attempts: rawRequest.attempts ?? 0,
      });
      if (request.status === "rejected" || (request.status === "failed" && (request.attempts ?? 0) > 0)) {
        resolvedRequests.push(request);
        continue;
      }
      if ((request.type === "file" || (request.type === "dependency" && isLikelyFileReference(request.suggestedCommand?.trim() ?? "")))
        && request.suggestedCommand
        && !isWorkspaceRelativePath(request.suggestedCommand.trim())) {
        request = await this.updateRequest(options, {
          ...request,
          status: "rejected",
          permissionDecision: "rejected",
          attempts: (request.attempts ?? 0) + 1,
          lastAttemptAt: new Date().toISOString(),
          resolvedAt: new Date().toISOString(),
        });
        resolvedRequests.push(request);
        continue;
      }
      const plan = this.resolvePlan(request);
      const fingerprint = scopeFingerprint(request, plan);
      const reusable = evidence.find((item) =>
        item.type === request.type
        && item.freshness.status === "fresh"
        && item.freshness.scopeFingerprint === fingerprint
      );
      if (reusable) {
        request = await this.updateRequest(options, {
          ...request,
          status: "collected",
          permissionDecision: "not_required",
          evidenceIds: unique([...request.evidenceIds, reusable.id]),
          resolvedAt: new Date().toISOString(),
        });
        resolvedRequests.push(request);
        reused.push(reusable);
        options.onProgress?.({ type: "evidence_reused", request, evidence: reusable });
        continue;
      }

      if (request.type === "user_answer") {
        const answers = request.suggestedCommand
          ? options.goal.answers.filter((answer) => answer.questionId === request.suggestedCommand)
          : options.goal.answers;
        if (answers.length === 0) {
          request = await this.updateRequest(options, {
            ...request,
            status: "rejected",
            permissionDecision: "not_required",
            attempts: (request.attempts ?? 0) + 1,
            lastAttemptAt: new Date().toISOString(),
            resolvedAt: new Date().toISOString(),
          });
          resolvedRequests.push(request);
          continue;
        }
        const item = EvidenceItemSchema.parse({
          id: `evidence-${crypto.randomUUID()}`,
          type: "user_answer",
          title: evidenceTitle(request),
          summary: bounded(JSON.stringify(answers), options.summaryLimit ?? DEFAULT_SUMMARY_LIMIT),
          workspacePath: options.workspacePath,
          collectedBy: "goal_answer",
          collectedAt: new Date().toISOString(),
          trusted: true,
          freshness: { status: "fresh", scopeFingerprint: fingerprint },
        });
        evidence.push(item);
        collected.push(item);
        await this.persistence?.saveEvidence(options.runId, item);
        request = await this.updateRequest(options, {
          ...request,
          status: "collected",
          permissionDecision: "not_required",
          attempts: (request.attempts ?? 0) + 1,
          lastAttemptAt: item.collectedAt,
          evidenceIds: unique([...request.evidenceIds, item.id]),
          resolvedAt: item.collectedAt,
        });
        resolvedRequests.push(request);
        options.onProgress?.({ type: "evidence_collected", request, evidence: item });
        continue;
      }

      if (!plan) {
        request = await this.updateRequest(options, {
          ...request,
          status: "failed",
          permissionDecision: "not_required",
          attempts: (request.attempts ?? 0) + 1,
          lastAttemptAt: new Date().toISOString(),
          resolvedAt: new Date().toISOString(),
        });
        resolvedRequests.push(request);
        continue;
      }

      if (plan.command) {
        if (isForbiddenEvidenceCommand(plan.command)) {
          request = await this.updateRequest(options, {
            ...request,
            status: "rejected",
            permissionDecision: "rejected",
            attempts: (request.attempts ?? 0) + 1,
            lastAttemptAt: new Date().toISOString(),
            resolvedAt: new Date().toISOString(),
          });
          resolvedRequests.push(request);
          continue;
        }
        const needsApproval = options.permissionMode === "ask_every_time"
          || (options.permissionMode === "auto_approve_safe" && !isKnownSafeEvidenceCommand(plan.command));
        if (needsApproval) {
          const approved = options.requestApproval
            ? await options.requestApproval(request, plan.command)
            : false;
          this.throwIfCancelled(options.signal);
          if (!approved) {
            request = await this.updateRequest(options, {
              ...request,
              status: "rejected",
              permissionDecision: "rejected",
              resolvedAt: new Date().toISOString(),
            });
            resolvedRequests.push(request);
            continue;
          }
          request = await this.updateRequest(options, { ...request, status: "approved", permissionDecision: "approved" });
        } else {
          request = await this.updateRequest(options, { ...request, status: "approved", permissionDecision: "not_required" });
        }
      } else {
        request = await this.updateRequest(options, { ...request, status: "approved", permissionDecision: "not_required" });
      }

      const attemptedAt = new Date().toISOString();
      request = await this.updateRequest(options, {
        ...request,
        attempts: (request.attempts ?? 0) + 1,
        lastAttemptAt: attemptedAt,
      });
      let toolResult: ToolCallResult;
      try {
        toolResult = await withCancellationAndTimeout(
          this.tools.execute(plan.toolName, plan.args, "goal", {
            // The coordinator already validated policy and recorded any user
            // decision for this exact command, so the tool layer must not ask twice.
            permissionMode: "auto_approve_all",
            signal: options.signal,
            timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          }),
          options.signal,
          options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        );
      } catch (error) {
        request = await this.updateRequest(options, {
          ...request,
          status: "failed",
          resolvedAt: new Date().toISOString(),
        });
        resolvedRequests.push(request);
        if (options.signal?.aborted) throw error;
        continue;
      }
      this.throwIfCancelled(options.signal);
      if (!toolResult.success || toolResult.result === undefined) {
        request = await this.updateRequest(options, {
          ...request,
          status: "failed",
          resolvedAt: new Date().toISOString(),
        });
        resolvedRequests.push(request);
        continue;
      }

      const item = await this.normalizeEvidence(
        options.runId,
        options.workspacePath,
        request,
        plan,
        toolResult.result,
        fingerprint,
        options.summaryLimit ?? DEFAULT_SUMMARY_LIMIT,
      );
      evidence.push(item);
      collected.push(item);
      await this.persistence?.saveEvidence(options.runId, item);
      request = await this.updateRequest(options, {
        ...request,
        status: "collected",
        evidenceIds: unique([...request.evidenceIds, item.id]),
        resolvedAt: new Date().toISOString(),
      });
      resolvedRequests.push(request);
      options.onProgress?.({ type: "evidence_collected", request, evidence: item });
    }

    return { requests: resolvedRequests, evidence, collected, reused };
  }

  private resolvePlan(request: EvidenceRequest): CollectionPlan | undefined {
    if (COMMAND_EVIDENCE.has(request.type)) {
      const command = request.suggestedCommand?.trim();
      if (!command) return undefined;
      return { toolName: "run_command", args: { command }, command };
    }
    if (request.type === "file") {
      const filePath = request.suggestedCommand?.trim();
      if (!filePath || !isWorkspaceRelativePath(filePath)) return undefined;
      return { toolName: "read_file", args: { path: filePath, offset: 0, limit: 400 }, filePath };
    }
    if (request.type === "search") {
      const query = request.suggestedCommand?.trim();
      if (!query) return undefined;
      return { toolName: "search_files", args: { query, case_sensitive: false } };
    }
    if (request.type === "diff") return { toolName: "get_git_diff", args: {} };
    if (request.type === "dependency") {
      const suggestion = request.suggestedCommand?.trim();
      if (!suggestion) return { toolName: "get_git_diff", args: {} };
      if (isLikelyFileReference(suggestion)) {
        if (!isWorkspaceRelativePath(suggestion)) return undefined;
        return { toolName: "get_git_diff", args: { path: suggestion }, filePath: suggestion };
      }
      return { toolName: "run_command", args: { command: suggestion }, command: suggestion };
    }
    return undefined;
  }

  private async normalizeEvidence(
    runId: string,
    workspacePath: string,
    request: EvidenceRequest,
    plan: CollectionPlan,
    result: unknown,
    fingerprint: string,
    summaryLimit: number,
  ): Promise<EvidenceItem> {
    const collectedAt = new Date().toISOString();
    const normalized = normalizeToolResult(request, plan, result);
    const fullContent = typeof result === "string" ? result : JSON.stringify(result, null, 2);
    const artifact = fullContent.length > summaryLimit && this.persistence
      ? await this.persistence.writeArtifact(runId, fullContent, "text/plain")
      : undefined;
    return EvidenceItemSchema.parse({
      id: `evidence-${crypto.randomUUID()}`,
      type: request.type,
      title: evidenceTitle(request),
      summary: bounded(normalized.summary, summaryLimit),
      ...(normalized.command ? { command: normalized.command } : {}),
      ...(normalized.exitCode !== undefined ? { exitCode: normalized.exitCode } : {}),
      ...(normalized.durationMs !== undefined ? { durationMs: normalized.durationMs } : {}),
      workspacePath,
      ...(plan.filePath ? { filePath: plan.filePath } : {}),
      ...(artifact ? { artifactId: artifact.id, contentLocation: artifact.relativePath } : {}),
      collectedBy: "evidence_coordinator",
      collectedAt,
      trusted: normalized.trusted,
      freshness: { status: "fresh", scopeFingerprint: fingerprint },
    });
  }

  private async updateRequest(options: EvidenceCollectionOptions, request: EvidenceRequest): Promise<EvidenceRequest> {
    const parsed = EvidenceRequestSchema.parse(request);
    await this.persistence?.saveEvidenceRequest(options.runId, parsed);
    options.onProgress?.({ type: "request_updated", request: parsed });
    return parsed;
  }

  private throwIfCancelled(signal?: AbortSignal): void {
    if (signal?.aborted) throw new Error("Evidence collection cancelled");
  }
}

export function invalidateEvidence(
  items: EvidenceItem[],
  changedFiles: string[],
  now = new Date().toISOString(),
): EvidenceItem[] {
  if (changedFiles.length === 0) return items;
  const normalized = changedFiles.map((path) => path.toLowerCase());
  const documentationOnly = normalized.every(isDocumentationPath);
  const dependencyOrConfig = normalized.some(isDependencyOrConfigPath);
  const sourceChanged = normalized.some(isSourcePath);
  return items.map((item) => {
    if (item.freshness.status === "stale") return item;
    let reason: string | undefined;
    if (item.filePath && normalized.includes(item.filePath.toLowerCase())) {
      reason = `Referenced file changed: ${item.filePath}`;
    } else if (!documentationOnly && sourceChanged && EXECUTION_EVIDENCE.has(item.type)) {
      reason = "Source files changed after this execution evidence was collected";
    } else if (dependencyOrConfig && (EXECUTION_EVIDENCE.has(item.type) || item.type === "dependency")) {
      reason = "Dependency or configuration files changed after evidence collection";
    } else if (item.type === "diff" || item.type === "search") {
      reason = "Repository contents changed after this repository evidence was collected";
    }
    return reason ? EvidenceItemSchema.parse({
      ...item,
      freshness: { status: "stale", staleReason: reason, invalidatedAt: now, scopeFingerprint: item.freshness.scopeFingerprint },
    }) : item;
  });
}

export function scopeFingerprint(request: EvidenceRequest, plan?: CollectionPlan): string {
  const value = JSON.stringify({ type: request.type, tool: plan?.toolName, args: plan?.args, suggested: request.suggestedCommand, expected: request.expectedOutcome });
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `evidence:v1:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export function isForbiddenEvidenceCommand(command: string): boolean {
  return FORBIDDEN_COMMAND.test(command) || /[\r\n]/.test(command) || /(?:^|\s)(?:cd|--cwd)\s+["']?(?:\/|~|\.\.)/.test(command);
}

function isKnownSafeEvidenceCommand(command: string): boolean {
  return /^(?:pnpm|npm|yarn)\s+(?:test|run\s+(?:test|build|lint|typecheck|check|coverage|bench))\b/.test(command)
    || /^(?:cargo\s+(?:test|check|clippy|bench)|pytest\b|go\s+test\b|git\s+(?:diff|status)\b)/.test(command);
}

function isWorkspaceRelativePath(path: string): boolean {
  return Boolean(path)
    && !path.startsWith("/")
    && !path.startsWith("~")
    && !/^[A-Za-z]:[/\\]/.test(path)
    && !path.split(/[/\\]/).includes("..")
    && !path.includes("\0");
}

function isLikelyFileReference(value: string): boolean {
  return Boolean(value) && !/\s|[;&|`$()<>]/.test(value);
}

function normalizeToolResult(request: EvidenceRequest, plan: CollectionPlan, result: unknown): { summary: string; command?: string; exitCode?: number; durationMs?: number; trusted: boolean } {
  const record = isRecord(result) ? result : {};
  if (plan.toolName === "run_command") {
    const exitCode = typeof record.exitCode === "number" ? record.exitCode : undefined;
    const durationMs = typeof record.durationMs === "number" ? record.durationMs : undefined;
    const stdout = typeof record.stdout === "string" ? record.stdout.trim() : "";
    const stderr = typeof record.stderr === "string" ? record.stderr.trim() : "";
    return {
      summary: [
        `${plan.command} finished${exitCode !== undefined ? ` with exit code ${exitCode}` : " without a trustworthy exit code"}.`,
        stdout,
        stderr,
      ].filter(Boolean).join("\n"),
      command: plan.command,
      exitCode,
      durationMs,
      trusted: exitCode !== undefined,
    };
  }
  if (plan.toolName === "read_file") {
    const content = typeof record.content === "string" ? record.content : JSON.stringify(result);
    return { summary: `Collected file excerpt from ${plan.filePath}.\n${content}`, trusted: true };
  }
  if (plan.toolName === "search_files") {
    const matches = Array.isArray(record.matches) ? record.matches.length : undefined;
    return { summary: `Repository search completed${matches !== undefined ? ` with ${matches} match${matches === 1 ? "" : "es"}` : ""}.\n${JSON.stringify(result)}`, trusted: true };
  }
  return { summary: `${request.type} evidence collected.\n${JSON.stringify(result)}`, trusted: true };
}

async function withCancellationAndTimeout<T>(promise: Promise<T>, signal: AbortSignal | undefined, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let abortHandler: (() => void) | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error("Evidence collection timed out")), timeoutMs);
  });
  const abortPromise = new Promise<never>((_, reject) => {
    if (!signal) return;
    abortHandler = () => reject(new Error("Evidence collection cancelled"));
    if (signal.aborted) abortHandler();
    else signal.addEventListener("abort", abortHandler, { once: true });
  });
  try {
    return await Promise.race([promise, timeoutPromise, abortPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
    if (signal && abortHandler) signal.removeEventListener("abort", abortHandler);
  }
}

function evidenceTitle(request: EvidenceRequest): string {
  return `${request.type.replace(/_/g, " ")} evidence for ${request.reviewerId}`;
}
function bounded(value: string, limit: number): string {
  const trimmed = value.trim() || "Evidence was collected without textual output.";
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, Math.max(0, limit - 24))}\n… output stored separately`;
}
function isDocumentationPath(path: string): boolean { return /(?:^|\/)docs?(?:\/|$)|(?:^|\/)(?:readme|changelog)(?:\.[^/]*)?$|\.(?:md|mdx|rst)$/.test(path); }
function isDependencyOrConfigPath(path: string): boolean { return /(?:^|\/)(?:package\.json|.*lock|cargo\.toml|requirements[^/]*|pyproject\.toml|go\.mod|.*config\.[^/]+|tsconfig[^/]*)$/.test(path); }
function isSourcePath(path: string): boolean { return /\.(?:ts|tsx|js|jsx|rs|py|go|java|kt|rb|swift|c|cc|cpp|h|hpp)$/.test(path) && !isDocumentationPath(path); }
function unique<T>(values: T[]): T[] { return [...new Set(values)]; }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
