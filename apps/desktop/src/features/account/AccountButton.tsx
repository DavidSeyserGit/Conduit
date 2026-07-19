import { lazy, Suspense, useState } from "react";

const AccountDialog = lazy(() => import("@/features/account/AccountDialog"));

type AccountIdentity = { name?: string | null; email: string };

export function AccountButton() {
  const [open, setOpen] = useState(false);
  const [identity, setIdentity] = useState<AccountIdentity | null>(null);
  const [isPro, setIsPro] = useState(false);
  const initials = identity?.name?.trim()
    ? identity.name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("")
    : identity?.email[0]?.toUpperCase();

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={`flex h-8 w-8 items-center justify-center rounded-full border text-xs font-semibold transition-all ${isPro ? "pro-avatar text-indigo-700" : identity ? "border-indigo-200 bg-indigo-50 text-indigo-700 hover:bg-indigo-100" : "border-gray-200 bg-gray-50 text-gray-500 hover:border-gray-300 hover:bg-gray-100 hover:text-gray-900"}`}
        title={identity ? `${identity.email}${isPro ? " · Pro" : ""}` : "Account"}
        aria-label={identity ? `Open ${isPro ? "Pro " : ""}account for ${identity.email}` : "Open account"}
      >
        {initials || <UserIcon />}
      </button>
      {open && (
        <Suspense fallback={<AccountLoadingDialog onClose={() => setOpen(false)} />}>
          <AccountDialog onClose={() => setOpen(false)} onIdentityChange={setIdentity} onEntitlementChange={setIsPro} />
        </Suspense>
      )}
    </>
  );
}

function AccountLoadingDialog({ onClose }: { onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm">
      <div role="dialog" aria-modal="true" aria-label="Loading account" className="w-[min(92vw,460px)] rounded-2xl border border-gray-100 bg-white p-8 text-center shadow-2xl">
        <div role="status" className="text-sm text-gray-500">Loading account…</div>
        <button type="button" onClick={onClose} className="mt-4 text-xs font-medium text-gray-500 hover:text-gray-900">Cancel</button>
      </div>
    </div>
  );
}

function UserIcon() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></svg>;
}
