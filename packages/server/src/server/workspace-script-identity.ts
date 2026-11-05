import { execCommand } from "../utils/spawn.js";

export async function resolveWorkspaceScriptBranch(
  cwd: string,
  fallback: string | null,
): Promise<string | null> {
  try {
    const result = await execCommand("git", ["-C", cwd, "symbolic-ref", "--short", "HEAD"], {
      envMode: "internal",
      timeout: 5000,
    });
    return String(result.stdout).trim() || fallback;
  } catch {
    return fallback;
  }
}
