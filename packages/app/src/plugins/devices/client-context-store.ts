// Global client context store (pa-yi0bsm). App-side implementation of
// the trusted PluginClientContextCapability: window/server/workspace/
// pane/agent/focus with getSnapshot/subscribe plus navigation and
// focus that work without a mounted plugin panel.
//
// The store is framework-free: identities resolve asynchronously,
// external app state arrives through injected readers, and no
// window/document global is touched here, so unit tests run in node.
// bind-app-client-context.ts wires the real app sources; the store
// itself only sees callbacks.

import type {
  PluginClientContextCapability,
  PluginClientContextSnapshot,
  PluginClientPane,
  PluginRouteTarget,
} from "@getpaseo/plugin/client";

export interface ClientContextIdentities {
  installationId: string;
  windowId: string;
}

export interface ClientContextExternalState {
  serverId: string | null;
  workspaceId: string | null;
  /** Visible agent, null outside an agent panel with no locked target. */
  agentId: string | null;
  focused: boolean;
}

export interface ClientContextStoreDeps {
  resolveIdentities: () => Promise<ClientContextIdentities>;
  readExternal: () => ClientContextExternalState;
  /** Re-read after every external change; the store diffs and notifies. */
  subscribeExternal: (notify: () => void) => () => void;
  focusTarget: (target: PluginRouteTarget) => Promise<void>;
  openWorkspace: (input: { serverId: string; workspaceId: string }) => void;
}

function sameSnapshot(a: PluginClientContextSnapshot, b: PluginClientContextSnapshot): boolean {
  return (
    a.installationId === b.installationId &&
    a.windowId === b.windowId &&
    a.serverId === b.serverId &&
    a.workspaceId === b.workspaceId &&
    a.pane === b.pane &&
    a.agentId === b.agentId &&
    a.focused === b.focused &&
    a.version === b.version
  );
}

export interface ClientContextStore extends PluginClientContextCapability {
  /** Resolves identities and subscribes to external changes; call once. */
  start(): void;
  /** Re-read external state and notify on change. */
  update(): void;
  /** Record an OS focus gain: bumps the ownership version. Idempotent per state. */
  markFocused(focused: boolean): void;
  dispose(): void;
}

export function paneForAgent(agentId: string | null): PluginClientPane {
  // The app cannot reliably tell terminal/file/diff tabs apart here
  // yet (pa-xweps refines this); "unknown" is the honest fallback the
  // contract defines for exactly this case.
  return agentId === null ? "unknown" : "agent";
}

export function createClientContextStore(deps: ClientContextStoreDeps): ClientContextStore {
  const listeners = new Set<(snapshot: PluginClientContextSnapshot | null) => void>();
  let version = 1;
  let identities: ClientContextIdentities | null = null;
  let external: ClientContextExternalState = {
    serverId: null,
    workspaceId: null,
    agentId: null,
    focused: false,
  };
  let current: PluginClientContextSnapshot | null = null;
  let disposed = false;
  let started = false;
  let externalUnsubscribe: (() => void) | null = null;

  const build = (): PluginClientContextSnapshot | null => {
    if (!identities) return null;
    return {
      installationId: identities.installationId,
      windowId: identities.windowId,
      serverId: external.serverId,
      workspaceId: external.workspaceId,
      pane: paneForAgent(external.agentId),
      agentId: external.agentId,
      focused: external.focused,
      version,
    };
  };

  const emit = () => {
    for (const listener of listeners) listener(current ? { ...current } : null);
  };

  const refresh = () => {
    const next = build();
    if (current === null || next === null || !sameSnapshot(current, next)) {
      current = next;
      emit();
    }
  };

  return {
    getSnapshot: () => (current ? { ...current } : null),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    focusTarget: (target) => deps.focusTarget(target),
    openWorkspace: (input) => deps.openWorkspace(input),
    start: () => {
      if (started || disposed) return;
      started = true;
      externalUnsubscribe = deps.subscribeExternal(() => {
        if (disposed) return;
        external = deps.readExternal();
        refresh();
      });
      external = deps.readExternal();
      refresh();
      const settleIdentities = async () => {
        try {
          const resolved = await deps.resolveIdentities();
          if (disposed) return;
          identities = resolved;
          refresh();
        } catch {
          // Identities stay unresolved: the snapshot stays null and
          // subscribers keep waiting instead of guessing.
        }
      };
      void settleIdentities();
    },
    update: () => {
      if (disposed) return;
      external = deps.readExternal();
      refresh();
    },
    markFocused: (next) => {
      if (disposed || external.focused === next) return;
      external = { ...external, focused: next };
      // A focus gain moves the ownership clock: this window's next
      // claim carries a higher version and follows the active window.
      if (next) version += 1;
      refresh();
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      externalUnsubscribe?.();
      externalUnsubscribe = null;
      listeners.clear();
    },
  };
}
