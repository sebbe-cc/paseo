import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";

/**
 * tmux-backed persistent terminals (pa-bhkn0).
 *
 * A persistent terminal's shell runs inside a tmux session owned by a tmux
 * server that daemonizes itself away from the Paseo daemon. Killing the
 * daemon (or its terminal worker) only kills the tmux *client* in the
 * daemon-held PTY; the session — and every PID inside it — survives. After a
 * restart the daemon attaches a fresh PTY to the same session, so the lab
 * keeps its authenticated processes (browsers, backends, readline shells)
 * with the same PIDs instead of being restarted.
 *
 * The tmux socket lives under the daemon's PASEO_HOME (`terminals/tmux.sock`)
 * so isolated test daemons never share sessions with production.
 */

export interface PersistentTerminalBinding {
  /** Absolute path to the tmux binary used for this terminal. */
  tmuxBin: string;
  /** Absolute path to the tmux server socket (`tmux -S`). */
  socketPath: string;
  /** tmux session name, unique per terminal id. */
  sessionName: string;
}

export function persistentSessionName(terminalId: string): string {
  const safe = terminalId.replace(/[^A-Za-z0-9_.-]/g, "-").slice(0, 64) || "terminal";
  return `paseo-${safe}`;
}

export function tmuxSocketPath(paseoHome: string): string {
  return join(paseoHome, "terminals", "tmux.sock");
}

/**
 * tmux never creates missing parents for `-S`: ensure the socket directory
 * before any spawn or invoke, or the first persistent terminal fails.
 */
export function ensureTmuxSocketDir(socketPath: string): void {
  mkdirSync(dirname(socketPath), { recursive: true });
}

export function resolveTmuxBinary(env: NodeJS.ProcessEnv = process.env): string | null {
  const pathValue = env.PATH ?? "";
  for (const dir of pathValue.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, "tmux");
    try {
      if (existsSync(candidate)) return candidate;
    } catch {
      // Ignore unreadable PATH entries.
    }
  }
  return null;
}

export interface TmuxInvokeResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export function tmuxInvoke(
  binding: Pick<PersistentTerminalBinding, "tmuxBin" | "socketPath">,
  args: string[],
  timeoutMs = 10_000,
): TmuxInvokeResult {
  const result = spawnSync(binding.tmuxBin, ["-S", binding.socketPath, ...args], {
    encoding: "utf8",
    timeout: timeoutMs,
  });
  return {
    code: typeof result.status === "number" ? result.status : null,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
  };
}

/** True when the tmux server is up and the session exists. */
export function tmuxSessionAlive(binding: PersistentTerminalBinding): boolean {
  return tmuxInvoke(binding, ["has-session", "-t", binding.sessionName]).code === 0;
}

/** PID of the session's active pane (the user's shell), or null. */
export function tmuxPanePid(binding: PersistentTerminalBinding): number | null {
  const result = tmuxInvoke(binding, ["display-message", "-p", "-t", binding.sessionName, "#{pane_pid}"]);
  if (result.code !== 0) return null;
  const pid = Number(result.stdout.trim());
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/**
 * Spawn arguments that attach the daemon-held PTY to the session, creating
 * it (detached, running `shell` in `cwd`) when it does not exist yet.
 */
export function persistentSpawnArgs(options: {
  binding: PersistentTerminalBinding;
  cwd: string;
  shell: string;
  command?: string;
  args?: string[];
  cols: number;
  rows: number;
}): { command: string; args: string[] } {
  const { binding, cwd, shell, command, args = [], cols, rows } = options;
  const sessionCommand = command ? [command, ...args] : [shell];
  return {
    command: binding.tmuxBin,
    args: [
      "-S",
      binding.socketPath,
      "new-session",
      "-A",
      "-s",
      binding.sessionName,
      "-c",
      cwd,
      "-x",
      String(cols),
      "-y",
      String(rows),
      ...sessionCommand,
    ],
  };
}

/** Best-effort: never throws, so shutdown paths stay infallible. */
export function tmuxKillSession(binding: PersistentTerminalBinding): void {
  try {
    tmuxInvoke(binding, ["kill-session", "-t", binding.sessionName]);
  } catch {
    // The session is already gone or tmux is unreachable; nothing to do.
  }
}
