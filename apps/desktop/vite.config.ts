import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { AuthStorage, ModelRegistry, SessionManager, createAgentSession } from "@mariozechner/pi-coding-agent";

const githubClientId = process.env.GITHUB_CLIENT_ID || "Ov23liMo1oJoAzSI7573";
const sessions = new Map<string, { token?: string; device?: { device_code: string; interval: number } }>();
const execFileAsync = promisify(execFile);
const workspaceRoot = process.env.LOOPKIT_WORKSPACE_ROOT || path.resolve(process.cwd(), "workspaces");

async function readJson(req: any) {
  let body = "";
  for await (const chunk of req) body += chunk;
  return JSON.parse(body || "{}");
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
      output.push({ name: entry.name, path: relative, entry_type: "directory", size: null });
      await walk(absolute, root, output, depth + 1, maxDepth);
    } else if (entry.isFile()) {
      output.push({ name: entry.name, path: relative, entry_type: "file", size: (await fs.stat(absolute)).size });
    }
  }
}

function githubApi() {
  return {
    name: "github-oauth-api",
    configureServer(server: { middlewares: { use: (handler: (req: any, res: any, next: () => void) => void) => void } }) {
      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith("/api/github/") && !req.url?.startsWith("/api/workspace/") && !req.url?.startsWith("/api/agent/")) return next();
        const cookies = Object.fromEntries((req.headers.cookie || "").split(";").filter(Boolean).map((part: string) => part.trim().split("=")));
        const sessionId = cookies.loopkit_session || randomUUID();
        const session = sessions.get(sessionId) || {};
        sessions.set(sessionId, session);
        res.setHeader("Set-Cookie", `loopkit_session=${sessionId}; HttpOnly; SameSite=Lax; Path=/`);
        res.setHeader("Content-Type", "application/json");

        if (req.url === "/api/workspace/tool" && req.method === "POST") {
          try {
            const { workspace, name, args = {}, mode } = await readJson(req);
            if (mode === "ask" && ["write_file", "replace_in_file", "create_file", "delete_file", "run_command", "get_git_diff"].includes(name)) throw new Error(`${name} is not available in Ask mode`);
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
              const output = await execFileAsync(process.platform === "win32" ? "cmd" : "sh", process.platform === "win32" ? ["/C", args.command] : ["-c", args.command], { cwd: root, maxBuffer: 10 * 1024 * 1024 }).catch((e: any) => e);
              result = { command: args.command, exitCode: output.code ?? 0, stdout: output.stdout || "", stderr: output.stderr || "", timedOut: false };
            } else if (name === "get_git_diff") {
              const output = await execFileAsync("git", ["diff", ...(args.path ? ["--", args.path] : [])], { cwd: root });
              result = { diff: output.stdout, hasChanges: Boolean(output.stdout) };
            } else throw new Error(`Unknown tool: ${name}`);
            return res.end(JSON.stringify({ success: true, result }));
          } catch (error: any) { res.statusCode = 400; return res.end(JSON.stringify({ success: false, error: error.message || String(error) })); }
        }

        if (req.url === "/api/agent/pi-iteration" && req.method === "POST") {
          try {
            const { workspace, goal, modelId, apiKey, previousPlan, judgeFeedback, iteration, maxIterations } = await readJson(req);
            const root = path.resolve(workspace);
            const isClone = root.startsWith(`${path.resolve(workspaceRoot)}${path.sep}`);
            const isGitRepo = await fs.stat(path.join(root, ".git")).then(() => true).catch(() => false);
            if (!isClone && !isGitRepo) throw new Error("Workspace is not a Git repository");

            if (String(modelId).startsWith("codex/")) {
              const outputFile = path.join(workspaceRoot, `.loopkit-codex-${randomUUID()}.txt`);
              const prompt = `Work directly on this repository and complete the goal using your coding tools.\n\nGoal: ${goal}\nIteration: ${iteration} of ${maxIterations}\n${previousPlan ? `Previous plan:\n${JSON.stringify(previousPlan)}` : ""}\n${judgeFeedback?.length ? `Judge feedback:\n${judgeFeedback.join("\n")}` : ""}\nAt the end, briefly summarize verified work completed.`;
              try {
                await execFileAsync("codex", ["exec", "--json", "--ephemeral", "--skip-git-repo-check", "-C", root, "-s", "workspace-write", "-a", "never", "-o", outputFile, prompt], { cwd: root, maxBuffer: 20 * 1024 * 1024 });
                const summary = await fs.readFile(outputFile, "utf8").catch(() => "");
                const diff = await execFileAsync("git", ["diff", "--name-only"], { cwd: root });
                const events = summary ? [{ type: "agent_message", content: summary, messageId: randomUUID() }] : [];
                return res.end(JSON.stringify({ events, result: { changedFiles: diff.stdout.split("\n").filter(Boolean), validationResults: [], agentSummary: summary, toolCalls: [], messages: [] } }));
              } finally { await fs.rm(outputFile, { force: true }); }
            }

            if (!apiKey) throw new Error("OpenRouter API key is missing");

            const authStorage = AuthStorage.inMemory();
            authStorage.setRuntimeApiKey("openrouter", apiKey);
            const modelRegistry = ModelRegistry.inMemory(authStorage);
            const piModelId = String(modelId).replace(/^openrouter\//, "");
            modelRegistry.registerProvider("openrouter", {
              api: "openai-completions",
              baseUrl: "https://openrouter.ai/api/v1",
              apiKey,
              models: [{ id: piModelId, name: piModelId, reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 16384 }],
            });
            const model = modelRegistry.find("openrouter", piModelId);
            if (!model) throw new Error(`Pi could not load model: ${piModelId}`);
            const { session } = await createAgentSession({ cwd: root, model, modelRegistry, authStorage, sessionManager: SessionManager.inMemory(root), tools: ["read", "bash", "edit", "write", "grep", "find", "ls"] });
            const events: any[] = [];
            const toolCalls = new Map<string, any>();
            let summary = "";
            session.subscribe((event: any) => {
              if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") summary += event.assistantMessageEvent.delta;
              if (event.type === "tool_execution_start") {
                const toolCall = { id: event.toolCallId, name: event.toolName, arguments: event.args || {}, status: "running", startedAt: new Date().toISOString() };
                toolCalls.set(event.toolCallId, toolCall); events.push({ type: "tool_started", toolCall });
              }
              if (event.type === "tool_execution_end") {
                const toolCall = toolCalls.get(event.toolCallId) || { id: event.toolCallId, name: event.toolName, arguments: event.args || {}, startedAt: new Date().toISOString() };
                toolCall.status = event.isError ? "failed" : "completed"; toolCall.result = event.result; toolCall.completedAt = new Date().toISOString();
                if (event.isError) toolCall.error = JSON.stringify(event.result);
                events.push({ type: "tool_completed", toolCall });
              }
            });
            await session.prompt(`Work directly on this repository and complete the goal using your tools.\n\nGoal: ${goal}\nIteration: ${iteration} of ${maxIterations}\n${previousPlan ? `Previous plan:\n${JSON.stringify(previousPlan)}` : ""}\n${judgeFeedback?.length ? `Judge feedback:\n${judgeFeedback.join("\n")}` : ""}\nAt the end, briefly summarize verified work completed.`);
            session.dispose();
            const diff = await execFileAsync("git", ["diff", "--name-only"], { cwd: root });
            const changedFiles = diff.stdout.split("\n").filter(Boolean);
            if (summary) events.push({ type: "agent_message", content: summary, messageId: randomUUID() });
            return res.end(JSON.stringify({ events, result: { changedFiles, validationResults: [], agentSummary: summary, toolCalls: Array.from(toolCalls.values()), messages: [] } }));
          } catch (error: any) { res.statusCode = 500; return res.end(JSON.stringify({ error: error.message || String(error) })); }
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
          if (result.access_token) { session.token = result.access_token; session.device = undefined; return res.end(JSON.stringify({ authorized: true })); }
          return res.end(JSON.stringify({ pending: result.error === "authorization_pending" || result.error === "slow_down", error: result.error_description || result.error }));
        }

        if (req.url === "/api/github/repos" && req.method === "GET") {
          if (!session.token) { res.statusCode = 401; return res.end(JSON.stringify({ error: "Not authorized" })); }
          const response = await fetch("https://api.github.com/user/repos?affiliation=owner,collaborator,organization_member&per_page=100", { headers: { Authorization: `Bearer ${session.token}`, Accept: "application/vnd.github+json" } });
          res.statusCode = response.status;
          return res.end(await response.text());
        }

        if (req.url === "/api/github/clone" && req.method === "POST") {
          if (!session.token) { res.statusCode = 401; return res.end(JSON.stringify({ error: "Not authorized" })); }
          const { full_name, clone_url } = await readJson(req);
          const name = String(full_name || "").split("/").pop() || "";
          let repoUrl: URL;
          try { repoUrl = new URL(clone_url); } catch { res.statusCode = 400; return res.end(JSON.stringify({ error: "Invalid repository URL" })); }
          if (!name || name.includes("/") || name.includes("\\") || repoUrl.hostname !== "github.com") { res.statusCode = 400; return res.end(JSON.stringify({ error: "Invalid repository" })); }
          await fs.mkdir(workspaceRoot, { recursive: true });
          const target = path.join(workspaceRoot, name);
          try { await fs.access(target); res.statusCode = 409; return res.end(JSON.stringify({ error: `Folder already exists: ${target}` })); } catch { /* target is available */ }
          const askpass = path.join(workspaceRoot, `.loopkit-askpass-${process.pid}`);
          await fs.writeFile(askpass, "#!/bin/sh\ncase \"$1\" in *Username*) echo x-access-token;; *) echo \"$LOOPKIT_GITHUB_TOKEN\";; esac\n", { mode: 0o700 });
          try {
            await execFileAsync("git", ["clone", clone_url, target], { env: { ...process.env, GIT_ASKPASS: askpass, GIT_TERMINAL_PROMPT: "0", LOOPKIT_GITHUB_TOKEN: session.token } });
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
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    target: "esnext",
    minify: !process.env.TAURI_ENV_DEBUG ? "esbuild" : false,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
});
