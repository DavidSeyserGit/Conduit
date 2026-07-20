import { useState } from "react";
import { pendingAnonymousAnalyticsPayload } from "@/lib/anonymous-analytics";
import { useAppStore } from "@/stores/app-store";

export default function PrivacySettings() {
  const enabled = useAppStore((state) => state.settings.anonymousAnalyticsEnabled === true);
  const updateSettings = useAppStore((state) => state.updateSettings);
  const [showPayload, setShowPayload] = useState(false);
  const payload = showPayload ? pendingAnonymousAnalyticsPayload() : null;

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-semibold text-gray-900">Privacy</h3>
        <p className="mt-1 text-xs leading-5 text-gray-500">Conduit is local-first. Anonymous analytics are optional and disabled until you choose to share them.</p>
      </div>

      <section className="rounded-xl border border-gray-200 p-4">
        <div className="flex items-start justify-between gap-5">
          <div>
            <div className="text-sm font-medium text-gray-900">Share anonymous usage analytics</div>
            <p className="mt-1 text-xs leading-5 text-gray-500">Help improve Conduit by sharing fixed feature counters. No identity, account, device, session, code, repository, goal, prompt, file path, command, or report content is included.</p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            aria-label="Share anonymous usage analytics"
            onClick={() => updateSettings({ anonymousAnalyticsEnabled: !enabled })}
            className={`relative mt-0.5 h-6 w-10 shrink-0 rounded-full transition-colors ${enabled ? "bg-emerald-500" : "bg-gray-300"}`}
          >
            <span className={`absolute left-1 top-1 h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${enabled ? "translate-x-4" : "translate-x-0"}`} />
          </button>
        </div>
        <div className={`mt-3 rounded-lg px-3 py-2 text-xs ${enabled ? "border border-emerald-200 bg-emerald-50 text-emerald-700" : "bg-gray-50 text-gray-500"}`}>
          {enabled ? "Enabled. Anonymous counters are periodically sent without an identifier." : "Disabled. No usage counters are collected or sent."}
        </div>
      </section>

      <section className="rounded-xl border border-gray-200 bg-gray-50 p-4">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500">Privacy guarantees</h4>
        <ul className="mt-3 space-y-2 text-xs leading-5 text-gray-600">
          <li>• No stable user, account, installation, device, or session identifier.</li>
          <li>• No goal, repository, model response, evidence, or report data.</li>
          <li>• Counters cannot be joined to your Conduit or Stripe account.</li>
          <li>• Disabling analytics immediately deletes locally queued counters.</li>
        </ul>
      </section>

      <button type="button" onClick={() => setShowPayload((value) => !value)} className="text-xs font-medium text-gray-600 hover:text-gray-900">
        {showPayload ? "Hide pending payload" : "View exact pending payload"}
      </button>
      {payload && <pre className="max-h-48 overflow-auto rounded-xl border border-gray-200 bg-gray-50 p-3 text-[11px] leading-5 text-gray-600">{JSON.stringify(payload, null, 2)}</pre>}
    </div>
  );
}
