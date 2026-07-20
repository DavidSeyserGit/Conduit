import { type FormEvent, useEffect, useState } from "react";
import { neonAuthClient } from "@/lib/neon-auth";
import { getSubscription, accountGatewayUrl } from "@/lib/account-gateway";
import { beginGoogleOAuth, isGoogleOAuthAvailable } from "@/lib/oauth";
import { useAppStore } from "@/stores/app-store";

type AuthClient = NonNullable<typeof neonAuthClient>;
type AuthViewName = "SIGN_IN" | "SIGN_UP";
type AccountIdentity = { name?: string | null; email: string };

export default function AccountDialog({ onClose, onIdentityChange, onEntitlementChange }: { onClose: () => void; onIdentityChange: (identity: AccountIdentity | null) => void; onEntitlementChange: (entitled: boolean) => void }) {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm"
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div role="dialog" aria-modal="true" aria-labelledby="account-dialog-title" className="flex max-h-[min(720px,calc(100vh-32px))] w-[min(92vw,460px)] flex-col overflow-hidden rounded-2xl border border-gray-100 bg-white shadow-2xl">
        <div className="flex shrink-0 items-center justify-between border-b border-gray-100 px-5 py-4">
          <div>
            <h2 id="account-dialog-title" className="text-base font-semibold text-gray-900">Conduit account</h2>
            <p className="mt-0.5 text-xs text-gray-500">Use Google or email to sign in or create an account.</p>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg p-1.5 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700" aria-label="Close account">
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          {neonAuthClient
            ? <ConnectedAccountDialog client={neonAuthClient} onClose={onClose} onIdentityChange={onIdentityChange} onEntitlementChange={onEntitlementChange} />
            : <AuthUnavailable />}
        </div>
      </div>
    </div>
  );
}

function ConnectedAccountDialog({ client, onClose, onIdentityChange, onEntitlementChange }: { client: AuthClient; onClose: () => void; onIdentityChange: (identity: AccountIdentity | null) => void; onEntitlementChange: (entitled: boolean) => void }) {
  const session = client.useSession();
  const [view, setView] = useState<AuthViewName>("SIGN_IN");
  const [signingOut, setSigningOut] = useState(false);
  const [entitled, setEntitled] = useState(false);
  const setShowSettings = useAppStore((state) => state.setShowSettings);
  const setSettingsTab = useAppStore((state) => state.setSettingsTab);
  const user = session.data?.user;

  useEffect(() => {
    onIdentityChange(user ? { name: user.name, email: user.email } : null);
    if (!user) onEntitlementChange(false);
  }, [onEntitlementChange, onIdentityChange, user]);

  useEffect(() => {
    if (!user || !accountGatewayUrl) return;
    let active = true;
    void getSubscription().then((result) => {
      if (active) {
        setEntitled(result.entitled);
        onEntitlementChange(result.entitled);
      }
    }).catch(() => undefined);
    return () => { active = false; };
  }, [onEntitlementChange, user]);

  if (session.isPending) {
    return <div role="status" className="py-12 text-center text-sm text-gray-500">Loading account…</div>;
  }

  if (user) {
    return (
      <div className="space-y-5">
        <div className="flex items-center gap-3 rounded-xl border border-gray-200 bg-gray-50 p-4">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-indigo-100 text-sm font-semibold text-indigo-700">
            {(user.name?.trim()?.[0] || user.email?.[0] || "U").toUpperCase()}
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <div className="truncate text-sm font-semibold text-gray-900">{user.name || "Conduit user"}</div>
              {entitled && <span className="pro-badge shrink-0" aria-label="Conduit Pro subscription">Pro</span>}
            </div>
            <div className="truncate text-xs text-gray-500">{user.email}</div>
          </div>
        </div>
        <button
          type="button"
          onClick={() => {
            onClose();
            setSettingsTab("user");
            setShowSettings(true);
          }}
          className="w-full rounded-lg bg-gray-900 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-gray-800"
        >
          Account settings
        </button>
        <button
          type="button"
          disabled={signingOut}
          onClick={() => {
            setSigningOut(true);
            void client.signOut().finally(() => setSigningOut(false));
          }}
          className="w-full rounded-lg border border-gray-200 px-4 py-2.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:opacity-50"
        >
          {signingOut ? "Signing out…" : "Sign out"}
        </button>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-5 grid grid-cols-2 gap-1 rounded-xl bg-gray-50 p-1">
        <button type="button" onClick={() => setView("SIGN_IN")} className={`rounded-lg px-3 py-2 text-sm transition-colors ${view === "SIGN_IN" ? "bg-white font-medium text-gray-900 shadow-sm" : "text-gray-500 hover:text-gray-800"}`}>Sign in</button>
        <button type="button" onClick={() => setView("SIGN_UP")} className={`rounded-lg px-3 py-2 text-sm transition-colors ${view === "SIGN_UP" ? "bg-white font-medium text-gray-900 shadow-sm" : "text-gray-500 hover:text-gray-800"}`}>Create account</button>
      </div>
      <EmailAuthForm client={client} view={view} refreshSession={session.refetch} />
    </div>
  );
}

function EmailAuthForm({ client, view, refreshSession }: { client: AuthClient; view: AuthViewName; refreshSession: () => Promise<void> }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [oauthPending, setOauthPending] = useState(false);

  useEffect(() => {
    const handleOAuth = (event: Event) => {
      const detail = (event as CustomEvent<{ status: "completed" | "error"; message?: string }>).detail;
      if (detail.status === "error") {
        setOauthPending(false);
        setError(detail.message || "Google sign-in failed.");
        return;
      }
      void refreshSession()
        .catch((caught) => setError(caught instanceof Error ? caught.message : "Conduit could not refresh the Google session."))
        .finally(() => setOauthPending(false));
    };
    window.addEventListener("conduit:oauth", handleOAuth);
    return () => window.removeEventListener("conduit:oauth", handleOAuth);
  }, [refreshSession]);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const result = view === "SIGN_UP"
        ? await client.signUp.email({ name: name.trim(), email: email.trim(), password })
        : await client.signIn.email({ email: email.trim(), password });
      if (result.error) setError(result.error.message || "Authentication failed. Please try again.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Authentication failed. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  const handleGoogleSignIn = async () => {
    setError(null);
    setOauthPending(true);
    try {
      await beginGoogleOAuth(client);
    } catch (caught) {
      setOauthPending(false);
      setError(caught instanceof Error ? caught.message : "Google sign-in could not be started.");
    }
  };

  return (
    <div className="space-y-4">
      {isGoogleOAuthAvailable() && (
        <>
          <button type="button" disabled={oauthPending} onClick={() => void handleGoogleSignIn()} className="flex w-full items-center justify-center gap-2.5 rounded-xl border border-gray-200 bg-white px-4 py-2.5 text-sm font-medium text-gray-800 transition-colors hover:bg-gray-50 disabled:opacity-50">
            <GoogleIcon />
            {oauthPending ? "Finish in your browser…" : "Continue with Google"}
          </button>
          <div className="flex items-center gap-3 text-[11px] uppercase tracking-wide text-gray-400"><span className="h-px flex-1 bg-gray-100" /><span>or use email</span><span className="h-px flex-1 bg-gray-100" /></div>
        </>
      )}
      <form className="space-y-4" onSubmit={(event) => void handleSubmit(event)}>
        {view === "SIGN_UP" && (
          <label className="block text-xs font-medium text-gray-700">
            Name
            <input autoComplete="name" required value={name} onChange={(event) => setName(event.target.value)} className="mt-1.5 w-full rounded-xl border border-gray-200 bg-gray-50 px-3.5 py-2.5 text-sm text-gray-900 outline-none transition-colors focus:border-indigo-400 focus:bg-white" />
          </label>
        )}
        <label className="block text-xs font-medium text-gray-700">
          Email
          <input type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} className="mt-1.5 w-full rounded-xl border border-gray-200 bg-gray-50 px-3.5 py-2.5 text-sm text-gray-900 outline-none transition-colors focus:border-indigo-400 focus:bg-white" />
        </label>
        <label className="block text-xs font-medium text-gray-700">
          Password
          <input type="password" autoComplete={view === "SIGN_UP" ? "new-password" : "current-password"} minLength={8} required value={password} onChange={(event) => setPassword(event.target.value)} className="mt-1.5 w-full rounded-xl border border-gray-200 bg-gray-50 px-3.5 py-2.5 text-sm text-gray-900 outline-none transition-colors focus:border-indigo-400 focus:bg-white" />
          {view === "SIGN_UP" && <span className="mt-1 block font-normal text-gray-400">At least 8 characters.</span>}
        </label>
        {error && <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{error}</div>}
        <button type="submit" disabled={submitting} className="w-full rounded-xl bg-gray-900 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-gray-800 disabled:opacity-50">
          {submitting ? "Please wait…" : view === "SIGN_UP" ? "Create account" : "Sign in"}
        </button>
        <p className="text-center text-[11px] text-gray-400">Authentication is provided by Neon Auth.</p>
      </form>
    </div>
  );
}

function GoogleIcon() {
  return <svg aria-hidden="true" className="h-4 w-4" viewBox="0 0 18 18"><path fill="#4285F4" d="M17.64 9.205c0-.638-.057-1.252-.164-1.841H9v3.482h4.844a4.14 4.14 0 0 1-1.797 2.715v2.259h2.909c1.702-1.567 2.684-3.875 2.684-6.615Z"/><path fill="#34A853" d="M9 18c2.43 0 4.468-.806 5.956-2.18l-2.909-2.259c-.806.54-1.836.859-3.047.859-2.344 0-4.328-1.584-5.037-3.711H.956v2.332A9 9 0 0 0 9 18Z"/><path fill="#FBBC05" d="M3.963 10.709A5.42 5.42 0 0 1 3.681 9c0-.593.102-1.17.282-1.709V4.959H.956A9 9 0 0 0 0 9c0 1.452.347 2.827.956 4.041l3.007-2.332Z"/><path fill="#EA4335" d="M9 3.58c1.321 0 2.507.454 3.441 1.346l2.581-2.581C13.464.892 11.426 0 9 0A9 9 0 0 0 .956 4.959l3.007 2.332C4.672 5.164 6.656 3.58 9 3.58Z"/></svg>;
}

function AuthUnavailable() {
  return (
    <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
      <div className="text-sm font-medium text-amber-800">Account sign-in is not configured</div>
      <p className="mt-1 text-xs text-amber-700">Set <code>VITE_NEON_AUTH_URL</code> when building Conduit, then restart the app.</p>
    </div>
  );
}
