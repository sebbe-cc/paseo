import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import {
  projectContainerNameKey,
  type ProjectContainer,
} from "@getpaseo/protocol/project-containers";
import type { CommandError, CommandOptions, OutputSchema } from "../../../output/index.js";
import { buildDaemonConnectionCommandError, connectToDaemon } from "../../../utils/client.js";

export interface ContainerRow {
  containerId: string;
  name: string;
  repositories: string[];
}

export const containerSchema: OutputSchema<ContainerRow> = {
  idField: "containerId",
  columns: [
    { header: "ID", field: "containerId", width: 22 },
    { header: "NAME", field: "name", width: 24 },
    { header: "REPOSITORIES", field: (row) => row.repositories.join(", "), width: 60 },
  ],
};

interface Catalog {
  containers: ProjectContainer[];
  repositories: { projectId: string; projectDisplayName: string }[];
}

/** Opens a client on a host that supports projects, runs `operation`, and always closes it. */
export async function withContainerClient<T>(
  options: CommandOptions,
  operation: (client: DaemonClient) => Promise<T>,
): Promise<T> {
  const client = await connectToDaemon({ target: options.daemonTarget }).catch((error: unknown) => {
    throw buildDaemonConnectionCommandError({ target: options.daemonTarget, error });
  });
  try {
    if (!client.getLastServerInfoMessage()?.features?.projectContainers) {
      throw {
        code: "PROJECTS_UNSUPPORTED",
        message: "This host does not support projects; update it to the fork build",
      } satisfies CommandError;
    }
    return await operation(client);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && !(error instanceof Error))
      throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw { code: "PROJECT_CONTAINER_FAILED", message } satisfies CommandError;
  } finally {
    await client.close().catch(() => undefined);
  }
}

export async function loadCatalog(client: DaemonClient): Promise<Catalog> {
  const [{ containers }, { projects }] = await Promise.all([
    client.listProjectContainers(),
    client.listProjects(),
  ]);
  return { containers, repositories: projects };
}

/** Accepts a `pcnt_` id or a case-insensitive name. */
export function resolveContainer(catalog: Catalog, ref: string): ProjectContainer {
  const key = projectContainerNameKey(ref);
  const match =
    catalog.containers.find((container) => container.id === ref) ??
    catalog.containers.find((container) => projectContainerNameKey(container.name) === key);
  if (!match) {
    throw {
      code: "PROJECT_NOT_FOUND",
      message: `No project matches "${ref}"`,
    } satisfies CommandError;
  }
  return match;
}

/** Accepts a `prj_` id or an exact repository display name; names must be unambiguous. */
export function resolveRepository(catalog: Catalog, ref: string): string {
  if (catalog.repositories.some((repository) => repository.projectId === ref)) return ref;
  const named = catalog.repositories.filter((repository) => repository.projectDisplayName === ref);
  if (named.length === 1) return named[0]!.projectId;
  throw {
    code: named.length === 0 ? "REPOSITORY_NOT_FOUND" : "REPOSITORY_AMBIGUOUS",
    message:
      named.length === 0
        ? `No repository matches "${ref}"`
        : `"${ref}" matches ${named.length} repositories; use the repository id`,
  } satisfies CommandError;
}

export function toContainerRow(catalog: Catalog, container: ProjectContainer): ContainerRow {
  const names = new Map(
    catalog.repositories.map((repository) => [repository.projectId, repository.projectDisplayName]),
  );
  return {
    containerId: container.id,
    name: container.name,
    repositories: container.projectIds.map((id) => names.get(id) ?? id),
  };
}
