import { createInternalNeonAuth } from "@neondatabase/auth";
import { BetterAuthReactAdapter, type BetterAuthReactAdapterInstance } from "@neondatabase/auth/react/adapters";
import { normalizeNeonAuthUrl } from "@/lib/auth-config";

export const neonAuthUrl = normalizeNeonAuthUrl(import.meta.env.VITE_NEON_AUTH_URL);

export const neonAuth = neonAuthUrl
  ? createInternalNeonAuth<BetterAuthReactAdapterInstance>(neonAuthUrl, { adapter: BetterAuthReactAdapter() })
  : null;

export const neonAuthClient = neonAuth?.adapter ?? null;

export async function getNeonAccessToken(): Promise<string | null> {
  return neonAuth?.getJWTToken() ?? null;
}
