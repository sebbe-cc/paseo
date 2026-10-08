import type { Command } from "commander";
import {
  WORKSPACE_LABEL_COLORS,
  type WorkspaceLabelColor,
} from "@getpaseo/protocol/workspace-labels";
import { connectToDaemon, getDaemonHost } from "../../utils/client.js";
import type {
  CommandError,
  ListResult,
  OutputSchema,
  SingleResult,
} from "../../output/index.js";

export interface WorkspaceLabelRow {
  name: string;
  color: string;
}

const workspaceLabelsSchema: OutputSchema<WorkspaceLabelRow> = {
  idField: "name",
  columns: [
    { header: "LABEL", field: "name", width: 30 },
    { header: "COLOR", field: "color", width: 10 },
  ],
};

interface WorkspaceLabelSetResult {
  workspaceId: string;
  name: string;
  color: string;
}

const workspaceLabelSetSchema: OutputSchema<WorkspaceLabelSetResult> = {
  idField: "workspaceId",
  columns: [
    { header: "WORKSPACE ID", field: "workspaceId", width: 20 },
    { header: "LABEL", field: "name", width: 30 },
    { header: "COLOR", field: "color", width: 10 },
  ],
};

interface WorkspaceLabelRemoveResult {
  workspaceId: string;
  name: string;
  status: "removed";
}

const workspaceLabelRemoveSchema: OutputSchema<WorkspaceLabelRemoveResult> = {
  idField: "workspaceId",
  columns: [
    { header: "WORKSPACE ID", field: "workspaceId", width: 20 },
    { header: "LABEL", field: "name", width: 30 },
    { header: "STATUS", field: "status", width: 10 },
  ],
};

export interface WorkspaceLabelCommandOptions {
  host?: string;
  daemonTarget: import("../../utils/daemon-target.js").DaemonTarget;
  color?: string;
}

export function resolveWorkspaceLabelName(name: string | undefined): string {
  const trimmed = name?.trim() ?? "";
  if (trimmed.length === 0) {
    throw {
      code: "MISSING_LABEL",
      message: "Label name cannot be empty",
      details: "Usage: paseo workspace label-set <workspace-id> <label> [--color <color>]",
    } satisfies CommandError;
  }
  return trimmed;
}

export function resolveWorkspaceLabelColor(color: string | undefined): WorkspaceLabelColor {
  if (color === undefined) return WORKSPACE_LABEL_COLORS[0];
  if ((WORKSPACE_LABEL_COLORS as readonly string[]).includes(color)) {
    return color as WorkspaceLabelColor;
  }
  throw {
    code: "INVALID_COLOR",
    message: `Unknown label color: ${color}`,
    details: `Valid colors: ${WORKSPACE_LABEL_COLORS.join(", ")}`,
  } satisfies CommandError;
}

async function withDaemonClient<T>(
  options: WorkspaceLabelCommandOptions,
  run: (client: Awaited<ReturnType<typeof connectToDaemon>>) => Promise<T>,
): Promise<T> {
  const host = getDaemonHost({ target: options.daemonTarget });
  const client = await connectToDaemon({ target: options.daemonTarget }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    throw {
      code: "DAEMON_NOT_RUNNING",
      message: `Cannot connect to daemon at ${host}: ${message}`,
      details: "Start the daemon with: paseo daemon start",
    } satisfies CommandError;
  });
  try {
    return await run(client);
  } finally {
    await client.close().catch(() => undefined);
  }
}

function toCommandError(code: string, error: unknown): CommandError {
  if (error && typeof error === "object" && "code" in error) throw error;
  const message = error instanceof Error ? error.message : String(error);
  return { code, message } satisfies CommandError;
}

export async function runLabelsCommand(
  workspaceId: string,
  options: WorkspaceLabelCommandOptions,
  _command: Command,
): Promise<ListResult<WorkspaceLabelRow>> {
  return withDaemonClient(options, async (client) => {
    try {
      const catalog = await client.listWorkspaceLabels();
      const colorsByLabel = new Map(
        catalog.labels.map((label) => [label.name.toLowerCase(), label.color]),
      );
      let cursor: string | undefined;
      let names: string[] | undefined;
      do {
        const payload = await client.fetchWorkspaces({
          page: { limit: 200, ...(cursor ? { cursor } : {}) },
        });
        const match = payload.entries.find((entry) => entry.id === workspaceId);
        if (match) {
          names = match.labels ?? [];
          break;
        }
        cursor = payload.pageInfo.nextCursor ?? undefined;
      } while (cursor);
      if (!names) {
        throw new Error(`Workspace ${workspaceId} not found`);
      }
      return {
        type: "list",
        data: names.map((name) => ({
          name,
          color: colorsByLabel.get(name.toLowerCase()) ?? "",
        })),
        schema: workspaceLabelsSchema,
      };
    } catch (error) {
      throw toCommandError("WORKSPACE_LABELS_FAILED", error);
    }
  });
}

export async function runLabelSetCommand(
  workspaceId: string,
  nameArg: string | undefined,
  options: WorkspaceLabelCommandOptions,
  command: Command,
): Promise<SingleResult<WorkspaceLabelSetResult>> {
  const name = resolveWorkspaceLabelName(nameArg);
  // withGlobalOptions() merges globals over subcommand options, so the global
  // --no-color default (color: true) would shadow --color <name>; read it locally.
  const localColor =
    typeof command?.opts === "function"
      ? (command.opts().color as string | undefined)
      : undefined;
  const mergedColor = typeof options.color === "string" ? options.color : undefined;
  const color = resolveWorkspaceLabelColor(localColor ?? mergedColor);
  return withDaemonClient(options, async (client) => {
    try {
      const payload = await client.setWorkspaceLabel({
        workspaceId,
        label: { name, color },
        assigned: true,
      });
      return {
        type: "single",
        data: {
          workspaceId,
          name: payload.label.name,
          color: payload.label.color,
        },
        schema: workspaceLabelSetSchema,
      };
    } catch (error) {
      throw toCommandError("WORKSPACE_LABEL_SET_FAILED", error);
    }
  });
}

export async function runLabelRemoveCommand(
  workspaceId: string,
  nameArg: string | undefined,
  options: WorkspaceLabelCommandOptions,
  _command: Command,
): Promise<SingleResult<WorkspaceLabelRemoveResult>> {
  const name = resolveWorkspaceLabelName(nameArg);
  return withDaemonClient(options, async (client) => {
    try {
      const payload = await client.setWorkspaceLabel({
        workspaceId,
        label: { name, color: WORKSPACE_LABEL_COLORS[0] },
        assigned: false,
      });
      return {
        type: "single",
        data: {
          workspaceId,
          name: payload.label.name,
          status: "removed",
        },
        schema: workspaceLabelRemoveSchema,
      };
    } catch (error) {
      throw toCommandError("WORKSPACE_LABEL_REMOVE_FAILED", error);
    }
  });
}
