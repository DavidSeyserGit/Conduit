import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import { runWorkspaceCommand } from "./dev-server/workspace-command.ts";
import { captureGitSnapshot, getScopedGitDiff } from "@conduit/tools/node";
import { AuthStorage, ModelRegistry, SessionManager, createAgentSession } from "@mariozechner/pi-coding-agent";
import {
  buildCodexJudgeArgs,
  buildCodexWorkerArgs,
  buildJudgePrompt,
  buildWorkerPrompt,
  parseKiloModelCatalog,
  runCodexProcess,
  runKiloProcess,
  toKiloRuntimeModelId,
  toRuntimeModelId,
  tryParseStructuredOutput,
} from "./backend/local-harness.ts";

const githubClientId = process.env.GITHUB_CLIENT_ID || "Ov23liMo1oJoAzSI7573";
const sessions = new Map<string, { token?: string; device?: { device_code: string; interval: number } }>();
const execFileAsync = promisify(execFile);
const workspaceRoot = process.env.LOOPKIT_WORKSPACE_ROOT || path.resolve(process.cwd(), "workspaces");
const AGENT_TIMEOUT_MS = 20 * 60 * 1000;

function nextGitHubPage(link: string | null): string | null {
  return link?.match(/<([^>]+)>;\s*rel="next"/)?.[1] ?? null;
}

async function readJson(req: any) {
  let body = "";
  for await (const chunk of req) body += chunk;
  return JSON.parse(body || "{}");
}

function createAgentStream(res: any) {
  res.setHeader("Content-Type", "application/x-ndjson");
  let closed = false;
  res.once?.("close", () => { closed = true; });
  const send = (payload: unknown) => {
    if (closed || res.writableEnded || res.destroyed) return false;
    try {
      return res.write(`${JSON.stringify(payload)}\n`);
    } catch {
      closed = true;
      return false;
    }
  };
  const status = (message: string) => send({ event: { type: "agent_status", message } });
  const heartbeat = (
    provider: string,
    source: "process" | "network",
    detail: string,
  ) => {
    const startedAt = new Date().toISOString();
    const sendHeartbeat = () => send({ event: { type: "agent_heartbeat", provider, at: new Date().toISOString(), startedAt, phase: "coding", source, detail } });
    sendHeartbeat();
    const timer = setInterval(sendHeartbeat, 10_000);
    return () => clearInterval(timer);
  };
  return { send, status, heartbeat };
}

function attachRequestAbort(req: any, res: any): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const abort = () => controller.abort();
  req.once?.("aborted", abort);
  res.once?.("close", () => {
    if (!res.writableEnded) abort();
  });
  return {
    signal: controller.signal,
    cleanup: () => req.removeListener?.("aborted", abort),
  };
}

function workspacePath(workspace: string, relative = ".") {
  const root = path.resolve(workspace);
  const target = path.resolve(root, relative);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new Error("Path outside workspace");
  return target;
}

async function walk(dir: string, root: string, output: any[], depth: number, maxDepth: number) {
  if (depth > maxDepth) return;
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || ["node_modules", "dist", "target", "build"].includes(entry.name)) continue;
    const absolute = path.join(dir, entry.name);
    const relative = path.relative(root, absolute);
    if (entry.isDirectory()) {
      output.push({ name: entry.name, path: relative, type: "directory", size: null });
      await walk(absolute, root, output, depth + 1, maxDepth);
    } else if (entry.isFile()) {
      output.push({ name: entry.name, path: relative, type: "file", size: (await fs.stat(absolute)).size });
    }
  }
}

function githubApi() {
  return {
    name: "github-oauth-api",
    configureServer(server: { middlewares: { use: (handler: (req: any, res: any, next: () => void) => void) => void } }) {
      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith("/api/github/") && !req.url?.startsWith("/api/workspace/") && !req.url?.startsWith("/api/agent/") && !req.url?.startsWith("/api/codex/") && !req.url?.startsWith("/api/kilo/")) return next();
        const cookies = Object.fromEntries((req.headers.cookie || "").split(";").filter(Boolean).map((part: string) => part.trim().split("=")));
        const sessionId = cookies.loopkit_session || randomUUID();
        const session = sessions.get(sessionId) || {};
        sessions.set(sessionId, session);
        res.setHeader("Set-Cookie", `loopkit_session=${sessionId}; HttpOnly; SameSite=Lax; Path=/`);
        res.setHeader("Content-Type", "application/json");

        if (req.url === "/api/codex/models" && req.method === "GET") {
          try {
            const cachePath = path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "models_cache.json");
            const cache = JSON.parse(await fs.readFile(cachePath, "utf8"));
            return res.end(JSON.stringify((cache.models || []).filter((model: any) => model.visibility === "list" && model.supported_in_api !== false)));
          } catch (error: any) { res.statusCode = 503; return res.end(JSON.stringify({ error: `Codex model cache unavailable: ${error.message}` })); }
        }

        if (req.url === "/api/codex/response" && req.method === "POST") {
          let cleanupRequest = () => {};
          let outputFile = "";
          let schemaFile = "";
          try {
            const { workspace, workspacePath: requestedWorkspacePath, modelId, reasoningEffort, messages = [], structuredOutput: requestedStructuredOutput } = await readJson(req);
            const root = path.resolve(workspace || requestedWorkspacePath || workspaceRoot);
            const isClone = root.startsWith(`${path.resolve(workspaceRoot)}${path.sep}`);
            const isGitRepo = await fs.stat(path.join(root, ".git")).then(() => true).catch(() => false);
            if (!isClone && !isGitRepo) throw new Error("Workspace is not a Git repository");
            if (typeof modelId !== "string" || !modelId.startsWith("codex/")) throw new Error("Invalid Codex model");

            const lifecycle = attachRequestAbort(req, res);
            cleanupRequest = lifecycle.cleanup;
            outputFile = path.join(os.tmpdir(), `conduit-codex-response-${randomUUID()}.json`);
            const schemaArgs: string[] = [];
            if (requestedStructuredOutput?.schema) {
              schemaFile = path.join(os.tmpdir(), `conduit-codex-schema-${randomUUID()}.json`);
              await fs.writeFile(schemaFile, JSON.stringify(requestedStructuredOutput.schema), "utf8");
              schemaArgs.push("--output-schema", schemaFile);
            }

            const prompt = buildJudgePrompt(messages, requestedStructuredOutput);
            const codexModel = toRuntimeModelId("codex", modelId);
            await runCodexProcess(
              buildCodexJudgeArgs({
                root,
                runtimeModelId: codexModel,
                prompt,
                outputFile,
                schemaFile: schemaFile || undefined,
                reasoningEffort: typeof reasoningEffort === "string" ? reasoningEffort : undefined,
              }),
              root,
              lifecycle.signal,
            );
            const content = await fs.readFile(outputFile, "utf8");
            let structuredOutput: unknown;
            try { structuredOutput = JSON.parse(content); } catch { /* The caller will handle an invalid structured response. */ }
            return res.end(JSON.stringify({ result: { content, structuredOutput, finishReason: "stop" } }));
          } catch (error: any) {
            res.statusCode = 500;
            return res.end(JSON.stringify({ error: error.message || String(error) }));
          } finally {
            cleanupRequest();
            if (outputFile) await fs.rm(outputFile, { force: true });
            if (schemaFile) await fs.rm(schemaFile, { force: true });
          }
        }

        if (req.url === "/api/kilo/models" && req.method === "GET") {
          try {
            const output = await execFileAsync("kilo", ["models"], { maxBuffer: 20 * 1024 * 1024, timeout: 30_000 });
            const models = parseKiloModelCatalog(output.stdout);
            return res.end(JSON.stringify(models));
          } catch (error: any) { res.statusCode = 503; return res.end(JSON.stringify({ error: `Kilo model discovery failed: ${error.message || String(error)}` })); }
        }

        if (req.url === "/api/workspace/tool" && req.method === "POST") {
          try {
            const { workspace, name, args = {}, mode } = await readJson(req);
            if (mode === "ask" && ["write_file", "replace_in_file", "create_file", "delete_file", "run_command", "get_git_diff", "capture_git_snapshot"].includes(name)) throw new Error(`${name} is not available in Ask mode`);
            const root = path.resolve(workspace);
            const isClone = root.startsWith(`${path.resolve(workspaceRoot)}${path.sep}`);
            const isGitRepo = await fs.stat(path.join(root, ".git")).then(() => true).catch(() => false);
            if (!isClone && !isGitRepo) throw new Error("Workspace is not a cloned Git repository");
            let result: any;
            if (name === "list_files") {
              const entries: any[] = [];
              await walk(workspacePath(workspace, args.path || "."), root, entries, 0, args.max_depth ?? 3);
              result = { path: args.path || ".", entries };
            } else if (name === "read_file") {
              const content = await fs.readFile(workspacePath(workspace, args.path), "utf8");
              const lines = content.split(/\r?\n/); const offset = args.offset || 0; const selected = lines.slice(offset, offset + (args.limit ?? lines.length));
              result = { path: args.path, content: selected.join("\n"), size: Buffer.byteLength(content), truncated: offset > 0 || selected.length < lines.length };
            } else if (name === "search_files") {
              const matches: any[] = []; const query = args.query || "";
              const visit = async (dir: string) => { for (const entry of await fs.readdir(dir, { withFileTypes: true })) { if (matches.length >= 100 || entry.name.startsWith(".") || ["node_modules", "dist", "target", "build"].includes(entry.name)) continue; const absolute = path.join(dir, entry.name); if (entry.isDirectory()) await visit(absolute); else if (entry.isFile()) { const text = await fs.readFile(absolute, "utf8").catch(() => ""); for (const [i, line] of text.split(/\r?\n/).entries()) { const found = args.regex ? new RegExp(query, args.case_sensitive ? "" : "i").test(line) : (args.case_sensitive ? line : line.toLowerCase()).includes(args.case_sensitive ? query : query.toLowerCase()); if (found) matches.push({ path: path.relative(root, absolute), line: i + 1, text: line.trim() }); } } } };
              await visit(root); result = { matches };
            } else if (["write_file", "create_file", "replace_in_file", "delete_file"].includes(name)) {
              const target = workspacePath(workspace, args.path);
              if (name === "delete_file") await fs.unlink(target);
              else if (name === "replace_in_file") { const old = await fs.readFile(target, "utf8"); if (!old.includes(args.search)) throw new Error(`Search string not found in ${args.path}`); await fs.writeFile(target, args.replace_all ? old.replaceAll(args.search, args.replace) : old.replace(args.search, args.replace)); }
              else { if (name === "create_file") { try { await fs.access(target); throw new Error(`File already exists: ${args.path}`); } catch (e: any) { if (e.code !== "ENOENT") throw e; } } await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, args.content); }
              result = { path: args.path };
            } else if (name === "run_command") {
              result = await runWorkspaceCommand(args.command, root);
            } else if (name === "get_git_diff") {
              if (args.baselineTree) result = getScopedGitDiff(root, args.baselineTree, args.path);
              else {
                const output = await execFileAsync("git", ["diff", ...(args.path ? ["--", args.path] : [])], { cwd: root });
                result = { diff: output.stdout, hasChanges: Boolean(output.stdout) };
              }
            } else if (name === "capture_git_snapshot") {
              result = captureGitSnapshot(root);
            } else throw new Error(`Unknown tool: ${name}`);
            return res.end(JSON.stringify({ success: true, result }));
          } catch (error: any) { res.statusCode = 400; return res.end(JSON.stringify({ success: false, error: error.message || String(error) })); }
        }

        if (req.url === "/api/agent/kilo-chat" && req.method === "POST") {
          let cleanupRequest = () => {};
          try {
            const { workspace, modelId, messages = [], structuredOutput } = await readJson(req);
            const root = path.resolve(workspace);
            const isClone = root.startsWith(`${path.resolve(workspaceRoot)}${path.sep}`);
            const isGitRepo = await fs.stat(path.join(root, ".git")).then(() => true).catch(() => false);
            if (!isClone && !isGitRepo) throw new Error("Workspace is not a Git repository");
            const lifecycle = attachRequestAbort(req, res);
            cleanupRequest = lifecycle.cleanup;
            const stream = createAgentStream(res);
            stream.status("Initializing Kilo agent…");
            const prompt = buildJudgePrompt(messages, structuredOutput);
            const kiloModel = toKiloRuntimeModelId(String(modelId));
            const run = await runKiloProcess(
              root,
              kiloModel,
              prompt,
              lifecycle.signal,
              stream.status,
              () => {},
              "judge",
            );
            const parsedStructuredOutput = structuredOutput?.schema
              ? tryParseStructuredOutput(run.summary)
              : undefined;
            if (run.summary) stream.send({ event: { type: "content_delta", content: run.summary } });
            stream.status("Kilo finished");
            cleanupRequest();
            return res.end(JSON.stringify({ result: { content: run.summary, structuredOutput: parsedStructuredOutput, toolCalls: [], finishReason: "stop" } }) + "\n");
          } catch (error: any) {
            cleanupRequest();
            if (res.headersSent && !res.writableEnded && !res.destroyed) {
              res.write(`${JSON.stringify({ error: error.message || String(error) })}\n`);
              return res.end();
            }
            if (!res.headersSent) res.statusCode = 500;
            return res.end(JSON.stringify({ error: error.message || String(error) }));
          }
        }

        if (req.url === "/api/agent/pi-iteration" && req.method === "POST") {
          let cleanupRequest = () => {};
          let activeSession: any;
          try {
            const { workspace, goal, modelId, apiKey, previousPlan, judgeFeedback, iteration, maxIterations, inputPrice, outputPrice, supportsReasoning, codingReasoningEffort, permissionMode } = await readJson(req);
            const root = path.resolve(workspace);
            const isClone = root.startsWith(`${path.resolve(workspaceRoot)}${path.sep}`);
            const isGitRepo = await fs.stat(path.join(root, ".git")).then(() => true).catch(() => false);
            if (!isClone && !isGitRepo) throw new Error("Workspace is not a Git repository");

            if (String(modelId).startsWith("kilo/")) {
              const lifecycle = attachRequestAbort(req, res);
              cleanupRequest = lifecycle.cleanup;
              const stream = createAgentStream(res);
              stream.status("Initializing Kilo agent…");
              const stopHeartbeat = stream.heartbeat("Kilo", "process", "Kilo process confirmed alive");
              const kiloModel = toKiloRuntimeModelId(String(modelId));
              try {
                stream.status(`Starting Kilo ${kiloModel}…`);
                const prompt = buildWorkerPrompt({ goal, iteration, maxIterations, previousPlan, judgeFeedback });
                const toolCalls: any[] = [];
                const run = await runKiloProcess(root, kiloModel, prompt, lifecycle.signal, stream.status, (toolCall) => {
                  const existing = toolCalls.find((item) => item.id === toolCall.id);
                  if (existing) Object.assign(existing, toolCall);
                  else toolCalls.push(toolCall);
                  stream.send({ event: { type: toolCall.status === "completed" ? "tool_completed" : "tool_started", toolCall } });
                }, "worker", permissionMode);
                stream.status("Kilo finished; collecting changes…");
                const diff = await execFileAsync("git", ["diff", "--name-only"], { cwd: root });
                if (run.summary) stream.send({ event: { type: "agent_message", content: run.summary, messageId: randomUUID() } });
                return res.end(JSON.stringify({ result: { changedFiles: diff.stdout.split("\n").filter(Boolean), validationResults: [], agentSummary: run.summary, toolCalls: run.toolCalls, messages: [] } }) + "\n");
              } finally {
                stopHeartbeat();
                cleanupRequest();
              }
            }

            if (String(modelId).startsWith("codex/")) {
              const lifecycle = attachRequestAbort(req, res);
              cleanupRequest = lifecycle.cleanup;
              const stream = createAgentStream(res);
              stream.status("Initializing Codex agent…");
              const outputFile = path.join(workspaceRoot, `.loopkit-codex-${randomUUID()}.txt`);
              const prompt = buildWorkerPrompt({ goal, iteration, maxIterations, previousPlan, judgeFeedback });
              let stopHeartbeat = () => {};
              try {
                const codexModel = toRuntimeModelId("codex", String(modelId));
                stream.status(`Starting Codex ${codexModel}…`);
                stopHeartbeat = stream.heartbeat("Codex", "process", "Codex process confirmed alive");
                await runCodexProcess(
                  buildCodexWorkerArgs({
                    root,
                    runtimeModelId: codexModel,
                    prompt,
                    outputFile,
                    reasoningEffort: typeof codingReasoningEffort === "string" ? codingReasoningEffort : undefined,
                  }),
                  root,
                  lifecycle.signal,
                );
                stream.status("Codex finished; collecting changes…");
                const summary = await fs.readFile(outputFile, "utf8").catch(() => "");
                const diff = await execFileAsync("git", ["diff", "--name-only"], { cwd: root });
                if (summary) stream.send({ event: { type: "agent_message", content: summary, messageId: randomUUID() } });
                return res.end(JSON.stringify({ result: { changedFiles: diff.stdout.split("\n").filter(Boolean), validationResults: [], agentSummary: summary, toolCalls: [], messages: [] } }) + "\n");
              } finally {
                stopHeartbeat();
                cleanupRequest();
                await fs.rm(outputFile, { force: true });
              }
            }

            if (!apiKey) throw new Error("OpenRouter API key is missing");

            const stream = createAgentStream(res);
            const lifecycle = attachRequestAbort(req, res);
            cleanupRequest = lifecycle.cleanup;
            const { send } = stream;
            const { status } = stream;
            status("Initializing Pi agent…");

            const authStorage = AuthStorage.inMemory();
            authStorage.setRuntimeApiKey("openrouter", apiKey);
            const modelRegistry = ModelRegistry.inMemory(authStorage);
            const piModelId = String(modelId).replace(/^openrouter\//, "");
            const inputPricePerToken = Number(inputPrice || 0) / 1_000_000;
            const outputPricePerToken = Number(outputPrice || 0) / 1_000_000;
            modelRegistry.registerProvider("openrouter", {
              api: "openai-completions",
              baseUrl: "https://openrouter.ai/api/v1",
              apiKey,
              models: [{ id: piModelId, name: piModelId, reasoning: Boolean(supportsReasoning), input: ["text"], cost: { input: inputPricePerToken, output: outputPricePerToken, cacheRead: inputPricePerToken, cacheWrite: inputPricePerToken }, contextWindow: 128000, maxTokens: 16384, headers: { "HTTP-Referer": "https://github.com/DavidSeyserGit/Conduit", "X-Title": "Conduit", "User-Agent": "Conduit/0.1" } }],
            });
            status(`Loading model ${piModelId}…`);
            const model = modelRegistry.find("openrouter", piModelId);
            if (!model) throw new Error(`Pi could not load model: ${piModelId}`);
            status("Creating Pi session…");
            const { session } = await createAgentSession({ cwd: root, model, modelRegistry, authStorage, sessionManager: SessionManager.inMemory(root), tools: ["read", "bash", "edit", "write", "grep", "find", "ls"] });
            activeSession = session;
            const disposeOnAbort = () => activeSession?.dispose?.();
            lifecycle.signal.addEventListener("abort", disposeOnAbort, { once: true });
            status("Pi session ready; sending goal…");
            const events: any[] = [];
            const toolCalls = new Map<string, any>();
            let summary = "";
            const tokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
            session.subscribe((event: any) => {
              if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") summary += event.assistantMessageEvent.delta;
              if (event.type === "message_end" && event.message?.usage) {
                const usage = event.message.usage;
                tokenUsage.promptTokens += Number(usage.input || 0);
                tokenUsage.completionTokens += Number(usage.output || 0);
                tokenUsage.totalTokens += Number(usage.totalTokens || Number(usage.input || 0) + Number(usage.output || 0));
                tokenUsage.cacheReadTokens += Number(usage.cacheRead || 0);
                tokenUsage.cacheWriteTokens += Number(usage.cacheWrite || 0);
              }
              if (event.type === "tool_execution_start") {
                const toolCall = { id: event.toolCallId, name: event.toolName, arguments: event.args || {}, status: "running", startedAt: new Date().toISOString() };
                toolCalls.set(event.toolCallId, toolCall); const streamed = { type: "tool_started", toolCall }; events.push(streamed); send({ event: streamed });
              }
              if (event.type === "tool_execution_end") {
                const toolCall = toolCalls.get(event.toolCallId) || { id: event.toolCallId, name: event.toolName, arguments: event.args || {}, startedAt: new Date().toISOString() };
                toolCall.status = event.isError ? "failed" : "completed"; toolCall.result = event.result; toolCall.completedAt = new Date().toISOString();
                if (event.isError) toolCall.error = JSON.stringify(event.result);
                const streamed = { type: "tool_completed", toolCall }; events.push(streamed); send({ event: streamed });
              }
            });
            status(judgeFeedback?.length ? "Applying judge feedback and revisiting the repository…" : "Pi is working through the repository…");
            const stopHeartbeat = stream.heartbeat("OpenRouter", "network", "Coding request remains open");
            try {
              const prompt = `Work directly on this repository and complete the goal using your tools.\nPreserve pre-existing workspace changes from earlier goals. Do not treat a dirty worktree as part of the current goal; Conduit scopes review evidence to this run.\n\nGoal: ${goal}\nIteration: ${iteration} of ${maxIterations}\n${previousPlan ? `Previous plan:\n${JSON.stringify(previousPlan)}` : ""}\n${judgeFeedback?.length ? `Judge feedback:\n${judgeFeedback.join("\n")}` : ""}\nAt the end, briefly summarize verified work completed.`;
              let completed = false;
              for (let attempt = 0; attempt < 3 && !completed; attempt++) {
                try {
                  await session.prompt(prompt);
                  completed = true;
                } catch (error: any) {
                  const message = error?.message || String(error);
                  const transient = /network|fetch failed|socket|timeout|timed out|econnreset|502|503|504|429/i.test(message);
                  if (!transient || attempt === 2) throw new Error(`OpenRouter coding request failed for ${piModelId}: ${message}`);
                  status(`OpenRouter connection interrupted; retrying (${attempt + 1}/2)…`);
                  await new Promise((resolve) => setTimeout(resolve, 1500 * (attempt + 1)));
                }
              }
            } finally {
              stopHeartbeat();
            }
            status("Pi finished; collecting changes…");
            session.dispose();
            lifecycle.signal.removeEventListener("abort", disposeOnAbort);
            activeSession = undefined;
            cleanupRequest();
            const diff = await execFileAsync("git", ["diff", "--name-only"], { cwd: root });
            const changedFiles = diff.stdout.split("\n").filter(Boolean);
            if (summary) events.push({ type: "agent_message", content: summary, messageId: randomUUID() });
            const estimatedCost = tokenUsage.promptTokens * inputPricePerToken + tokenUsage.completionTokens * outputPricePerToken;
            const result = { changedFiles, validationResults: [], agentSummary: summary, toolCalls: Array.from(toolCalls.values()), messages: [], tokenUsage, estimatedCost };
            send({ result });
            return res.end();
          } catch (error: any) {
            activeSession?.dispose?.();
            cleanupRequest();
            if (res.headersSent) {
              if (!res.writableEnded && !res.destroyed) {
                try {
                  res.write(`${JSON.stringify({ event: { type: "agent_status", message: `Agent failed: ${error.message || String(error)}` } })}\n`);
                  res.write(`${JSON.stringify({ error: error.message || String(error) })}\n`);
                  return res.end();
                } catch {
                  return;
                }
              }
              return;
            }
            res.statusCode = 500;
            return res.end(JSON.stringify({ error: error.message || String(error) }));
          }
        }

        if (req.url === "/api/github/device/start" && req.method === "POST") {
          const response = await fetch("https://github.com/login/device/code", { method: "POST", headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: githubClientId, scope: "repo" }) });
          const device = await response.json();
          if (!response.ok) { res.statusCode = response.status; return res.end(JSON.stringify(device)); }
          session.device = { device_code: device.device_code, interval: device.interval || 5 };
          return res.end(JSON.stringify({ verification_uri: device.verification_uri, user_code: device.user_code, interval: session.device.interval }));
        }

        if (req.url === "/api/github/device/poll" && req.method === "POST") {
          if (!session.device) { res.statusCode = 400; return res.end(JSON.stringify({ error: "No authorization in progress" })); }
          const response = await fetch("https://github.com/login/oauth/access_token", { method: "POST", headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: githubClientId, device_code: session.device.device_code, grant_type: "urn:ietf:params:oauth:grant-type:device_code" }) });
          const result = await response.json();
          if (result.access_token) { session.token = result.access_token; session.device = undefined; return res.end(JSON.stringify({ authorized: true, token: result.access_token })); }
          return res.end(JSON.stringify({ pending: result.error === "authorization_pending" || result.error === "slow_down", error: result.error_description || result.error }));
        }

        if (req.url === "/api/github/repos" && req.method === "GET") {
          if (!session.token) { res.statusCode = 401; return res.end(JSON.stringify({ error: "Not authorized" })); }
          const repos: unknown[] = [];
          let url: string | null = "https://api.github.com/user/repos?affiliation=owner,collaborator,organization_member&per_page=100";
          while (url) {
            const response = await fetch(url, { headers: { Authorization: `Bearer ${session.token}`, Accept: "application/vnd.github+json" } });
            if (!response.ok) {
              res.statusCode = response.status;
              return res.end(await response.text());
            }
            const page = await response.json();
            if (!Array.isArray(page)) {
              res.statusCode = 502;
              return res.end(JSON.stringify({ error: "GitHub returned an invalid repository list" }));
            }
            repos.push(...page);
            url = nextGitHubPage(response.headers.get("link"));
          }
          return res.end(JSON.stringify(repos));
        }

        if (req.url?.startsWith("/api/github/issues") && req.method === "GET") {
          if (!session.token) { res.statusCode = 401; return res.end(JSON.stringify({ error: "Not authorized" })); }
          const repo = new URL(req.url, "http://localhost").searchParams.get("repo") || "";
          if (!/^[^/]+\/[^/]+$/.test(repo)) { res.statusCode = 400; return res.end(JSON.stringify({ error: "Invalid repository" })); }
          const response = await fetch(`https://api.github.com/repos/${repo}/issues?state=open&sort=updated&per_page=50`, { headers: { Authorization: `Bearer ${session.token}`, Accept: "application/vnd.github+json" } });
          const issues = await response.json();
          res.statusCode = response.status;
          return res.end(JSON.stringify(Array.isArray(issues) ? issues.filter((issue: any) => !issue.pull_request) : issues));
        }

        if (req.url === "/api/workspace/git-worktree" && req.method === "POST") {
          try {
            const { action, repository, branch, sessionId, worktree } = await readJson(req);
            const root = path.resolve(String(repository || ""));
            const gitRoot = await execFileAsync("git", ["-C", root, "rev-parse", "--show-toplevel"]);
            const resolvedRoot = path.resolve(gitRoot.stdout.trim());
            const validIdentifier = (value: unknown, allowSlash = false) => typeof value === "string" && value.length > 0 && value.length <= 80 && /^[A-Za-z0-9_.\/-]+$/.test(value) && !value.includes("..") && (allowSlash || !value.includes("/"));
            const worktreeRoot = path.join(path.dirname(resolvedRoot), ".conduit-worktrees", path.basename(resolvedRoot));
            if (action === "create") {
              if (!validIdentifier(branch, true) || !validIdentifier(sessionId)) throw new Error("Invalid branch or session identifier");
              const target = path.join(worktreeRoot, String(sessionId));
              if (await fs.access(target).then(() => true).catch(() => false)) throw new Error(`Worktree already exists: ${target}`);
              await fs.mkdir(worktreeRoot, { recursive: true });
              await execFileAsync("git", ["-C", resolvedRoot, "worktree", "add", "-b", String(branch), target, "HEAD"]);
              return res.end(JSON.stringify({ success: true, result: { path: target, branch } }));
            }
            if (action === "remove") {
              const target = path.resolve(String(worktree || ""));
              if (!target.startsWith(`${worktreeRoot}${path.sep}`)) throw new Error("Invalid worktree path");
              await execFileAsync("git", ["-C", resolvedRoot, "worktree", "remove", "--force", target]);
              return res.end(JSON.stringify({ success: true, result: { removed: true } }));
            }
            throw new Error("Unknown Git worktree action");
          } catch (error: any) {
            res.statusCode = 400;
            return res.end(JSON.stringify({ success: false, error: error.stderr || error.message || String(error) }));
          }
        }

        if (req.url === "/api/github/clone" && req.method === "POST") {
          const { full_name, clone_url, token } = await readJson(req);
          const accessToken = session.token || String(token || "");
          if (!accessToken) { res.statusCode = 401; return res.end(JSON.stringify({ error: "Not authorized" })); }
          const name = String(full_name || "").split("/").pop() || "";
          let repoUrl: URL;
          try { repoUrl = new URL(clone_url); } catch { res.statusCode = 400; return res.end(JSON.stringify({ error: "Invalid repository URL" })); }
          if (!name || name.includes("/") || name.includes("\\") || repoUrl.hostname !== "github.com") { res.statusCode = 400; return res.end(JSON.stringify({ error: "Invalid repository" })); }
          await fs.mkdir(workspaceRoot, { recursive: true });
          const target = path.join(workspaceRoot, name);
          const existingGitRepo = await fs.stat(path.join(target, ".git")).then(() => true).catch(() => false);
          if (existingGitRepo) return res.end(JSON.stringify({ path: target, existing: true }));
          try { await fs.access(target); res.statusCode = 409; return res.end(JSON.stringify({ error: `Folder already exists and is not a Git repository: ${target}` })); } catch { /* target is available */ }
          const askpass = path.join(workspaceRoot, `.loopkit-askpass-${process.pid}`);
          await fs.writeFile(askpass, "#!/bin/sh\ncase \"$1\" in *Username*) echo x-access-token;; *) echo \"$LOOPKIT_GITHUB_TOKEN\";; esac\n", { mode: 0o700 });
          try {
            await execFileAsync("git", ["clone", clone_url, target], { env: { ...process.env, GIT_ASKPASS: askpass, GIT_TERMINAL_PROMPT: "0", LOOPKIT_GITHUB_TOKEN: accessToken } });
            return res.end(JSON.stringify({ path: target }));
          } catch (error: any) {
            res.statusCode = 500;
            return res.end(JSON.stringify({ error: error.stderr || error.message || "Clone failed" }));
          } finally { await fs.rm(askpass, { force: true }); }
        }

        res.statusCode = 404;
        return res.end(JSON.stringify({ error: "Not found" }));
      });
    },
  };
}

export default defineConfig({
  plugins: [githubApi(), react(), tailwindcss()],
  // Cloned repositories are agent workspaces, not Vite source. Watching them
  // can restart the dev server while an agent is editing, which cuts the
  // shared NDJSON stream for every provider.
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      ignored: [path.join(workspaceRoot, "**")],
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  clearScreen: false,
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    target: "esnext",
    minify: !process.env.TAURI_ENV_DEBUG ? "esbuild" : false,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
});
