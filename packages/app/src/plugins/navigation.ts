import { buildPluginSettingsRoute } from "./settings/routes";
import { router } from "expo-router";
import type { PluginPanelLocation } from "@getpaseo/plugin/client";
import type { JsonValue } from "@getpaseo/protocol/agent-types";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { buildPluginSurfaceRoute } from "./routes";
import type { PluginNavigation } from "./actions";

export function createPluginNavigation(input: {
  serverId: string;
  workspaceId: string | null;
}): PluginNavigation {
  const { serverId, workspaceId } = input;
  function placement(location: PluginPanelLocation) {
    if (location !== "explorer") return undefined;
    if (!workspaceId) throw new Error("No active workspace");
    const workspaceKey = `${serverId}:${workspaceId}`;
    const paneId = useWorkspaceLayoutStore.getState().showExplorerSidebar(workspaceKey);
    if (!paneId) throw new Error("Explorer is unavailable");
    return { mode: "pane" as const, paneId };
  }
  return {
    openSettings(pluginId, screenId) {
      router.push(buildPluginSettingsRoute(serverId, pluginId, screenId));
    },
    openSurface(pluginId, surfaceId, params) {
      router.push(
        buildPluginSurfaceRoute(serverId, pluginId, { kind: "surface", id: surfaceId }, params),
      );
    },
    openWorkspacePanel(pluginId, panelId, location, params?: JsonValue, newTab?: boolean) {
      if (!workspaceId) throw new Error("No active workspace");
      navigateToWorkspace({
        serverId,
        workspaceId,
        target: {
          kind: "plugin",
          pluginId,
          panelId,
          context: "workspace",
          ...(params === undefined ? {} : { params }),
        },
        placement: placement(location),
        ...(newTab === true ? { newTab: true as const } : {}),
      });
    },
    openAgentPanel(pluginId, panelId, agentId, location, params?: JsonValue, newTab?: boolean) {
      if (!workspaceId) throw new Error("No active workspace");
      navigateToWorkspace({
        serverId,
        workspaceId,
        target: {
          kind: "plugin",
          pluginId,
          panelId,
          context: "agent",
          agentId,
          ...(params === undefined ? {} : { params }),
        },
        placement: placement(location),
        ...(newTab === true ? { newTab: true as const } : {}),
      });
    },
  };
}
