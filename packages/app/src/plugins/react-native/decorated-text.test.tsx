/** @vitest-environment jsdom */
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createInlineDecorator } from "../inline-decorators/model";
import type { InstalledPlugin } from "../types";

const installed = vi.hoisted(() => [] as InstalledPlugin[]);
const pressed = vi.hoisted(() => vi.fn());
vi.mock("../registry", () => ({ useInstalledPlugins: () => installed }));
vi.mock("../navigation", () => ({ createPluginNavigation: () => ({}) }));
vi.mock("../client-state/source", () => ({
  createPluginClientStateSource: () => ({
    subscribe: () => () => {},
    getWorkspace: (id: string) => ({ id }),
    getAgent: (id: string) => ({ id, workspaceId: "ws" }),
  }),
}));
vi.mock("../icons", () => ({ Icon: () => null }));
import { InlineDecorationScopeProvider } from "../inline-decorators";
import { DecoratedText } from "./decorated-text";

const roots: ReturnType<typeof createRoot>[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  installed.length = 0;
  pressed.mockClear();
});

function mount(scoped = true, inlineCode = false) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const outer = vi.fn();
  let known = false;
  const decorator = createInlineDecorator(
    {
      id: "bead",
      pattern: /pa-[a-z0-9]+/g,
      inlineCode: false,
      resolve: ({ text }) =>
        text === "pa-unknown" || !known
          ? null
          : {
              label: `${text} · klar`,
              tone: "success",
              tooltip: "A bead title",
            },
      onPress: pressed,
    },
    "bead",
  );
  installed.push({
    id: "gascity",
    serverId: "local",
    inlineDecorators: [decorator],
  } as InstalledPlugin);
  const container = document.createElement("div");
  const root = createRoot(container);
  roots.push(root);
  const text = (
    <DecoratedText inlineCode={inlineCode}>{"**pa-123** <literal> pa-unknown"}</DecoratedText>
  );
  act(() =>
    root.render(
      <div onClick={outer}>
        {scoped ? (
          <InlineDecorationScopeProvider serverId="local" workspaceId="ws" agentId="agent-1">
            {text}
          </InlineDecorationScopeProvider>
        ) : (
          text
        )}
      </div>,
    ),
  );
  return {
    container,
    outer,
    resolve() {
      act(() => {
        known = true;
        decorator.invalidate(["pa-123"]);
      });
    },
  };
}

describe("DecoratedText", () => {
  it("keeps pending/unknown IDs literal, resolves invalidations, and routes clicks and keyboard with original context", () => {
    const h = mount();
    expect(h.container.querySelector('[role="button"]')).toBeNull();
    h.resolve();
    const chip = h.container.querySelector('[role="button"]') as HTMLElement;
    expect(chip.textContent).toBe("pa-123 · klar");
    expect(chip.title).toBe("A bead title");
    expect(h.container.textContent).toBe("**pa-123 · klar** <literal> pa-unknown");
    act(() => chip.click());
    expect(pressed).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "pa-123",
        agent: expect.objectContaining({ id: "agent-1" }),
        workspace: expect.objectContaining({ id: "ws" }),
      }),
    );
    expect(h.outer).not.toHaveBeenCalled();
    act(() => chip.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(pressed).toHaveBeenCalledTimes(2);
  });
  it("renders ordinary text outside timeline scope", () => {
    const h = mount(false);
    h.resolve();
    expect(h.container.querySelector('[role="button"]')).toBeNull();
    expect(h.container.textContent).toContain("**pa-123** <literal>");
  });
  it("honors inline-code opt-outs", () => {
    const h = mount(true, true);
    h.resolve();
    expect(h.container.querySelector('[role="button"]')).toBeNull();
  });
  it("never consults another host's decorators", () => {
    const h = mount();
    installed[0].serverId = "other";
    // Re-mount a fresh host scope with the mismatched registry.
    const container = document.createElement("div");
    const root = createRoot(container);
    roots.push(root);
    act(() =>
      root.render(
        <InlineDecorationScopeProvider serverId="local" workspaceId="ws" agentId="agent-1">
          <DecoratedText>{"pa-123"}</DecoratedText>
        </InlineDecorationScopeProvider>,
      ),
    );
    h.resolve();
    expect(container.querySelector('[role="button"]')).toBeNull();
  });
});
