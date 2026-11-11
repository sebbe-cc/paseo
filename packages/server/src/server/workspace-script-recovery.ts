import type { Logger } from "pino";
import { resolveWorkspaceScriptBranch } from "./workspace-script-identity.js";
import type { TerminalManager } from "../terminal/terminal-manager.js";
import type { TerminalSession } from "../terminal/terminal.js";
import type { WorkspaceRegistry } from "./workspace-registry.js";
import type { ServiceProxySubsystem } from "./service-proxy.js";
import type {
  ScriptRuntimeEntry,
  WorkspaceScriptRuntimeStore,
} from "./workspace-script-runtime-store.js";
import { markWorkspaceScriptStopped, watchWorkspaceScript } from "./workspace-script-lifecycle.js";
import { restoreWorkspaceServicePort } from "./workspace-service-port-registry.js";

interface ScriptRestoreOptions {
  runtimeStore: WorkspaceScriptRuntimeStore;
  terminalManager: TerminalManager;
  workspaceRegistry: Pick<WorkspaceRegistry, "get">;
  serviceProxy: ServiceProxySubsystem;
  publicBaseUrl: string | null;
  logger?: Pick<Logger, "warn">;
  onLifecycleChanged?: (workspaceId: string) => void;
}

/**
 * Reconcile one journaled run against the adopted terminal. Plain scripts run in
 * reusable shells, so a command that finished while the daemon was detached
 * leaves the terminal alive with no live event to observe. The worker-retained
 * last completion is the only witness: read it after installing the watcher, so
 * a completion racing adoption is seen either here or by the listener, and the
 * guarded transition makes a double delivery a no-op.
 */
function reconcileDetachedCompletion(
  options: ScriptRestoreOptions,
  entry: ScriptRuntimeEntry,
  terminal: TerminalSession,
): void {
  if (entry.type !== "script" || entry.commandSeq === undefined) return;
  const { runtimeStore, serviceProxy } = options;
  const finished = terminal.getLastCommandFinished?.();
  if (finished && finished.seq > entry.commandSeq) {
    markWorkspaceScriptStopped({
      runtimeStore,
      serviceProxy,
      workspaceId: entry.workspaceId,
      scriptName: entry.scriptName,
      terminalId: terminal.id,
      exitCode: finished.exitCode,
      onLifecycleChanged: () => options.onLifecycleChanged?.(entry.workspaceId),
    });
  }
}

async function restoreScriptEntry(
  options: ScriptRestoreOptions,
  entry: ScriptRuntimeEntry,
): Promise<void> {
  const { runtimeStore, terminalManager, workspaceRegistry, serviceProxy } = options;
  const workspace = await workspaceRegistry.get(entry.workspaceId);
  const terminal = terminalManager.getTerminal(entry.terminalId);
  if (
    !workspace ||
    workspace.archivedAt ||
    !terminal ||
    terminal.workspaceId !== entry.workspaceId ||
    terminal.cwd !== workspace.cwd ||
    (entry.cwd !== undefined && entry.cwd !== terminal.cwd)
  ) {
    runtimeStore.set({ ...entry, lifecycle: "stopped" });
    return;
  }
  if (entry.type === "service") {
    if (!entry.port || !entry.projectSlug)
      throw new Error(`Missing recovery metadata for script ${entry.scriptName}`);
    restoreWorkspaceServicePort(entry.workspaceId, entry.scriptName, entry.port);
    serviceProxy.registerWorkspaceService({
      workspaceId: entry.workspaceId,
      scriptName: entry.scriptName,
      port: entry.port,
      projectSlug: entry.projectSlug,
      branchName: await resolveWorkspaceScriptBranch(
        workspace.cwd,
        workspace.branch ?? entry.branchName ?? null,
      ),
      publicBaseUrl: options.publicBaseUrl,
    });
  }
  watchWorkspaceScript({
    ...entry,
    terminal,
    runtimeStore,
    serviceProxy,
    onLifecycleChanged: () => options.onLifecycleChanged?.(entry.workspaceId),
  });
  reconcileDetachedCompletion(options, entry, terminal);
}

/** Reconcile durable metadata against the worker's adopted identities, never terminal names. */
export async function restoreWorkspaceScripts(options: ScriptRestoreOptions): Promise<void> {
  const { runtimeStore, terminalManager } = options;
  const unavailable = terminalManager.getUnavailableError?.();
  if (unavailable) return;
  for (const entry of runtimeStore.list()) {
    if (entry.lifecycle !== "running") continue;
    try {
      await restoreScriptEntry(options, entry);
    } catch (error) {
      // One bad entry must not abort the restore of the remaining scripts,
      // and never fail daemon startup: mark it stopped so status stays honest.
      options.logger?.warn(
        { err: error, workspaceId: entry.workspaceId, scriptName: entry.scriptName },
        "Cannot restore workspace script; marking it stopped",
      );
      runtimeStore.set({ ...entry, lifecycle: "stopped", exitCode: null });
    }
  }
  await runtimeStore.flush();
}
