import assert from "node:assert/strict";
import { test } from "node:test";
import type { ModelDescriptor } from "@conduit/shared";
import { catalogNeedsMigration, normalizePersistedModelId } from "./model-catalog.ts";

test("legacy Kilo selections migrate without changing other provider IDs", () => {
  assert.equal(
    normalizePersistedModelId("kilo/kilo-auto/free"),
    "kilo/kilo/kilo-auto/free",
  );
  assert.equal(
    normalizePersistedModelId("kilo/~anthropic/claude-sonnet-latest"),
    "kilo/kilo/~anthropic/claude-sonnet-latest",
  );
  assert.equal(
    normalizePersistedModelId("kilo/kilo/kilo-auto/free"),
    "kilo/kilo/kilo-auto/free",
  );
  assert.equal(normalizePersistedModelId("codex/gpt-5.6"), "codex/gpt-5.6");
});

test("catalog migration detects only legacy Kilo descriptors", () => {
  const descriptor = (id: string, provider: string): ModelDescriptor => ({
    id,
    provider,
    displayName: id,
    supportsTools: true,
    supportsStructuredOutput: false,
  });
  assert.equal(catalogNeedsMigration([
    descriptor("codex/gpt-5.6", "codex"),
    descriptor("kilo/kilo/model", "kilo"),
  ]), false);
  assert.equal(catalogNeedsMigration([
    descriptor("kilo/kilo-auto/free", "kilo"),
  ]), true);
});
