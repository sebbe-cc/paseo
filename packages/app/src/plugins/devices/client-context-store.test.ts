import { describe, expect, it, vi } from "vitest";
import { createClientContextStore, paneForAgent } from "./client-context-store";
import type { PluginRouteTarget } from "@getpaseo/plugin/client";

function createDeps(overrides: Partial<Parameters<typeof createClientContextStore>[0]> = {}) {
  const external = {
    serverId: "server-1" as string | null,
    workspaceId: "workspace-1" as string | null,
    agentId: "agent-1" as string | null,
    focused: true,
  };
  const subscribers = new Set<() => void>();
  return {
    external,
    subscribers,
    focusTarget: vi.fn(async (_target: PluginRouteTarget) => undefined),
    openWorkspace: vi.fn((_input: { serverId: string; workspaceId: string }) => undefined),
    deps: {
      resolveIdentities: async () => ({ installationId: "install-1", windowId: "w1" }),
      readExternal: () => ({ ...external }),
      subscribeExternal: (notify: () => void) => {
        subscribers.add(notify);
        return () => {
          subscribers.delete(notify);
        };
      },
      focusTarget: async (_target: PluginRouteTarget) => undefined,
      openWorkspace: (_input: { serverId: string; workspaceId: string }) => undefined,
      ...overrides,
    },
  };
}

async function settled() {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("client context store", () => {
  it("stays null until identities resolve, then publishes the snapshot", async () => {
    const { deps } = createDeps();
    const store = createClientContextStore(deps);
    const seen: Array<unknown> = [];
    store.subscribe((snapshot) => seen.push(snapshot));
    store.start();
    expect(store.getSnapshot()).toBeNull();
    await settled();
    expect(store.getSnapshot()).toMatchObject({
      installationId: "install-1",
      windowId: "w1",
      serverId: "server-1",
      workspaceId: "workspace-1",
      pane: "agent",
      agentId: "agent-1",
      focused: true,
      version: 1,
    });
    expect(seen.length).toBeGreaterThan(0);
    store.dispose();
  });

  it("stays null when identities never resolve instead of guessing", async () => {
    const { deps } = createDeps({
      resolveIdentities: () => new Promise<never>(() => undefined),
    });
    const store = createClientContextStore(deps);
    store.start();
    await settled();
    expect(store.getSnapshot()).toBeNull();
    store.dispose();
  });

  it("maps a missing agent to the unknown pane without falling back", async () => {
    expect(paneForAgent("agent-1")).toBe("agent");
    expect(paneForAgent(null)).toBe("unknown");
    const { deps, external } = createDeps();
    external.agentId = null;
    const store = createClientContextStore(deps);
    store.start();
    await settled();
    expect(store.getSnapshot()).toMatchObject({ agentId: null, pane: "unknown" });
    store.dispose();
  });

  it("notifies on external changes but not on identical reads", async () => {
    const { deps, external, subscribers } = createDeps();
    const store = createClientContextStore(deps);
    const spy = vi.fn();
    store.subscribe(spy);
    store.start();
    await settled();
    const callsAfterStart = spy.mock.calls.length;
    // Identical re-read: no notification.
    for (const notify of subscribers) notify();
    expect(spy.mock.calls.length).toBe(callsAfterStart);
    // Changed agent: one notification.
    external.agentId = "agent-2";
    for (const notify of subscribers) notify();
    expect(spy.mock.calls.length).toBe(callsAfterStart + 1);
    expect(store.getSnapshot()).toMatchObject({ agentId: "agent-2" });
    store.dispose();
  });

  it("bumps the ownership version exactly once per focus gain", async () => {
    const { deps, external } = createDeps();
    external.focused = false;
    const store = createClientContextStore(deps);
    store.start();
    await settled();
    expect(store.getSnapshot()).toMatchObject({ focused: false, version: 1 });
    store.markFocused(false);
    expect(store.getSnapshot()).toMatchObject({ version: 1 });
    store.markFocused(true);
    expect(store.getSnapshot()).toMatchObject({ focused: true, version: 2 });
    store.markFocused(true);
    expect(store.getSnapshot()).toMatchObject({ version: 2 });
    store.markFocused(false);
    store.markFocused(true);
    expect(store.getSnapshot()).toMatchObject({ version: 3 });
    store.dispose();
  });

  it("navigates and focuses without a mounted panel", async () => {
    const focusTarget = vi.fn(async (_target: PluginRouteTarget) => undefined);
    const openWorkspace = vi.fn((_input: { serverId: string; workspaceId: string }) => undefined);
    const { deps } = createDeps({ focusTarget, openWorkspace });
    const store = createClientContextStore(deps);
    store.start();
    await settled();
    await store.focusTarget({ serverId: "server-9", agentId: "agent-9" });
    expect(focusTarget).toHaveBeenCalledWith({ serverId: "server-9", agentId: "agent-9" });
    store.openWorkspace({ serverId: "server-9", workspaceId: "workspace-9" });
    expect(openWorkspace).toHaveBeenCalledWith({
      serverId: "server-9",
      workspaceId: "workspace-9",
    });
    store.dispose();
  });

  it("teardown stops external notifications and clears listeners", async () => {
    const { deps, external, subscribers } = createDeps();
    const store = createClientContextStore(deps);
    const spy = vi.fn();
    store.subscribe(spy);
    store.start();
    await settled();
    expect(subscribers.size).toBe(1);
    const calls = spy.mock.calls.length;
    store.dispose();
    expect(subscribers.size).toBe(0);
    external.agentId = "agent-x";
    // No crash, no notification after dispose.
    expect(spy.mock.calls.length).toBe(calls);
    store.update();
    expect(spy.mock.calls.length).toBe(calls);
  });

  it("keeps two store instances independent", async () => {
    const first = createDeps();
    const second = createDeps();
    const firstStore = createClientContextStore(first.deps);
    const secondStore = createClientContextStore(second.deps);
    firstStore.start();
    secondStore.start();
    await settled();
    first.external.agentId = "agent-a";
    for (const notify of first.subscribers) notify();
    expect(firstStore.getSnapshot()).toMatchObject({ agentId: "agent-a" });
    expect(secondStore.getSnapshot()).toMatchObject({ agentId: "agent-1" });
    firstStore.dispose();
    secondStore.dispose();
  });
});
