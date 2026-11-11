import type { Logger } from "pino";
import type { TerminalManager } from "../terminal/terminal-manager.js";
import type { TerminalSession } from "../terminal/terminal.js";
import {
  listTerminalWorkerRecords,
  type TerminalWorkerTerminalEntry,
} from "../terminal/terminal-worker-record.js";
import {
  createTerminalWorkerProcessInspector,
  type TerminalWorkerProcessInspector,
} from "../terminal/terminal-worker-processes.js";
import { classifyTerminalProgramProcess } from "../terminal/terminal-worker-ownership.js";
import type {
  WorkspaceRegistry,
  ProjectRegistry,
  PersistedWorkspaceRecord,
} from "./workspace-registry.js";
import type { WorkspaceScriptRuntimeStore } from "./workspace-script-runtime-store.js";
import { getScriptConfigs, isServiceScript, readPaseoConfig } from "../utils/worktree.js";
import { deriveProjectServiceSlug } from "./workspace-git-metadata.js";
import { normalizeServiceEnvName } from "./workspace-service-env.js";
import { resolveWorkspaceScriptBranch } from "./workspace-script-identity.js";
interface RecoveryOptions {
  paseoHome: string;
  runtimeStore: WorkspaceScriptRuntimeStore;
  terminalManager: TerminalManager;
  workspaceRegistry: Pick<WorkspaceRegistry, "get" | "listAll">;
  projectRegistry: Pick<ProjectRegistry, "get">;
  logger: Pick<Logger, "warn" | "info">;
}
interface RecoveryContext {
  options: RecoveryOptions;
  inspector: TerminalWorkerProcessInspector;
  programs: TerminalWorkerTerminalEntry[];
  workspaces: Map<string, PersistedWorkspaceRecord>;
}
async function servicePort(
  terminal: TerminalSession,
  context: RecoveryContext,
): Promise<number | null> {
  const program = context.programs.find((p) => p.id === terminal.id);
  if (
    !program ||
    classifyTerminalProgramProcess(program, await context.inspector.inspect(program.pid)).status !==
      "owned"
  )
    return null;
  const env = await context.inspector.readEnvironment(program.pid);
  const value = (name: string) =>
    env?.find((line) => line.startsWith(`${name}=`))?.slice(name.length + 1);
  const port = Number(value("PASEO_PORT"));
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) return null;
  return value(`PASEO_SERVICE_${normalizeServiceEnvName(terminal.name)}_PORT`) === String(port)
    ? port
    : null;
}
async function recoverDirectory(cwd: string, context: RecoveryContext): Promise<void> {
  const { options } = context;
  const terminals = await options.terminalManager.getTerminals(cwd);
  const parsed = await readPaseoConfig(cwd);
  if (!parsed.ok) return;
  const scripts = getScriptConfigs(parsed.config);
  for (const terminal of terminals) {
    const workspace = context.workspaces.get(terminal.workspaceId);
    const script = scripts.get(terminal.name);
    if (
      !workspace ||
      workspace.archivedAt ||
      workspace.cwd !== cwd ||
      !script ||
      !isServiceScript(script)
    )
      continue;
    const key = { workspaceId: workspace.workspaceId, scriptName: terminal.name };
    if (options.runtimeStore.get(key)) continue;
    if (
      terminals.filter((t) => t.workspaceId === terminal.workspaceId && t.name === terminal.name)
        .length !== 1
    ) {
      options.logger.warn(key, "Multiple legacy script terminals require manual reconciliation");
      continue;
    }
    const port = await servicePort(terminal, context);
    if (port === null) continue;
    const project = await options.projectRegistry.get(workspace.projectId);
    if (!project) continue;
    const branchName = await resolveWorkspaceScriptBranch(cwd, workspace.branch ?? null);
    options.runtimeStore.set({
      ...key,
      terminalId: terminal.id,
      type: "service",
      lifecycle: "running",
      exitCode: null,
      cwd,
      port,
      projectSlug: deriveProjectServiceSlug(project),
      branchName,
    });
    options.logger.info(
      { ...key, terminalId: terminal.id, port },
      "Recovered legacy workspace script from its owned terminal environment",
    );
  }
}
/** One-time bridge for services started before the runtime journal existed. */
export async function recoverLegacyWorkspaceScripts(options: RecoveryOptions): Promise<void> {
  if (process.platform !== "linux" || options.terminalManager.getUnavailableError?.()) return;
  const directories = options.terminalManager.listDirectories();
  if (!directories.length) return;
  const files = await listTerminalWorkerRecords(options.paseoHome);
  const context: RecoveryContext = {
    options,
    inspector: createTerminalWorkerProcessInspector(),
    programs: files.flatMap((f) => ("error" in f ? [] : f.record.terminals)),
    workspaces: new Map((await options.workspaceRegistry.listAll()).map((w) => [w.workspaceId, w])),
  };
  for (const cwd of directories) await recoverDirectory(cwd, context);
  await options.runtimeStore.flush();
}
