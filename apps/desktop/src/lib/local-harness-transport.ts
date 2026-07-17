import { Channel, invoke } from "@tauri-apps/api/core";
import type {
  CodingIterationRequest,
  CodingIterationResult,
  LocalHarnessTransport,
} from "@conduit/model-providers";
import type {
  GoalRunEvent,
  ModelRequest,
  ModelResponse,
  ModelStreamEvent,
} from "@conduit/shared";

type InvokeFn = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
interface EventChannel<T> { onmessage: ((message: T) => void) | null }
type ChannelFactory = <T>() => EventChannel<T>;

/** IPC adapter used by the packaged application; no localhost server required. */
export class TauriLocalHarnessTransport implements LocalHarnessTransport {
  constructor(
    private readonly invokeCommand: InvokeFn = invoke,
    private readonly createChannel: ChannelFactory = <T>() => new Channel<T>(),
  ) {}

  async listModels(providerId: "codex" | "kilo" | "kimi"): Promise<unknown[]> {
    return this.invokeCommand<unknown[]>("local_harness_models", { providerId });
  }

  async createResponse(
    providerId: "codex" | "kilo" | "kimi",
    request: ModelRequest,
    onEvent: (event: ModelStreamEvent) => void,
  ): Promise<ModelResponse> {
    return this.invokeCancellable<ModelResponse, ModelStreamEvent>(
      "local_harness_response",
      providerId,
      serializableModelRequest(request),
      request.signal,
      onEvent,
    );
  }

  async runCodingIteration(
    providerId: "codex" | "kilo" | "kimi",
    request: CodingIterationRequest,
    onEvent: (event: GoalRunEvent) => void,
  ): Promise<CodingIterationResult> {
    return this.invokeCancellable<CodingIterationResult, GoalRunEvent>(
      "local_harness_coding_iteration",
      providerId,
      {
        goal: request.goal,
        workspacePath: request.workspacePath,
        modelId: request.modelId,
        previousPlan: request.previousPlan,
        judgeFeedback: request.judgeFeedback,
        iteration: request.iteration,
        maxIterations: request.maxIterations,
        reasoningEffort: request.reasoningEffort,
        permissionMode: request.permissionMode,
      },
      request.signal,
      onEvent,
    );
  }

  private async invokeCancellable<TResult, TEvent>(
    command: string,
    providerId: "codex" | "kilo" | "kimi",
    request: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onEvent: (event: TEvent) => void,
  ): Promise<TResult> {
    if (signal?.aborted) throw new DOMException("This operation was aborted", "AbortError");
    const requestId = crypto.randomUUID();
    const channel = this.createChannel<TEvent>();
    channel.onmessage = onEvent;
    const cancel = () => {
      void this.invokeCommand("local_harness_cancel", { requestId }).catch(() => {});
    };
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      return await this.invokeCommand<TResult>(command, {
        providerId,
        requestId,
        request,
        onEvent: channel,
      });
    } catch (error) {
      if (signal?.aborted) throw new DOMException("This operation was aborted", "AbortError");
      throw error;
    } finally {
      signal?.removeEventListener("abort", cancel);
      channel.onmessage = null;
    }
  }
}

function serializableModelRequest(request: ModelRequest): Record<string, unknown> {
  return {
    workspacePath: request.workspacePath,
    modelId: request.modelId,
    reasoningEffort: request.reasoningEffort,
    messages: request.messages,
    structuredOutput: request.structuredOutput,
    temperature: request.temperature,
    maxTokens: request.maxTokens,
  };
}
