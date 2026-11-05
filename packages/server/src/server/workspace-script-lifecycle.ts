import type { TerminalSession } from "../terminal/terminal.js";
import type { WorkspaceScriptRuntimeStore } from "./workspace-script-runtime-store.js";
import type { ServiceProxySubsystem } from "./service-proxy.js";

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
    const current = runtimeStore.get({ workspaceId, scriptName });
    if (current?.terminalId !== terminal.id || current.lifecycle !== "running") return;
    dispose();
    if (current.type === "service")
      serviceProxy.removeWorkspaceService({ workspaceId, scriptName });
    runtimeStore.set({ ...current, lifecycle: "stopped", exitCode });
    options.onLifecycleChanged?.();
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
