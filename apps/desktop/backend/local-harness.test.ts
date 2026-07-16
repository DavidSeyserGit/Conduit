import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import {
  KiloEventCollector,
  buildCodexJudgeArgs,
  buildCodexWorkerArgs,
  buildJudgePrompt,
  buildKiloArgs,
  buildKiloSecurityConfig,
  buildWorkerPrompt,
  parseKiloModelCatalog,
  runCodexProcess,
  runKiloProcess,
  toCanonicalKiloModelId,
  toKiloRuntimeModelId,
  toRuntimeModelId,
  tryParseStructuredOutput,
} from "./local-harness.ts";

test("provider model IDs have one explicit application namespace", () => {
  assert.equal(toRuntimeModelId("codex", "codex/gpt-5.6"), "gpt-5.6");
  assert.equal(toCanonicalKiloModelId("kilo/kilo-auto/free"), "kilo/kilo/kilo-auto/free");
  assert.equal(toKiloRuntimeModelId("kilo/kilo/kilo-auto/free"), "kilo/kilo-auto/free");
  assert.equal(toKiloRuntimeModelId("kilo/kilo-auto/free"), "kilo/kilo-auto/free");
  assert.throws(() => toRuntimeModelId("codex", "openrouter/gpt"), /Invalid codex model ID/);
  assert.throws(() => toKiloRuntimeModelId("openrouter/model"), /Invalid Kilo model ID/);
});

test("Kilo catalog exposes canonical IDs and required capabilities", () => {
  const models = parseKiloModelCatalog([
    "diagnostic noise",
    "kilo/~anthropic/claude-sonnet-latest",
    "kilo/kilo-auto/free",
    "",
  ].join("\n"));

  assert.deepEqual(models.map((model) => model.id), [
    "kilo/kilo/~anthropic/claude-sonnet-latest",
    "kilo/kilo/kilo-auto/free",
  ]);
  assert.equal(models[0]?.provider, "kilo");
  assert.equal(models[0]?.supportsAsk, true);
  assert.equal(models[0]?.supportsGoal, true);
  assert.equal(models[0]?.supportsJudge, true);
});

test("judge prompt is tool-free and carries the exact schema and transcript", () => {
  const prompt = buildJudgePrompt(
    [
      { role: "system", content: "Plan carefully" },
      { role: "user", content: "Rename the title" },
    ],
    {
      name: "implementation_plan",
      schema: { type: "object", required: ["summary"] },
    },
  );

  assert.match(prompt, /Do not inspect or modify the workspace and do not call tools/);
  assert.match(prompt, /implementation_plan schema exactly/);
  assert.match(prompt, /"required":\["summary"\]/);
  assert.match(prompt, /## system\nPlan carefully/);
  assert.match(prompt, /## user\nRename the title/);
});

test("worker prompt includes iteration, plan, feedback, and validation duty", () => {
  const prompt = buildWorkerPrompt({
    goal: "Rename the title",
    iteration: 2,
    maxIterations: 3,
    previousPlan: { summary: "Rename", tasks: [] },
    judgeFeedback: ["Update metadata", "Run the build"],
  });

  assert.match(prompt, /Iteration: 2 of 3/);
  assert.match(prompt, /Previous plan:/);
  assert.match(prompt, /1\. Update metadata/);
  assert.match(prompt, /2\. Run the build/);
  assert.match(prompt, /validate them/);
});

test("Kilo role policy keeps judges read-only and workers autonomous", () => {
  const judge = buildKiloArgs("/repo", "kilo/free", "prompt", "judge");
  const worker = buildKiloArgs("/repo", "kilo/free", "prompt", "worker");

  assert.deepEqual(judge, [
    "run", "--format", "json", "--dir", "/repo", "--model", "kilo/free",
    "--pure", "--agent", "ask", "prompt",
  ]);
  assert.equal(judge.includes("--auto"), false);
  assert.equal(judge.includes("--dangerously-skip-permissions"), false);
  assert.equal(worker.includes("--agent"), true);
  assert.equal(worker.includes("code"), true);
  assert.equal(worker.includes("--auto"), false);
  assert.equal(worker.includes("--dangerously-skip-permissions"), false);
  assert.equal(worker.includes("--pure"), true);
});

test("Kilo worker security config enforces command policy and workspace boundaries", () => {
  const safe = JSON.parse(buildKiloSecurityConfig("worker", "auto_approve_safe"));
  assert.equal(safe.permission.external_directory, "deny");
  assert.equal(safe.permission.bash["*"], "deny");
  assert.equal(safe.permission.bash["git status *"], "allow");
  assert.deepEqual(safe.agent.code.permission, safe.permission);
  if (process.platform !== "win32") {
    assert.equal(safe.sandbox.enabled, true);
    assert.equal(safe.sandbox.network, "deny");
  }
  assert.equal(JSON.parse(buildKiloSecurityConfig("worker", "ask_every_time")).permission.bash, "deny");
  assert.equal(JSON.parse(buildKiloSecurityConfig("worker", "auto_approve_all")).permission.bash, "allow");
  assert.throws(() => buildKiloSecurityConfig("worker", "invalid" as never), /Invalid command permission mode/);
});

test("Codex role policy isolates judge and worker command flags", () => {
  const judge = buildCodexJudgeArgs({
    root: "/repo",
    runtimeModelId: "gpt-5.6",
    prompt: "judge",
    outputFile: "/tmp/result.json",
    schemaFile: "/tmp/schema.json",
    reasoningEffort: "low",
  });
  const worker = buildCodexWorkerArgs({
    root: "/repo",
    runtimeModelId: "gpt-5.6",
    prompt: "work",
    outputFile: "/tmp/result.txt",
    reasoningEffort: "high",
  });

  assert.equal(judge.includes("read-only"), true);
  assert.equal(judge.includes("--ignore-rules"), true);
  assert.equal(judge.includes("--output-schema"), true);
  assert.equal(judge.includes("--dangerously-bypass-approvals-and-sandbox"), false);
  assert.equal(worker.includes("--dangerously-bypass-approvals-and-sandbox"), false);
  assert.equal(worker.includes("workspace-write"), true);
  assert.equal(worker.includes("--ignore-user-config"), true);
  assert.equal(worker.includes("approval_policy=\"never\""), true);
  assert.equal(worker.includes("sandbox_workspace_write.network_access=false"), true);
  assert.equal(worker.includes("--output-schema"), false);
  assert.equal(judge[judge.length - 1], "judge");
  assert.equal(worker[worker.length - 1], "work");
});

test("structured output parser handles raw JSON, fenced JSON, braces in strings, and malformed output", () => {
  assert.deepEqual(tryParseStructuredOutput('{"summary":"ok"}'), { summary: "ok" });
  assert.deepEqual(
    tryParseStructuredOutput('Result:\n```json\n{"summary":"use {braces} safely","tasks":[]}\n```'),
    { summary: "use {braces} safely", tasks: [] },
  );
  assert.equal(tryParseStructuredOutput("not json"), undefined);
  assert.equal(tryParseStructuredOutput('{"summary":'), undefined);
});

test("Kilo event collector accumulates text and tracks a complete tool lifecycle", () => {
  const statuses: string[] = [];
  const updates: string[] = [];
  let time = 0;
  const collector = new KiloEventCollector(
    (status) => statuses.push(status),
    (toolCall) => updates.push(`${toolCall.id}:${toolCall.status}`),
    () => `time-${time += 1}`,
    () => "generated-id",
  );

  collector.consume("not-json");
  collector.consume('{"type":"step_start"}');
  collector.consume('{"type":"text","text":"hello "}');
  collector.consume('{"part":{"type":"text","text":"world"}}');
  collector.consume('{"type":"tool_call","toolCallId":"call-1","toolName":"read_file","arguments":{"path":"README.md"}}');
  collector.consume('{"type":"tool_result","toolCallId":"call-1","result":"contents"}');
  collector.consume('{"type":"step_finish"}');

  const result = collector.result();
  assert.equal(result.summary, "hello world");
  assert.deepEqual(statuses, ["Kilo started a step…", "Kilo finished a step"]);
  assert.deepEqual(updates, ["call-1:running", "call-1:completed"]);
  assert.deepEqual(result.toolCalls[0], {
    id: "call-1",
    name: "read_file",
    arguments: { path: "README.md" },
    status: "completed",
    startedAt: "time-1",
    completedAt: "time-2",
    result: "contents",
  });
});

test("Codex process runner closes stdin and preserves stderr failures", async () => {
  let stdinEnded = false;
  const successfulExec = ((
    _file: string,
    _args: readonly string[],
    _options: unknown,
    callback: (error: Error | null, stdout: string, stderr: string) => void,
  ) => {
    queueMicrotask(() => callback(null, "output", ""));
    return { stdin: { end: () => { stdinEnded = true; } } };
  }) as unknown as typeof execFile;

  const result = await runCodexProcess(
    ["exec", "prompt"],
    "/repo",
    new AbortController().signal,
    1_000,
    successfulExec,
  );
  assert.equal(stdinEnded, true);
  assert.deepEqual(result, { stdout: "output", stderr: "" });

  const failingExec = ((
    _file: string,
    _args: readonly string[],
    _options: unknown,
    callback: (error: Error | null, stdout: string, stderr: string) => void,
  ) => {
    queueMicrotask(() => callback(new Error("generic"), "", "specific failure"));
    return { stdin: { end: () => {} } };
  }) as unknown as typeof execFile;
  await assert.rejects(
    runCodexProcess(["exec"], "/repo", new AbortController().signal, 1_000, failingExec),
    /specific failure/,
  );
});

test("Kilo process runner parses successful output and propagates CLI failures", async () => {
  const success = fakeChildProcess();
  const successRun = runKiloProcess(
    "/repo",
    "kilo/free",
    "prompt",
    new AbortController().signal,
    () => {},
    () => {},
    "judge",
    "auto_approve_safe",
    1_000,
    (() => success.child) as unknown as typeof spawn,
  );
  success.stdout.write('{"type":"text","text":"done"}\n');
  success.child.emit("close", 0);
  assert.deepEqual(await successRun, { summary: "done", toolCalls: [] });

  const failure = fakeChildProcess();
  const failedRun = runKiloProcess(
    "/repo",
    "kilo/free",
    "prompt",
    new AbortController().signal,
    () => {},
    () => {},
    "judge",
    "auto_approve_safe",
    1_000,
    (() => failure.child) as unknown as typeof spawn,
  );
  failure.stderr.write("authentication failed");
  failure.child.emit("close", 2);
  await assert.rejects(failedRun, /authentication failed/);
});

test("Kilo process runner terminates promptly on cancellation and timeout", async () => {
  const cancelled = fakeChildProcess();
  const controller = new AbortController();
  const cancelledRun = runKiloProcess(
    "/repo",
    "kilo/free",
    "prompt",
    controller.signal,
    () => {},
    () => {},
    "judge",
    "auto_approve_safe",
    1_000,
    (() => cancelled.child) as unknown as typeof spawn,
  );
  controller.abort();
  await assert.rejects(cancelledRun, /cancelled before completion/);
  assert.deepEqual(cancelled.kills, ["SIGTERM"]);

  const timedOut = fakeChildProcess();
  const timedOutRun = runKiloProcess(
    "/repo",
    "kilo/free",
    "prompt",
    new AbortController().signal,
    () => {},
    () => {},
    "judge",
    "auto_approve_safe",
    5,
    (() => timedOut.child) as unknown as typeof spawn,
  );
  await assert.rejects(timedOutRun, /timed out after 5ms/);
  assert.deepEqual(timedOut.kills, ["SIGTERM"]);
});

function fakeChildProcess() {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const kills: string[] = [];
  const child = Object.assign(new EventEmitter(), {
    stdout,
    stderr,
    kill(signal: string) {
      kills.push(signal);
      queueMicrotask(() => child.emit("close", null));
      return true;
    },
  });
  return { child, stdout, stderr, kills };
}
