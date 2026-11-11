import type { Command } from "commander";
import { workspaceBaseOf, type PaseoWorkspaceBase } from "@getpaseo/client";
import type { WorkspaceDescriptorPayload } from "@getpaseo/protocol/messages";
import { connectToDaemon, getDaemonHost } from "../../utils/client.js";
import type { CommandError, OutputSchema, SingleResult } from "../../output/index.js";

export interface WorkspaceShowOptions {
  host?: string;
  daemonTarget: import("../../utils/daemon-target.js").DaemonTarget;
}

export interface WorkspaceDetailRow {
  workspaceId: string;
  project: string;
  name: string;
  isolation: "local" | "worktree";
  cwd: string;
  background: boolean;
  branch: string;
  /** The daemon-resolved base ref, with a missing marker; "" when not reported. */
  base: string;
  baseMissing: boolean;
  /** Commit the comparison starts from when the ref is missing; "" otherwise. */
  forkSha: string;
  /** Why the daemon could not resolve the base; "" when it did. */
  baseError: string;
}

function formatBaseStatus(row: WorkspaceDetailRow): string {
  if (row.baseError) return row.baseError;
  if (row.baseMissing) return "missing; comparing against saved fork point";
  return row.base ? "available" : "unavailable";
}

/**
 * Format the daemon-resolved base for display. A pruned or deleted ref keeps
 * its name with a missing marker instead of silently falling back to the
 * repository default, so Changes/Commits views can say what they compare
 * against. "" means the daemon did not report a base (older host).
 */
export function formatWorkspaceBase(base: PaseoWorkspaceBase | null): string {
  if (!base) return "";
  return base.missing ? `${base.ref} (missing)` : base.ref;
}

export function toWorkspaceDetail(workspace: WorkspaceDescriptorPayload): WorkspaceDetailRow {
  const base = workspaceBaseOf(workspace);
  return {
    workspaceId: workspace.id,
    project: workspace.projectDisplayName,
    name: workspace.name,
    isolation: workspace.workspaceKind === "worktree" ? "worktree" : "local",
    cwd: workspace.workspaceDirectory,
    background: workspace.background === true,
    branch: workspace.gitRuntime?.currentBranch ?? "",
    base: formatWorkspaceBase(base),
    baseMissing: base?.missing ?? false,
    forkSha: base?.forkSha ?? "",
    baseError: workspace.baseError ?? "",
  };
}

export const workspaceDetailSchema: OutputSchema<WorkspaceDetailRow> = {
  idField: "workspaceId",
  columns: [
    { header: "WORKSPACE ID", field: "workspaceId", width: 20 },
    { header: "PROJECT", field: "project", width: 20 },
    { header: "NAME", field: "name", width: 22 },
    { header: "ISOLATION", field: "isolation", width: 10 },
    { header: "CWD", field: "cwd", width: 42 },
    { header: "BACKGROUND", field: (row) => (row.background ? "yes" : ""), width: 10 },
    { header: "BASE", field: "base", width: 40 },
    { header: "FORK SHA", field: "forkSha", width: 40 },
    { header: "BASE STATUS", field: formatBaseStatus, width: 45 },
  ],
  renderHuman: (result) => {
    const row = result.type === "single" ? result.data : result.data[0];
    if (!row) return "";
    const lines = [
      `workspace: ${row.workspaceId}`,
      `project: ${row.project}`,
      `name: ${row.name}`,
      `isolation: ${row.isolation}`,
      `cwd: ${row.cwd}`,
      `background: ${row.background ? "yes" : "no"}`,
      `branch: ${row.branch || "unknown"}`,
    ];
    if (row.base) {
      lines.push(`base: ${row.base}`);
      if (row.baseMissing && row.forkSha) lines.push(`fork sha: ${row.forkSha}`);
      lines.push(`base status: ${formatBaseStatus(row)}`);
    } else if (row.baseError) {
      lines.push(`base: unavailable (${row.baseError})`);
    } else {
      lines.push("base: not reported (update the host for base-aware views)");
    }
    return lines.join("\n");
  },
};

export async function runShowCommand(
  workspaceId: string,
  options: WorkspaceShowOptions,
  _command: Command,
): Promise<SingleResult<WorkspaceDetailRow>> {
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
    // A show addresses one workspace by id, so a background one resolves too
    // on hosts that support them.
    const filter = {
      idPrefix: workspaceId,
      ...(client.supportsBackgroundWorkspaces() ? { includeBackground: true } : {}),
    };
    let cursor: string | undefined;
    do {
      const payload = await client.fetchWorkspaces({
        filter,
        page: { limit: 200, ...(cursor ? { cursor } : {}) },
      });
      const match = payload.entries.find((entry) => entry.id === workspaceId);
      if (match) {
        return { type: "single", data: toWorkspaceDetail(match), schema: workspaceDetailSchema };
      }
      cursor = payload.pageInfo.nextCursor ?? undefined;
    } while (cursor);
    throw {
      code: "WORKSPACE_NOT_FOUND",
      message: `Workspace ${workspaceId} not found`,
      details: "List workspaces with: paseo workspace ls",
    } satisfies CommandError;
  } finally {
    await client.close().catch(() => undefined);
  }
}
