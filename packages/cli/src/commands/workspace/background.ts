import type { Command } from "commander";
import { connectToDaemon, getDaemonHost } from "../../utils/client.js";
import type { CommandError, OutputSchema, SingleResult } from "../../output/index.js";

interface WorkspaceBackgroundResult {
  workspaceId: string;
  background: boolean;
}

const workspaceBackgroundSchema: OutputSchema<WorkspaceBackgroundResult> = {
  idField: "workspaceId",
  columns: [
    { header: "WORKSPACE ID", field: "workspaceId", width: 20 },
    { header: "BACKGROUND", field: (item) => (item.background ? "on" : "off"), width: 12 },
  ],
};

/** `on` hides the workspace from default lists and the sidebar; `off` shows it. */
export function parseBackgroundState(state: string): boolean {
  switch (state.trim().toLowerCase()) {
    case "on":
      return true;
    case "off":
      return false;
    default:
      throw {
        code: "INVALID_STATE",
        message: `Expected on or off, got: ${state}`,
        details: "Usage: paseo workspace background <workspace-id> on|off",
      } satisfies CommandError;
  }
}

export interface WorkspaceBackgroundClient {
  getLastServerInfoMessage(): { features?: { workspaceBackgroundToggle?: boolean } } | null;
  setWorkspaceBackground(
    workspaceId: string,
    background: boolean,
  ): Promise<{ background: boolean }>;
  close(): Promise<void>;
}

interface WorkspaceBackgroundOptions {
  host?: string;
  daemonTarget: import("../../utils/daemon-target.js").DaemonTarget;
}

export async function runBackgroundCommand(
  workspaceId: string,
  state: string,
  options: WorkspaceBackgroundOptions,
  _command: Command,
): Promise<SingleResult<WorkspaceBackgroundResult>> {
  return setWorkspaceBackground(workspaceId, state, options);
}

export async function setWorkspaceBackground(
  workspaceId: string,
  state: string,
  options: WorkspaceBackgroundOptions,
  connect: (
    options: Parameters<typeof connectToDaemon>[0],
  ) => Promise<WorkspaceBackgroundClient> = connectToDaemon,
): Promise<SingleResult<WorkspaceBackgroundResult>> {
  const background = parseBackgroundState(state);
  const host = getDaemonHost({ target: options.daemonTarget });
  const client = await connect({ target: options.daemonTarget }).catch((error: unknown) => {
    throw {
      code: "DAEMON_NOT_RUNNING",
      message: `Cannot connect to daemon at ${host}: ${error instanceof Error ? error.message : String(error)}`,
      details: "Start the daemon with: paseo daemon start",
    } satisfies CommandError;
  });
  try {
    // COMPAT(workspaceBackgroundToggle): added in the v0.16.1 fork, remove gate after 2027-05-18.
    if (!client.getLastServerInfoMessage()?.features?.workspaceBackgroundToggle) {
      throw {
        code: "DAEMON_UPDATE_REQUIRED",
        message: "Update the host to change a workspace's background setting.",
      } satisfies CommandError;
    }
    const applied = await client.setWorkspaceBackground(workspaceId, background);
    return {
      type: "single",
      data: { workspaceId, background: applied.background },
      schema: workspaceBackgroundSchema,
    };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw { code: "WORKSPACE_BACKGROUND_FAILED", message } satisfies CommandError;
  } finally {
    await client.close().catch(() => undefined);
  }
}
