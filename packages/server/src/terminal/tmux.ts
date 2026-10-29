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

/**
 * Harden the tmux server behind a persistent binding (pa-vbhcu). An orphaned
 * tmux client (its session was killed from outside) attaches to ANOTHER
 * session by default, so a dead terminal would serve that session's output
 * and swallow input addressed to it. With `detach-on-destroy` the client
 * detaches — and exits — instead, so the daemon sees the PTY EOF and forgets
 * the terminal through the normal exit path. Sessions inherit the global
 * value (even ones created before this ran), so setting it once per server
 * covers everything behind the socket.
 *
 * Best-effort and never throws: the option only sticks on a running server
 * (a fresh `start-server` with no sessions exits immediately), so callers run
 * this before spawning (covers a server started earlier) and
 * `ensureTmuxServerStable` after (covers the server this very spawn starts).
 */
export function ensureTmuxServer(
  binding: Pick<PersistentTerminalBinding, "tmuxBin" | "socketPath">,
): void {
  try {
    tmuxInvoke(binding, ["set-option", "-g", "detach-on-destroy", "on"]);
  } catch {
    // Best-effort: a missing tmux binary already fails loudly at spawn.
  }
}

/**
 * Retrying variant of ensureTmuxServer for right after spawning (pa-vbhcu):
 * the server may still be starting under the new client, so a single
 * set-option can land before anything listens. Resolves true once the option
 * sticks, false on timeout. Never throws.
 */
export async function ensureTmuxServerStable(
  binding: Pick<PersistentTerminalBinding, "tmuxBin" | "socketPath">,
  timeoutMs = 5_000,
): Promise<boolean> {
  const start = Date.now();
  for (;;) {
    try {
      if (tmuxInvoke(binding, ["set-option", "-g", "detach-on-destroy", "on"]).code === 0) {
        return true;
      }
    } catch {
      // Fall through to the retry below.
    }
    if (Date.now() - start > timeoutMs) return false;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
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

/**
 * Exact session target (pa-vbhcu). tmux resolves `-t <name>` by prefix, so a
 * missing session can match ANOTHER session (`has-session` exits 0,
 * `display-message` prints the other's pane, `kill-session` kills it).
 * Prefixing with `=` forces an exact match; every session-targeting call
 * below uses it, and pane-targeting calls go through the exact `$id`.
 */
export function exactSessionTarget(sessionName: string): string {
  return `=${sessionName}`;
}

/** True when the tmux server is up and EXACTLY this session exists. */
export function tmuxSessionAlive(binding: PersistentTerminalBinding): boolean {
  return (
    tmuxInvoke(binding, ["has-session", "-t", exactSessionTarget(binding.sessionName)]).code === 0
  );
}

/**
 * Exact session id (`$N`) for the binding, or null. The id never prefix-matches
 * another session, so it is the safe `-t` target for pane commands
 * (`display-message -p`, `capture-pane`, `send-keys`).
 */
export function tmuxSessionId(
  binding: Pick<PersistentTerminalBinding, "tmuxBin" | "socketPath" | "sessionName">,
): string | null {
  const result = tmuxInvoke(binding, ["list-sessions", "-F", "#{session_name}\x1f#{session_id}"]);
  if (result.code !== 0) return null;
  for (const line of result.stdout.split("\n")) {
    const tab = line.indexOf("\x1f");
    if (tab < 0) continue;
    if (line.slice(0, tab) === binding.sessionName) {
      const id = line.slice(tab + 1).trim();
      if (/^\$\d+$/.test(id)) return id;
      return null;
    }
  }
  return null;
}

/** PID of the session's active pane (the user's shell), or null. */
export function tmuxPanePid(binding: PersistentTerminalBinding): number | null {
  const sessionId = tmuxSessionId(binding);
  if (sessionId === null) return null;
  const result = tmuxInvoke(binding, ["display-message", "-p", "-t", sessionId, "#{pane_pid}"]);
  if (result.code !== 0) return null;
  const pid = Number(result.stdout.trim());
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/**
 * Exact `$id` of the session, or throws when the session is gone (pa-vbhcu).
 * Shutdown paths keep using best-effort kills; every read/send path must fail
 * loudly here instead of falling back to another session's data.
 */
export function requireTmuxSession(
  binding: Pick<PersistentTerminalBinding, "tmuxBin" | "socketPath" | "sessionName">,
): string {
  const sessionId = tmuxSessionId(binding);
  if (sessionId === null) {
    throw new Error(
      `tmux session '${binding.sessionName}' not found (socket ${binding.socketPath})`,
    );
  }
  return sessionId;
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

/**
 * Best-effort: never throws, so shutdown paths stay infallible. Exact target:
 * a bare prefix once killed ANOTHER session sharing it (pa-vbhcu).
 */
export function tmuxKillSession(binding: PersistentTerminalBinding): void {
  try {
    tmuxInvoke(binding, ["kill-session", "-t", exactSessionTarget(binding.sessionName)]);
  } catch {
    // The session is already gone or tmux is unreachable; nothing to do.
  }
}
