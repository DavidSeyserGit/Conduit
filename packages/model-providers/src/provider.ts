import type {
  ModelDescriptor,
  ModelRequest,
  ModelResponse,
  ModelStreamEvent,
} from "@conduit/shared";

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

export interface LocalHarnessCapabilities {
  supportsAsk: boolean;
  supportsGoal: boolean;
  supportsJudge: boolean;
  streamsToolEvents: boolean;
}

/** Shared contract for local CLI harnesses such as Codex and Kilo. */
export abstract class LocalHarnessProvider implements ModelProvider {
  abstract readonly id: string;
  abstract readonly name: string;
  readonly kind = "local-harness" as const;
  readonly capabilities: LocalHarnessCapabilities = {
    supportsAsk: false,
    supportsGoal: true,
    supportsJudge: true,
    streamsToolEvents: true,
  } as const;

  abstract listModels(): Promise<ModelDescriptor[]>;

  async createResponse(_request: ModelRequest): Promise<ModelResponse> {
    throw new Error(`${this.name} is executed by the local harness backend`);
  }

  async streamResponse(
    _request: ModelRequest,
    _onEvent: (event: ModelStreamEvent) => void
  ): Promise<ModelResponse> {
    throw new Error(`${this.name} streaming is handled by the local harness backend`);
  }
}

export interface ProviderRegistry {
  register(provider: ModelProvider): void;
  unregister(id: string): void;
  get(id: string): ModelProvider | undefined;
  list(): ModelProvider[];
  listAllModels(): Promise<ModelDescriptor[]>;
}

export class DefaultProviderRegistry implements ProviderRegistry {
  private providers = new Map<string, ModelProvider>();

  register(provider: ModelProvider): void {
    this.providers.set(provider.id, provider);
  }

  unregister(id: string): void {
    this.providers.delete(id);
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
  // ModelProvider requests use the canonical namespaced ID. Each provider is
  // responsible for translating that ID to its own runtime/API representation.
  const providers = registry.list();
  for (const provider of providers) {
    if (modelId.startsWith(`${provider.id}/`)) {
      return { provider, modelId };
    }
  }

  // Never guess. Persisted IDs are migrated at the catalog boundary; an
  // unknown namespace must fail before a request reaches the wrong provider.
  return undefined;
}
