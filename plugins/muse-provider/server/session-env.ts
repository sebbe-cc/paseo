// Per-session environment for Muse sessions served by the shared session daemon.
//
// The daemon runs a session's built-in command tools (`bash`, `shell`,
// `monitor`, `powershell`) as `/bin/sh -c <command>` children of the daemon
// process, so they inherit the daemon's environment. MSP has no per-session
// environment for them (muse-code 1.4.15: `shell_environment_policy` only
// filters the daemon env, session `settingsOverrides` admit no env,
// `launchContext` carries only invocation ids). Two things do work:
//
// - A daemon-wide PreToolUse hook (daemon settings.json `hooks`) runs before
//   every tool call, receives the call's `session_id`, and may rewrite the
//   call's input (`hookSpecificOutput.updatedInput`).
// - The provider knows each session's launch environment and native id.
//
// So the provider writes `<dir>/<sessionId>.json` (the session's complete
// launch environment, mode 0600) when a daemon session starts or resumes and
// removes it on close, and installs two scripts in `<dir>`:
//
// - `hook.cjs`, the PreToolUse hook: for a session that has an env file it
//   rewrites the `command` to run through `run.cjs`; a session without one
//   (not opened by Paseo) is left alone.
// - `run.cjs`, which runs `/bin/sh -c <command>` with exactly that session's
//   environment, as an own `muse serve` host would have.
//
// The daemon's settings.json enables the hook once:
//   "hooks": { "PreToolUse": [{ "matcher": "bash|shell|monitor|powershell",
//     "hooks": [{ "type": "command", "command": "<node> <dir>/hook.cjs" }] }] }
//
// <dir> is $PASEO_MUSE_SESSION_ENV_DIR, else $XDG_RUNTIME_DIR/paseo-muse-session-env,
// else ~/.local/state/paseo-muse-session-env. The Paseo daemon and the Muse
// daemon must resolve the same directory.
//
// The scripts are written from the source of self-contained functions: provider
// plugins are bundled and evaluated by the daemon, so no file shipped next to
// them can be located at runtime.
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const SESSION_ENV_DIR_VAR = "PASEO_MUSE_SESSION_ENV_DIR";
const SESSION_ID = /^[0-9a-f-]{36}$/;

export function sessionEnvDir(env: Readonly<Record<string, string | undefined>>): string {
  if (env[SESSION_ENV_DIR_VAR]) return env[SESSION_ENV_DIR_VAR];
  if (env.XDG_RUNTIME_DIR) return path.join(env.XDG_RUNTIME_DIR, "paseo-muse-session-env");
  return path.join(env.HOME || os.homedir(), ".local", "state", "paseo-muse-session-env");
}

/* oxlint-disable typescript-eslint(no-require-imports) -- written out as CommonJS scripts */

/** PreToolUse hook: route a Paseo daemon session's commands through run.cjs. */
export function sessionEnvHookMain(): void {
  const fs = require("node:fs") as typeof import("node:fs");
  const { join } = require("node:path") as typeof import("node:path");
  let input = "";
  process.stdin.on("data", (chunk: Buffer) => (input += chunk.toString("utf8")));
  process.stdin.on("end", () => {
    let call: { session_id?: unknown; tool_input?: Record<string, unknown> };
    try {
      call = JSON.parse(input);
    } catch {
      return;
    }
    const command = call.tool_input?.command;
    const id = call.session_id;
    if (typeof command !== "string" || typeof id !== "string" || !/^[0-9a-f-]{36}$/.test(id))
      return;
    const dir = __dirname;
    const envFile = join(dir, `${id}.json`);
    if (!fs.existsSync(envFile)) return;
    const encoded = Buffer.from(command, "utf8").toString("base64");
    const wrapped = `exec '${process.execPath}' '${join(dir, "run.cjs")}' '${envFile}' '${encoded}'`;
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          updatedInput: { ...call.tool_input, command: wrapped },
        },
      }),
    );
  });
}

/** Runs one command with a session's stored environment. */
export function sessionEnvRunMain(): void {
  const fs = require("node:fs") as typeof import("node:fs");
  const { spawn } = require("node:child_process") as typeof import("node:child_process");
  const [envFile, encoded] = process.argv.slice(2);
  let env: Record<string, string>;
  let wrapper: string[];
  try {
    const record = JSON.parse(fs.readFileSync(envFile ?? "", "utf8")) as {
      env: Record<string, string>;
      wrapper?: string[];
    };
    env = record.env;
    wrapper = record.wrapper ?? [];
  } catch (error) {
    // The file vanished between hook and run (session closed): fail loudly.
    process.stderr.write(`paseo: session environment unavailable (${String(error)})\n`);
    process.exit(126);
  }
  const command = Buffer.from(encoded ?? "", "base64").toString("utf8");
  const argv = [...wrapper, "/bin/sh", "-c", command];
  // A wrapper that cannot start fails the command (exit 127), never runs it unwrapped.
  const child = spawn(argv[0]!, argv.slice(1), { env, stdio: "inherit" });
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
    process.on(signal, () => child.kill(signal));
  child.on("error", (error) => {
    process.stderr.write(`paseo: cannot start ${argv[0]} (${error.message})\n`);
    process.exit(127);
  });
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 1);
  });
}

/* oxlint-enable typescript-eslint(no-require-imports) */

function script(main: () => void): string {
  return `"use strict";\n(${main.toString()})();\n`;
}

async function writeAtomic(file: string, content: string, mode: number): Promise<void> {
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, content, { mode });
  await chmod(temp, mode);
  await rename(temp, file);
}

/** Writes the hook and runner scripts (idempotent) and returns the directory. */
export async function installSessionEnvScripts(
  env: Readonly<Record<string, string | undefined>>,
): Promise<string> {
  const dir = sessionEnvDir(env);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  await writeAtomic(path.join(dir, "hook.cjs"), script(sessionEnvHookMain), 0o600);
  await writeAtomic(path.join(dir, "run.cjs"), script(sessionEnvRunMain), 0o600);
  return dir;
}

/** `wrapper`, when set, prefixes every command (e.g. a worktree sandbox launcher). */
export async function writeSessionEnv(
  dir: string,
  sessionId: string,
  env: Readonly<Record<string, string>>,
  wrapper?: readonly string[],
): Promise<void> {
  if (!SESSION_ID.test(sessionId)) throw new Error(`invalid Muse session id ${sessionId}`);
  const record = { env, wrapper: wrapper ?? [] };
  await writeAtomic(path.join(dir, `${sessionId}.json`), JSON.stringify(record), 0o600);
}

export async function removeSessionEnv(dir: string, sessionId: string): Promise<void> {
  if (!SESSION_ID.test(sessionId)) return;
  await rm(path.join(dir, `${sessionId}.json`), { force: true });
}
