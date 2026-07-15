import type { ModelDescriptor } from "@conduit/shared";

/**
 * Kilo previously exposed its native `kilo/<model>` ID directly. Canonical
 * application IDs now add a separate provider namespace: `kilo/kilo/<model>`.
 */
export function normalizePersistedModelId(modelId: string): string {
  if (modelId.startsWith("kilo/") && !modelId.startsWith("kilo/kilo/")) {
    return `kilo/${modelId}`;
  }
  return modelId;
}

export function catalogNeedsMigration(models: ModelDescriptor[]): boolean {
  return models.some(
    (model) => model.provider === "kilo" && normalizePersistedModelId(model.id) !== model.id,
  );
}
