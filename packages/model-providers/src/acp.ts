import type {
  ModelDescriptor,
  ModelRequest,
  ModelResponse,
  ModelStreamEvent,
  AcpAgentConfig,
} from "@conduit/shared";
import { ProviderError } from "@conduit/shared";
import type { ModelProvider } from "./provider.js";

/**
 * Experimental ACP (Agent Client Protocol) adapter.
 * ACP agents run their own internal loop; this adapter bridges
 * ACP sessions to Conduit's goal loop as an alternative coding backend.
 */
export class ACPAgentProvider implements ModelProvider {
  readonly id = "acp";
  readonly name = "ACP Agent (Experimental)";

  constructor(private agents: AcpAgentConfig[] = []) {}

  updateAgents(agents: AcpAgentConfig[]): void {
    this.agents = agents;
  }

  async listModels(): Promise<ModelDescriptor[]> {
    return this.agents.map((agent) => ({
      id: `acp/${agent.id}`,
      provider: "acp",
      displayName: `${agent.name} (ACP)`,
      supportsTools: false,
      supportsStructuredOutput: false,
    }));
  }

  async createResponse(request: ModelRequest): Promise<ModelResponse> {
    const agentId = request.modelId.startsWith("acp/")
      ? request.modelId.slice("acp/".length)
      : request.modelId;

    const agent = this.agents.find((a) => a.id === agentId);
    if (!agent) {
      throw new ProviderError(`ACP agent not found: ${agentId}`);
    }

    // ACP integration stub: in production this would spawn the agent process,
    // establish a session, send the goal, and collect streamed events.
    throw new ProviderError(
      `ACP agent "${agent.name}" integration is experimental and not yet fully implemented. ` +
        `Configure the agent command: ${agent.command} ${(agent.args ?? []).join(" ")}`,
      true
    );
  }

  async streamResponse(
    request: ModelRequest,
    onEvent: (event: ModelStreamEvent) => void
  ): Promise<ModelResponse> {
    onEvent({
      type: "error",
      error: "ACP streaming is experimental and not yet implemented",
    });
    return this.createResponse(request);
  }
}

export interface AcpSessionEvent {
  type: "started" | "message" | "tool_call" | "completed" | "error";
  content?: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  toolResult?: unknown;
  error?: string;
}

/**
 * Future ACP session manager for when full integration is implemented.
 */
export class AcpSessionManager {
  private activeSessions = new Map<string, AbortController>();

  async startSession(
    _agent: AcpAgentConfig,
    _goal: string,
    _workspacePath: string,
    onEvent: (event: AcpSessionEvent) => void
  ): Promise<{ sessionId: string; result: ModelResponse }> {
    const sessionId = crypto.randomUUID();
    const controller = new AbortController();
    this.activeSessions.set(sessionId, controller);

    onEvent({ type: "started" });

    // Placeholder for ACP protocol implementation
    onEvent({
      type: "error",
      error: "ACP session management is not yet implemented",
    });

    this.activeSessions.delete(sessionId);

    return {
      sessionId,
      result: {
        content: "",
        finishReason: "error",
      },
    };
  }

  cancelSession(sessionId: string): void {
    const controller = this.activeSessions.get(sessionId);
    if (controller) {
      controller.abort();
      this.activeSessions.delete(sessionId);
    }
  }
}
