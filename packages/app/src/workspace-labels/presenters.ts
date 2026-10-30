import { useMemo } from "react";
import {
  WORKSPACE_LABEL_COLORS,
  workspaceLabelKey,
  type WorkspaceLabelColor,
  type WorkspaceLabelDefinition,
} from "@getpaseo/protocol/workspace-labels";
import { useInstalledPlugins } from "@/plugins/registry";
import type { InstalledPlugin } from "@/plugins/types";
import { useSidebarMetaPreferences } from "@/components/sidebar/display-preferences/model";
import { useWorkspaceLabels } from "./index";

/**
 * What a sidebar workspace row draws on its own label line.
 *
 * The host owns the line: labels always render below the
 * branch/project/host/change-request line and wrap onto more lines instead
 * of competing with them, whether or not any plugin contributes. Plugins
 * only reshape which names are drawn through `addWorkspaceLabelPresenter`:
 * typically hiding one long machine-written label (kept intact on the
 * workspace, so lookups still resolve) and adding short readable ones,
 * which render first so the curated identity leads the line.
 */

export interface WorkspaceLabelPresenterRequest {
  serverId: string;
  workspaceId: string;
  labels: readonly string[];
}

export interface ResolvedWorkspaceLabelPresentation {
  /** Raw names the presenters asked to hide, matched exactly. */
  hidden: ReadonlySet<string>;
  /** Display names the presenters added, in order, already de-duplicated. */
  added: readonly { name: string; color?: WorkspaceLabelColor }[];
}

/** A presenter may add this many display names before the rest are dropped. */
const MAX_ADDED_LABELS = 8;

/** Fallback tint for a display name the host catalog does not know. */
const DEFAULT_ADDED_COLOR: WorkspaceLabelColor = "sky";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

function asColor(value: unknown): WorkspaceLabelColor | undefined {
  if (typeof value !== "string") return undefined;
  return (WORKSPACE_LABEL_COLORS as readonly string[]).includes(value)
    ? (value as WorkspaceLabelColor)
    : undefined;
}

/**
 * Run every installed presenter's `present` over the workspace's raw labels.
 * Presenters see the original labels in registration order; one throwing or
 * returning a misshapen result never takes the others down with it.
 */
export function resolveWorkspaceLabelPresentation(input: {
  plugins: readonly InstalledPlugin[];
  serverId: string;
  workspaceId: string;
  labels: readonly string[];
}): ResolvedWorkspaceLabelPresentation {
  const { plugins, serverId, workspaceId, labels } = input;
  const hidden = new Set<string>();
  const added: { name: string; color?: WorkspaceLabelColor }[] = [];
  const seen = new Set(labels.map((name) => workspaceLabelKey(name)));
  for (const plugin of plugins) {
    for (const presenter of plugin.workspaceLabelPresenters ?? []) {
      let result: unknown;
      try {
        result = presenter.present({ serverId, workspaceId, labels });
      } catch (error) {
        console.warn(
          `[Plugins] Workspace label presenter failed: ${plugin.id}/${presenter.id}`,
          error,
        );
        continue;
      }
      if (result === undefined) continue;
      if (!isRecord(result)) {
        console.warn(
          `[Plugins] Workspace label presenter failed: ${plugin.id}/${presenter.id} returned no object`,
        );
        continue;
      }
      for (const name of asStringList(result.hide)) {
        if (name.length > 0) hidden.add(name);
      }
      const additions = Array.isArray(result.add) ? result.add : [];
      for (const entry of additions) {
        if (added.length >= MAX_ADDED_LABELS) break;
        if (!isRecord(entry) || typeof entry.name !== "string") continue;
        const name = entry.name.trim();
        if (!name || name.length > 160) continue;
        const key = workspaceLabelKey(name);
        if (seen.has(key)) continue;
        seen.add(key);
        const color = asColor(entry.color);
        added.push(color ? { name, color } : { name });
      }
    }
  }
  return { hidden, added };
}

/**
 * The label definitions a sidebar row draws: presenter additions first,
 * then the workspace's raw labels minus what presenters hid. A name the
 * host catalog does not know is dropped rather than drawn in an invented
 * color — except presenter additions, which fall back to the presenter
 * hint or the default tint so a plugin's readable names always survive.
 */
export function selectWorkspaceLabelRowDefinitions(input: {
  catalog: readonly WorkspaceLabelDefinition[];
  names: readonly string[];
  hidden: ReadonlySet<string>;
  added: readonly { name: string; color?: WorkspaceLabelColor }[];
}): readonly WorkspaceLabelDefinition[] {
  const { catalog, names, hidden, added } = input;
  const byKey = new Map(catalog.map((label) => [workspaceLabelKey(label.name), label]));
  const definitions = added.map(
    (entry): WorkspaceLabelDefinition =>
      byKey.get(workspaceLabelKey(entry.name)) ?? {
        name: entry.name,
        color: entry.color ?? DEFAULT_ADDED_COLOR,
      },
  );
  for (const name of names) {
    if (hidden.has(name)) continue;
    const definition = byKey.get(workspaceLabelKey(name));
    if (definition) definitions.push(definition);
  }
  return definitions;
}

/**
 * Reactive label line for one sidebar workspace row. Honors the same
 * `labels` row-item toggle as the old in-line chips; with the toggle off
 * the row draws no label line at all.
 */
export function useWorkspaceLabelRowDefinitions(
  serverId: string,
  workspaceId: string,
  names: readonly string[] | undefined,
): readonly WorkspaceLabelDefinition[] {
  const plugins = useInstalledPlugins();
  const hostsById = useWorkspaceLabels((state) => state.hosts);
  const {
    rowItems: { labels: labelsVisible },
  } = useSidebarMetaPreferences();
  return useMemo(() => {
    if (!labelsVisible || !names || names.length === 0) return EMPTY_DEFINITIONS;
    const { hidden, added } = resolveWorkspaceLabelPresentation({
      plugins,
      serverId,
      workspaceId,
      labels: names,
    });
    return selectWorkspaceLabelRowDefinitions({
      catalog: hostsById[serverId]?.labels ?? [],
      names,
      hidden,
      added,
    });
  }, [labelsVisible, names, plugins, serverId, workspaceId, hostsById]);
}

const EMPTY_DEFINITIONS: readonly WorkspaceLabelDefinition[] = [];
