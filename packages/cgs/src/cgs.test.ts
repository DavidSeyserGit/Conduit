import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  CgsArtifactUnionSchema, CGS_VERSION, deserializeCgsArtifact, parseGoalSpecification,
  serializeCgsArtifact, validateAnswersForBatch, validateGoalSpecification,
} from "./index.ts";

const examples = fileURLToPath(new URL("../examples", import.meta.url));
const schemas = fileURLToPath(new URL("../schemas", import.meta.url));

test("every packaged CGS example validates", async () => {
  for (const file of await readdir(examples)) {
    if (!file.endsWith(".json")) continue;
    const value = JSON.parse(await readFile(`${examples}/${file}`, "utf8"));
    assert.equal(CgsArtifactUnionSchema.safeParse(value).success, true, file);
  }
});

test("all required JSON Schemas are checked in and valid JSON", async () => {
  const required = ["goal.schema.json", "question.schema.json", "review.schema.json", "evidence.schema.json", "report.schema.json", "run.schema.json"];
  assert.deepEqual((await readdir(schemas)).sort(), required.sort());
  for (const file of required) assert.equal(JSON.parse(await readFile(`${schemas}/${file}`, "utf8")).$schema, "https://json-schema.org/draft/2020-12/schema");
});

test("goal parsing rejects incompatible versions and invalid approved goals", async () => {
  const source = JSON.parse(await readFile(`${examples}/feature-goal.cgs.json`, "utf8"));
  assert.equal(parseGoalSpecification(source).cgsVersion, CGS_VERSION);
  assert.equal(validateGoalSpecification({ ...source, cgsVersion: "1.0.0" }).valid, false);
  assert.equal(validateGoalSpecification({ ...source, successCriteria: [] }).valid, false);
});

test("serialization preserves unknown minor fields", async () => {
  const source = JSON.parse(await readFile(`${examples}/feature-goal.cgs.json`, "utf8"));
  source.extensionField = { retained: true };
  const roundTrip = deserializeCgsArtifact(serializeCgsArtifact(source));
  assert.deepEqual(roundTrip.extensionField, { retained: true });
});

test("answer validation enforces required questions and declared option values", async () => {
  const batch = CgsArtifactUnionSchema.parse(JSON.parse(await readFile(`${examples}/clarification.cgs.json`, "utf8")));
  assert.equal(batch.kind, "question-batch");
  if (batch.kind !== "question-batch") return;
  const base = { cgsVersion: CGS_VERSION, kind: "answer-batch" as const, id: "answers_1", createdAt: "2026-07-18T12:02:00Z", goalId: batch.goalId, questionBatchId: batch.id };
  assert.equal(validateAnswersForBatch(batch, { ...base, answers: [] }).valid, false);
  assert.equal(validateAnswersForBatch(batch, { ...base, answers: [{ questionId: "question_delivery", value: "push", answeredAt: "2026-07-18T12:02:00Z", answeredBy: "user" }] }).valid, false);
  assert.equal(validateAnswersForBatch(batch, { ...base, answers: [{ questionId: "question_delivery", value: "email", answeredAt: "2026-07-18T12:02:00Z", answeredBy: "user" }] }).valid, true);
});
