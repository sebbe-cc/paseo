import { useMemo } from "react";
import { useInstalledPlugins } from "@/plugins/registry";
import type { InstalledPlugin } from "@/plugins/types";

/**
 * A plugin's project group, resolved for the sidebar's project list.
 *
 * The host owns the drawing: headers render in `order` (ties break on
 * name) across every installed plugin, members are sidebar projects with a
 * matching host project id, and `key` is the stable collapse-store key.
 * The plugin owns the data and refreshes it through its registration's
 * `update`; the host never edits groups itself.
 */
export interface ResolvedSidebarProjectGroup {
  pluginId: string;
  serverId: string;
  /** Group id within the plugin. */
  id: string;
  /** Stable collapse-store key, shared across hosts. */
  key: string;
  name: string;
  projectIds: readonly string[];
  order: number;
  onManage?: () => void;
  manageLabel?: string;
}

export function sidebarProjectGroupKey(pluginId: string, groupId: string): string {
  return `sidebar-project-group:${pluginId}:${groupId}`;
}

/**
 * Merge every installation's project groups in snapshot order. Groups sort
 * by `order`, then name, within each plugin; a group id a plugin contributes
 * from several hosts resolves once, from the first host.
 */
export function resolveSidebarProjectGroups(
  plugins: readonly InstalledPlugin[],
): ResolvedSidebarProjectGroup[] {
  const resolved: ResolvedSidebarProjectGroup[] = [];
  const seen = new Set<string>();
  for (const plugin of plugins) {
    const contribution = plugin.sidebarProjectGroups;
    if (!contribution) continue;
    const groups = [...contribution.groups].sort(
      (left, right) => left.order - right.order || left.name.localeCompare(right.name),
    );
    for (const group of groups) {
      const key = sidebarProjectGroupKey(plugin.id, group.id);
      if (seen.has(key)) continue;
      seen.add(key);
      resolved.push({
        pluginId: plugin.id,
        serverId: plugin.serverId,
        id: group.id,
        key,
        name: group.name,
        projectIds: group.projectIds,
        order: group.order,
        ...(contribution.onManage ? { onManage: contribution.onManage } : {}),
        ...(contribution.manageLabel ? { manageLabel: contribution.manageLabel } : {}),
      });
    }
  }
  return resolved;
}

export function useSidebarProjectGroups(): ResolvedSidebarProjectGroup[] {
  const plugins = useInstalledPlugins();
  return useMemo(() => resolveSidebarProjectGroups(plugins), [plugins]);
}
