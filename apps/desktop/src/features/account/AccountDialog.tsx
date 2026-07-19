import { type FormEvent, useCallback, useEffect, useState } from "react";
import { neonAuthClient } from "@/lib/neon-auth";
import {
  createBillingPortal,
  createCheckout,
  getSubscription,
  accountGatewayUrl,
  type SubscriptionState,
} from "@/lib/account-gateway";

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
            <p className="mt-0.5 text-xs text-gray-500">Sign in or create an account without leaving the app.</p>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg p-1.5 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700" aria-label="Close account">
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          {neonAuthClient
            ? <ConnectedAccountDialog client={neonAuthClient} onIdentityChange={onIdentityChange} onEntitlementChange={onEntitlementChange} />
            : <AuthUnavailable />}
        </div>
      </div>
    </div>
  );
}

function ConnectedAccountDialog({ client, onIdentityChange, onEntitlementChange }: { client: AuthClient; onIdentityChange: (identity: AccountIdentity | null) => void; onEntitlementChange: (entitled: boolean) => void }) {
  const session = client.useSession();
  const [view, setView] = useState<AuthViewName>("SIGN_IN");
  const [signingOut, setSigningOut] = useState(false);
  const [entitled, setEntitled] = useState(false);
  const user = session.data?.user;

  useEffect(() => {
    onIdentityChange(user ? { name: user.name, email: user.email } : null);
    if (!user) onEntitlementChange(false);
  }, [onEntitlementChange, onIdentityChange, user]);

  const handleEntitlementChange = useCallback((nextEntitled: boolean) => {
    setEntitled(nextEntitled);
    onEntitlementChange(nextEntitled);
  }, [onEntitlementChange]);

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
        <SubscriptionPanel onEntitlementChange={handleEntitlementChange} />
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
      <EmailAuthForm client={client} view={view} />
    </div>
  );
}

function SubscriptionPanel({ onEntitlementChange }: { onEntitlementChange: (entitled: boolean) => void }) {
  const [subscription, setSubscription] = useState<SubscriptionState | null>(null);
  const [loading, setLoading] = useState(Boolean(accountGatewayUrl));
  const [action, setAction] = useState<"checkout" | "portal" | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!accountGatewayUrl) return;
    let active = true;
    void getSubscription()
      .then((result) => {
        if (active) {
          setSubscription(result);
          onEntitlementChange(result.entitled);
        }
      })
      .catch((caught) => { if (active) setError(errorMessage(caught)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [onEntitlementChange]);

  const openBilling = async (kind: "checkout" | "portal") => {
    setError(null);
    setAction(kind);
    try {
      const url = kind === "checkout" ? await createCheckout() : await createBillingPortal();
      try {
        const { openUrl } = await import("@tauri-apps/plugin-opener");
        await openUrl(url);
      } catch {
        window.open(url, "_blank", "noopener,noreferrer");
      }
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setAction(null);
    }
  };

  return (
    <div className="rounded-xl border border-gray-200 p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="text-sm font-medium text-gray-900">Subscription</div>
        {subscription && (
          <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${subscription.entitled ? "bg-emerald-50 text-emerald-700" : "bg-gray-100 text-gray-600"}`}>
            {subscription.entitled ? "Active" : subscription.status === "none" ? "Free" : subscription.status}
          </span>
        )}
      </div>
      {!accountGatewayUrl && <p className="mt-1 text-xs text-gray-500">Billing is not configured in this build. Conduit remains fully usable locally.</p>}
      {accountGatewayUrl && loading && <p className="mt-1 text-xs text-gray-500">Checking subscription…</p>}
      {accountGatewayUrl && !loading && subscription?.entitled && (
        <p className="mt-1 text-xs text-gray-500">Your Conduit subscription is active{subscription.currentPeriodEnd ? ` through ${new Date(subscription.currentPeriodEnd).toLocaleDateString()}` : ""}.</p>
      )}
      {accountGatewayUrl && !loading && !subscription?.entitled && (
        <p className="mt-1 text-xs text-gray-500">Subscribe through Stripe Managed Payments. Checkout opens securely in your browser.</p>
      )}
      {error && <div role="alert" className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{error}</div>}
      {accountGatewayUrl && !loading && (
        <button
          type="button"
          disabled={action !== null}
          onClick={() => void openBilling(subscription?.entitled ? "portal" : "checkout")}
          className="mt-3 w-full rounded-lg bg-gray-900 px-3 py-2 text-xs font-medium text-white transition-colors hover:bg-gray-800 disabled:opacity-50"
        >
          {action ? "Opening…" : subscription?.entitled ? "Manage billing" : "Subscribe with Stripe"}
        </button>
      )}
    </div>
  );
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : "The account service could not complete the request.";
}

function EmailAuthForm({ client, view }: { client: AuthClient; view: AuthViewName }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  return (
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
  );
}

function AuthUnavailable() {
  return (
    <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
      <div className="text-sm font-medium text-amber-800">Account sign-in is not configured</div>
      <p className="mt-1 text-xs text-amber-700">Set <code>VITE_NEON_AUTH_URL</code> when building Conduit, then restart the app.</p>
    </div>
  );
}
