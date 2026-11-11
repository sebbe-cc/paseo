import { statSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { MuseError } from "./errors.js";

const optionsSchema = z
  .object({
    sandbox: z
      .object({
        enabled: z.boolean().default(false),
        network: z.enum(["proxy-only", "restricted", "enabled"]).default("proxy-only"),
      })
      .strict()
      .prefault({}),
    trustWorkspace: z.boolean().default(true),
  })
  .strict();

export function serveArgs(providerOptions: unknown): string[] {
  const parsed = optionsSchema.safeParse(providerOptions === undefined ? {} : providerOptions);
  if (!parsed.success) {
    const errors = parsed.error.issues
      .map((issue) => `${["providerOptions", ...issue.path].join(".")}: ${issue.message}`)
      .join("; ");
    throw new MuseError("invalidProviderOptions", `Invalid Muse providerOptions: ${errors}`);
  }
  const { sandbox, trustWorkspace } = parsed.data;
  return [
    "--sandbox-network",
    sandbox.network,
    ...(sandbox.enabled ? [] : ["--disable-sandbox"]),
    ...(trustWorkspace ? ["--trust-workspace"] : []),
  ];
}

// A session whose env carries PASEO_MUSE_DAEMON=1 runs in the machine's shared
// Muse session daemon (`muse serve --listen`). `muse serve --join` alone would
// start a daemon of its own when none answers, so the provider checks the
// daemon socket first and fails the session when it is not there.
export const DAEMON_ENV_VAR = "PASEO_MUSE_DAEMON";

export function isDaemonSession(env: Readonly<Record<string, string>> | undefined): boolean {
  return env?.[DAEMON_ENV_VAR] === "1";
}

/** The well-known daemon socket `muse serve --listen` binds and `--join` connects to. */
export function daemonSocket(env: Readonly<Record<string, string | undefined>>): string {
  const data = env.XDG_DATA_HOME || path.join(env.HOME || os.homedir(), ".local", "share");
  return path.join(data, "muse", "session-server", "session-server.sock");
}

function unavailable(socket: string, reason: string): MuseError {
  return new MuseError(
    "daemonUnavailable",
    `The Muse session daemon does not answer on ${socket} (${reason}). ` +
      "This session runs in the shared daemon (PASEO_MUSE_DAEMON=1); start the daemon " +
      "(`muse serve --listen`) and retry.",
  );
}

/** Throws `daemonUnavailable` unless the daemon socket exists. */
export function assertDaemonSocket(env: Readonly<Record<string, string | undefined>>): void {
  const socket = daemonSocket(env);
  let isSocket = false;
  try {
    isSocket = statSync(socket).isSocket();
  } catch (error) {
    throw unavailable(socket, (error as NodeJS.ErrnoException).code ?? "missing");
  }
  if (!isSocket) throw unavailable(socket, "not a socket");
}

/**
 * Resolves when a daemon accepts connections on `socket`, rejects with
 * `daemonUnavailable` otherwise. A socket file left behind by a killed daemon
 * refuses the connect, so it counts as no daemon.
 */
export function probeDaemon(socket: string, timeoutMs = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    const connection = net.createConnection(socket);
    const fail = (reason: string) => {
      connection.destroy();
      reject(unavailable(socket, reason));
    };
    connection.setTimeout(timeoutMs, () => fail("timed out"));
    connection.once("error", (error: NodeJS.ErrnoException) => fail(error.code ?? error.message));
    connection.once("connect", () => {
      connection.destroy();
      resolve();
    });
  });
}
