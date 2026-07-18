export function UpdatePill({
  version,
  installing,
  progress,
  error,
  onUpdate,
  onSkip,
  onDismiss,
}: {
  version: string;
  installing: boolean;
  progress: number | null;
  error: string | null;
  onUpdate: () => void;
  onSkip: () => void;
  onDismiss: () => void;
}) {
  return (
    <div className="fixed right-5 bottom-5 z-[80] animate-pill-in">
      <div
        role="status"
        aria-live="polite"
        className="flex items-center gap-3 rounded-full border border-gray-200 bg-white pl-4 pr-2 py-2 shadow-xl"
      >
        <span className="text-sm text-gray-700 whitespace-nowrap">New version available{version ? ` · v${version}` : ""}</span>
        {error
          ? <span className="text-xs text-red-500 max-w-40 truncate" title={error}>{error}</span>
          : null}
        <button
          onClick={onUpdate}
          disabled={installing}
          className="px-3.5 py-1.5 text-xs font-medium bg-gray-900 text-white rounded-full hover:bg-gray-800 transition-colors disabled:opacity-60 whitespace-nowrap"
        >
          {installing ? (progress != null ? `${progress}%` : "…") : "Update"}
        </button>
        <button
          onClick={onSkip}
          disabled={installing}
          title="Skip this version"
          className="text-xs text-gray-400 hover:text-gray-600 transition-colors"
        >
          skip
        </button>
        <button
          onClick={onDismiss}
          disabled={installing}
          title="Later"
          aria-label="Dismiss"
          className="p-1 text-gray-400 hover:text-gray-700 transition-colors"
        >
          ✕
        </button>
      </div>
    </div>
  );
}
