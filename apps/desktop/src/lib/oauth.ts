import { accountGatewayUrl } from "@/lib/account-gateway";
import { desktopAuthFetch, neonAuthClient, neonAuthUrl } from "@/lib/neon-auth";

const PENDING_OAUTH_KEY = "conduit.oauth.pending";
const OAUTH_MAX_AGE_MS = 10 * 60 * 1000;
let initialized = false;
const handledUrls = new Set<string>();

type AuthClient = NonNullable<typeof neonAuthClient>;
type OAuthStatus = { status: "completed" | "error"; message?: string };

export function isGoogleOAuthAvailable(): boolean {
  return Boolean(neonAuthClient && neonAuthUrl && accountGatewayUrl && isTauri());
}

export async function beginGoogleOAuth(client: AuthClient): Promise<void> {
  if (!accountGatewayUrl || !isTauri()) {
    throw new Error("Google sign-in is available in the installed Conduit app when the account service is configured.");
  }

  const state = randomState();
  localStorage.setItem(PENDING_OAUTH_KEY, JSON.stringify({ state, createdAt: Date.now() }));
  const callbackURL = `${accountGatewayUrl}/auth/callback?state=${encodeURIComponent(state)}`;
  const result = await client.signIn.social({ provider: "google", callbackURL, disableRedirect: true });
  if (result.error) {
    localStorage.removeItem(PENDING_OAUTH_KEY);
    throw new Error(result.error.message || "Google sign-in could not be started.");
  }
  const oauthUrl = result.data?.url;
  if (!oauthUrl) {
    localStorage.removeItem(PENDING_OAUTH_KEY);
    throw new Error("Neon did not return a Google sign-in URL.");
  }

  const { openUrl } = await import("@tauri-apps/plugin-opener");
  await openUrl(oauthUrl);
}

export async function initializeOAuthDeepLinks(): Promise<void> {
  if (initialized || !isTauri() || !neonAuthClient || !neonAuthUrl) return;
  const { getCurrent, onOpenUrl } = await import("@tauri-apps/plugin-deep-link");
  const handleUrls = (urls: string[] | null) => {
    for (const url of urls ?? []) {
      if (handledUrls.has(url)) continue;
      handledUrls.add(url);
      void completeOAuth(url);
    }
  };
  const checkCurrent = async () => handleUrls(await getCurrent());

  const { listen } = await import("@tauri-apps/api/event");
  await listen<string[]>("conduit:deep-link", (event) => handleUrls(event.payload));
  await onOpenUrl(handleUrls);
  window.addEventListener("focus", () => void checkCurrent());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void checkCurrent();
  });
  initialized = true;
  await checkCurrent();
}

async function completeOAuth(rawUrl: string): Promise<void> {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "conduit:" || url.hostname !== "auth" || url.pathname !== "/callback") return;

    const pending = readPendingOAuth();
    const state = url.searchParams.get("state");
    if (!pending || !state || state !== pending.state) throw new Error("The Google sign-in response did not match this Conduit session.");
    if (Date.now() - pending.createdAt > OAUTH_MAX_AGE_MS) throw new Error("Google sign-in expired. Please try again.");
    const providerError = url.searchParams.get("error_description") ?? url.searchParams.get("error");
    if (providerError) throw new Error(providerError);
    const verifier = url.searchParams.get("neon_auth_session_verifier");
    if (!verifier) throw new Error("Neon did not return the session verifier.");

    const exchangeUrl = new URL(`${neonAuthUrl}/get-session`);
    exchangeUrl.searchParams.set("neon_auth_session_verifier", verifier);
    exchangeUrl.searchParams.set("disableCookieCache", "true");
    const response = await desktopAuthFetch(exchangeUrl, { credentials: "include" });
    if (!response.ok) throw new Error("Neon could not complete the Google session exchange.");
    const session = await response.json() as { user?: unknown; session?: unknown } | null;
    if (!session?.user || !session.session) {
      throw new Error("Google sign-in returned without an active Neon session. Please try again.");
    }

    const refreshed = await neonAuthClient!.getSession({
      query: { disableCookieCache: true },
      fetchOptions: { headers: { "X-Force-Fetch": "true" } },
    });
    if (refreshed.error || !refreshed.data?.user || !refreshed.data.session) {
      throw new Error(refreshed.error?.message || "Conduit could not refresh the Google session.");
    }

    localStorage.removeItem(PENDING_OAUTH_KEY);
    announce({ status: "completed" });
  } catch (error) {
    localStorage.removeItem(PENDING_OAUTH_KEY);
    announce({ status: "error", message: error instanceof Error ? error.message : "Google sign-in failed." });
  }
}

function readPendingOAuth(): { state: string; createdAt: number } | null {
  try {
    const value = JSON.parse(localStorage.getItem(PENDING_OAUTH_KEY) ?? "null") as unknown;
    if (!value || typeof value !== "object") return null;
    const candidate = value as Record<string, unknown>;
    return typeof candidate.state === "string" && typeof candidate.createdAt === "number"
      ? { state: candidate.state, createdAt: candidate.createdAt }
      : null;
  } catch {
    return null;
  }
}

function randomState(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function announce(detail: OAuthStatus): void {
  window.dispatchEvent(new CustomEvent<OAuthStatus>("conduit:oauth", { detail }));
}

function isTauri(): boolean {
  return Boolean((window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
}
