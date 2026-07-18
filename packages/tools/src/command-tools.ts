import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { CommandPermissionMode, ValidationResult } from "@conduit/shared";
import { ToolError } from "@conduit/shared";
import { assertWorkspaceExists, requiresApproval } from "./safety.js";

const execAsync = promisify(exec);

const DEFAULT_TIMEOUT_MS = 120_000;

export interface RunCommandResult {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

export interface CommandApprovalRequest {
  requestId: string;
  command: string;
  resolve: (approved: boolean) => void;
}

export class CommandExecutor {
  private pendingApprovals = new Map<string, CommandApprovalRequest>();

  constructor(
    private workspacePath: string,
    private permissionMode: CommandPermissionMode = "auto_approve_safe"
  ) {}

  setPermissionMode(mode: CommandPermissionMode): void {
    this.permissionMode = mode;
  }

  async runCommand(
    command: string,
    options: {
      timeout?: number;
      onApprovalRequired?: (requestId: string, command: string) => void;
      permissionMode?: CommandPermissionMode;
      signal?: AbortSignal;
    } = {}
  ): Promise<RunCommandResult> {
    assertWorkspaceExists(this.workspacePath);

    if (requiresApproval(command, options.permissionMode ?? this.permissionMode)) {
      const requestId = crypto.randomUUID();
      const approved = await this.requestApproval(
        requestId,
        command,
        options.onApprovalRequired
      );
      if (!approved) {
        throw new ToolError(`Command not approved: ${command}`);
      }
    }

    const startTime = Date.now();
    const timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;

    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd: this.workspacePath,
        timeout,
        signal: options.signal,
        maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, FORCE_COLOR: "0" },
      });

      return {
        command,
        exitCode: 0,
        stdout: stdout ?? "",
        stderr: stderr ?? "",
        timedOut: false,
        durationMs: Date.now() - startTime,
      };
    } catch (err: unknown) {
      const execErr = err as {
        code?: number;
        killed?: boolean;
        stdout?: string;
        stderr?: string;
        message?: string;
      };

      if (execErr.killed) {
        return {
          command,
          exitCode: -1,
          stdout: execErr.stdout ?? "",
          stderr: execErr.stderr ?? "Command timed out",
          timedOut: true,
          durationMs: Date.now() - startTime,
        };
      }

      return {
        command,
        exitCode: typeof execErr.code === "number" ? execErr.code : 1,
        stdout: execErr.stdout ?? "",
        stderr: execErr.stderr ?? execErr.message ?? "Command failed",
        timedOut: false,
        durationMs: Date.now() - startTime,
      };
    }
  }

  approveCommand(requestId: string): void {
    const pending = this.pendingApprovals.get(requestId);
    if (pending) {
      pending.resolve(true);
      this.pendingApprovals.delete(requestId);
    }
  }

  rejectCommand(requestId: string): void {
    const pending = this.pendingApprovals.get(requestId);
    if (pending) {
      pending.resolve(false);
      this.pendingApprovals.delete(requestId);
    }
  }

  toValidationResult(result: RunCommandResult): ValidationResult {
    return {
      command: result.command,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      passed: result.exitCode === 0 && !result.timedOut,
    };
  }

  private requestApproval(
    requestId: string,
    command: string,
    onApprovalRequired?: (requestId: string, command: string) => void
  ): Promise<boolean> {
    return new Promise((resolve) => {
      this.pendingApprovals.set(requestId, { requestId, command, resolve });
      onApprovalRequired?.(requestId, command);
    });
  }
}
