import assert from "node:assert/strict";
import { test } from "node:test";
import type { ModelProvider } from "./provider.ts";
import { DefaultProviderRegistry, findProviderForModel } from "./provider.ts";

function provider(id: string): ModelProvider {
  return {
    id,
    name: id,
    listModels: async () => [],
    createResponse: async () => ({ content: "" }),
    streamResponse: async () => ({ content: "" }),
  };
}

test("provider routing uses a complete namespace segment and preserves canonical IDs", () => {
  const registry = new DefaultProviderRegistry();
  const kilo = provider("kilo");
  const codex = provider("codex");
  registry.register(kilo);
  registry.register(codex);

  assert.deepEqual(findProviderForModel(registry, "kilo/kilo/model"), {
    provider: kilo,
    modelId: "kilo/kilo/model",
  });
  assert.deepEqual(findProviderForModel(registry, "codex/gpt"), {
    provider: codex,
    modelId: "codex/gpt",
  });
  assert.equal(findProviderForModel(registry, "kilobyte/model"), undefined);
  assert.equal(findProviderForModel(registry, "unknown/model"), undefined);
});

test("provider registry replacement is deterministic", () => {
  const registry = new DefaultProviderRegistry();
  const first = provider("kilo");
  const replacement = provider("kilo");
  registry.register(first);
  registry.register(replacement);

  assert.equal(registry.list().length, 1);
  assert.equal(registry.get("kilo"), replacement);
});

test("a single registered provider does not receive unknown legacy IDs", () => {
  const registry = new DefaultProviderRegistry();
  registry.register(provider("codex"));

  assert.equal(findProviderForModel(registry, "gpt-5.6"), undefined);
  assert.equal(findProviderForModel(registry, "kilo/model"), undefined);
});
