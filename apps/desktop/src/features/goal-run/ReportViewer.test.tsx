import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("professional report UI links sections, evidence, findings, artifacts, and exports", () => {
  const viewer = readFileSync(new URL("./ReportViewer.tsx", import.meta.url), "utf8");
  const timeline = readFileSync(new URL("./ExecutionTimeline.tsx", import.meta.url), "utf8");
  const exporter = readFileSync(new URL("../../lib/report-export.ts", import.meta.url), "utf8");

  for (const section of ["overview", "goal", "clarifications", "implementation", "criteria", "evidence", "reviews", "decision"]) {
    assert.match(viewer, new RegExp(`id="${section}"`));
  }
  assert.match(viewer, /#report-\$\{target\}-\$\{id\}/);
  assert.match(viewer, /report-evidence-\$\{item\.id\}/);
  assert.match(viewer, /report-finding-\$\{finding\.id\}/);
  assert.match(viewer, /Artifact unavailable:/);
  assert.match(viewer, /runExport\("markdown"\)/);
  assert.match(viewer, /runExport\("json"\)/);
  assert.match(viewer, /Could not export report:/);
  assert.match(timeline, /runHistory\.find[\s\S]*\.report/);
  assert.match(timeline, /View report/);
  assert.match(exporter, /plugin-dialog/);
  assert.match(exporter, /report_export_write/);
  assert.match(exporter, /URL\.createObjectURL/);
});
