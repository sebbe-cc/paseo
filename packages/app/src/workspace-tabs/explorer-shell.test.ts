import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn(async () => null),
    setItem: vi.fn(async () => undefined),
    removeItem: vi.fn(async () => undefined),
  },
}));

import {
  collectAllTabs,
  createWorkspaceLayoutStore,
  DEFAULT_PANE_ID,
  findPaneById,
} from "@/stores/workspace-layout-store";
import { createExplorerShellStore, createExplorerShellSync } from "@/workspace-tabs/explorer-shell";
import type { WorkspaceTabTarget } from "@/workspace-tabs/model";

const A = "server-1:ws-a";
const B = "server-1:ws-b";
const EXPLORER = "explorer";
const PLUGIN_ONE = {
  kind: "plugin",
  pluginId: "p1",
  panelId: "one",
  context: "workspace",
} as const;
const PLUGIN_TWO = { ...PLUGIN_ONE, pluginId: "p2", panelId: "two" } as const;
const PLUGIN_ONE_ID = "plugin_workspace_2_p1_3_one";
const PLUGIN_TWO_ID = "plugin_workspace_2_p2_3_two";

let layoutStore: ReturnType<typeof createWorkspaceLayoutStore>;
let shellStore: ReturnType<typeof createExplorerShellStore>;
let sync: ReturnType<typeof createExplorerShellSync>;

function layout() {
  return layoutStore.getState();
}

function explorerOf(workspaceKey: string) {
  const current = layout().layoutByWorkspace[workspaceKey];
  const pane = current ? findPaneById(current.root, EXPLORER) : null;
  if (!pane) throw new Error(`No Explorer in ${workspaceKey}`);
  return pane;
}

function tabIdsIn(workspaceKey: string, paneId: string) {
  const current = layout().layoutByWorkspace[workspaceKey];
  return current ? (findPaneById(current.root, paneId)?.tabIds ?? []) : [];
}

function openInExplorer(workspaceKey: string, target: WorkspaceTabTarget) {
  return layout().openTab({
    workspaceKey,
    target,
    intent: "reveal",
    placement: { mode: "pane", paneId: EXPLORER },
  });
}

/** Workspace A with its Explorer shown and Files selected; Files and Changes are its defaults. */
function showExplorerInA() {
  sync.activate(A);
  layout().showExplorerSidebar(A);
  layout().selectTabInPane(A, EXPLORER, "files");
}

beforeEach(async () => {
  layoutStore = createWorkspaceLayoutStore();
  shellStore = createExplorerShellStore();
  await Promise.all([layoutStore.persist.rehydrate(), shellStore.persist.rehydrate()]);
  sync = createExplorerShellSync(layoutStore, shellStore);
  return () => sync.dispose();
});

describe("Explorer shell", () => {
  it("gives the next workspace the same views, active view and width", () => {
    sync.activate(B);
    layout().showExplorerSidebar(B);
    layout().closeTab(B, "changes_tree");
    sync.activate(A);
    expect(explorerOf(A).tabIds).toEqual(["files"]);

    openInExplorer(A, { kind: "changes_tree" });
    layout().resizeExplorerSidebar(A, 420);
    sync.activate(B);

    expect(explorerOf(B)).toMatchObject({
      tabIds: ["files", "changes_tree"],
      focusedTabId: "changes_tree",
    });
    expect(explorerOf(B).hidden).toBeUndefined();
    expect(layout().explorerSidebarWidthByWorkspace[B]).toBe(420);
  });

  it("drops a view closed in one workspace from the others", () => {
    showExplorerInA();
    sync.activate(B);
    layout().closeTab(B, "changes_tree");
    sync.activate(A);

    expect(explorerOf(A).tabIds).toEqual(["files"]);
  });

  it("keeps an agent tab that was dragged into the Explorer", () => {
    showExplorerInA();
    const agentTabId = openInExplorer(A, { kind: "agent", agentId: "agent-1" });
    sync.activate(B);
    expect(explorerOf(B).tabIds).toEqual(["files", "changes_tree"]);
    layout().closeTab(B, "changes_tree");
    sync.activate(A);

    expect(explorerOf(A).tabIds).toEqual(["files", agentTabId]);
  });

  it("keeps the pull request tab in its own workspace", () => {
    showExplorerInA();
    const prTabId = openInExplorer(A, { kind: "pull_request" });
    sync.activate(B);

    expect(
      collectAllTabs(layout().layoutByWorkspace[B]!.root).map((tab) => tab.target.kind),
    ).toEqual(["new_tab", "files", "changes_tree"]);
    sync.activate(A);
    expect(explorerOf(A).tabIds).toContain(prTabId);
  });

  it("hides the Explorer everywhere once it is hidden in one workspace", () => {
    showExplorerInA();
    sync.activate(B);
    expect(explorerOf(B).hidden).toBeUndefined();
    sync.activate(A);
    layout().hideExplorerSidebar(A);
    sync.activate(B);

    expect(explorerOf(B).hidden).toBe(true);
  });

  it("keeps the order and selection of workspace plugin panels", () => {
    showExplorerInA();
    openInExplorer(A, PLUGIN_ONE);
    openInExplorer(A, PLUGIN_TWO);
    layout().reorderTabsInPane(A, EXPLORER, [
      "files",
      PLUGIN_TWO_ID,
      "changes_tree",
      PLUGIN_ONE_ID,
    ]);
    layout().selectTabInPane(A, EXPLORER, PLUGIN_ONE_ID);
    sync.activate(B);

    expect(explorerOf(B)).toMatchObject({
      tabIds: ["files", PLUGIN_TWO_ID, "changes_tree", PLUGIN_ONE_ID],
      focusedTabId: PLUGIN_ONE_ID,
    });
  });

  it("applies in one layout change without recording it back", () => {
    showExplorerInA();
    openInExplorer(A, { kind: "working_diff" });
    layout().resizeExplorerSidebar(A, 380);
    const shell = shellStore.getState().shell;
    const layoutChanges = vi.fn();
    const shellChanges = vi.fn();
    const unsubscribeLayout = layoutStore.subscribe(layoutChanges);
    const unsubscribeShell = shellStore.subscribe(shellChanges);

    sync.activate(B);
    unsubscribeLayout();
    unsubscribeShell();

    expect(layoutChanges).toHaveBeenCalledTimes(1);
    expect(shellChanges).not.toHaveBeenCalled();
    expect(shellStore.getState().shell).toBe(shell);
    expect(explorerOf(B)).toMatchObject({
      tabIds: ["files", "changes_tree", "working_diff"],
      focusedTabId: "working_diff",
    });
    expect(layout().explorerSidebarWidthByWorkspace[B]).toBe(380);
  });

  it("leaves a shell view where a workspace keeps it in a main pane", () => {
    sync.activate(B);
    const diffTabId = layout().openTab({
      workspaceKey: B,
      target: { kind: "working_diff" },
      intent: "reveal",
      placement: { mode: "pane", paneId: DEFAULT_PANE_ID },
    });
    showExplorerInA();
    openInExplorer(A, { kind: "working_diff" });
    openInExplorer(A, PLUGIN_ONE);
    sync.activate(B);

    expect(explorerOf(B).tabIds).toEqual(["files", "changes_tree", PLUGIN_ONE_ID]);
    expect(tabIdsIn(B, DEFAULT_PANE_ID)).toEqual([diffTabId]);
    layout().selectTabInPane(B, EXPLORER, "changes_tree");
    sync.activate(A);
    expect(explorerOf(A).tabIds).toEqual(["files", "changes_tree", "working_diff", PLUGIN_ONE_ID]);
  });
});
