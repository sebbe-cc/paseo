import { createContext, useContext, useMemo, useSyncExternalStore, type ReactNode } from "react";
import type { PluginInlineDecoration } from "@getpaseo/plugin/client";
import { createPluginAgentActionContext } from "../actions";
import { createPluginClientStateSource } from "../client-state/source";
import { createPluginNavigation } from "../navigation";
import { useInstalledPlugins } from "../registry";
import type { InstalledPlugin } from "../types";
import { findInlineDecorator, resolveInlineDecoration, type InlineDecorator } from "./model";

export { combineLinkRecognition, createInlineDecorator, type InlineDecorator } from "./model";

export interface InlineDecoratorEntry {
  plugin: InstalledPlugin;
  decorator: InlineDecorator;
}

interface InlineDecorationScope {
  serverId: string;
  workspaceId: string | null;
  agentId: string;
}

const InlineDecorationScopeContext = createContext<InlineDecorationScope | null>(null);
const InlineDecoratorEntriesContext = createContext<{
  serverId: string;
  entries: readonly InlineDecoratorEntry[];
} | null>(null);

/** Opts a subtree into plugin decorations; only assistant messages do in v1. */
export function InlineDecorationScopeProvider({
  serverId,
  workspaceId,
  agentId,
  children,
}: InlineDecorationScope & { children: ReactNode }) {
  const value = useMemo(
    () => ({ serverId, workspaceId, agentId }),
    [agentId, serverId, workspaceId],
  );
  return (
    <InlineDecorationScopeContext.Provider value={value}>
      {children}
    </InlineDecorationScopeContext.Provider>
  );
}

const NO_ENTRIES: readonly InlineDecoratorEntry[] = [];

/** Decorators from plugins of this message's host, in registry order. */
export function useInlineDecorators() {
  const scope = useContext(InlineDecorationScopeContext);
  const installed = useInstalledPlugins();
  const entries = useMemo(() => {
    if (!scope) return NO_ENTRIES;
    const found = installed
      .filter((plugin) => plugin.serverId === scope.serverId)
      .flatMap((plugin) => plugin.inlineDecorators.map((decorator) => ({ plugin, decorator })));
    return found.length ? found : NO_ENTRIES;
  }, [installed, scope]);
  const press = (url: string): boolean => {
    const entry = findInlineDecorator(entries, url);
    if (!entry || !scope) return false;
    const match = { text: url, serverId: scope.serverId };
    if (resolveInlineDecoration(entry.decorator, match, warn(entry)) === null) return true;
    runInlineDecoratorPress(entry, scope, url);
    return true;
  };
  return { serverId: scope?.serverId ?? "", entries, press };
}

function runInlineDecoratorPress(
  entry: InlineDecoratorEntry,
  scope: InlineDecorationScope,
  text: string,
): void {
  if (!scope.workspaceId) return;
  const context = createPluginAgentActionContext({
    plugin: entry.plugin,
    navigation: createPluginNavigation({
      serverId: scope.serverId,
      workspaceId: scope.workspaceId,
    }),
    state: createPluginClientStateSource(scope.serverId),
    workspaceId: scope.workspaceId,
    agentId: scope.agentId,
  });
  if (!context) return;
  try {
    void Promise.resolve(entry.decorator.onPress({ ...context, text })).catch(warn(entry));
  } catch (error) {
    warn(entry)(error);
  }
}

function warn(entry: InlineDecoratorEntry) {
  return (error: unknown) =>
    console.warn(
      `[Plugins] Inline decorator failed: ${entry.plugin.id}/${entry.decorator.id}`,
      error,
    );
}

export function InlineDecoratorEntriesProvider({
  serverId,
  entries,
  children,
}: {
  serverId: string;
  entries: readonly InlineDecoratorEntry[];
  children: ReactNode;
}) {
  const value = useMemo(() => ({ serverId, entries }), [entries, serverId]);
  return (
    <InlineDecoratorEntriesContext.Provider value={value}>
      {children}
    </InlineDecoratorEntriesContext.Provider>
  );
}

const NEVER = () => () => undefined;
const NO_REVISION = () => "";

export type InlineDecorationState =
  | { kind: "none" }
  | { kind: "text" }
  | { kind: "decorated"; decoration: PluginInlineDecoration | undefined };

/** Resolves one recognized link; re-resolves only when its own text is invalidated. */
export function useInlineDecoration(url: string): InlineDecorationState {
  const value = useContext(InlineDecoratorEntriesContext);
  const entry = value ? findInlineDecorator(value.entries, url) : undefined;
  const decorator = entry?.decorator;
  const revision = useSyncExternalStore(
    decorator ? decorator.subscribe : NEVER,
    decorator ? () => decorator.getRevision(url) : NO_REVISION,
    decorator ? () => decorator.getRevision(url) : NO_REVISION,
  );
  return useMemo((): InlineDecorationState => {
    if (!entry || !value) return { kind: "none" };
    const decoration = resolveInlineDecoration(
      entry.decorator,
      { text: url, serverId: value.serverId },
      warn(entry),
    );
    return decoration === null ? { kind: "text" } : { kind: "decorated", decoration };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- revision re-runs resolve().
  }, [entry, value, url, revision]);
}
