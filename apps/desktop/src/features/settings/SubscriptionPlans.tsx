import { useEffect, useState } from "react";
import {
  createCheckout,
  getSubscriptionPlans,
  type SubscriptionPlan,
  type SubscriptionPlanId,
} from "@/lib/account-gateway";
import { recordAnonymousEvent, type AnonymousAnalyticsEvent } from "@/lib/anonymous-analytics";

const PLAN_DETAILS: Record<SubscriptionPlanId, { description: string; features: string[]; recommended?: boolean }> = {
  yearly: {
    description: "The best value for using Conduit throughout the year.",
    features: ["Conduit Pro for one user", "Billed once per year"],
    recommended: true,
  },
  three_month: {
    description: "Full Pro access with a shorter commitment.",
    features: ["Conduit Pro for one user", "Billed every three months"],
  },
  team: {
    description: "A shared plan for teams building with Conduit.",
    features: ["Conduit Pro for your team", "Team billing through Stripe"],
  },
};

export default function SubscriptionPlans({ onClose }: { onClose: () => void }) {
  const [plans, setPlans] = useState<SubscriptionPlan[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedPlan, setSelectedPlan] = useState<SubscriptionPlanId | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void getSubscriptionPlans()
      .then((result) => { if (active) setPlans(result); })
      .catch((caught) => { if (active) setError(errorMessage(caught)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  const choosePlan = async (planId: SubscriptionPlanId) => {
    const event: Record<SubscriptionPlanId, AnonymousAnalyticsEvent> = {
      yearly: "checkout_yearly_started",
      three_month: "checkout_three_month_started",
      team: "checkout_team_started",
    };
    recordAnonymousEvent(event[planId]);
    setSelectedPlan(planId);
    setError(null);
    try {
      await openExternalUrl(await createCheckout(planId));
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setSelectedPlan(null);
    }
  };

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/45 p-5 backdrop-blur-sm" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div role="dialog" aria-modal="true" aria-labelledby="plan-dialog-title" className="max-h-[calc(100vh-40px)] w-[min(1040px,96vw)] overflow-y-auto rounded-3xl border border-gray-200 bg-white p-7 shadow-2xl">
        <div className="flex items-start justify-between gap-5">
          <div>
            <div className="mb-3 inline-flex items-center rounded-full border border-gray-200 bg-gray-50 px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-gray-500">Conduit memberships</div>
            <h3 id="plan-dialog-title" className="max-w-xl text-3xl font-semibold tracking-tight text-gray-900">Pick the plan that works for you</h3>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-gray-500">Choose the billing rhythm that fits your work. Every plan keeps your projects local, and Stripe securely handles checkout.</p>
          </div>
          <button type="button" onClick={onClose} className="rounded-xl p-2 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700" aria-label="Close plan chooser">
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>

        {loading && <div role="status" className="mt-8 rounded-2xl border border-gray-200 py-20 text-center text-sm text-gray-500">Loading plans…</div>}

        {!loading && plans.length === 0 && !error && (
          <div className="mt-8 rounded-2xl border border-amber-200 bg-amber-50 p-5 text-sm text-amber-800">Subscription plans are not configured yet.</div>
        )}

        <div className="mt-8 grid gap-4 md:grid-cols-3">
          {plans.map((plan) => {
            const details = PLAN_DETAILS[plan.id];
            const pending = selectedPlan === plan.id;
            return (
              <article key={plan.id} className={`relative flex min-h-[340px] flex-col rounded-2xl border p-5 transition-transform hover:-translate-y-0.5 ${details.recommended ? "subscription-plan-featured border-indigo-300" : "border-gray-200 bg-gray-50"}`}>
                {details.recommended && <span className="absolute right-4 top-4 rounded-full bg-indigo-50 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide text-indigo-700">Best value</span>}
                <h4 className="pr-20 text-lg font-semibold text-gray-900">{plan.name}</h4>
                <p className="mt-1 text-xs font-medium text-gray-500">{plan.audience}</p>
                <div className="mt-7">
                  <span className="text-4xl font-semibold tracking-tight text-gray-900">{formatPrice(plan)}</span>
                  <span className="ml-1.5 text-xs text-gray-500">{formatInterval(plan)}</span>
                </div>
                <p className="mt-4 min-h-10 text-xs leading-5 text-gray-500">{details.description}</p>
                <ul className="mt-4 space-y-2">
                  {details.features.map((feature) => <li key={feature} className="flex items-center gap-2 text-xs text-gray-700"><span className="flex h-4 w-4 items-center justify-center rounded-full bg-emerald-100 text-[10px] font-bold text-emerald-700">✓</span>{feature}</li>)}
                </ul>
                <button type="button" disabled={selectedPlan !== null} onClick={() => void choosePlan(plan.id)} className={`mt-auto w-full rounded-xl px-4 py-3 text-sm font-medium transition-colors disabled:opacity-50 ${details.recommended ? "bg-gray-950 text-white hover:bg-gray-800" : "border border-gray-300 bg-white text-gray-900 hover:bg-gray-100"}`}>
                  {pending ? "Opening checkout…" : `Choose ${plan.name}`}
                </button>
              </article>
            );
          })}
        </div>

        {error && <div role="alert" className="mt-5 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-xs text-red-700">{error}</div>}
        <p className="mt-5 text-center text-[11px] text-gray-400">Manage or cancel at any time from Settings → User.</p>
      </div>
    </div>
  );
}

function formatPrice(plan: SubscriptionPlan): string {
  if (plan.unitAmount === null) return "Custom";
  return new Intl.NumberFormat(undefined, { style: "currency", currency: plan.currency.toUpperCase() }).format(plan.unitAmount / 100);
}

function formatInterval(plan: SubscriptionPlan): string {
  if (plan.intervalCount === 1) return `per ${plan.interval}`;
  return `every ${plan.intervalCount} ${plan.interval}s`;
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
  return value instanceof Error ? value.message : "The account service could not load subscription plans.";
}
