import { projectContainerNameKey } from "@getpaseo/protocol/project-containers";
import { i18n } from "@/i18n/i18next";
import type { LayoutRepository } from "./layout";
import {
  placementForHost,
  projectContainers,
  useProjectContainers,
  type MergedProjectContainer,
} from "./index";

function onlineHost(serverId: string): boolean {
  return useProjectContainers.getState().hosts[serverId]?.status === "online";
}

/** Every online host the repository lives on; hosts without project support are left alone. */
function assignableHosts(repository: LayoutRepository) {
  return repository.hosts.filter((host) => onlineHost(host.serverId));
}

// Moves the repository on each of its hosts. A host that has no container by this name gets one,
// so a same-name project stays one header across hosts.
export async function assignRepository(input: {
  repository: LayoutRepository;
  container: MergedProjectContainer | null;
  index?: number;
}): Promise<void> {
  const { container } = input;
  await Promise.all(
    assignableHosts(input.repository).map(async (host) => {
      if (!container) {
        const grouped = useProjectContainers
          .getState()
          .hosts[host.serverId]?.containers.some((c) => c.projectIds.includes(host.projectId));
        if (!grouped) return;
        await projectContainers.assign({
          serverId: host.serverId,
          projectIds: [host.projectId],
          containerId: null,
        });
        return;
      }
      const placement = placementForHost(container, host.serverId);
      if (!placement) {
        await projectContainers.create({
          serverId: host.serverId,
          name: container.name,
          projectIds: [host.projectId],
        });
        return;
      }
      await projectContainers.assign({
        serverId: host.serverId,
        projectIds: [host.projectId],
        containerId: placement.containerId,
        index: input.index,
      });
    }),
  );
}

/** Creates the project on each online host the repository lives on, with the repository in it. */
export async function createForRepository(input: {
  repository: LayoutRepository;
  name: string;
}): Promise<void> {
  const hosts = assignableHosts(input.repository);
  if (hosts.length === 0) throw new Error(i18n.t("projectContainers.offline"));
  await Promise.all(
    hosts.map((host) =>
      projectContainers.create({
        serverId: host.serverId,
        name: input.name,
        projectIds: [host.projectId],
      }),
    ),
  );
}

export async function renameContainer(
  container: MergedProjectContainer,
  name: string,
): Promise<void> {
  await Promise.all(
    container.placements.map((placement) =>
      projectContainers.rename({
        serverId: placement.serverId,
        containerId: placement.containerId,
        name,
      }),
    ),
  );
}

export async function deleteContainer(container: MergedProjectContainer): Promise<void> {
  await Promise.all(
    container.placements.map((placement) =>
      projectContainers.delete({
        serverId: placement.serverId,
        containerId: placement.containerId,
      }),
    ),
  );
}

// Swaps the container with its merged neighbour, then asks each host to match the merged order
// for the containers it holds. Hosts whose order already matches are not written to.
export async function moveContainer(input: {
  containers: readonly MergedProjectContainer[];
  key: string;
  direction: -1 | 1;
}): Promise<void> {
  const order = input.containers.map((container) => container.key);
  const from = order.indexOf(input.key);
  const to = from + input.direction;
  if (from < 0 || to < 0 || to >= order.length) return;
  [order[from], order[to]] = [order[to]!, order[from]!];
  const rank = new Map(order.map((key, index) => [key, index]));
  const hosts = Object.values(useProjectContainers.getState().hosts);
  await Promise.all(
    hosts
      .filter((host) => host.status === "online")
      .map(async (host) => {
        const current = host.containers.map((container) => container.id);
        const next = [...host.containers]
          .sort(
            (left, right) =>
              (rank.get(projectContainerNameKey(left.name)) ?? 0) -
              (rank.get(projectContainerNameKey(right.name)) ?? 0),
          )
          .map((container) => container.id);
        if (next.every((id, index) => id === current[index])) return;
        await projectContainers.reorder({ serverId: host.serverId, containerIds: next });
      }),
  );
}
