// Model calls should feel interactive. If a provider has produced no result
// within a minute, treat the attempt as stale and retry it with a fresh signal.
// Command and evidence execution use their own, task-appropriate timeouts.
export const DEFAULT_MODEL_ATTEMPT_TIMEOUT_MS = 60_000;
export const DEFAULT_MODEL_MAX_ATTEMPTS = 2;

export interface ModelOperationOptions {
  label: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxAttempts?: number;
  onRetry?: (retry: { attempt: number; maxAttempts: number; reason: string }) => void;
}

export class ModelOperationExhaustedError extends Error {
  constructor(
    readonly label: string,
    readonly attempts: number,
    readonly reason: string,
  ) {
    super(`${label} did not complete after ${attempts} attempts: ${reason}`);
    this.name = "ModelOperationExhaustedError";
  }
}

/**
 * Run a model operation with an attempt-scoped timeout. A timeout aborts only
 * the current provider request and starts a fresh attempt; user cancellation
 * always stops immediately and is never retried.
 */
export async function retryModelOperation<T>(
  operation: (signal: AbortSignal, attempt: number) => Promise<T>,
  options: ModelOperationOptions,
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_MODEL_ATTEMPT_TIMEOUT_MS;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MODEL_MAX_ATTEMPTS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("Model attempt timeout must be positive");
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new Error("Model max attempts must be a positive integer");

  let lastReason = "unknown provider error";
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (options.signal?.aborted) throw cancelledError(options.label);
    const attemptController = new AbortController();
    const timeoutId = setTimeout(() => attemptController.abort(), timeoutMs);
    const signal = options.signal
      ? AbortSignal.any([options.signal, attemptController.signal])
      : attemptController.signal;
    try {
      return await operation(signal, attempt);
    } catch (error) {
      if (options.signal?.aborted) throw cancelledError(options.label);
      const timedOut = attemptController.signal.aborted;
      if (!timedOut && !isRetryableModelError(error)) throw error;
      lastReason = timedOut
        ? `attempt timed out after ${formatDuration(timeoutMs)}`
        : conciseError(error);
      if (attempt === maxAttempts) break;
      options.onRetry?.({ attempt: attempt + 1, maxAttempts, reason: lastReason });
    } finally {
      clearTimeout(timeoutId);
    }
  }
  throw new ModelOperationExhaustedError(options.label, maxAttempts, lastReason);
}

export function isRetryableModelError(error: unknown): boolean {
  const message = conciseError(error);
  return /timed?\s*out|timeout|temporar(?:y|ily)|network|fetch failed|load failed|socket|econnreset|econnrefused|429|502|503|504|rate.?limit|service unavailable/i.test(message);
}

function cancelledError(label: string): Error {
  return new Error(`${label} cancelled`);
}

function conciseError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatDuration(timeoutMs: number): string {
  if (timeoutMs < 60_000) return `${Math.max(1, Math.round(timeoutMs / 1_000))} seconds`;
  const minutes = Math.round(timeoutMs / 60_000);
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}
