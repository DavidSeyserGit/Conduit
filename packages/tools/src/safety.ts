import * as path from "node:path";
import * as fs from "node:fs";
import { WorkspaceError } from "@conduit/shared";

const PROTECTED_PATHS = [
  "/etc",
  "/usr",
  "/bin",
  "/sbin",
  "/var",
  "/root",
  "/proc",
  "/sys",
  "/dev",
];

export function normalizeWorkspacePath(
  workspacePath: string,
  targetPath: string
): string {
  const resolvedWorkspace = path.resolve(workspacePath);
  const resolvedTarget = path.resolve(resolvedWorkspace, targetPath);

  if (!resolvedTarget.startsWith(resolvedWorkspace + path.sep) &&
      resolvedTarget !== resolvedWorkspace) {
    throw new WorkspaceError(
      `Path "${targetPath}" is outside the workspace boundary`
    );
  }

  for (const protectedPath of PROTECTED_PATHS) {
    if (resolvedTarget.startsWith(protectedPath + path.sep) ||
        resolvedTarget === protectedPath) {
      throw new WorkspaceError(
        `Access to protected path "${targetPath}" is not allowed`
      );
    }
  }

  return resolvedTarget;
}

export function assertWorkspaceExists(workspacePath: string): void {
  const resolved = path.resolve(workspacePath);
  if (!fs.existsSync(resolved)) {
    throw new WorkspaceError(`Workspace does not exist: ${workspacePath}`);
  }
  if (!fs.statSync(resolved).isDirectory()) {
    throw new WorkspaceError(`Workspace is not a directory: ${workspacePath}`);
  }
}

export function isSafeSymlink(
  workspacePath: string,
  filePath: string
): boolean {
  try {
    const stats = fs.lstatSync(filePath);
    if (!stats.isSymbolicLink()) return true;

    const linkTarget = fs.readlinkSync(filePath);
    const resolvedLink = path.resolve(path.dirname(filePath), linkTarget);
    const resolvedWorkspace = path.resolve(workspacePath);

    return (
      resolvedLink.startsWith(resolvedWorkspace + path.sep) ||
      resolvedLink === resolvedWorkspace
    );
  } catch {
    return false;
  }
}

export const SAFE_COMMANDS = [
  /^git\s+status\b/,
  /^git\s+diff\b/,
  /^git\s+log\b/,
  /^npm\s+test\b/,
  /^npm\s+run\s+test\b/,
  /^pnpm\s+test\b/,
  /^yarn\s+test\b/,
  /^pytest\b/,
  /^cargo\s+test\b/,
  /^go\s+test\b/,
  /^node\s+--version\b/,
  /^npm\s+--version\b/,
  /^python\s+--version\b/,
  /^python3\s+--version\b/,
];

export const UNSAFE_COMMAND_PATTERNS = [
  /\brm\s+-rf?\b/,
  /\bsudo\b/,
  /\bcurl\b/,
  /\bwget\b/,
  /\bssh\b/,
  /\bscp\b/,
  /\bnpm\s+install\b/,
  /\bpnpm\s+install\b/,
  /\byarn\s+add\b/,
  /\bpip\s+install\b/,
  /\bcargo\s+install\b/,
  /\bchmod\b/,
  /\bchown\b/,
  /\bmkfs\b/,
  /\bdd\s+if=/,
  />\s*\/dev\//,
  /\|\s*sh\b/,
  /\|\s*bash\b/,
];

export function isSafeCommand(command: string): boolean {
  const trimmed = command.trim();

  for (const pattern of UNSAFE_COMMAND_PATTERNS) {
    if (pattern.test(trimmed)) return false;
  }

  for (const pattern of SAFE_COMMANDS) {
    if (pattern.test(trimmed)) return true;
  }

  return false;
}

export function requiresApproval(
  command: string,
  permissionMode: "ask_every_time" | "auto_approve_safe" | "auto_approve_all"
): boolean {
  switch (permissionMode) {
    case "ask_every_time":
      return true;
    case "auto_approve_all":
      return false;
    case "auto_approve_safe":
      return !isSafeCommand(command);
  }
}
