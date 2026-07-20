import { createInternalNeonAuth } from "@neondatabase/auth";
import { BetterAuthReactAdapter, type BetterAuthReactAdapterInstance } from "@neondatabase/auth/react/adapters";
import { normalizeNeonAuthUrl } from "@/lib/auth-config";

export const neonAuthUrl = normalizeNeonAuthUrl(import.meta.env.VITE_NEON_AUTH_URL);

export const neonAuth = neonAuthUrl
  ? createInternalNeonAuth<BetterAuthReactAdapterInstance>(neonAuthUrl, {
      adapter: BetterAuthReactAdapter({ fetchOptions: { customFetchImpl: desktopAuthFetch } }),
    })
  : null;

export const neonAuthClient = neonAuth?.adapter ?? null;

export async function getNeonAccessToken(): Promise<string | null> {
  return neonAuth?.getJWTToken() ?? null;
}

let sessionToken: string | null | undefined;

export async function desktopAuthFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  const token = await getDesktopSessionToken();
  if (token && !headers.has("authorization")) headers.set("Authorization", `Bearer ${token}`);

  const response = await fetch(input, { ...init, headers });
  const nextToken = response.headers.get("set-auth-token");
  if (nextToken) await storeDesktopSessionToken(nextToken);

  const requestUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (response.ok && new URL(requestUrl, window.location.href).pathname.endsWith("/sign-out")) {
    await storeDesktopSessionToken(null);
  }
  return response;
}

async function getDesktopSessionToken(): Promise<string | null> {
  if (sessionToken !== undefined) return sessionToken;
  if (!isTauri()) return (sessionToken = null);
  const { invoke } = await import("@tauri-apps/api/core");
  const response = await invoke<{ success: boolean; result?: { token?: string | null }; error?: string }>("neon_auth_session_get");
  if (!response.success) throw new Error(response.error || "Could not read the account session.");
  sessionToken = response.result?.token ?? null;
  return sessionToken;
}

async function storeDesktopSessionToken(token: string | null): Promise<void> {
  sessionToken = token;
  if (!isTauri()) return;
  const { invoke } = await import("@tauri-apps/api/core");
  const response = await invoke<{ success: boolean; error?: string }>("neon_auth_session_store", { token: token ?? "" });
  if (!response.success) throw new Error(response.error || "Could not store the account session.");
}

function isTauri(): boolean {
  return Boolean((window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
}
