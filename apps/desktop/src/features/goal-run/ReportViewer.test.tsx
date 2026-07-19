import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("professional report UI has outcome-first views, grouped reviews, artifacts, and exports", () => {
  const viewer = readFileSync(new URL("./ReportViewer.tsx", import.meta.url), "utf8");
  const timeline = readFileSync(new URL("./ExecutionTimeline.tsx", import.meta.url), "utf8");
  const exporter = readFileSync(new URL("../../lib/report-export.ts", import.meta.url), "utf8");

  for (const view of ["summary", "goal", "changes", "evidence", "reviews"]) {
    assert.match(viewer, new RegExp(`id: "${view}"`));
    assert.match(viewer, new RegExp(`report-panel-${view}`));
  }
  assert.match(viewer, /All completion gates passed/);
  assert.match(viewer, /Needs attention/);
  assert.match(viewer, /Previous rounds/);
  assert.match(viewer, /not applicable/);
  assert.match(viewer, /aria-haspopup="menu"/);
  assert.match(viewer, />\s*Export\s*</);
  assert.match(viewer, /Readable project report/);
  assert.match(viewer, /Structured report data/);
  assert.match(viewer, /report-evidence-\$\{item\.id\}/);
  assert.match(viewer, /report-review-\$\{group\.reviewerId\}/);
  assert.match(viewer, /Artifact unavailable:/);
  assert.match(viewer, /runExport\("markdown"\)/);
  assert.match(viewer, /runExport\("json"\)/);
  assert.match(viewer, /Could not export report:/);
  assert.match(viewer, /CanonicalReportViewer/);
  assert.match(viewer, /CGS \{report\.cgsVersion\} report/);
  assert.match(timeline, /runHistory\.find[\s\S]*\.report/);
  assert.match(timeline, /\.cgsReport/);
  assert.match(timeline, /View report/);
  assert.match(exporter, /plugin-dialog/);
  assert.match(exporter, /report_export_write/);
  assert.match(exporter, /URL\.createObjectURL/);
});
