export function WhatsNewDialog({
  version,
  body,
  publishedAt,
  onClose,
}: {
  version: string;
  body: string;
  publishedAt?: string;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/20 p-4">
      <div role="dialog" aria-label={`What's new in v${version}`} className="w-[min(92vw,480px)] rounded-2xl border border-gray-200 bg-white p-5 shadow-2xl space-y-4">
        <div>
          <div className="text-base font-semibold text-gray-900">What&apos;s new in v{version}</div>
          {publishedAt && <div className="text-xs text-gray-400 mt-0.5">{new Date(publishedAt).toLocaleDateString()}</div>}
        </div>
        <div className="max-h-72 overflow-y-auto rounded-xl bg-gray-50 p-3 text-sm text-gray-700 whitespace-pre-wrap">{body}</div>
        <div className="flex justify-end">
          <button onClick={onClose} className="px-4 py-2 text-sm bg-gray-900 text-white rounded-lg font-medium hover:bg-gray-800 transition-colors">
            Got it
          </button>
        </div>
      </div>
    </div>
  );
}
