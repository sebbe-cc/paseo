import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "pino";
import {
  ensureTmuxSocketDir,
  persistentSessionName,
  resolveTmuxBinary,
  tmuxPanePid,
  tmuxSessionAlive,
  tmuxSocketPath,
  type PersistentTerminalBinding,
} from "../terminal/tmux.js";
import type { TerminalManager } from "../terminal/terminal-manager.js";
import type { ServiceProxySubsystem } from "./service-proxy.js";
import type { WorkspaceScriptRuntimeStore } from "./workspace-script-runtime-store.js";

/**
 * Disk journal for persistent (tmux-backed) terminals (pa-bhkn0).
 *
 * The tmux session survives the daemon, but the daemon's own records (terminal
 * ids, script runtime entries, service-proxy routes) are in-memory. This
 * journal bridges restarts: shutdown spares the sessions, boot reattaches a
 * fresh PTY to each live session under the same terminal id, restores the
 * script runtime entries as running, and re-registers service routes — so the
 * lab keeps its PIDs and Paseo shows it as running instead of restarting it.
 *
 * Records live in `<paseoHome>/terminals/persistent/<terminalId>.json`.
 * Agent hosts (muse serve, claude, codex) are never recorded here and keep
 * the existing shutdown path (closeAllAgents + provider shutdown).
 */

export interface PersistentTerminalRecord {
  /** Terminal id; reused on reattach so script entries keep pointing at it. */
  id: string;
  name: string;
  cwd: string;
  workspaceId: string;
  title?: string;
  /** tmux session name (derived from id at record time). */
  sessionName: string;
  /** Workspace script this terminal runs, when created for one. */
  scriptName?: string;
  scriptType?: "script" | "service";
  /** Service route inputs, so reattach re-registers the same hostname/port. */
  serviceHostname?: string;
  servicePort?: number | null;
  projectSlug?: string;
  branchName?: string | null;
  /** Command to send when the session had to be recreated fresh. */
  command?: string;
  /** Environment for a recreated session (service PORT/HOSTNAMES/...). */
  env?: Record<string, string>;
  rows?: number;
  cols?: number;
  createdAt: string;
}

export function persistentTerminalDir(paseoHome: string): string {
  return join(paseoHome, "terminals", "persistent");
}

export function recordPersistentTerminal(
  paseoHome: string,
  record: PersistentTerminalRecord,
): void {
  const dir = persistentTerminalDir(paseoHome);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${record.id}.json`);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(record, null, 2));
  // Atomic replace so a crash mid-write never leaves a half record.
  writeFileSync(path, readFileSync(tmp));
  rmSync(tmp);
}

export function removePersistentTerminal(paseoHome: string, terminalId: string): void {
  rmSync(join(persistentTerminalDir(paseoHome), `${terminalId}.json`), { force: true });
}

export function listPersistentTerminals(paseoHome: string): PersistentTerminalRecord[] {
  let files: string[];
  try {
    files = readdirSync(persistentTerminalDir(paseoHome));
  } catch {
    return [];
  }
  const records: PersistentTerminalRecord[] = [];
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    try {
      const parsed = JSON.parse(
        readFileSync(join(persistentTerminalDir(paseoHome), file), "utf8"),
      ) as PersistentTerminalRecord;
      if (parsed && typeof parsed.id === "string" && typeof parsed.sessionName === "string") {
        records.push(parsed);
      }
    } catch {
      // A corrupt record must not block the reattach of its siblings.
    }
  }
  return records;
}

export interface PersistentTerminalContext {
  paseoHome: string;
  tmuxBin?: string;
}

export function resolvePersistentBinding(
  context: PersistentTerminalContext,
  terminalId: string,
): PersistentTerminalBinding | null {
  const tmuxBin = context.tmuxBin ?? resolveTmuxBinary();
  if (!tmuxBin) return null;
  return {
    tmuxBin,
    socketPath: tmuxSocketPath(context.paseoHome),
    sessionName: persistentSessionName(terminalId),
  };
}

export interface ReattachPersistentTerminalsDeps {
  paseoHome: string;
  terminalManager: TerminalManager;
  runtimeStore: WorkspaceScriptRuntimeStore;
  /** Null in environments without a service proxy (tests); routes are skipped then. */
  serviceProxy: Pick<ServiceProxySubsystem, "registerWorkspaceService"> | null;
  serviceProxyPublicBaseUrl: string | null;
  logger?: Pick<Logger, "info" | "warn">;
}

export interface ReattachPersistentTerminalsResult {
  /** Live sessions reattached under the same terminal id (same PIDs). */
  attached: string[];
  /** Dead sessions recreated fresh (new PIDs) and restarted where recorded. */
  recreated: string[];
  /** Records dropped (terminal gone and nothing to recreate). */
  dropped: Array<{ id: string; reason: string }>;
}

/**
 * Boot recovery: reattach every journaled persistent terminal. Runs once at
 * daemon start, before serving. A live tmux session keeps its PIDs — attach
 * only. A dead session is recreated and, for scripts, the recorded command is
 * resent so a service comes back on its recorded port; never a duplicate of
 * a live one.
 */
export async function reattachPersistentTerminals(
  deps: ReattachPersistentTerminalsDeps,
): Promise<ReattachPersistentTerminalsResult> {
  const { paseoHome, terminalManager, runtimeStore, serviceProxy, serviceProxyPublicBaseUrl, logger } =
    deps;
  const result: ReattachPersistentTerminalsResult = { attached: [], recreated: [], dropped: [] };
  const tmuxBin = resolveTmuxBinary();
  if (!tmuxBin) {
    logger?.warn("tmux is not on PATH; skipping persistent terminal reattach");
    return result;
  }
  const socketPath = tmuxSocketPath(paseoHome);
  ensureTmuxSocketDir(socketPath);

  for (const record of listPersistentTerminals(paseoHome)) {
    const binding: PersistentTerminalBinding = {
      tmuxBin,
      socketPath,
      sessionName: record.sessionName,
    };
    try {
      if (tmuxSessionAlive(binding)) {
        const terminal = await terminalManager.createTerminal({
          id: record.id,
          cwd: record.cwd,
          workspaceId: record.workspaceId,
          name: record.name,
          ...(record.title ? { title: record.title } : {}),
          ...(record.rows !== undefined ? { rows: record.rows } : {}),
          ...(record.cols !== undefined ? { cols: record.cols } : {}),
          persistent: binding,
        });
        void terminal;
        restoreScriptRuntime({ record, runtimeStore, serviceProxy, serviceProxyPublicBaseUrl, logger });
        result.attached.push(record.id);
        logger?.info(
          { terminalId: record.id, panePid: tmuxPanePid(binding) },
          "Reattached persistent terminal to its surviving tmux session",
        );
      } else if (record.scriptName && record.command) {
        // The session died with the lab (machine reboot, tmux server gone):
        // recreate it fresh and restart the recorded command once.
        const terminal = await terminalManager.createTerminal({
          id: record.id,
          cwd: record.cwd,
          workspaceId: record.workspaceId,
          name: record.name,
          ...(record.title ? { title: record.title } : {}),
          ...(record.env ? { env: record.env } : {}),
          persistent: binding,
        });
        // Wait briefly for the client to attach before sending the command.
        await new Promise((resolve) => setTimeout(resolve, 500));
        terminal.send({ type: "input", data: `${record.command}\r` });
        restoreScriptRuntime({ record, runtimeStore, serviceProxy, serviceProxyPublicBaseUrl, logger });
        result.recreated.push(record.id);
        logger?.info({ terminalId: record.id }, "Recreated dead persistent terminal and resent its command");
      } else {
        removePersistentTerminal(paseoHome, record.id);
        result.dropped.push({ id: record.id, reason: "tmux session is gone" });
      }
    } catch (error) {
      logger?.warn({ err: error, terminalId: record.id }, "Failed to reattach persistent terminal");
      result.dropped.push({ id: record.id, reason: (error as Error).message });
    }
  }
  return result;
}

function restoreScriptRuntime(options: {
  record: PersistentTerminalRecord;
  runtimeStore: WorkspaceScriptRuntimeStore;
  serviceProxy: Pick<ServiceProxySubsystem, "registerWorkspaceService"> | null;
  serviceProxyPublicBaseUrl: string | null;
  logger?: Pick<Logger, "info" | "warn">;
}): void {
  const { record, runtimeStore, serviceProxy, serviceProxyPublicBaseUrl, logger } = options;
  if (!record.scriptName) return;
  if (
    record.scriptType === "service" &&
    record.servicePort != null &&
    record.projectSlug &&
    serviceProxy
  ) {
    try {
      serviceProxy.registerWorkspaceService({
        port: record.servicePort,
        workspaceId: record.workspaceId,
        projectSlug: record.projectSlug,
        branchName: record.branchName ?? null,
        scriptName: record.scriptName,
        publicBaseUrl: serviceProxyPublicBaseUrl ?? null,
      });
    } catch (error) {
      logger?.warn(
        { err: error, scriptName: record.scriptName },
        "Failed to re-register service route for reattached script",
      );
    }
  }
  runtimeStore.set({
    workspaceId: record.workspaceId,
    scriptName: record.scriptName,
    type: record.scriptType ?? "script",
    lifecycle: "running",
    terminalId: record.id,
    exitCode: null,
  });
}
