import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const server = process.env.CONDUIT_SMOKE_SERVER || "http://[::1]:1420";
const requestedProvider = process.argv.includes("--provider")
  ? process.argv[process.argv.indexOf("--provider") + 1]
  : "all";
const workerProvider = process.argv.includes("--worker")
  ? process.argv[process.argv.indexOf("--worker") + 1]
  : undefined;
const providers = requestedProvider === "all" ? ["kilo", "codex"] : [requestedProvider];

for (const provider of providers) {
  if (provider !== "kilo" && provider !== "codex") {
    throw new Error(`Unsupported smoke provider: ${provider}`);
  }
  await smokeJudge(provider);
}

if (workerProvider) {
  if (workerProvider !== "kilo" && workerProvider !== "codex") {
    throw new Error(`Unsupported worker smoke provider: ${workerProvider}`);
  }
  await smokeWorker(workerProvider);
}

async function smokeJudge(provider) {
  const startedAt = performance.now();
  const modelId = provider === "kilo"
    ? process.env.CONDUIT_SMOKE_KILO_MODEL || "kilo/kilo/kilo-auto/free"
    : process.env.CONDUIT_SMOKE_CODEX_MODEL || "codex/gpt-5.6-sol";
  const body = {
    workspace: process.cwd(),
    modelId,
    reasoningEffort: provider === "codex" ? "low" : undefined,
    messages: [
      { role: "system", content: "Return only a valid implementation plan." },
      { role: "user", content: "Plan a one-line product-title rename." },
    ],
    structuredOutput: { name: "implementation_plan", schema: planSchema() },
  };
  const endpoint = provider === "kilo" ? "/api/agent/kilo-chat" : "/api/codex/response";
  const response = await fetch(`${server}${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  const result = await readResult(response);
  assertPlan(result.structuredOutput);
  process.stdout.write(`${provider} judge smoke passed in ${seconds(startedAt)}s (${modelId})\n`);
}

async function smokeWorker(provider) {
  const root = await mkdtemp(path.join(tmpdir(), `conduit-${provider}-worker-`));
  try {
    await writeFile(path.join(root, "README.md"), "# Old Product\n", "utf8");
    await execFileAsync("git", ["init"], { cwd: root });
    await execFileAsync("git", ["add", "README.md"], { cwd: root });
    await execFileAsync(
      "git",
      ["-c", "user.name=Conduit Smoke", "-c", "user.email=smoke@conduit.local", "commit", "-m", "fixture"],
      { cwd: root },
    );
    const modelId = provider === "kilo"
      ? process.env.CONDUIT_SMOKE_KILO_MODEL || "kilo/kilo/kilo-auto/free"
      : process.env.CONDUIT_SMOKE_CODEX_MODEL || "codex/gpt-5.6-sol";
    const startedAt = performance.now();
    const response = await fetch(`${server}/api/agent/pi-iteration`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspace: root,
        goal: "In README.md, replace exactly '# Old Product' with '# FarmBot', then verify the file. Do not change anything else.",
        modelId,
        iteration: 1,
        maxIterations: 1,
        codingReasoningEffort: provider === "codex" ? "low" : undefined,
      }),
      signal: AbortSignal.timeout(180_000),
    });
    const result = await readResult(response);
    const readme = await readFile(path.join(root, "README.md"), "utf8");
    assert.equal(readme, "# FarmBot\n");
    assert.ok(result.changedFiles?.includes("README.md"), "worker result must report README.md");
    process.stdout.write(`${provider} worker smoke passed in ${seconds(startedAt)}s (${modelId})\n`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function readResult(response) {
  const text = await response.text();
  if (!response.ok) throw new Error(text || `HTTP ${response.status}`);
  let result;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const packet = JSON.parse(line);
    if (packet.error) throw new Error(packet.error);
    if (packet.result) result = packet.result;
  }
  if (!result) throw new Error(`Harness response contained no result: ${text}`);
  return result;
}

function assertPlan(value) {
  assert.ok(value && typeof value === "object", "judge must return structured output");
  assert.equal(typeof value.summary, "string");
  assert.ok(Array.isArray(value.tasks) && value.tasks.length > 0, "plan must contain tasks");
  for (const task of value.tasks) {
    assert.equal(typeof task.id, "string");
    assert.equal(typeof task.description, "string");
    assert.equal(task.status, "pending");
  }
}

function planSchema() {
  return {
    type: "object",
    properties: {
      summary: { type: "string" },
      tasks: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            description: { type: "string" },
            status: { type: "string", enum: ["pending"] },
          },
          required: ["id", "description", "status"],
          additionalProperties: false,
        },
      },
    },
    required: ["summary", "tasks"],
    additionalProperties: false,
  };
}

function seconds(startedAt) {
  return ((performance.now() - startedAt) / 1_000).toFixed(1);
}
