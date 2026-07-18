import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const AGENT_TIMEOUT_MS = 20 * 60 * 1000;

export async function runWorkspaceCommand(command: string, cwd: string, options: { timeoutMs?: number; signal?: AbortSignal } = {}) {
  const shell = process.platform === "win32" ? "cmd" : "sh";
  const shellArgs = process.platform === "win32" ? ["/C", command] : ["-c", command];
  const startedAt = Date.now();

  try {
    const output = await execFileAsync(shell, shellArgs, {
      cwd,
      maxBuffer: 10 * 1024 * 1024,
      timeout: options.timeoutMs ?? AGENT_TIMEOUT_MS,
      signal: options.signal,
    });
    // execFile only adds `code` to errors. A fulfilled result is always a
    // successful process, so treating its missing `code` as a failure makes
    // every browser-mode validation appear to exit with code 1.
    return {
      command,
      exitCode: 0,
      stdout: output.stdout || "",
      stderr: output.stderr || "",
      timedOut: false,
      durationMs: Date.now() - startedAt,
    };
  } catch (error: unknown) {
    const output = error as {
      code?: number | string | null;
      killed?: boolean;
      stdout?: string;
      stderr?: string;
      message?: string;
    };
    const timedOut = output.code === null && output.killed === true;
    return {
      command,
      exitCode: typeof output.code === "number" ? output.code : timedOut ? 124 : 1,
      stdout: output.stdout || "",
      stderr: output.stderr || output.message || "",
      timedOut,
      durationMs: Date.now() - startedAt,
    };
  }
}
