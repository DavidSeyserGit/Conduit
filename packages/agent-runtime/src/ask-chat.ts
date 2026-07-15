import type {
  ChatMessage,
  ModelMessage,
  TokenUsage,
} from "@conduit/shared";
import type { ToolExecutor } from "@conduit/tools";
import type { ModelProvider } from "@conduit/model-providers";
import { getToolDefinitions } from "@conduit/tools";
import { ASK_MODE_SYSTEM_PROMPT } from "./prompts.js";
import { accumulateTokenUsage } from "./state.js";

export interface AskChatConfig {
  workspacePath: string;
  modelId: string;
  provider: ModelProvider;
  toolExecutor: ToolExecutor;
  messages: ChatMessage[];
  userMessage: string;
  onStream?: (content: string) => void;
  signal?: AbortSignal;
}

export interface AskChatResult {
  message: ChatMessage;
  tokenUsage?: TokenUsage;
}

const MAX_TOOL_ROUNDS = 15;

export class AskChatRunner {
  async run(config: AskChatConfig): Promise<AskChatResult> {
    const tools = getToolDefinitions("ask");
    const modelMessages: ModelMessage[] = [
      { role: "system", content: ASK_MODE_SYSTEM_PROMPT },
      ...config.messages.map((m) => ({
        role: m.role as ModelMessage["role"],
        content: m.content,
      })),
      { role: "user" as const, content: config.userMessage },
    ];

    let totalUsage: TokenUsage | undefined;
    let finalContent = "";
    let toolRounds = 0;

    while (toolRounds < MAX_TOOL_ROUNDS) {
      if (config.signal?.aborted) break;
      toolRounds++;
      let streamedUsage: TokenUsage | undefined;

      const response = await config.provider.streamResponse(
        {
          modelId: config.modelId,
          workspacePath: config.workspacePath,
          signal: config.signal,
          messages: modelMessages,
          tools,
          temperature: 0.3,
          maxTokens: 8192,
        },
        (event) => {
          if (event.type === "content_delta" && event.content) {
            finalContent += event.content;
            config.onStream?.(event.content);
          }
          if (event.usage) {
            streamedUsage = event.usage;
          }
        }
      );

      const roundUsage = response.usage ?? streamedUsage;
      if (roundUsage) {
        totalUsage = accumulateTokenUsage(totalUsage, roundUsage);
      }

      if (!response.toolCalls || response.toolCalls.length === 0) {
        if (response.content && !finalContent) {
          finalContent = response.content;
        }
        break;
      }

      modelMessages.push({
        role: "assistant",
        content: response.content,
        toolCalls: response.toolCalls,
      });

      for (const tc of response.toolCalls) {
        const result = await config.toolExecutor.execute(tc.name, tc.arguments, "ask");
        modelMessages.push({
          role: "tool",
          content: JSON.stringify(
            result.success ? result.result : { error: result.error }
          ),
          toolCallId: tc.id,
        });
      }
    }

    return {
      message: {
        id: crypto.randomUUID(),
        role: "assistant",
        content: finalContent,
        timestamp: new Date().toISOString(),
      },
      tokenUsage: totalUsage,
    };
  }
}
