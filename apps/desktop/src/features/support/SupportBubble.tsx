import { useEffect, useState } from "react";
import { SUPPORT_PROMPT_FADE_MS, SUPPORT_PROMPT_VISIBLE_MS, SUPPORT_PROJECT_URL } from "@/lib/support-prompt";

export function SupportBubble({ onClose, onDismiss }: { onClose: () => void; onDismiss: () => void }) {
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    const fadeTimer = window.setTimeout(() => setLeaving(true), SUPPORT_PROMPT_VISIBLE_MS);
    const closeTimer = window.setTimeout(onClose, SUPPORT_PROMPT_VISIBLE_MS + SUPPORT_PROMPT_FADE_MS);
    return () => {
      window.clearTimeout(fadeTimer);
      window.clearTimeout(closeTimer);
    };
  }, [onClose]);

  const dismiss = () => {
    setLeaving(true);
    window.setTimeout(onDismiss, SUPPORT_PROMPT_FADE_MS);
  };

  const openSupportPage = async () => {
    const isTauri = Boolean((window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
    if (isTauri) {
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      await openUrl(SUPPORT_PROJECT_URL);
      return;
    }
    window.open(SUPPORT_PROJECT_URL, "_blank", "noopener,noreferrer");
  };

  return (
    <div className={`fixed right-5 bottom-5 z-[70] w-[min(360px,calc(100vw-40px))] ${leaving ? "animate-support-out" : "animate-support-in"}`}>
      <div role="status" aria-live="polite" className="flex items-start gap-3 rounded-2xl border border-gray-200 bg-white px-4 py-3.5 shadow-xl">
        <span aria-hidden="true" className="text-lg leading-5">☕</span>
        <div className="min-w-0 flex-1">
          <p className="text-sm leading-5 text-gray-700">Thanks for using Conduit. If you enjoy it, please consider supporting the project.</p>
          <button type="button" onClick={() => void openSupportPage()} className="mt-1.5 text-xs font-semibold text-indigo-600 hover:text-indigo-800 transition-colors">Support the project</button>
        </div>
        <button type="button" onClick={dismiss} title="Dismiss" aria-label="Dismiss support message" className="-mr-1 p-1 text-gray-400 hover:text-gray-700 transition-colors">✕</button>
      </div>
    </div>
  );
}
