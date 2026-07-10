import { useMemo, useState } from "react";
import { useAppStore } from "@/stores/app-store";

type DiffFile = {
  path: string;
  lines: string[];
  additions: number;
  deletions: number;
};

function parseDiff(diff: string): DiffFile[] {
  return diff.split(/(?=^diff --git )/m).filter(Boolean).map((chunk) => {
    const path = chunk.match(/^\+\+\+ b\/(.*)$/m)?.[1] || chunk.match(/^diff --git a\/.* b\/(.*)$/m)?.[1] || "Changed file";
    const lines = chunk.split("\n");
    return {
      path,
      lines,
      additions: lines.filter((line) => line.startsWith("+") && !line.startsWith("+++" )).length,
      deletions: lines.filter((line) => line.startsWith("-") && !line.startsWith("---" )).length,
    };
  });
}

export function GitDiffPanel() {
  const diff = useAppStore((s) => s.gitDiff);
  const loading = useAppStore((s) => s.gitDiffLoading);
  const open = useAppStore((s) => s.showGitDiff);
  const close = useAppStore((s) => s.closeGitDiff);
  const refresh = useAppStore((s) => s.openGitDiff);
  const files = useMemo(() => parseDiff(diff), [diff]);
  const [selectedPath, setSelectedPath] = useState("");
  const selected = files.find((file) => file.path === selectedPath) || files[0];
  const additions = files.reduce((total, file) => total + file.additions, 0);
  const deletions = files.reduce((total, file) => total + file.deletions, 0);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/20" onMouseDown={(event) => event.target === event.currentTarget && close()}>
      <section className="w-full max-w-[760px] h-full bg-white border-l border-gray-200 shadow-xl flex flex-col">
        <header className="px-5 py-4 border-b border-gray-100 flex items-start justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold text-gray-900">Git changes</h2>
            <div className="flex items-center gap-3 mt-1 text-xs text-gray-500">
              <span>{files.length} {files.length === 1 ? "file" : "files"}</span>
              <span className="text-emerald-600">+{additions}</span>
              <span className="text-red-600">-{deletions}</span>
            </div>
          </div>
          <div className="flex items-center gap-1">
            <button onClick={() => void refresh()} className="p-2 text-gray-500 hover:text-gray-900 hover:bg-gray-100 rounded-lg" title="Refresh Git diff" aria-label="Refresh Git diff">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M20 11a8.1 8.1 0 0 0-15.5-2M4 5v4h4M4 13a8.1 8.1 0 0 0 15.5 2M20 19v-4h-4" /></svg>
            </button>
            <button onClick={close} className="p-2 text-gray-500 hover:text-gray-900 hover:bg-gray-100 rounded-lg" title="Close Git diff" aria-label="Close Git diff">x</button>
          </div>
        </header>

        {loading ? <div className="p-6 text-sm text-gray-500">Loading changes...</div> : !files.length ? (
          <div className="flex-1 flex items-center justify-center text-sm text-gray-500">No uncommitted changes in this workspace.</div>
        ) : (
          <div className="flex-1 min-h-0 flex">
            <aside className="w-[220px] shrink-0 border-r border-gray-100 overflow-y-auto py-2">
              {files.map((file) => <button key={file.path} onClick={() => setSelectedPath(file.path)} className={`w-full px-4 py-2 text-left hover:bg-gray-50 ${selected?.path === file.path ? "bg-gray-100" : ""}`}>
                <div className="text-xs font-medium text-gray-800 truncate" title={file.path}>{file.path}</div>
                <div className="text-[11px] mt-1"><span className="text-emerald-600">+{file.additions}</span><span className="text-red-600 ml-2">-{file.deletions}</span></div>
              </button>)}
            </aside>
            <div className="flex-1 min-w-0 overflow-auto bg-gray-950">
              <div className="px-4 py-2 text-xs text-gray-300 border-b border-gray-800 truncate">{selected?.path}</div>
              <pre className="text-[11px] leading-5 font-mono whitespace-pre min-w-max">
                {selected?.lines.map((line, index) => {
                  const added = line.startsWith("+") && !line.startsWith("+++");
                  const removed = line.startsWith("-") && !line.startsWith("---");
                  const header = line.startsWith("@@");
                  return <div key={`${index}-${line}`} className={`px-4 ${added ? "bg-emerald-950 text-emerald-200" : removed ? "bg-red-950 text-red-200" : header ? "bg-blue-950 text-blue-200" : "text-gray-300"}`}>{line || " "}</div>;
                })}
              </pre>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
