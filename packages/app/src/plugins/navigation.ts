import { buildPluginSettingsRoute } from "./settings/routes";
import { router } from "expo-router";
import type { PluginPanelLocation, PluginPanelSplit } from "@getpaseo/plugin/client";
import type { JsonValue } from "@getpaseo/protocol/agent-types";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import type { WorkspaceTabTarget } from "@/workspace-tabs/model";
import { buildPluginSurfaceRoute } from "./routes";
import type { PluginNavigation } from "./actions";

export function createPluginNavigation(input: {
  serverId: string;
  workspaceId: string | null;
}): PluginNavigation {
  const { serverId, workspaceId } = input;
  function placement(
    location: PluginPanelLocation,
    target: WorkspaceTabTarget,
    split: PluginPanelSplit | undefined,
  ) {
    if (location !== "explorer") {
      if (!split || !workspaceId) return undefined;
      const paneId = useWorkspaceLayoutStore
        .getState()
        .splitPaneForTarget(`${serverId}:${workspaceId}`, target, split);
      return paneId ? { mode: "pane" as const, paneId } : undefined;
    }
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
    openWorkspacePanel(
      pluginId,
      panelId,
      location,
      params?: JsonValue,
      newTab?: boolean,
      split?: PluginPanelSplit,
    ) {
      if (!workspaceId) throw new Error("No active workspace");
      const target: WorkspaceTabTarget = {
        kind: "plugin",
        pluginId,
        panelId,
        context: "workspace",
        ...(params === undefined ? {} : { params }),
      };
      navigateToWorkspace({
        serverId,
        workspaceId,
        target,
        placement: placement(location, target, split),
        ...(newTab === true ? { newTab: true as const } : {}),
      });
    },
    openAgentPanel(
      pluginId,
      panelId,
      agentId,
      location,
      params?: JsonValue,
      newTab?: boolean,
      split?: PluginPanelSplit,
    ) {
      if (!workspaceId) throw new Error("No active workspace");
      const target: WorkspaceTabTarget = {
        kind: "plugin",
        pluginId,
        panelId,
        context: "agent",
        agentId,
        ...(params === undefined ? {} : { params }),
      };
      navigateToWorkspace({
        serverId,
        workspaceId,
        target,
        placement: placement(location, target, split),
        ...(newTab === true ? { newTab: true as const } : {}),
      });
    },
  };
}
