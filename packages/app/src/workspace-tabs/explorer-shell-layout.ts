import {
  collectAllTabs,
  findPaneById,
  replacePaneTabsInLayout,
  setPaneHiddenInLayout,
  type WorkspaceLayout,
} from "@/stores/workspace-layout-actions";
import { buildDeterministicWorkspaceTabId } from "@/workspace-tabs/identity";
import type { WorkspaceTab, WorkspaceTabTarget } from "@/workspace-tabs/model";
import { createNewWorkspaceTab } from "@/workspace-tabs/new-tab";

/** An Explorer view without its workspace: Files lists whichever workspace is active. */
export type ExplorerViewDescriptor =
  | { kind: "files" | "changes_tree" | "working_diff" }
  | { kind: "plugin"; pluginId: string; panelId: string };

/** The Explorer's tabs, selection, visibility and width, shared by every workspace. */
export interface ExplorerShell {
  open: boolean;
  views: ExplorerViewDescriptor[];
  activeView: string | null;
  width: number | null;
}

function explorerViewFromTarget(target: WorkspaceTabTarget): ExplorerViewDescriptor | null {
  if (target.kind === "files" || target.kind === "changes_tree" || target.kind === "working_diff") {
    return { kind: target.kind };
  }
  if (target.kind === "plugin" && target.context === "workspace") {
    return { kind: "plugin", pluginId: target.pluginId, panelId: target.panelId };
  }
  return null;
}

function explorerViewTarget(view: ExplorerViewDescriptor): WorkspaceTabTarget {
  return view.kind === "plugin" ? { ...view, context: "workspace" } : { kind: view.kind };
}

export function explorerViewKey(view: ExplorerViewDescriptor): string {
  return buildDeterministicWorkspaceTabId(explorerViewTarget(view));
}

function viewKeyOfTab(tab: WorkspaceTab): string | null {
  const view = explorerViewFromTarget(tab.target);
  return view ? explorerViewKey(view) : null;
}

function viewKeysInLayout(layout: WorkspaceLayout): Set<string | null> {
  return new Set(collectAllTabs(layout.root).map(viewKeyOfTab));
}

function uniqueViews(views: ExplorerViewDescriptor[]): ExplorerViewDescriptor[] {
  const keys = new Set<string>();
  return views.filter((view) => {
    const key = explorerViewKey(view);
    if (keys.has(key)) return false;
    keys.add(key);
    return true;
  });
}

function arrangeExplorerTabs(paneTabs: WorkspaceTab[], views: WorkspaceTab[]): WorkspaceTab[] {
  const isPlaceholder = paneTabs.length === 1 && paneTabs[0]?.target.kind === "new_tab";
  // Views take the slots view tabs held, so tabs dragged into the Explorer keep their place.
  const tabs: WorkspaceTab[] = [];
  const pending = views.slice();
  for (const tab of isPlaceholder && views.length > 0 ? [] : paneTabs) {
    if (!viewKeyOfTab(tab)) tabs.push(tab);
    else if (pending.length > 0) tabs.push(pending.shift()!);
  }
  tabs.push(...pending);
  return tabs.length > 0 ? tabs : [createNewWorkspaceTab()];
}

/** The layout with its Explorer rebuilt from the shell, or null when nothing changes. */
export function applyExplorerShellToLayout(input: {
  layout: WorkspaceLayout;
  explorerPaneId: string;
  shell: ExplorerShell;
  now: number;
  canHost: (target: WorkspaceTabTarget) => boolean;
}): WorkspaceLayout | null {
  const pane = findPaneById(input.layout.root, input.explorerPaneId);
  if (!pane) return null;
  const paneTabs = collectAllTabs({ kind: "pane", pane });
  const openViewKeys = viewKeysInLayout(input.layout);
  const views = uniqueViews(input.shell.views).flatMap((view): WorkspaceTab[] => {
    const key = explorerViewKey(view);
    const existing = paneTabs.find((tab) => viewKeyOfTab(tab) === key);
    if (existing) return [existing];
    const target = explorerViewTarget(view);
    if (openViewKeys.has(key) || !input.canHost(target)) return [];
    return [{ tabId: key, target, createdAt: input.now }];
  });
  const tabs = arrangeExplorerTabs(paneTabs, views);
  const activeTab = tabs.find((tab) => viewKeyOfTab(tab) === input.shell.activeView);
  const focusedTabId = activeTab?.tabId ?? pane.focusedTabId;

  const unchanged =
    focusedTabId === pane.focusedTabId &&
    tabs.length === paneTabs.length &&
    tabs.every((tab, index) => tab === paneTabs[index]);
  const layout = unchanged
    ? input.layout
    : replacePaneTabsInLayout({ layout: input.layout, paneId: pane.id, tabs, focusedTabId });
  const shown =
    setPaneHiddenInLayout({ layout, paneId: pane.id, hidden: !input.shell.open }) ?? layout;
  return shown === input.layout ? null : shown;
}

/** Views that were open somewhere in the workspace and no longer are. */
export function closedExplorerViewKeys(
  before: WorkspaceLayout | undefined,
  after: WorkspaceLayout,
): Set<string> {
  const closed = new Set<string>();
  if (!before) return closed;
  const stillOpen = viewKeysInLayout(after);
  for (const key of viewKeysInLayout(before)) {
    if (key !== null && !stillOpen.has(key)) closed.add(key);
  }
  return closed;
}

function keepUnclosedViews(input: {
  views: ExplorerViewDescriptor[];
  previous: ExplorerViewDescriptor[];
  closedViewKeys: Set<string>;
}): ExplorerViewDescriptor[] {
  const views = input.views.slice();
  input.previous.forEach((view, index) => {
    const key = explorerViewKey(view);
    const keys = views.map(explorerViewKey);
    if (input.closedViewKeys.has(key) || keys.includes(key)) return;
    const anchor = input.previous
      .slice(0, index)
      .findLast((candidate) => keys.includes(explorerViewKey(candidate)));
    views.splice(anchor ? keys.indexOf(explorerViewKey(anchor)) + 1 : 0, 0, view);
  });
  return views;
}

// A shell view missing from this Explorer stays until it is closed: the user moved it to a
// main pane, or this workspace can't host it.
export function readExplorerShellFromLayout(input: {
  layout: WorkspaceLayout;
  explorerPaneId: string;
  width: number | undefined;
  previous: ExplorerShell | null;
  closedViewKeys: Set<string>;
}): ExplorerShell | null {
  const pane = findPaneById(input.layout.root, input.explorerPaneId);
  if (!pane) return null;
  const paneTabs = collectAllTabs({ kind: "pane", pane });
  const paneViews = paneTabs.flatMap((tab) => {
    const view = explorerViewFromTarget(tab.target);
    return view ? [view] : [];
  });
  const focusedTab = paneTabs.find((tab) => tab.tabId === pane.focusedTabId);
  return {
    open: pane.hidden !== true,
    views: keepUnclosedViews({
      views: uniqueViews(paneViews),
      previous: input.previous?.views ?? [],
      closedViewKeys: input.closedViewKeys,
    }),
    activeView: focusedTab ? viewKeyOfTab(focusedTab) : null,
    width: input.width ?? input.previous?.width ?? null,
  };
}

export function explorerShellsEqual(left: ExplorerShell | null, right: ExplorerShell): boolean {
  return (
    left !== null &&
    left.open === right.open &&
    left.activeView === right.activeView &&
    left.width === right.width &&
    left.views.length === right.views.length &&
    left.views.every(
      (view, index) => explorerViewKey(view) === explorerViewKey(right.views[index]!),
    )
  );
}
