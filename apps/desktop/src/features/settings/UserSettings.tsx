import { useEffect, useState } from "react";
import { neonAuthClient } from "@/lib/neon-auth";
import {
  accountGatewayUrl,
  createBillingPortal,
  deleteBillingAccount,
  getSubscription,
  type SubscriptionState,
} from "@/lib/account-gateway";
import SubscriptionPlans from "@/features/settings/SubscriptionPlans";
import { recordAnonymousEvent } from "@/lib/anonymous-analytics";

type AuthClient = NonNullable<typeof neonAuthClient>;

export default function UserSettings() {
  if (!neonAuthClient) {
    return <Notice title="Accounts are not configured" description="This build has no Neon Auth endpoint. Conduit remains fully usable locally." />;
  }
  return <ConnectedUserSettings client={neonAuthClient} />;
}

function ConnectedUserSettings({ client }: { client: AuthClient }) {
  const session = client.useSession();
  const user = session.data?.user;
  const [subscription, setSubscription] = useState<SubscriptionState | null>(null);
  const [loadingSubscription, setLoadingSubscription] = useState(Boolean(accountGatewayUrl));
  const [billingAction, setBillingAction] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleteConfirmation, setDeleteConfirmation] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [showPlans, setShowPlans] = useState(false);

  useEffect(() => {
    if (!user || !accountGatewayUrl) return;
    let active = true;
    setLoadingSubscription(true);
    void getSubscription()
      .then((result) => { if (active) setSubscription(result); })
      .catch((caught) => { if (active) setError(errorMessage(caught)); })
      .finally(() => { if (active) setLoadingSubscription(false); });
    return () => { active = false; };
  }, [user]);

  if (session.isPending) {
    return <div role="status" className="py-12 text-center text-sm text-gray-500">Loading account…</div>;
  }

  if (!user) {
    return <Notice title="You are not signed in" description="Close Settings and select the profile icon in the header to sign in or create an account." />;
  }

  if (showPlans) {
    return <SubscriptionPlans onClose={() => setShowPlans(false)} />;
  }

  const hasSubscriptionRecord = Boolean(subscription && subscription.status !== "none");
  const canManageSubscription = Boolean(subscription && !["none", "canceled", "incomplete_expired"].includes(subscription.status));
  const openBilling = async () => {
    recordAnonymousEvent("billing_manage_opened");
    setBillingAction(true);
    setError(null);
    try {
      const url = await createBillingPortal();
      await openExternalUrl(url);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBillingAction(false);
    }
  };

  const deleteAccount = async () => {
    setDeleting(true);
    setError(null);
    try {
      if (accountGatewayUrl) await deleteBillingAccount();
      const result = await client.deleteUser();
      if (result.error) throw new Error(result.error.message || "Account deletion failed.");
      await client.signOut();
    } catch (caught) {
      setError(errorMessage(caught));
      setDeleting(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-semibold text-gray-900">User</h3>
        <p className="mt-1 text-xs text-gray-500">Manage your optional Conduit identity and billing.</p>
      </div>

      <div className="rounded-xl border border-gray-200 bg-gray-50 p-4">
        <div className="flex items-center gap-3">
          <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-sm font-semibold text-indigo-700 ${subscription?.entitled ? "pro-avatar" : "bg-indigo-100"}`}>
            {(user.name?.trim()?.[0] || user.email?.[0] || "U").toUpperCase()}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <div className="truncate text-sm font-semibold text-gray-900">{user.name || "Conduit user"}</div>
              {subscription?.entitled && <span className="pro-badge shrink-0">Pro</span>}
            </div>
            <div className="truncate text-xs text-gray-500">{user.email}</div>
          </div>
          <button type="button" onClick={() => void client.signOut()} className="text-xs font-medium text-gray-500 hover:text-gray-900">Sign out</button>
        </div>
      </div>

      <section className="space-y-3">
        <div>
          <h4 className="text-sm font-medium text-gray-900">Membership</h4>
          <p className="mt-0.5 text-xs text-gray-500">Billing is handled securely by Stripe Managed Payments.</p>
        </div>
        <div className="flex items-center justify-between gap-4 rounded-xl border border-gray-200 p-4">
          <div className="min-w-0">
            <div className="text-sm font-medium text-gray-900">{subscription?.entitled ? subscriptionName(subscription.planId) : "Conduit Free"}</div>
            <div className="mt-0.5 text-xs text-gray-500">
              {loadingSubscription
                ? "Checking membership…"
                : subscription?.entitled
                  ? subscription.currentPeriodEnd ? `Active through ${new Date(subscription.currentPeriodEnd).toLocaleDateString()}` : "Membership active"
                  : hasSubscriptionRecord ? `Billing status: ${subscription?.status}` : "Local features remain available without an account."}
            </div>
          </div>
          {accountGatewayUrl && !loadingSubscription && (
            <button type="button" disabled={billingAction} onClick={() => { if (canManageSubscription) void openBilling(); else { recordAnonymousEvent("plan_chooser_opened"); setShowPlans(true); } }} className={`shrink-0 rounded-lg px-3 py-2 text-xs font-medium transition-colors disabled:opacity-50 ${canManageSubscription ? "border border-gray-200 text-gray-700 hover:bg-gray-50" : "bg-gray-900 text-white hover:bg-gray-800"}`}>
              {billingAction ? "Opening…" : canManageSubscription ? "Manage billing" : "Choose a plan"}
            </button>
          )}
        </div>
      </section>

      {error && <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{error}</div>}

      <section className="border-t border-gray-100 pt-5">
        <h4 className="text-sm font-medium text-red-700">Delete account</h4>
        <p className="mt-1 text-xs leading-5 text-gray-500">Permanently removes your Neon identity and Stripe customer, immediately cancelling an active subscription. Local repositories, goals, runs, and reports are not deleted.</p>
        {!confirmingDelete ? (
          <button type="button" onClick={() => setConfirmingDelete(true)} className="mt-3 rounded-lg border border-red-200 px-3 py-2 text-xs font-medium text-red-700 hover:bg-red-50">Delete account…</button>
        ) : (
          <div className="mt-3 rounded-xl border border-red-200 bg-red-50 p-3">
            <label className="block text-xs font-medium text-red-700">
              Type your email to confirm
              <input value={deleteConfirmation} onChange={(event) => setDeleteConfirmation(event.target.value)} className="mt-1.5 w-full rounded-lg border border-red-200 bg-white px-3 py-2 text-sm text-gray-900 outline-none focus:border-red-400" placeholder={user.email} />
            </label>
            <div className="mt-3 flex justify-end gap-2">
              <button type="button" disabled={deleting} onClick={() => { setConfirmingDelete(false); setDeleteConfirmation(""); }} className="px-3 py-2 text-xs font-medium text-gray-600">Cancel</button>
              <button type="button" disabled={deleting || deleteConfirmation.trim().toLowerCase() !== user.email.toLowerCase()} onClick={() => void deleteAccount()} className="rounded-lg bg-red-600 px-3 py-2 text-xs font-medium text-white disabled:opacity-40">
                {deleting ? "Deleting…" : "Permanently delete"}
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

function Notice({ title, description }: { title: string; description: string }) {
  return <div className="rounded-xl border border-gray-200 bg-gray-50 p-4"><div className="text-sm font-medium text-gray-900">{title}</div><p className="mt-1 text-xs text-gray-500">{description}</p></div>;
}

async function openExternalUrl(url: string): Promise<void> {
  try {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
  } catch {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : "The account service could not complete the request.";
}

function subscriptionName(planId: SubscriptionState["planId"]): string {
  if (planId === "team") return "Conduit Team";
  if (planId === "three_month") return "Conduit Pro · 3 months";
  return "Conduit Pro · Yearly";
}
