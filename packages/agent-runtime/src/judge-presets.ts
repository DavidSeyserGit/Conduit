import type { JudgePreset } from "@conduit/shared";

export const JUDGE_PRESETS: JudgePreset[] = [
  {
    id: "claude-gpt4o",
    name: "Claude writes, GPT-4o judges",
    description: "Claude Sonnet for coding, GPT-4o for independent evaluation",
    codingModelPattern: "anthropic/claude-sonnet",
    judgeModelPattern: "openai/gpt-4o",
    recommended: true,
  },
  {
    id: "gpt4o-claude",
    name: "GPT-4o writes, Claude judges",
    description: "GPT-4o for coding, Claude Sonnet for independent evaluation",
    codingModelPattern: "openai/gpt-4o",
    judgeModelPattern: "anthropic/claude-sonnet",
    recommended: true,
  },
  {
    id: "codex-claude",
    name: "Codex writes, Claude judges",
    description: "Use ChatGPT subscription for coding, Claude for judging",
    codingModelPattern: "codex/",
    judgeModelPattern: "anthropic/claude",
    recommended: true,
  },
  {
    id: "deepseek-gpt4o",
    name: "DeepSeek writes, GPT-4o judges",
    description: "DeepSeek for cost-effective coding, GPT-4o for evaluation",
    codingModelPattern: "deepseek/",
    judgeModelPattern: "openai/gpt-4o",
    recommended: false,
  },
  {
    id: "qwen-claude",
    name: "Qwen writes, Claude judges",
    description: "Qwen for coding, Claude for evaluation",
    codingModelPattern: "qwen/",
    judgeModelPattern: "anthropic/claude",
    recommended: false,
  },
];

export function findMatchingPreset(
  codingModelId: string,
  judgeModelId: string
): JudgePreset | undefined {
  return JUDGE_PRESETS.find(
    (preset) =>
      codingModelId.includes(preset.codingModelPattern) &&
      judgeModelId.includes(preset.judgeModelPattern)
  );
}

export function isRecommendedJudgeModel(
  codingModelId: string,
  judgeModelId: string
): boolean {
  const preset = findMatchingPreset(codingModelId, judgeModelId);
  return preset?.recommended ?? false;
}
