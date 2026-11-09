import type { Command } from "commander";
import type { CommandOptions, ListResult } from "../../output/index.js";
import { buildDaemonConnectionCommandError, connectToDaemon } from "../../utils/client.js";
import { projectSchema, toProjectRow, type ProjectRow } from "./shared.js";

export async function runLsCommand(
  options: CommandOptions,
  _command: Command,
): Promise<ListResult<ProjectRow>> {
  const client = await connectToDaemon({ target: options.daemonTarget }).catch((error: unknown) => {
    throw buildDaemonConnectionCommandError({ target: options.daemonTarget, error });
  });

  try {
    const payload = await client.listProjects();
    const containers = client.getLastServerInfoMessage()?.features?.projectContainers
      ? (await client.listProjectContainers()).containers
      : [];
    return {
      type: "list",
      data: payload.projects.map((project) => toProjectRow(project, containers)),
      schema: projectSchema,
    };
  } finally {
    await client.close().catch(() => undefined);
  }
}
