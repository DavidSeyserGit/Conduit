import { z } from "zod";

export const CGS_VERSION = "0.1.0" as const;
export const CGS_MAJOR_VERSION = 0;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.string(), z.number().finite(), z.boolean(), z.null(),
  z.array(JsonValueSchema), z.record(JsonValueSchema),
]));

export const IdSchema = z.string().trim().min(1);
export const NonEmptyStringSchema = z.string().trim().min(1);
export const TimestampSchema = z.string().datetime({ offset: true });
export const CgsVersionSchema = z.literal(CGS_VERSION);

export const ArtifactKindSchema = z.enum([
  "goal", "question-batch", "answer-batch", "review-request", "review-result",
  "evidence-request", "evidence-artifact", "run", "report",
]);

export const CgsArtifactSchema = z.object({
  cgsVersion: CgsVersionSchema,
  kind: ArtifactKindSchema,
  id: IdSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema.optional(),
}).passthrough().superRefine((artifact, ctx) => {
  if (artifact.updatedAt && Date.parse(artifact.updatedAt) < Date.parse(artifact.createdAt)) {
    ctx.addIssue({ code: "custom", message: "updatedAt cannot precede createdAt", path: ["updatedAt"] });
  }
});

export const RepositoryPathSchema = NonEmptyStringSchema.superRefine((path, ctx) => {
  if (path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path) || path.includes("\\") || path.includes("\0")) {
    ctx.addIssue({ code: "custom", message: "Repository paths must be relative POSIX paths" });
  }
  if (path.split("/").some((part) => part === ".." || part === "." || part === "")) {
    ctx.addIssue({ code: "custom", message: "Repository paths must be normalized" });
  }
});

export const PermissionPathPatternSchema = NonEmptyStringSchema.superRefine((path, ctx) => {
  if (path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path) || path.includes("\\") || path.includes("\0") || path.split("/").includes("..")) {
    ctx.addIssue({ code: "custom", message: "Permission paths must be safe repository-relative patterns" });
  }
});

export type CgsArtifact = z.infer<typeof CgsArtifactSchema>;

export interface ValidationError {
  path: Array<string | number>;
  code: string;
  message: string;
}

export type ValidationResult<T = unknown> =
  | { valid: true; value: T; errors: [] }
  | { valid: false; errors: ValidationError[]; value?: undefined };
