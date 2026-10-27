import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InstalledPlugin } from "../types";
import { runPluginClientBundle, type PluginClientRuntime } from "../evaluate";

const installed: InstalledPlugin[] = [];
const openAgentPanel = vi.fn();
vi.mock("../registry", () => ({ useInstalledPlugins: () => installed }));
vi.mock("../navigation", () => ({
  createPluginNavigation: () => ({
    openSettings() {},
    openSurface() {},
    openWorkspacePanel() {},
    openAgentPanel,
  }),
}));
vi.mock("../client-state/source", () => ({
  createPluginClientStateSource: () => ({
    subscribe: () => () => undefined,
    getWorkspace: (id: string) => ({ id }),
    getAgent: (id: string) => ({ id, workspaceId: "ws" }),
  }),
}));

const {
  InlineDecorationScopeProvider,
  InlineDecoratorEntriesProvider,
  useInlineDecoration,
  useInlineDecorators,
} = await import("./index");

// The bead plugin from the design: resolve() from a cache, click opens its agent panel.
const BUNDLE = `(function(require) {
  return { default(client) {
    function Panel() { return null; }
    client.addWorkspacePanel({ id: "bead", title: "Bead", icon: "CircleDot", context: "agent", Component: Panel });
    const cache = { "pa-k1q": { title: "Inline decorators" }, "do-it": null };
    globalThis.__beads = client.addInlineDecorator({
      id: "bead",
      pattern: /\\b(?:pa|do)-[a-z0-9]{2,}\\b/,
      resolve: ({ text }) => text in cache ? cache[text] && { icon: "CircleDot", tooltip: cache[text].title } : undefined,
      onPress: (ctx) => { globalThis.__pressed = ctx.text; ctx.openPanel("bead"); },
    });
    return function() {};
  } };
})`;

function install(): InstalledPlugin {
  const evaluated = runPluginClientBundle("gascity", BUNDLE, {} as PluginClientRuntime);
  return { ...evaluated, serverId: "local" } as InstalledPlugin;
}

function inScope(children: React.ReactNode) {
  return (
    <InlineDecorationScopeProvider serverId="local" workspaceId="ws" agentId="agent-1">
      {children}
    </InlineDecorationScopeProvider>
  );
}

describe("inline decorators in assistant messages", () => {
  beforeEach(() => {
    installed.splice(0, installed.length, install());
    openAgentPanel.mockClear();
    Reflect.deleteProperty(globalThis, "__pressed");
  });

  it("routes a press on a bead id to the plugin, which opens its panel", () => {
    let press: ((url: string) => boolean) | undefined;
    function Probe() {
      press = useInlineDecorators().press;
      return null;
    }
    renderToStaticMarkup(inScope(<Probe />));
    expect(press?.("src/app.ts")).toBe(false);
    expect(press?.("pa-k1q")).toBe(true);
    expect(Reflect.get(globalThis, "__pressed")).toBe("pa-k1q");
    expect(openAgentPanel).toHaveBeenCalledWith("gascity", "bead", "agent-1", "workspace");
  });

  it("swallows presses on matches the plugin resolves to plain text", () => {
    let press: ((url: string) => boolean) | undefined;
    function Probe() {
      press = useInlineDecorators().press;
      return null;
    }
    renderToStaticMarkup(inScope(<Probe />));
    expect(press?.("do-it")).toBe(true);
    expect(Reflect.get(globalThis, "__pressed")).toBeUndefined();
  });

  it("does not decorate outside an assistant message scope", () => {
    let count = -1;
    function Probe() {
      count = useInlineDecorators().entries.length;
      return null;
    }
    renderToStaticMarkup(<Probe />);
    expect(count).toBe(0);
  });

  it("resolves the decoration state for a recognized link", () => {
    const states: string[] = [];
    function Link({ url }: { url: string }) {
      const state = useInlineDecoration(url);
      states.push(state.kind === "decorated" ? `chip:${state.decoration?.tooltip}` : state.kind);
      return null;
    }
    function Message() {
      const { serverId, entries } = useInlineDecorators();
      return (
        <InlineDecoratorEntriesProvider serverId={serverId} entries={entries}>
          <Link url="pa-k1q" />
          <Link url="do-it" />
          <Link url="pa-zz9" />
          <Link url="src/app.ts" />
        </InlineDecoratorEntriesProvider>
      );
    }
    renderToStaticMarkup(inScope(<Message />));
    expect(states).toEqual(["chip:Inline decorators", "text", "chip:undefined", "none"]);
  });
});
