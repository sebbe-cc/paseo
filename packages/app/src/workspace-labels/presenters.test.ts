import { describe, expect, it, vi } from "vitest";
import type { WorkspaceLabelDefinition } from "@getpaseo/protocol/workspace-labels";
import type { InstalledPlugin } from "@/plugins/types";
import {
  resolveWorkspaceLabelPresentation,
  selectWorkspaceLabelRowDefinitions,
} from "./presenters";

function pluginWith(
  presenters: { id: string; present: (input: never) => unknown }[],
  id = "neutral-labels",
): InstalledPlugin {
  return { id, workspaceLabelPresenters: presenters } as unknown as InstalledPlugin;
}

const CATALOG: WorkspaceLabelDefinition[] = [
  { name: "sprint4", color: "blue" },
  { name: "inbox", color: "red" },
];

/** Neutral example: one long machine-written label becomes one short name. */
function queuePresenter() {
  return {
    id: "queue-shortener",
    present: ({ labels }: { labels: readonly string[] }) => {
      const raw = labels.find((name) => name.startsWith("queue="));
      if (!raw) return undefined;
      return { hide: [raw], add: [{ name: "inbox" }] };
    },
  };
}

describe("resolveWorkspaceLabelPresentation", () => {
  it("hides nothing and adds nothing without presenters", () => {
    const resolved = resolveWorkspaceLabelPresentation({
      plugins: [],
      serverId: "server",
      workspaceId: "workspace",
      labels: ["sprint4"],
    });
    expect([...resolved.hidden]).toEqual([]);
    expect(resolved.added).toEqual([]);
  });

  it("hides the raw label and adds the short display name", () => {
    const resolved = resolveWorkspaceLabelPresentation({
      plugins: [pluginWith([queuePresenter()])],
      serverId: "server",
      workspaceId: "workspace",
      labels: ["sprint4", "queue=triaged/inbox"],
    });
    expect([...resolved.hidden]).toEqual(["queue=triaged/inbox"]);
    expect(resolved.added).toEqual([{ name: "inbox" }]);
  });

  it("leaves labels alone when no presenter matches", () => {
    const resolved = resolveWorkspaceLabelPresentation({
      plugins: [pluginWith([queuePresenter()])],
      serverId: "server",
      workspaceId: "workspace",
      labels: ["sprint4"],
    });
    expect([...resolved.hidden]).toEqual([]);
    expect(resolved.added).toEqual([]);
  });

  it("skips a throwing presenter and keeps the others", () => {
    const failing = {
      id: "failing",
      present: () => {
        throw new Error("boom");
      },
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const resolved = resolveWorkspaceLabelPresentation({
        plugins: [pluginWith([failing]), pluginWith([queuePresenter()], "second")],
        serverId: "server",
        workspaceId: "workspace",
        labels: ["queue=triaged/inbox"],
      });
      expect([...resolved.hidden]).toEqual(["queue=triaged/inbox"]);
      expect(resolved.added).toEqual([{ name: "inbox" }]);
      expect(warn).toHaveBeenCalledOnce();
    } finally {
      warn.mockRestore();
    }
  });

  it("ignores misshapen results without dropping the row", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const resolved = resolveWorkspaceLabelPresentation({
        plugins: [
          pluginWith([
            {
              id: "misshapen",
              present: () => ({ hide: "not-a-list", add: [{ name: "" }, { name: "  " }] }),
            },
          ]),
        ],
        serverId: "server",
        workspaceId: "workspace",
        labels: ["sprint4"],
      });
      expect([...resolved.hidden]).toEqual([]);
      expect(resolved.added).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });

  it("never adds a name the row already shows", () => {
    const resolved = resolveWorkspaceLabelPresentation({
      plugins: [
        pluginWith([
          {
            id: "echo",
            present: () => ({ add: [{ name: "Sprint4" }, { name: "fresh" }] }),
          },
        ]),
      ],
      serverId: "server",
      workspaceId: "workspace",
      labels: ["sprint4"],
    });
    expect(resolved.added).toEqual([{ name: "fresh" }]);
  });

  it("caps runaway additions so one plugin cannot flood the line", () => {
    const resolved = resolveWorkspaceLabelPresentation({
      plugins: [
        pluginWith([
          {
            id: "flooder",
            present: () => ({
              add: Array.from({ length: 20 }, (_, index) => ({ name: `extra-${index}` })),
            }),
          },
        ]),
      ],
      serverId: "server",
      workspaceId: "workspace",
      labels: [],
    });
    expect(resolved.added).toHaveLength(8);
  });
});

describe("selectWorkspaceLabelRowDefinitions", () => {
  it("resolves raw labels through the host catalog", () => {
    expect(
      selectWorkspaceLabelRowDefinitions({
        catalog: CATALOG,
        names: ["sprint4"],
        hidden: new Set(),
        added: [],
      }),
    ).toEqual([{ name: "sprint4", color: "blue" }]);
  });

  it("drops hidden raws and leads with presenter names in fallback tints", () => {
    expect(
      selectWorkspaceLabelRowDefinitions({
        catalog: CATALOG,
        names: ["sprint4", "queue=triaged/inbox", "unknown-raw"],
        hidden: new Set(["queue=triaged/inbox"]),
        added: [{ name: "inbox" }, { name: "custom", color: "teal" }],
      }),
    ).toEqual([
      { name: "inbox", color: "red" },
      { name: "custom", color: "teal" },
      { name: "sprint4", color: "blue" },
    ]);
  });
});
