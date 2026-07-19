import { invoke } from "@tauri-apps/api/core";
import { reportToJSON, reportToMarkdown } from "@conduit/runtime";
import type { GoalReport } from "@conduit/cgs/legacy";
import { renderReportJson, renderReportMarkdown, type GoalReport as CgsGoalReport } from "@conduit/cgs";

export async function exportGoalReport(report: GoalReport | CgsGoalReport, format: "markdown" | "json"): Promise<boolean> {
  const maxReportBytes = 2 * 1024 * 1024;
  const extension = format === "markdown" ? "md" : "json";
  const content = isCgsReport(report)
    ? format === "markdown" ? renderReportMarkdown(report) : `${renderReportJson(report)}\n`
    : format === "markdown" ? reportToMarkdown(report) : `${JSON.stringify(reportToJSON(report, report.generatedAt), null, 2)}\n`;
  if (new TextEncoder().encode(content).byteLength > maxReportBytes) {
    throw new Error("Report export exceeds the 2 MiB safety limit");
  }
  const filename = `conduit-report-${report.runId.slice(0, 8)}.${extension}`;
  if ((window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__) {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const path = await save({ defaultPath: filename, filters: [{ name: format === "markdown" ? "Markdown" : "JSON", extensions: [extension] }] });
    if (!path) return false;
    await invoke("report_export_write", { path, content });
    return true;
  }
  const blob = new Blob([content], { type: format === "markdown" ? "text/markdown" : "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
  return true;
}

function isCgsReport(report: GoalReport | CgsGoalReport): report is CgsGoalReport {
  return (report as { kind?: unknown }).kind === "report" && (report as { cgsVersion?: unknown }).cgsVersion === "0.1.0";
}
