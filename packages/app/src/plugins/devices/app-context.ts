// App wiring for the trusted device capabilities (pa-yi0bsm). Binds
// the framework-free client-context store and HID broker to the real
// app sources with app lifetime: one store and one broker per client
// (window), shared by every installed plugin. Works without any
// mounted plugin panel — contribute() only reads the singletons.

import { getDesktopHost } from "@/desktop/host";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import { getOrCreateClientId } from "@/utils/client-id";
import {
  getLastWorkspaceSelection,
  navigateToWorkspace,
} from "@/stores/navigation-active-workspace-store";
import { useSessionStore } from "@/stores/session-store";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import type {
  PluginClientContextCapability,
  PluginHidCapability,
  PluginRouteTarget,
} from "@getpaseo/plugin/client";
import { createClientContextStore, type ClientContextStore } from "./client-context-store";
import { createHidBrokerHandle, type HidBrokerHandle } from "./hid-broker";

function readWindowFocused(): boolean {
  if (typeof document !== "undefined" && typeof document.hasFocus === "function") {
    return document.hasFocus();
  }
  // Native clients have no document: assume focused; AppState
  // refinement is follow-up work (the flag only seeds the snapshot).
  return true;
}

function sessionWindowId(): string {
  return `web-${Math.floor(Math.random() * 0xffffffff)
    .toString(16)
    .padStart(8, "0")}`;
}

function readExternalState() {
  const selection = getLastWorkspaceSelection();
  const serverId = selection?.serverId ?? null;
  const workspaceId = selection?.workspaceId ?? null;
  const agentId =
    (serverId ? useSessionStore.getState().sessions[serverId]?.focusedAgentId : undefined) ?? null;
  return { serverId, workspaceId, agentId, focused: readWindowFocused() };
}

let sharedStore: ClientContextStore | null = null;
let hidHandle: HidBrokerHandle | null | undefined;
let windowListenersAttached = false;

function attachWindowFocusListeners(store: ClientContextStore): void {
  if (windowListenersAttached || typeof window === "undefined") return;
  windowListenersAttached = true;
  window.addEventListener("focus", () => store.markFocused(true));
  window.addEventListener("blur", () => store.markFocused(false));
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", () => {
      store.markFocused(!document.hidden && readWindowFocused());
    });
  }
  // Seed from the current OS state so the first snapshot is honest.
  store.markFocused(readWindowFocused());
}

/** One client-context store per client; starts on first call. */
export function getAppClientContextStore(): ClientContextStore {
  if (!sharedStore) {
    const store = createClientContextStore({
      resolveIdentities: async () => {
        const [installationId, identity] = await Promise.all([
          getOrCreateClientId(),
          getDesktopHost()?.hid?.identity?.(),
        ]);
        return { installationId, windowId: identity?.windowId ?? sessionWindowId() };
      },
      readExternal: readExternalState,
      subscribeExternal: (notify) => {
        const stopSession = useSessionStore.subscribe(notify);
        const stopLayout = useWorkspaceLayoutStore.subscribe(notify);
        return () => {
          stopSession();
          stopLayout();
        };
      },
      focusTarget: async (target: PluginRouteTarget) => {
        navigateToAgent({ serverId: target.serverId, agentId: target.agentId });
        await getDesktopHost()?.window?.getCurrentWindow?.()?.focusSelf?.();
      },
      openWorkspace: (input) => {
        navigateToWorkspace({ serverId: input.serverId, workspaceId: input.workspaceId });
      },
    });
    store.start();
    attachWindowFocusListeners(store);
    sharedStore = store;
  }
  return sharedStore;
}

/** One HID broker handle per client; null without the capability. */
export function getAppHidBrokerHandle(): HidBrokerHandle | null {
  if (hidHandle === undefined) {
    const store = getAppClientContextStore();
    hidHandle = createHidBrokerHandle(getDesktopHost(), {
      getOwner: () => {
        const snapshot = store.getSnapshot();
        if (!snapshot) return null;
        return {
          installationId: snapshot.installationId,
          windowId: snapshot.windowId,
          version: snapshot.version,
        };
      },
    });
  }
  return hidHandle;
}

/** Trusted device capability for the plugin client context. */
export function getAppHidCapability(): PluginHidCapability | undefined {
  const handle = getAppHidBrokerHandle();
  if (!handle) return undefined;
  return {
    getBroker: () => handle.broker,
    subscribe: (listener) => handle.broker.subscribe(() => listener(handle.broker)),
  };
}

/** Trusted global client context for the plugin client context. */
export function getAppClientContextCapability(): PluginClientContextCapability {
  const store = getAppClientContextStore();
  return {
    getSnapshot: () => store.getSnapshot(),
    subscribe: (listener) => store.subscribe(listener),
    focusTarget: (target) => store.focusTarget(target),
    openWorkspace: (input) => store.openWorkspace(input),
  };
}
