import type { MergedProjectContainer } from "./internal/merge";

/** The slice of a sidebar repository entry the layout needs; `hosts` maps it to daemon ids. */
export interface LayoutRepository {
  viewKey: string;
  hosts: readonly { serverId: string; projectId: string }[];
}

export interface ContainerListItem<R extends LayoutRepository> {
  kind: "container";
  key: string;
  container: MergedProjectContainer;
  /** Visible members in sidebar order, including those hidden by a collapsed header. */
  members: R[];
  collapsed: boolean;
}

export interface RepositoryListItem<R extends LayoutRepository> {
  kind: "repository";
  key: string;
  repository: R;
  /** Name key of the container this row sits under, or null when ungrouped. */
  containerKey: string | null;
}

export type ProjectListItem<R extends LayoutRepository> =
  | ContainerListItem<R>
  | RepositoryListItem<R>;

export function containerItemKey(containerKey: string): string {
  return `project-container:${containerKey}`;
}

/** First container in display order that lists any of the repository's host placements. */
export function findRepositoryContainer(
  repository: LayoutRepository,
  containers: readonly MergedProjectContainer[],
): MergedProjectContainer | null {
  for (const container of containers) {
    for (const placement of container.placements) {
      const member = repository.hosts.some(
        (host) =>
          host.serverId === placement.serverId && placement.projectIds.includes(host.projectId),
      );
      if (member) return container;
    }
  }
  return null;
}

// Containers in daemon order, each followed by its members in `repositories` order, then the
// ungrouped rows. With a filter active, a container left with no visible members is hidden.
export function buildProjectListItems<R extends LayoutRepository>(input: {
  repositories: readonly R[];
  containers: readonly MergedProjectContainer[];
  collapsedContainerKeys: ReadonlySet<string>;
  filterActive: boolean;
}): ProjectListItem<R>[] {
  const { repositories, containers, collapsedContainerKeys, filterActive } = input;
  if (containers.length === 0) {
    return repositories.map((repository) => repositoryItem(repository, null));
  }
  const membersByKey = new Map<string, R[]>(containers.map((container) => [container.key, []]));
  const ungrouped: R[] = [];
  for (const repository of repositories) {
    const container = findRepositoryContainer(repository, containers);
    if (container) membersByKey.get(container.key)!.push(repository);
    else ungrouped.push(repository);
  }
  const items: ProjectListItem<R>[] = [];
  for (const container of containers) {
    const members = membersByKey.get(container.key)!;
    if (filterActive && members.length === 0) continue;
    const collapsed = collapsedContainerKeys.has(container.key);
    const key = containerItemKey(container.key);
    items.push({ kind: "container", key, container, members, collapsed });
    if (collapsed) continue;
    for (const member of members) items.push(repositoryItem(member, container.key));
  }
  for (const repository of ungrouped) items.push(repositoryItem(repository, null));
  return items;
}

function repositoryItem<R extends LayoutRepository>(
  repository: R,
  containerKey: string | null,
): RepositoryListItem<R> {
  return { kind: "repository", key: repository.viewKey, repository, containerKey };
}

export interface ProjectListDrop<R extends LayoutRepository> {
  repository: R;
  fromContainerKey: string | null;
  /** Null ungroups the repository. */
  toContainerKey: string | null;
  /** Repository view keys top to bottom after the drop, for the client-side order store. */
  order: string[];
}

/** Reads a single-row move out of a reordered list; a moved header is not a drop. */
export function resolveProjectListDrop<R extends LayoutRepository>(input: {
  previous: readonly ProjectListItem<R>[];
  next: readonly ProjectListItem<R>[];
  movedKey?: string | null;
}): ProjectListDrop<R> | null {
  const index = input.movedKey
    ? input.next.findIndex((item) => item.key === input.movedKey)
    : movedIndex(input.previous, input.next);
  if (index === null || index < 0) return null;
  const moved = input.next[index]!;
  if (moved.kind !== "repository") return null;
  const order = input.next.flatMap((item) => {
    if (item.kind === "repository") return [item.key];
    return item.collapsed ? item.members.map((member) => member.viewKey) : [];
  });
  return {
    repository: moved.repository,
    fromContainerKey: moved.containerKey,
    toContainerKey: targetContainerKey(input.next, index, moved.containerKey),
    order,
  };
}

// The header above a row claims it. Where the ungrouped rows begin, an ungrouped row stays
// ungrouped, except directly under an expanded header, whose slot is visibly its own.
function targetContainerKey<R extends LayoutRepository>(
  items: readonly ProjectListItem<R>[],
  index: number,
  current: string | null,
): string | null {
  const above = items[index - 1];
  if (!above) return null;
  const below = items[index + 1];
  const boundary = !below || (below.kind === "repository" && below.containerKey === null);
  const staysUngrouped = boundary && current === null;
  if (above.kind === "container") {
    return above.collapsed && staysUngrouped ? null : above.container.key;
  }
  if (above.containerKey === null || staysUngrouped) return null;
  return above.containerKey;
}

// Without the dragged key, a two-row swap is ambiguous; prefer reading it as a repository move.
function movedIndex<R extends LayoutRepository>(
  previous: readonly ProjectListItem<R>[],
  next: readonly ProjectListItem<R>[],
): number | null {
  if (previous.length !== next.length) return null;
  let first = 0;
  while (first < next.length && previous[first]!.key === next[first]!.key) first += 1;
  if (first === next.length) return null;
  let last = next.length - 1;
  while (last > first && previous[last]!.key === next[last]!.key) last -= 1;
  const movedUp = next[first]!.key === previous[last]!.key;
  const movedDown = next[last]!.key === previous[first]!.key;
  if (movedUp && movedDown) return next[first]!.kind === "repository" ? first : last;
  return movedUp ? first : last;
}

// Repositories in the grouped display order, for keyboard shortcuts; members of collapsed
// containers are returned in `hiddenKeys` so their workspaces take no shortcut numbers.
export function orderByProjectContainers<R extends LayoutRepository>(input: {
  repositories: R[];
  containers: readonly MergedProjectContainer[];
  collapsedContainerKeys: ReadonlySet<string>;
}): { repositories: R[]; hiddenKeys: ReadonlySet<string> } {
  if (input.containers.length === 0) {
    return { repositories: input.repositories, hiddenKeys: NO_KEYS };
  }
  const repositories: R[] = [];
  const hiddenKeys = new Set<string>();
  for (const item of buildProjectListItems({ ...input, filterActive: false })) {
    if (item.kind === "repository") {
      repositories.push(item.repository);
    } else if (item.collapsed) {
      for (const member of item.members) {
        repositories.push(member);
        hiddenKeys.add(member.viewKey);
      }
    }
  }
  return { repositories, hiddenKeys };
}

const NO_KEYS: ReadonlySet<string> = new Set();
