import {
  projectContainerNameKey,
  type ProjectContainer,
} from "@getpaseo/protocol/project-containers";

export interface HostProjectContainerCatalog {
  serverId: string;
  containers: readonly ProjectContainer[];
}

/** One host's copy of a merged project; mutations are routed to `serverId` with `containerId`. */
export interface ProjectContainerPlacement {
  serverId: string;
  containerId: string;
  projectIds: readonly string[];
}

/** Same-name projects on several hosts render as one header keyed by the normalized name. */
export interface MergedProjectContainer {
  key: string;
  name: string;
  placements: ProjectContainerPlacement[];
}

/** Target host first, then by serverId: the first host with a name decides its spelling and slot. */
export function mergeProjectContainerCatalogs(input: {
  catalogs: readonly HostProjectContainerCatalog[];
  targetServerId?: string;
}): MergedProjectContainer[] {
  const ordered = [...input.catalogs].sort((left, right) => {
    if (left.serverId === input.targetServerId) return -1;
    if (right.serverId === input.targetServerId) return 1;
    return left.serverId.localeCompare(right.serverId);
  });
  const merged = new Map<string, MergedProjectContainer>();
  for (const catalog of ordered) {
    for (const container of catalog.containers) {
      const key = projectContainerNameKey(container.name);
      const placement = {
        serverId: catalog.serverId,
        containerId: container.id,
        projectIds: container.projectIds,
      };
      const existing = merged.get(key);
      if (existing) existing.placements.push(placement);
      else merged.set(key, { key, name: container.name, placements: [placement] });
    }
  }
  return [...merged.values()];
}

export function placementForHost(
  container: MergedProjectContainer,
  serverId: string,
): ProjectContainerPlacement | null {
  return container.placements.find((placement) => placement.serverId === serverId) ?? null;
}
