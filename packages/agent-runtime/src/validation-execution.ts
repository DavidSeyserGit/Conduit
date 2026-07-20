import type { ValidationResult } from "@conduit/shared";
import type { ToolCallResult } from "@conduit/tools";

export interface ValidationExecution {
  result: ValidationResult;
  toolResult: ToolCallResult;
  attemptedCommands: string[];
}

type CommandRunner = (command: string) => Promise<ToolCallResult>;

/** Execute a validation command with bounded, deterministic launcher fallbacks. */
export async function executeValidationCommand(command: string, run: CommandRunner): Promise<ValidationExecution> {
  const candidates = validationCommandCandidates(command);
  let last: ValidationExecution | undefined;
  for (const [index, candidate] of candidates.entries()) {
    const toolResult = await run(candidate);
    const result = validationResult(candidate, toolResult);
    last = { result, toolResult, attemptedCommands: candidates.slice(0, index + 1) };
    if (!launcherUnavailable(result) || index === candidates.length - 1) return last;
  }
  if (!last) throw new Error("Validation command resolution produced no candidate");
  return last;
}

function launcherUnavailable(result: ValidationResult): boolean {
  const output = `${result.stdout}\n${result.stderr}`;
  return result.exitCode === 127
    || /(?:command not found|executable file not found|is not recognized as an internal or external command)/i.test(output);
}

export function validationCommandCandidates(command: string): string[] {
  const trimmed = command.trim();
  const match = trimmed.match(/^pytest(?=\s|$)(.*)$/s);
  if (!match) return [trimmed];
  const args = match[1] ?? "";
  return unique([trimmed, `python3 -m pytest${args}`, `python -m pytest${args}`]);
}

export function validationResult(command: string, toolResult: ToolCallResult): ValidationResult {
  const value = isRecord(toolResult.result) ? toolResult.result : {};
  const exitCode = typeof value.exitCode === "number" ? value.exitCode : toolResult.success ? 0 : 1;
  const stdout = typeof value.stdout === "string" ? value.stdout : "";
  const stderr = typeof value.stderr === "string" ? value.stderr : toolResult.error ?? "";
  const combined = `${stdout}\n${stderr}`.trim();
  const unavailable = environmentLimitation(exitCode, combined);
  const onlySkipped = exitCode === 0 && /\b\d+\s+skipped\b/i.test(combined) && !/\b\d+\s+passed\b/i.test(combined);
  const outcome: NonNullable<ValidationResult["outcome"]> = unavailable
    ? "blocked_environment"
    : exitCode !== 0 || !toolResult.success
      ? "failed"
      : onlySkipped
        ? "skipped"
        : "passed";
  return {
    command,
    exitCode,
    stdout,
    stderr,
    passed: outcome === "passed",
    outcome,
    ...(unavailable ? { limitation: unavailable } : {}),
  };
}

/** Normalize validation captured by an autonomous provider through the same
 * failure/environment semantics used by coordinator-run commands. */
export function normalizeCapturedValidation(result: ValidationResult): ValidationResult {
  return validationResult(result.command, {
    success: true,
    result: {
      command: result.command,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    },
  });
}

export function environmentLimitation(exitCode: number, output: string): string | undefined {
  const normalized = output.trim();
  if (exitCode === 127 || /(?:command not found|executable file not found|is not recognized as an internal or external command)/i.test(normalized)) {
    return "The validation command is unavailable in this execution environment.";
  }
  if (/(?:no module named|modulenotfounderror:).*['\"]?(?:pytest|ompl|rclpy|pykdl|ament|launch_ros)/i.test(normalized)) {
    return "A required test or ROS runtime module is unavailable in this execution environment.";
  }
  if (/(?:requires? (?:a )?linux|not supported on (?:macos|darwin)|ros_distro.*not set|underlay.*not found)/i.test(normalized)) {
    return "The validation requires a different platform or ROS environment.";
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
