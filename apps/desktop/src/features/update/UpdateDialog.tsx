export function UpdateDialog({
  version,
  body,
  installing,
  progress,
  error,
  onUpdate,
  onLater,
  onSkip,
}: {
  version: string;
  body?: string;
  installing: boolean;
  progress: number | null;
  error: string | null;
  onUpdate: () => void;
  onLater: () => void;
  onSkip: () => void;
}) {
  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/20 p-4">
      <div role="dialog" aria-modal="true" aria-label="Update available" className="w-[min(92vw,440px)] rounded-2xl border border-gray-200 bg-white p-5 shadow-2xl space-y-4">
        <div>
          <div className="text-base font-semibold text-gray-900">Update available</div>
          <div className="text-sm text-gray-500 mt-0.5">Conduit v{version} is ready to install.</div>
        </div>
        {body && (
          <div className="max-h-48 overflow-y-auto rounded-xl bg-gray-50 p-3 text-xs text-gray-700 whitespace-pre-wrap">{body}</div>
        )}
        {error && <div className="text-xs text-red-500">{error}</div>}
        <div className="flex items-center justify-between gap-2">
          <button onClick={onSkip} disabled={installing} className="text-xs text-gray-400 hover:text-gray-600 transition-colors">
            Skip this version
          </button>
          <div className="flex gap-2">
            <button onClick={onLater} disabled={installing} className="px-3.5 py-2 text-sm border border-gray-200 rounded-lg text-gray-700 hover:bg-gray-50 transition-colors">
              Later
            </button>
            <button onClick={onUpdate} disabled={installing} className="px-3.5 py-2 text-sm bg-gray-900 text-white rounded-lg font-medium hover:bg-gray-800 transition-colors disabled:opacity-60">
              {installing ? (progress != null ? `Downloading ${progress}%` : "Downloading…") : "Update now"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
