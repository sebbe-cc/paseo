import { resolveWorkspaceScriptBranch } from "./workspace-script-identity.js";
import type { TerminalManager } from "../terminal/terminal-manager.js";
import type { WorkspaceRegistry } from "./workspace-registry.js";
import type { ServiceProxySubsystem } from "./service-proxy.js";
import type { WorkspaceScriptRuntimeStore } from "./workspace-script-runtime-store.js";
import { watchWorkspaceScript } from "./workspace-script-lifecycle.js";
import { restoreWorkspaceServicePort } from "./workspace-service-port-registry.js";

/** Reconcile durable metadata against the worker's adopted identities, never terminal names. */
export async function restoreWorkspaceScripts(options: {
  runtimeStore: WorkspaceScriptRuntimeStore;
  terminalManager: TerminalManager;
  workspaceRegistry: Pick<WorkspaceRegistry, "get">;
  serviceProxy: ServiceProxySubsystem;
  publicBaseUrl: string | null;
  onLifecycleChanged?: (workspaceId: string) => void;
}): Promise<void> {
  const { runtimeStore, terminalManager, workspaceRegistry, serviceProxy } = options;
  const unavailable = terminalManager.getUnavailableError?.();
  if (unavailable) return;
  for (const entry of runtimeStore.list()) {
    if (entry.lifecycle !== "running") continue;
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
      continue;
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
  }
  await runtimeStore.flush();
}
