import { describe, expect, it } from "vitest";
import { mergeProjectContainerCatalogs } from "./internal/merge";
import {
  buildProjectListItems,
  containerItemKey,
  orderByProjectContainers,
  resolveProjectListDrop,
  type LayoutRepository,
  type ProjectListItem,
} from "./layout";

function repo(viewKey: string, serverId = "host-a"): LayoutRepository {
  return { viewKey, hosts: [{ serverId, projectId: `p-${viewKey}` }] };
}

function container(id: string, name: string, members: string[]) {
  const now = "2026-09-25T00:00:00.000Z";
  return { id, name, projectIds: members.map((m) => `p-${m}`), createdAt: now, updatedAt: now };
}

const repositories = ["a", "b", "c", "d"].map((key) => repo(key));
const containers = mergeProjectContainerCatalogs({
  catalogs: [
    {
      serverId: "host-a",
      containers: [container("pcnt_1", "Heads", ["b", "d"]), container("pcnt_2", "Empty", [])],
    },
  ],
});

function keys(items: readonly ProjectListItem<LayoutRepository>[]): string[] {
  return items.map((item) => item.key);
}

function build(collapsed: string[] = [], filterActive = false) {
  return buildProjectListItems({
    repositories,
    containers,
    collapsedContainerKeys: new Set(collapsed),
    filterActive,
  });
}

function move<T>(items: readonly T[], from: number, to: number): T[] {
  const next = [...items];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item!);
  return next;
}

describe("buildProjectListItems", () => {
  it("keeps today's flat list when there are no containers", () => {
    const items = buildProjectListItems({
      repositories,
      containers: [],
      collapsedContainerKeys: new Set(),
      filterActive: false,
    });
    expect(keys(items)).toEqual(["a", "b", "c", "d"]);
  });

  it("places members under their container and the rest below", () => {
    expect(keys(build())).toEqual([
      containerItemKey("heads"),
      "b",
      "d",
      containerItemKey("empty"),
      "a",
      "c",
    ]);
  });

  it("hides the members of a collapsed container but keeps them on the header", () => {
    const items = build(["heads"]);
    expect(keys(items)).toEqual([containerItemKey("heads"), containerItemKey("empty"), "a", "c"]);
    const header = items[0]!;
    expect(header.kind === "container" && header.members.map((m) => m.viewKey)).toEqual(["b", "d"]);
  });

  it("hides empty containers only while a filter is active", () => {
    expect(keys(build([], true))).not.toContain(containerItemKey("empty"));
  });

  it("groups a repository whose placement lives on another host", () => {
    const merged = mergeProjectContainerCatalogs({
      targetServerId: "host-a",
      catalogs: [
        { serverId: "host-b", containers: [container("pcnt_9", "heads", ["x"])] },
        { serverId: "host-a", containers: [container("pcnt_1", "Heads", ["b"])] },
      ],
    });
    expect(merged).toHaveLength(1);
    expect(merged[0]!.name).toBe("Heads");
    const items = buildProjectListItems({
      repositories: [repo("b"), repo("x", "host-b"), repo("y", "host-b")],
      containers: merged,
      collapsedContainerKeys: new Set(),
      filterActive: false,
    });
    expect(keys(items)).toEqual([containerItemKey("heads"), "b", "x", "y"]);
  });
});

describe("resolveProjectListDrop", () => {
  it("moves an ungrouped row into the container above it", () => {
    const previous = build();
    const next = move(previous, 4, 1);
    const drop = resolveProjectListDrop({ previous, next });
    expect(drop?.repository.viewKey).toBe("a");
    expect(drop?.fromContainerKey).toBeNull();
    expect(drop?.toContainerKey).toBe("heads");
    expect(drop?.order).toEqual(["a", "b", "d", "c"]);
  });

  it("ungroups a member dropped among the ungrouped rows", () => {
    const previous = build();
    const next = move(previous, 1, 5);
    const drop = resolveProjectListDrop({ previous, next });
    expect(drop?.repository.viewKey).toBe("b");
    expect(drop?.toContainerKey).toBeNull();
  });

  it("keeps a member at the bottom edge of its container grouped", () => {
    const previous = build();
    const next = move(previous, 1, 2);
    const drop = resolveProjectListDrop({ previous, next, movedKey: "b" });
    expect(drop?.toContainerKey).toBe("heads");
    expect(drop?.order).toEqual(["d", "b", "a", "c"]);
  });

  it("lets an ungrouped row stay put under a collapsed header", () => {
    const previous = build(["heads", "empty"]);
    const next = move(previous, 3, 2);
    const drop = resolveProjectListDrop({ previous, next, movedKey: "c" });
    expect(drop?.toContainerKey).toBeNull();
    expect(drop?.order).toEqual(["b", "d", "c", "a"]);
  });

  it("drops into an expanded empty container", () => {
    const previous = build();
    const next = move(previous, 5, 4);
    const drop = resolveProjectListDrop({ previous, next, movedKey: "c" });
    expect(drop?.toContainerKey).toBe("empty");
  });

  it("ignores a dragged header", () => {
    const previous = build();
    const next = move(previous, 3, 0);
    expect(resolveProjectListDrop({ previous, next, movedKey: containerItemKey("empty") })).toBe(
      null,
    );
  });
});

describe("orderByProjectContainers", () => {
  it("orders repositories as the grouped list shows them", () => {
    const ordered = orderByProjectContainers({
      repositories: [...repositories],
      containers,
      collapsedContainerKeys: new Set(["heads"]),
    });
    expect(ordered.repositories.map((r) => r.viewKey)).toEqual(["b", "d", "a", "c"]);
    expect([...ordered.hiddenKeys]).toEqual(["b", "d"]);
  });

  it("returns the input untouched without containers", () => {
    const input = [...repositories];
    const ordered = orderByProjectContainers({
      repositories: input,
      containers: [],
      collapsedContainerKeys: new Set(),
    });
    expect(ordered.repositories).toBe(input);
  });
});
