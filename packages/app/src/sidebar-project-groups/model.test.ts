import { describe, expect, it } from "vitest";
import type { InstalledPlugin } from "@/plugins/types";
import { resolveSidebarProjectGroups, sidebarProjectGroupKey } from "./model";

function installed(
  pluginId: string,
  serverId: string,
  groups: { id: string; name: string; projectIds: string[]; order: number }[] | null,
  onManage?: () => void,
): InstalledPlugin {
  return {
    id: pluginId,
    cleanup: () => undefined,
    serverId,
    clientBundle: serverId,
    lifetime: new AbortController(),
    locale: "en",
    i18n: {} as InstalledPlugin["i18n"],
    queryClient: {} as InstalledPlugin["queryClient"],
    paseo: {} as InstalledPlugin["paseo"],
    invoke: async () => undefined,
    sidebarProjectGroups: groups
      ? {
          groups: groups.map((group) => ({ ...group, projectIds: [...group.projectIds] })),
          ...(onManage ? { onManage } : {}),
        }
      : null,
    surfaces: [],
    settingsScreens: [],
    sidebarItems: { header: [], footer: [] },
    legacySidebarItems: [],
    filePanels: [],
    workspacePanels: [],
    commandCenterItems: [],
    clientSlashCommands: [],
    attachmentSources: [],
    themes: [],
    timelineTransformers: [],
    timelineRenderers: [],
    timelineSelectionActions: [],
    inlineDecorators: [],
    workspaceLabelPresenters: [],
  };
}

describe("resolveSidebarProjectGroups", () => {
  it("returns no groups when no plugin contributes", () => {
    expect(resolveSidebarProjectGroups([installed("a", "host-a", null)])).toEqual([]);
  });

  it("sorts a plugin's groups by order, then name", () => {
    const plugins = [
      installed("groups", "host-a", [
        { id: "b", name: "Beta", projectIds: [], order: 1 },
        { id: "a", name: "Alpha", projectIds: [], order: 1 },
        { id: "first", name: "First", projectIds: [], order: 0 },
      ]),
    ];
    expect(resolveSidebarProjectGroups(plugins).map((group) => group.id)).toEqual([
      "first",
      "a",
      "b",
    ]);
  });

  it("keys collapse state by plugin and group id", () => {
    const [resolved] = resolveSidebarProjectGroups([
      installed("groups", "host-a", [{ id: "heads", name: "Heads", projectIds: [], order: 0 }]),
    ]);
    expect(resolved?.key).toBe("sidebar-project-group:groups:heads");
    expect(resolved?.key).toBe(sidebarProjectGroupKey("groups", "heads"));
  });

  it("resolves a group id once across the plugin's hosts", () => {
    const plugins = [
      installed("groups", "host-a", [{ id: "heads", name: "Heads", projectIds: ["p1"], order: 0 }]),
      installed("groups", "host-b", [{ id: "heads", name: "Heads", projectIds: ["p2"], order: 0 }]),
    ];
    const resolved = resolveSidebarProjectGroups(plugins);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.serverId).toBe("host-a");
  });

  it("keeps different plugins' same-named groups apart", () => {
    const plugins = [
      installed("one", "host-a", [{ id: "heads", name: "Heads", projectIds: [], order: 0 }]),
      installed("two", "host-a", [{ id: "heads", name: "Heads", projectIds: [], order: 0 }]),
    ];
    expect(resolveSidebarProjectGroups(plugins).map((group) => group.key)).toEqual([
      "sidebar-project-group:one:heads",
      "sidebar-project-group:two:heads",
    ]);
  });

  it("carries the manage callback", () => {
    const onManage = () => undefined;
    const [resolved] = resolveSidebarProjectGroups([
      installed(
        "groups",
        "host-a",
        [{ id: "heads", name: "Heads", projectIds: [], order: 0 }],
        onManage,
      ),
    ]);
    expect(resolved?.onManage).toBe(onManage);
  });
});
