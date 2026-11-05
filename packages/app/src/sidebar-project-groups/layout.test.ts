import { describe, expect, it } from "vitest";
import {
  buildSidebarProjectListItems,
  findSidebarProjectGroup,
  orderSidebarProjectsByGroups,
  resolveSidebarProjectDrop,
  sidebarProjectGroupRowKey,
  type GroupableSidebarProject,
  type SidebarProjectListItem,
} from "./layout";
import type { ResolvedSidebarProjectGroup } from "./model";

function repo(viewKey: string, serverId = "host-a"): GroupableSidebarProject {
  return { viewKey, hosts: [{ serverId, projectId: `p-${viewKey}` }] };
}

function group(
  id: string,
  name: string,
  members: string[],
  order = 0,
): ResolvedSidebarProjectGroup {
  return {
    pluginId: "groups",
    serverId: "host-a",
    id,
    key: `sidebar-project-group:groups:${id}`,
    name,
    projectIds: members.map((m) => `p-${m}`),
    order,
  };
}

const projects = ["a", "b", "c", "d"].map((key) => repo(key));
const groups = [
  group("heads", "Heads", ["b", "d"], 0),
  group("empty", "Empty", [], 1),
  group("fleet", "Fleet", ["a"], 2),
];

function keys(items: readonly SidebarProjectListItem<GroupableSidebarProject>[]): string[] {
  return items.map((item) => item.key);
}

function build(collapsed: string[] = [], filterActive = false) {
  return buildSidebarProjectListItems({
    projects,
    groups,
    collapsedGroupKeys: new Set(collapsed),
    filterActive,
  });
}

function move<T>(items: readonly T[], from: number, to: number): T[] {
  const next = [...items];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item!);
  return next;
}

describe("findSidebarProjectGroup", () => {
  it("matches a project by any host placement project id", () => {
    const multi = {
      viewKey: "x",
      hosts: [
        { serverId: "host-a", projectId: "p-nope" },
        { serverId: "host-b", projectId: "p-d" },
      ],
    };
    expect(findSidebarProjectGroup(multi, groups)?.id).toBe("heads");
  });

  it("returns the first group in display order", () => {
    const both = group("both", "Both", ["b"], -1);
    expect(findSidebarProjectGroup(repo("b"), [both, ...groups])?.id).toBe("both");
  });

  it("returns null when no group lists the project", () => {
    expect(findSidebarProjectGroup(repo("c"), groups)).toBeNull();
  });
});

describe("buildSidebarProjectListItems", () => {
  it("keeps today's flat list when there are no groups", () => {
    const items = buildSidebarProjectListItems({
      projects,
      groups: [],
      collapsedGroupKeys: new Set(),
      filterActive: false,
    });
    expect(keys(items)).toEqual(["a", "b", "c", "d"]);
  });

  it("renders headers in group order, members in project order, ungrouped last", () => {
    expect(keys(build())).toEqual([
      sidebarProjectGroupRowKey(groups[0]!.key),
      "b",
      "d",
      sidebarProjectGroupRowKey(groups[1]!.key),
      sidebarProjectGroupRowKey(groups[2]!.key),
      "a",
      "c",
    ]);
  });

  it("hides members of collapsed groups but keeps their header", () => {
    const items = build([groups[0]!.key]);
    expect(keys(items)).toEqual([
      sidebarProjectGroupRowKey(groups[0]!.key),
      sidebarProjectGroupRowKey(groups[1]!.key),
      sidebarProjectGroupRowKey(groups[2]!.key),
      "a",
      "c",
    ]);
    const header = items[0]!;
    expect(header.kind).toBe("group");
    if (header.kind === "group") {
      expect(header.collapsed).toBe(true);
      expect(header.members.map((member) => member.viewKey)).toEqual(["b", "d"]);
    }
  });

  it("hides memberless groups while a filter is active", () => {
    expect(keys(build([], true)).filter((key) => key.includes("empty"))).toEqual([]);
  });

  it("marks member rows with their group key", () => {
    for (const item of build()) {
      if (item.kind === "project" && ["b", "d"].includes(item.key)) {
        expect(item.groupKey).toBe(groups[0]!.key);
      }
      if (item.kind === "project" && item.key === "c") {
        expect(item.groupKey).toBeNull();
      }
    }
  });
});

describe("resolveSidebarProjectDrop", () => {
  it("reads the flat project order after a member move", () => {
    const previous = build();
    const movedB = previous.findIndex((item) => item.key === "b");
    const next = move(
      previous,
      movedB,
      previous.findIndex((item) => item.key === "c"),
    );
    const drop = resolveSidebarProjectDrop({ previous, next });
    expect(drop?.project.viewKey).toBe("b");
    expect(drop?.order).toEqual(["d", "a", "c", "b"]);
  });

  it("keeps collapsed members in the flat order", () => {
    const previous = build([groups[0]!.key]);
    const next = move(
      previous,
      previous.findIndex((item) => item.key === "a"),
      previous.findIndex((item) => item.key === "c"),
    );
    expect(resolveSidebarProjectDrop({ previous, next })?.order).toEqual(["b", "d", "c", "a"]);
  });

  it("ignores a moved header", () => {
    const previous = build();
    const next = move(previous, 0, 2);
    expect(resolveSidebarProjectDrop({ previous, next })).toBeNull();
  });

  it("returns null when nothing moved", () => {
    const previous = build();
    expect(resolveSidebarProjectDrop({ previous, next: [...previous] })).toBeNull();
  });
});

describe("orderSidebarProjectsByGroups", () => {
  it("returns the grouped display order and hides collapsed members from shortcuts", () => {
    const { projects: ordered, hiddenKeys } = orderSidebarProjectsByGroups({
      projects: [...projects],
      groups,
      collapsedGroupKeys: new Set([groups[0]!.key]),
    });
    expect(ordered.map((project) => project.viewKey)).toEqual(["b", "d", "a", "c"]);
    expect([...hiddenKeys]).toEqual(["b", "d"]);
  });

  it("passes projects through when there are no groups", () => {
    const { projects: ordered, hiddenKeys } = orderSidebarProjectsByGroups({
      projects: [...projects],
      groups: [],
      collapsedGroupKeys: new Set(),
    });
    expect(ordered.map((project) => project.viewKey)).toEqual(["a", "b", "c", "d"]);
    expect(hiddenKeys.size).toBe(0);
  });
});
