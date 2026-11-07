import type { Command } from "commander";
import type { WorkspaceDescriptorPayload } from "@getpaseo/protocol/messages";
import { connectToDaemon } from "../../utils/client.js";
import type { SingleResult } from "../../output/index.js";
import type { WorkspaceLsOptions } from "./ls.js";

export async function runShowCommand(
  workspaceId: string,
  options: WorkspaceLsOptions,
  _command: Command,
): Promise<SingleResult<WorkspaceDescriptorPayload>> {
  const client = await connectToDaemon({ target: options.daemonTarget });
  try {
    const payload = await client.fetchWorkspaces({
      filter: { idPrefix: workspaceId, includeBackground: true },
    });
    const workspace = payload.entries.find((entry) => entry.id === workspaceId);
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`);
    return {
      type: "single",
      data: workspace,
      schema: {
        idField: "id",
        columns: [
          { header: "WORKSPACE ID", field: "id", width: 20 },
          { header: "BASE", field: (row) => row.base?.ref ?? "", width: 40 },
          { header: "FORK SHA", field: (row) => row.base?.forkSha ?? "", width: 40 },
          {
            header: "BASE STATUS",
            field: (row) => {
              if (row.baseError) return row.baseError;
              if (row.base?.missing) return "missing; comparing against saved fork point";
              return row.base ? "available" : "unavailable";
            },
            width: 45,
          },
        ],
      },
    };
  } finally {
    await client.close().catch(() => undefined);
  }
}
