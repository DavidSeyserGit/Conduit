import type { HarnessId } from "@conduit/shared";

export interface HarnessDefinition {
  id: HarnessId;
  name: string;
  description: string;
  available: boolean;
  requiresApiKey?: boolean;
  installHint?: string;
}

/** Single source of truth for provider switches shown in Settings. */
export const HARNESS_DEFINITIONS: readonly HarnessDefinition[] = [
  {
    id: "openrouter",
    name: "OpenRouter",
    description: "Cloud models through your OpenRouter API key",
    available: true,
    requiresApiKey: true,
  },
  {
    id: "codex",
    name: "Codex",
    description: "ChatGPT subscription through the local Codex CLI",
    available: true,
    installHint: "codex login",
  },
  {
    id: "kilo",
    name: "Kilo Code",
    description: "Local Kilo Code CLI with its configured models and account",
    available: true,
    installHint: "npm install -g @kilocode/cli",
  },
  {
    id: "kimi",
    name: "Kimi",
    description: "Moonshot Kimi models through the local kimi CLI",
    available: true,
    installHint: "npm install -g @moonshot-ai/kimi-code",
  },
  {
    id: "acp",
    name: "ACP agents",
    description: "Configured Agent Client Protocol agents (experimental)",
    available: true,
  },
  {
    id: "claude-code",
    name: "Claude Code",
    description: "Claude Code harness integration",
    available: false,
  },
];

export function getHarnessDefinition(id: HarnessId): HarnessDefinition | undefined {
  return HARNESS_DEFINITIONS.find((definition) => definition.id === id);
}
