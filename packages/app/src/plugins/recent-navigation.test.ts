import { expect, test } from "vitest";

// The layout store reaches this module through plugins/registry; loading the store
// first must not touch its exports before they are initialized (pa-gktp5).
test("loads when the workspace layout store is imported first", async () => {
  const store = await import("@/stores/workspace-layout-store");
  const { pluginRecentNavigation } = await import("./recent-navigation");
  expect(store.useWorkspaceLayoutStore.getState()).toBeDefined();
  expect(pluginRecentNavigation.getActive()).toBeNull();
}, 60_000);
