import { invoke } from "@tauri-apps/api/core";

export type HarnessAuthState = "yes" | "no" | "unknown";
export interface HarnessHealth {
  installed: boolean;
  authenticated: HarnessAuthState;
  detail?: string | null;
}
export type HarnessHealthMap = Partial<Record<"codex" | "kilo", HarnessHealth>>;

type InvokeFn = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

const inTauri = () =>
  typeof window !== "undefined" &&
  Boolean((window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);

/** Packaged-app only; returns null in the dev server or when the probe fails. */
export async function fetchHarnessHealth(
  invokeCommand: InvokeFn = invoke,
): Promise<HarnessHealthMap | null> {
  if (!inTauri()) return null;
  try {
    return await invokeCommand<HarnessHealthMap>("local_harness_health");
  } catch {
    return null;
  }
}

export interface HarnessStatusView {
  tone: "ok" | "warn" | "muted";
  text: string;
}

/** Maps probe results to the status line shown next to a harness in Settings. */
export function harnessStatusView(
  harnessId: "codex" | "kilo",
  health: HarnessHealthMap | null,
  installHint?: string,
): HarnessStatusView | null {
  const entry = health?.[harnessId];
  if (!entry) return null;
  if (!entry.installed) {
    return { tone: "warn", text: `CLI not found${installHint ? ` · install: ${installHint}` : ""}` };
  }
  if (entry.authenticated === "no") {
    return {
      tone: "warn",
      text: harnessId === "codex" ? "Not signed in · run: codex login" : "Not signed in · check the CLI auth",
    };
  }
  if (entry.authenticated === "yes") return { tone: "ok", text: "CLI ready" };
  return { tone: "muted", text: entry.detail ? `Status unknown · ${entry.detail}` : "Status unknown" };
}
