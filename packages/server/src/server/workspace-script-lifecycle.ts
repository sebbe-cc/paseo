import type { TerminalSession } from "../terminal/terminal.js";
import type { WorkspaceScriptRuntimeStore } from "./workspace-script-runtime-store.js";
import type { ServiceProxySubsystem } from "./service-proxy.js";

/**
 * Guarded running -> stopped transition for one journaled run. Only the run bound
 * to `terminalId` flips, so a late event from a previous run is a no-op. Returns
 * whether the entry was flipped.
 */
export function markWorkspaceScriptStopped(options: {
  runtimeStore: WorkspaceScriptRuntimeStore;
  serviceProxy: ServiceProxySubsystem;
  workspaceId: string;
  scriptName: string;
  terminalId: string;
  exitCode: number | null;
  onLifecycleChanged?: () => void;
}): boolean {
  const { runtimeStore, serviceProxy, workspaceId, scriptName, terminalId, exitCode } = options;
  const current = runtimeStore.get({ workspaceId, scriptName });
  if (current?.terminalId !== terminalId || current.lifecycle !== "running") return false;
  if (current.type === "service") serviceProxy.removeWorkspaceService({ workspaceId, scriptName });
  runtimeStore.set({ ...current, lifecycle: "stopped", exitCode });
  options.onLifecycleChanged?.();
  return true;
}

/** The same exit/command listeners serve freshly launched and adopted scripts. */
export function watchWorkspaceScript(options: {
  terminal: TerminalSession;
  runtimeStore: WorkspaceScriptRuntimeStore;
  serviceProxy: ServiceProxySubsystem;
  workspaceId: string;
  scriptName: string;
  onLifecycleChanged?: () => void;
}): () => void {
  const { terminal, runtimeStore, serviceProxy, workspaceId, scriptName } = options;
  let dispose = () => {};
  const stopped = (exitCode: number | null) => {
    dispose();
    markWorkspaceScriptStopped({
      runtimeStore,
      serviceProxy,
      workspaceId,
      scriptName,
      terminalId: terminal.id,
      exitCode,
      onLifecycleChanged: options.onLifecycleChanged,
    });
  };
  const offExit = terminal.onExit((info) => stopped(info.exitCode));
  const offCommand =
    runtimeStore.get({ workspaceId, scriptName })?.type === "script"
      ? terminal.onCommandFinished((info) => stopped(info.exitCode))
      : () => {};
  dispose = () => {
    offExit();
    offCommand();
  };
  return dispose;
}
