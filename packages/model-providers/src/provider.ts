import type {
  ModelDescriptor,
  ModelRequest,
  ModelResponse,
  ModelStreamEvent,
} from "@loopkit/shared";

export interface ModelProvider {
  readonly id: string;
  readonly name: string;

  listModels(): Promise<ModelDescriptor[]>;

  createResponse(request: ModelRequest): Promise<ModelResponse>;

  streamResponse(
    request: ModelRequest,
    onEvent: (event: ModelStreamEvent) => void
  ): Promise<ModelResponse>;
}

export interface ProviderRegistry {
  register(provider: ModelProvider): void;
  get(id: string): ModelProvider | undefined;
  list(): ModelProvider[];
  listAllModels(): Promise<ModelDescriptor[]>;
}

export class DefaultProviderRegistry implements ProviderRegistry {
  private providers = new Map<string, ModelProvider>();

  register(provider: ModelProvider): void {
    this.providers.set(provider.id, provider);
  }

  get(id: string): ModelProvider | undefined {
    return this.providers.get(id);
  }

  list(): ModelProvider[] {
    return Array.from(this.providers.values());
  }

  async listAllModels(): Promise<ModelDescriptor[]> {
    const all: ModelDescriptor[] = [];
    for (const provider of this.providers.values()) {
      try {
        const models = await provider.listModels();
        all.push(...models);
      } catch {
        // skip unavailable providers
      }
    }
    return all;
  }
}

export function findProviderForModel(
  registry: ProviderRegistry,
  modelId: string
): { provider: ModelProvider; modelId: string } | undefined {
  // Direct provider prefix match: openrouter/..., acp/...
  for (const provider of registry.list()) {
    if (modelId.startsWith(`${provider.id}/`)) {
      return { provider, modelId: modelId.slice(provider.id.length + 1) };
    }
  }

  // Try each provider with the full model ID
  for (const provider of registry.list()) {
    return { provider, modelId };
  }

  return undefined;
}
