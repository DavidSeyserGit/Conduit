import { CgsArtifactUnionSchema, type CgsArtifactValue } from "@conduit/cgs";

/** Lossless persistence port; database projections remain adapter-private. */
export interface CgsArtifactRepository {
  saveCgsArtifact(artifact: CgsArtifactValue): Promise<void>;
  getCgsArtifact(id: string): Promise<CgsArtifactValue | null>;
}

export async function validatedCgsRead(repository: CgsArtifactRepository, id: string): Promise<CgsArtifactValue | null> {
  const value = await repository.getCgsArtifact(id);
  return value === null ? null : CgsArtifactUnionSchema.parse(value);
}
