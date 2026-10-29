import { describe, expect, it } from "vitest";
import { buildProjectContainerContributions } from "./command-center";
import { mergeProjectContainerCatalogs } from "./internal/merge";

const now = "2026-09-25T00:00:00.000Z";
const containers = mergeProjectContainerCatalogs({
  catalogs: [
    {
      serverId: "host-a",
      containers: [
        { id: "pcnt_1", name: "Heads", projectIds: [], createdAt: now, updatedAt: now },
        { id: "pcnt_2", name: "Tails", projectIds: [], createdAt: now, updatedAt: now },
      ],
    },
  ],
});

describe("project container command center contributions", () => {
  it("offers one toggle per project that collapses it by key", () => {
    const toggled: string[] = [];
    const contributions = buildProjectContainerContributions({
      containers,
      labels: { section: "Actions", toggle: (name) => `Toggle project: ${name}` },
      toggle: (key) => toggled.push(key),
    });

    expect(
      contributions.map((c) => c.presentation.kind === "action" && c.presentation.title),
    ).toEqual(["Toggle project: Heads", "Toggle project: Tails"]);
    void contributions[1]!.run();
    expect(toggled).toEqual(["tails"]);
  });
});
