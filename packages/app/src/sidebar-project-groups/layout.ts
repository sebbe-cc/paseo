import type { ResolvedSidebarProjectGroup } from "./model";

/** The slice of a sidebar project entry the grouping needs. */
export interface GroupableSidebarProject {
  viewKey: string;
  hosts: readonly { serverId: string; projectId: string }[];
}

export interface SidebarProjectGroupItem<R extends GroupableSidebarProject> {
  kind: "group";
  key: string;
  group: ResolvedSidebarProjectGroup;
  /** Visible members in sidebar order, including those hidden while collapsed. */
  members: R[];
  collapsed: boolean;
}

export interface SidebarProjectItem<R extends GroupableSidebarProject> {
  kind: "project";
  key: string;
  project: R;
  /** Key of the group this row sits under, or null when ungrouped. */
  groupKey: string | null;
}

export type SidebarProjectListItem<R extends GroupableSidebarProject> =
  | SidebarProjectGroupItem<R>
  | SidebarProjectItem<R>;

export function sidebarProjectGroupRowKey(groupKey: string): string {
  return `sidebar-project-group-row:${groupKey}`;
}

/** First group in display order that lists any of the project's host project ids. */
export function findSidebarProjectGroup(
  project: GroupableSidebarProject,
  groups: readonly ResolvedSidebarProjectGroup[],
): ResolvedSidebarProjectGroup | null {
  for (const group of groups) {
    if (group.projectIds.length === 0) continue;
    const member = project.hosts.some((host) => group.projectIds.includes(host.projectId));
    if (member) return group;
  }
  return null;
}

// Groups in display order, each followed by its members in `projects` order,
// then the ungrouped rows. With a filter active, a group left with no visible
// members is hidden.
export function buildSidebarProjectListItems<R extends GroupableSidebarProject>(input: {
  projects: readonly R[];
  groups: readonly ResolvedSidebarProjectGroup[];
  collapsedGroupKeys: ReadonlySet<string>;
  filterActive: boolean;
}): SidebarProjectListItem<R>[] {
  const { projects, groups, collapsedGroupKeys, filterActive } = input;
  if (groups.length === 0) {
    return projects.map((project) => projectItem(project, null));
  }
  const membersByKey = new Map<string, R[]>(groups.map((group) => [group.key, []]));
  const ungrouped: R[] = [];
  for (const project of projects) {
    const group = findSidebarProjectGroup(project, groups);
    if (group) membersByKey.get(group.key)!.push(project);
    else ungrouped.push(project);
  }
  const items: SidebarProjectListItem<R>[] = [];
  for (const group of groups) {
    const members = membersByKey.get(group.key)!;
    if (filterActive && members.length === 0) continue;
    const collapsed = collapsedGroupKeys.has(group.key);
    items.push({
      kind: "group",
      key: sidebarProjectGroupRowKey(group.key),
      group,
      members,
      collapsed,
    });
    if (collapsed) continue;
    for (const member of members) items.push(projectItem(member, group.key));
  }
  for (const project of ungrouped) items.push(projectItem(project, null));
  return items;
}

function projectItem<R extends GroupableSidebarProject>(
  project: R,
  groupKey: string | null,
): SidebarProjectItem<R> {
  return { kind: "project", key: project.viewKey, project, groupKey };
}

export interface SidebarProjectDrop<R extends GroupableSidebarProject> {
  project: R;
  /** Flat project view keys top to bottom after the drop, for the client-side order store. */
  order: string[];
}

/**
 * Reads a single project move out of a reordered list. A moved header is not
 * a drop: group membership is owned by the plugin (its manager UI), so the
 * host only keeps the flat project order.
 */
export function resolveSidebarProjectDrop<R extends GroupableSidebarProject>(input: {
  previous: readonly SidebarProjectListItem<R>[];
  next: readonly SidebarProjectListItem<R>[];
  movedKey?: string | null;
}): SidebarProjectDrop<R> | null {
  const index = input.movedKey
    ? input.next.findIndex((item) => item.key === input.movedKey)
    : movedIndex(input.previous, input.next);
  if (index === null || index < 0) return null;
  const moved = input.next[index]!;
  if (moved.kind !== "project") return null;
  const order = input.next.flatMap((item) => {
    if (item.kind === "project") return [item.key];
    return item.collapsed ? item.members.map((member) => member.viewKey) : [];
  });
  return { project: moved.project, order };
}

// Without the dragged key, a two-row swap is ambiguous; prefer reading it as a project move.
function movedIndex<R extends GroupableSidebarProject>(
  previous: readonly SidebarProjectListItem<R>[],
  next: readonly SidebarProjectListItem<R>[],
): number | null {
  if (previous.length !== next.length) return null;
  let first = 0;
  while (first < next.length && previous[first]!.key === next[first]!.key) first += 1;
  if (first === next.length) return null;
  let last = next.length - 1;
  while (last > first && previous[last]!.key === next[last]!.key) last -= 1;
  const movedUp = next[first]!.key === previous[last]!.key;
  const movedDown = next[last]!.key === previous[first]!.key;
  if (movedUp && movedDown) return next[first]!.kind === "project" ? first : last;
  return movedUp ? first : last;
}

// Projects in the grouped display order, for keyboard shortcuts; members of
// collapsed groups are returned in `hiddenKeys` so their workspaces take no
// shortcut numbers.
export function orderSidebarProjectsByGroups<R extends GroupableSidebarProject>(input: {
  projects: R[];
  groups: readonly ResolvedSidebarProjectGroup[];
  collapsedGroupKeys: ReadonlySet<string>;
}): { projects: R[]; hiddenKeys: ReadonlySet<string> } {
  if (input.groups.length === 0) {
    return { projects: input.projects, hiddenKeys: NO_KEYS };
  }
  const projects: R[] = [];
  const hiddenKeys = new Set<string>();
  for (const item of buildSidebarProjectListItems({ ...input, filterActive: false })) {
    if (item.kind === "project") {
      projects.push(item.project);
    } else if (item.collapsed) {
      for (const member of item.members) {
        projects.push(member);
        hiddenKeys.add(member.viewKey);
      }
    }
  }
  return { projects, hiddenKeys };
}

const NO_KEYS: ReadonlySet<string> = new Set();
