import type { PluginRecentNavigation, PluginNavigationLocation } from "@getpaseo/plugin/client";
import { useSessionStore } from "@/stores/session-store";
import {
  useWorkspaceLayoutStore,
  collectAllTabs,
  findPaneById,
} from "@/stores/workspace-layout-store";
import { resolveWorkspaceMapKeyByIdentity } from "@/utils/workspace-identity";
import { buildHostWorkspaceRoute } from "@/utils/host-routes";
import { navigateToHostWorkspaceRoute } from "@/navigation/workspace-route-navigation";

let activeWorkspace: { serverId: string; workspaceId: string } | null = null;
let previousKey = "";
const listeners = new Set<(location: PluginNavigationLocation | null) => void>();

function resolveWorkspace(serverId: string, workspaceId: string): string | null {
  return resolveWorkspaceMapKeyByIdentity({
    workspaces: useSessionStore.getState().sessions[serverId]?.workspaces,
    workspaceId,
  });
}

function getActive(): PluginNavigationLocation | null {
  if (!activeWorkspace) return null;
  const { serverId, workspaceId } = activeWorkspace;
  const key = `${serverId}:${workspaceId}`;
  const layout = useWorkspaceLayoutStore.getState().layoutByWorkspace[key];
  const pane = layout ? findPaneById(layout.root, layout.focusedPaneId) : null;
  return { serverId, workspaceId, tabId: pane?.focusedTabId ?? null };
}

function publish() {
  const active = getActive();
  const key = active ? `${active.serverId}:${active.workspaceId}:${active.tabId ?? ""}` : "";
  if (key === previousKey) return;
  previousKey = key;
  for (const listener of listeners) listener(active);
}

useWorkspaceLayoutStore.subscribe(publish);

export function setPluginActiveWorkspace(selection: typeof activeWorkspace) {
  activeWorkspace = selection;
  publish();
}

export const pluginRecentNavigation: PluginRecentNavigation = {
  getActive,
  subscribe(listener) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  activateWorkspace({ serverId, workspaceId }) {
    const resolved = resolveWorkspace(serverId, workspaceId);
    if (!resolved) return false;
    navigateToHostWorkspaceRoute(buildHostWorkspaceRoute(serverId, resolved));
    return true;
  },
  activateTab({ serverId, workspaceId, tabId }) {
    const resolved = resolveWorkspace(serverId, workspaceId);
    if (!resolved) return false;
    const key = `${serverId}:${resolved}`;
    const layout = useWorkspaceLayoutStore.getState().layoutByWorkspace[key];
    if (!layout || !collectAllTabs(layout.root).some((tab) => tab.tabId === tabId)) return false;
    useWorkspaceLayoutStore.getState().focusTab(key, tabId);
    navigateToHostWorkspaceRoute(buildHostWorkspaceRoute(serverId, resolved));
    return true;
  },
};
