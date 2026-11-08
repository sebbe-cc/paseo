import type { Command } from "commander";
import type { WorkspaceBase } from "@getpaseo/protocol/messages";
import { connectToDaemon, getDaemonHost } from "../../utils/client.js";
import type { CommandError, OutputSchema, SingleResult } from "../../output/index.js";

interface WorkspaceSetBaseResult {
  workspaceId: string;
  base: string;
  forkSha: string | null;
}

const workspaceSetBaseSchema: OutputSchema<WorkspaceSetBaseResult> = {
  idField: "workspaceId",
  columns: [
    { header: "WORKSPACE ID", field: "workspaceId", width: 20 },
    { header: "BASE", field: "base", width: 40 },
    { header: "FORK SHA", field: (row) => row.forkSha ?? "", width: 40 },
  ],
};

export interface WorkspaceSetBaseOptions {
  host?: string;
  daemonTarget: import("../../utils/daemon-target.js").DaemonTarget;
}

export function resolveWorkspaceBaseRef(input: { baseRef?: string }): string {
  const baseRef = input.baseRef?.trim() ?? "";
  if (!baseRef) {
    throw {
      code: "MISSING_BASE",
      message: "Base ref cannot be empty",
      details: "Usage: paseo workspace set-base <workspace-id> <ref>",
    } satisfies CommandError;
  }
  return baseRef;
}

export async function runSetBaseCommand(
  workspaceId: string,
  baseRefArg: string | undefined,
  options: WorkspaceSetBaseOptions,
  _command: Command,
): Promise<SingleResult<WorkspaceSetBaseResult>> {
  const baseRef = resolveWorkspaceBaseRef({ baseRef: baseRefArg });

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
    const applied = await client.setWorkspaceBase(workspaceId, baseRef);
    const base: WorkspaceBase | null = applied.base;
    if (!base) {
      throw {
        code: "WORKSPACE_SET_BASE_FAILED",
        message: "Daemon did not return a workspace base",
      } satisfies CommandError;
    }
    return {
      type: "single",
      data: { workspaceId, base: base.ref, forkSha: base.forkSha },
      schema: workspaceSetBaseSchema,
    };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw { code: "WORKSPACE_SET_BASE_FAILED", message } satisfies CommandError;
  } finally {
    await client.close().catch(() => undefined);
  }
}
