import type { ModelDescriptor, QualityLaneDefault, QualityLaneId } from "@conduit/shared";
import { isRecommendedJudgeModel } from "@conduit/agent-runtime";

export interface ResolvedQualityLane {
  id: QualityLaneId;
  title: string;
  description: string;
  iterations: number;
  codingModelId: string;
  judgeModelId: string;
}

export const QUALITY_LANE_META: Record<QualityLaneId, Pick<ResolvedQualityLane, "title" | "description">> = {
  fast: { title: "Fast draft", description: "Lowest-cost worker, quick review" },
  confidence: { title: "Ship confidently", description: "A capable worker with independent review" },
  deep: { title: "Deep review", description: "Strong review with more repair cycles" },
};

export function resolveQualityLanes(
  models: ModelDescriptor[],
  defaults: Partial<Record<QualityLaneId, QualityLaneDefault>> | undefined,
  defaultCodingModelId?: string,
  defaultJudgeModelId?: string,
): ResolvedQualityLane[] {
  const workers = models.filter((model) => model.supportsTools && model.supportsGoal !== false);
  const judges = models.filter((model) => model.supportsJudge !== false);
  if (!workers.length || !judges.length) return [];

  const baselineWorker = configuredWorker(defaultCodingModelId, workers) ?? [...workers].sort(compareByQuality)[0];
  const baselineJudge = configuredJudge(defaultJudgeModelId, judges) ?? pickJudge(judges, baselineWorker.id, "confidence");

  return (Object.keys(QUALITY_LANE_META) as QualityLaneId[]).map((id) => {
    const setting = defaults?.[id];
    const worker = configuredWorker(setting?.codingModelId, workers)
      ?? (id === "fast" ? [...workers].sort(compareByPrice)[0] : baselineWorker);
    const judge = configuredJudge(setting?.judgeModelId, judges)
      ?? (id === "fast" ? pickJudge(judges, worker.id, "fast") : id === "deep" ? pickJudge(judges, worker.id, "deep") : baselineJudge);
    return {
      id,
      ...QUALITY_LANE_META[id],
      iterations: clampIterations(setting?.maxIterations ?? (id === "fast" ? 2 : id === "confidence" ? 3 : 5)),
      codingModelId: worker.id,
      judgeModelId: judge.id,
    };
  });
}

export function clampIterations(value: number): number {
  return Math.min(10, Math.max(1, value));
}

function configuredWorker(id: string | undefined, workers: ModelDescriptor[]): ModelDescriptor | undefined {
  return workers.find((model) => model.id === id);
}

function configuredJudge(id: string | undefined, judges: ModelDescriptor[]): ModelDescriptor | undefined {
  return judges.find((model) => model.id === id);
}

function pickJudge(models: ModelDescriptor[], workerId: string, kind: "fast" | "confidence" | "deep"): ModelDescriptor {
  const independent = models.filter((model) => model.id !== workerId);
  const candidates = independent.length ? independent : models;
  return [...candidates].sort(kind === "fast" ? compareByPrice : (a, b) => compareByQuality(a, b, workerId))[0]!;
}

function compareByPrice(a: ModelDescriptor, b: ModelDescriptor): number {
  return modelPrice(a) - modelPrice(b) || a.displayName.localeCompare(b.displayName);
}

function compareByQuality(a: ModelDescriptor, b: ModelDescriptor, workerId = ""): number {
  return qualityScore(b, workerId) - qualityScore(a, workerId) || a.displayName.localeCompare(b.displayName);
}

function modelPrice(model: ModelDescriptor): number {
  if (model.inputPrice === undefined && model.outputPrice === undefined) return 10_000;
  return (model.inputPrice ?? 0) + (model.outputPrice ?? 0);
}

function qualityScore(model: ModelDescriptor, workerId: string): number {
  const label = `${model.displayName} ${model.id}`.toLowerCase();
  let score = 0;
  if (workerId && isRecommendedJudgeModel(workerId, model.id)) score += 100;
  if (/opus|gpt-5|terra|luna|sonnet|pro|max|codex/.test(label)) score += 30;
  if (model.supportsReasoning) score += 10;
  if (model.contextLength) score += Math.min(10, model.contextLength / 100_000);
  return score;
}
