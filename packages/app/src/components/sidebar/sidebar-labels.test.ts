import { describe, expect, test } from "vitest";
import type { SidebarWorkspaceEntry } from "@/hooks/use-sidebar-workspaces-list";
import { SIDEBAR_UNLABELLED_LABEL_KEY } from "@/stores/sidebar-view-store";
import {
  filterWorkspacesByLabels,
  labelWorkspaceGroupKey,
  labelWorkspaceGroups,
} from "./sidebar-labels";

function workspace(
  workspaceId: string,
  labels: string[],
  pinnedAt: string | null = null,
): SidebarWorkspaceEntry {
  return {
    workspaceKey: `host:${workspaceId}`,
    serverId: "host",
    workspaceId,
    projectViewKey: "project",
    projectName: "Project",
    projectRootPath: "/repo",
    workspaceDirectory: `/repo/${workspaceId}`,
    workspaceDirectoryLabel: workspaceId,
    projectKind: "git",
    workspaceKind: "worktree",
    name: workspaceId,
    title: null,
    pinnedAt,
    labels,
    currentBranch: "main",
    statusBucket: "done",
    statusEnteredAt: null,
    archivingAt: null,
    diffStat: null,
    prHint: null,
    archiveHasUncommittedChanges: null,
    archiveUnpushedCommitCount: null,
    scripts: [],
    hasRunningScripts: false,
  };
}

describe("sidebar label filtering", () => {
  const workspaces = [
    workspace("one", ["Backend", "Urgent"], "2026-01-01"),
    workspace("two", ["Backend"]),
    workspace("three", []),
  ];

  function filtered(labels: string[]) {
    return filterWorkspacesByLabels({ workspaces, labels }).map((entry) => entry.workspaceId);
  }

  test("includes a workspace carrying any selected label", () => {
    expect(filtered([])).toEqual(["one", "two", "three"]);
    expect(filtered(["backend"])).toEqual(["one", "two"]);
    expect(filtered(["backend", "urgent"])).toEqual(["one", "two"]);
  });

  test("models Unlabelled as a row in the same list", () => {
    expect(filtered([SIDEBAR_UNLABELLED_LABEL_KEY])).toEqual(["three"]);
    expect(filtered(["backend", SIDEBAR_UNLABELLED_LABEL_KEY])).toEqual(["one", "two", "three"]);
  });

  test("reads whitespace-only label names as no label rather than as the Unlabelled key", () => {
    expect(
      filterWorkspacesByLabels({
        workspaces: [workspace("blank", ["   "])],
        labels: [SIDEBAR_UNLABELLED_LABEL_KEY],
      }).map((entry) => entry.workspaceId),
    ).toEqual(["blank"]);
  });
});

describe("sidebar label grouping", () => {
  const catalog = [
    { name: "Urgent", color: "red" as const },
    { name: "Backend", color: "sky" as const },
  ];

  function grouped(workspaces: SidebarWorkspaceEntry[]) {
    return labelWorkspaceGroups({ workspaces, catalog, unlabelledTitle: "Unlabelled" }).map(
      (group) => ({
        key: group.key,
        label: group.label,
        leading: group.leading,
        rows: group.rows.map((entry) => entry.workspaceId),
      }),
    );
  }

  test("lists a workspace under each of its labels, in catalog order, then Unlabelled", () => {
    expect(
      grouped([
        workspace("one", ["Backend", "Urgent"]),
        workspace("two", ["backend"]),
        workspace("three", []),
      ]),
    ).toEqual([
      {
        key: "label:urgent",
        label: "Urgent",
        leading: { kind: "label", name: "Urgent", color: "red" },
        rows: ["one"],
      },
      {
        key: "label:backend",
        label: "Backend",
        leading: { kind: "label", name: "Backend", color: "sky" },
        rows: ["one", "two"],
      },
      {
        key: labelWorkspaceGroupKey(SIDEBAR_UNLABELLED_LABEL_KEY),
        label: "Unlabelled",
        leading: { kind: "label", name: null, color: null },
        rows: ["three"],
      },
    ]);
  });

  test("groups a name the catalog has not loaded yet, without a color, after catalog labels", () => {
    expect(grouped([workspace("one", ["Later"]), workspace("two", ["Backend"])])).toEqual([
      {
        key: "label:backend",
        label: "Backend",
        leading: { kind: "label", name: "Backend", color: "sky" },
        rows: ["two"],
      },
      {
        key: "label:later",
        label: "Later",
        leading: { kind: "label", name: "Later", color: null },
        rows: ["one"],
      },
    ]);
  });

  test("gives empty labels and an empty Unlabelled no section", () => {
    expect(
      grouped([workspace("one", ["Urgent", "  ", "urgent"])]).map((group) => group.key),
    ).toEqual(["label:urgent"]);
  });
});

describe("sidebar label group ordering", () => {
  const catalog = [
    { name: "Urgent", color: "red" as const },
    { name: "Backend", color: "sky" as const },
  ];

  function orderedKeys(labelGroupOrder?: readonly string[]) {
    return labelWorkspaceGroups({
      workspaces: [
        workspace("one", ["Backend"]),
        workspace("two", ["Urgent"]),
        workspace("three", ["Later"]),
        workspace("four", []),
      ],
      catalog,
      unlabelledTitle: "Unlabelled",
      labelGroupOrder,
    }).map((group) => group.key);
  }

  test("defaults to catalog order, then names, then Unlabelled", () => {
    expect(orderedKeys()).toEqual([
      "label:urgent",
      "label:backend",
      "label:later",
      labelWorkspaceGroupKey(SIDEBAR_UNLABELLED_LABEL_KEY),
    ]);
  });

  test("a stored order wins over the catalog", () => {
    expect(orderedKeys(["label:backend", "label:urgent", "label:later"])).toEqual([
      "label:backend",
      "label:urgent",
      "label:later",
      labelWorkspaceGroupKey(SIDEBAR_UNLABELLED_LABEL_KEY),
    ]);
  });

  test("labels missing from the stored order land last, before Unlabelled", () => {
    expect(orderedKeys(["label:later", "label:backend"])).toEqual([
      "label:later",
      "label:backend",
      "label:urgent",
      labelWorkspaceGroupKey(SIDEBAR_UNLABELLED_LABEL_KEY),
    ]);
  });

  test("ignores stored keys with no visible section", () => {
    expect(orderedKeys(["label:gone", "label:urgent"])).toEqual([
      "label:urgent",
      "label:backend",
      "label:later",
      labelWorkspaceGroupKey(SIDEBAR_UNLABELLED_LABEL_KEY),
    ]);
  });
});
