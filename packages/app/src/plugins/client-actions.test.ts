import { describe, expect, it, vi } from "vitest";
import {
  ClientActionsPartUnavailableError,
  createAppClientActionsCapability,
  createDomPanelResolver,
  createWebPanelNavigator,
  type ClientActionsVoicePipeline,
  type FocusedPanelResolver,
  type PanelNavigator,
} from "./client-actions";

const target = { serverId: "server-1", agentId: "agent-1" };

function setupVoice() {
  const events: string[] = [];
  let connectionLoss: (() => void) | null = null;
  let blur: (() => void) | null = null;
  const pipeline: ClientActionsVoicePipeline = {
    start: vi.fn(async () => {
      events.push("start");
    }),
    stop: vi.fn(async () => {
      events.push("stop");
    }),
    subscribeConnectionLoss: vi.fn((handler: () => void) => {
      connectionLoss = handler;
      return () => {
        connectionLoss = null;
      };
    }),
    subscribeWindowBlur: vi.fn((handler: () => void) => {
      blur = handler;
      return () => {
        blur = null;
      };
    }),
  };
  return {
    pipeline,
    events,
    fireConnectionLoss: () => connectionLoss?.(),
    fireBlur: () => blur?.(),
  };
}

function setupPanels() {
  const scrolled: number[] = [];
  const panels: FocusedPanelResolver = {
    resolveFocusedScrollablePanel: () => ({
      viewportHeight: 800,
      scrollBy: (dy) => scrolled.push(dy),
    }),
  };
  const navigated: string[] = [];
  const navigator: PanelNavigator = {
    openHistory: () => navigated.push("history"),
    openSidebar: () => navigated.push("sidebar"),
    goForward: () => navigated.push("forward"),
    goBack: () => navigated.push("back"),
  };
  return { panels, navigator, scrolled, navigated };
}

describe("app clientActions capability", () => {
  it("probes voiceInput and panelScroll independently", () => {
    const { pipeline } = setupVoice();
    const { panels, navigator } = setupPanels();
    expect(
      createAppClientActionsCapability({ voice: pipeline, panels, navigator }).getCapabilities(),
    ).toEqual({ voiceInput: true, panelScroll: true });
    expect(
      createAppClientActionsCapability({ voice: null, panels, navigator }).getCapabilities(),
    ).toEqual({ voiceInput: false, panelScroll: true });
    expect(
      createAppClientActionsCapability({ voice: pipeline, panels: null }).getCapabilities(),
    ).toEqual({ voiceInput: true, panelScroll: false });
    expect(createAppClientActionsCapability({}).getCapabilities()).toEqual({
      voiceInput: false,
      panelScroll: false,
    });
  });

  it("runs the voice start/stop sequence against the target", async () => {
    const { pipeline } = setupVoice();
    const { panels, navigator } = setupPanels();
    const capability = createAppClientActionsCapability({ voice: pipeline, panels, navigator });
    await capability.startVoiceInput(target);
    await capability.stopVoiceInput();
    expect(pipeline.start).toHaveBeenCalledWith(target);
    expect(pipeline.stop).toHaveBeenCalledTimes(1);
  });

  it("rejects voice start with an unsupported error when the pipeline is missing", async () => {
    const { panels, navigator } = setupPanels();
    const capability = createAppClientActionsCapability({ voice: null, panels, navigator });
    await expect(capability.startVoiceInput(target)).rejects.toBeInstanceOf(
      ClientActionsPartUnavailableError,
    );
    await expect(capability.startVoiceInput(target)).rejects.toMatchObject({
      part: "voiceInput",
    });
  });

  it("stops the previous session when start is pressed twice so the mic is never leaked", async () => {
    const { pipeline, events } = setupVoice();
    const { panels, navigator } = setupPanels();
    const capability = createAppClientActionsCapability({ voice: pipeline, panels, navigator });
    await capability.startVoiceInput(target);
    await capability.startVoiceInput(target);
    await capability.stopVoiceInput();
    expect(events).toEqual(["start", "stop", "start", "stop"]);
    expect(pipeline.stop).toHaveBeenCalledTimes(2);
  });

  it("resolves stop on idle without touching the pipeline", async () => {
    const { pipeline } = setupVoice();
    const { panels, navigator } = setupPanels();
    const capability = createAppClientActionsCapability({ voice: pipeline, panels, navigator });
    await expect(capability.stopVoiceInput()).resolves.toBeUndefined();
    expect(pipeline.stop).not.toHaveBeenCalled();
  });

  it("stops the mic on disconnect as the app-side last guarantor", async () => {
    const { pipeline, fireConnectionLoss } = setupVoice();
    const { panels, navigator } = setupPanels();
    const capability = createAppClientActionsCapability({ voice: pipeline, panels, navigator });
    await capability.startVoiceInput(target);
    fireConnectionLoss();
    await vi.waitFor(() => expect(pipeline.stop).toHaveBeenCalledTimes(1));
  });

  it("stops the mic on window blur", async () => {
    const { pipeline, fireBlur } = setupVoice();
    const { panels, navigator } = setupPanels();
    const capability = createAppClientActionsCapability({ voice: pipeline, panels, navigator });
    await capability.startVoiceInput(target);
    fireBlur();
    await vi.waitFor(() => expect(pipeline.stop).toHaveBeenCalledTimes(1));
  });

  it("scrolls the focused panel without requiring a mounted plugin panel", () => {
    const { panels, navigator, scrolled } = setupPanels();
    const capability = createAppClientActionsCapability({ voice: null, panels, navigator });
    capability.scrollFocusedPanel("down", "page");
    capability.scrollFocusedPanel("up", "step");
    expect(scrolled).toEqual([800, -120]);
  });

  it("is a no-op when no panel is scrollable", () => {
    const { navigator } = setupPanels();
    const capability = createAppClientActionsCapability({
      voice: null,
      panels: { resolveFocusedScrollablePanel: () => null },
      navigator,
    });
    expect(() => capability.scrollFocusedPanel("down", "page")).not.toThrow();
  });

  it("throws an unsupported error for scroll when the panel surface is missing", () => {
    const { navigator } = setupPanels();
    const capability = createAppClientActionsCapability({ voice: null, panels: null, navigator });
    expect(() => capability.scrollFocusedPanel("down", "page")).toThrow(
      ClientActionsPartUnavailableError,
    );
  });

  it("routes joystick targets through the panelScroll gate", () => {
    const { panels, navigator, navigated } = setupPanels();
    const capability = createAppClientActionsCapability({ voice: null, panels, navigator });
    capability.navigatePanel("history");
    capability.navigatePanel("sidebar");
    capability.navigatePanel("forward");
    capability.navigatePanel("back");
    expect(navigated).toEqual(["history", "sidebar", "forward", "back"]);
  });

  it("throws an unsupported error for navigation when the navigator is missing", () => {
    const { panels } = setupPanels();
    const capability = createAppClientActionsCapability({ voice: null, panels, navigator: null });
    expect(() => capability.navigatePanel("back")).toThrow(ClientActionsPartUnavailableError);
  });

  it("rejects empty route targets instead of starting the mic", async () => {
    const { pipeline } = setupVoice();
    const { panels, navigator } = setupPanels();
    const capability = createAppClientActionsCapability({ voice: pipeline, panels, navigator });
    await expect(
      capability.startVoiceInput({ serverId: "  ", agentId: "agent-1" }),
    ).rejects.toThrow(/serverId/);
    expect(pipeline.start).not.toHaveBeenCalled();
  });
});

interface FakeDomNode {
  scrollBy(options: { top: number }): void;
  parentElement: FakeDomNode | null;
  clientHeight: number;
  scrollHeight: number;
  overflowY: string;
  scrolled: number[];
}

function makeDomNode(
  overrides: {
    clientHeight?: number;
    scrollHeight?: number;
    overflowY?: string;
    parent?: FakeDomNode | null;
  } = {},
): FakeDomNode {
  const node: FakeDomNode = {
    scrolled: [],
    scrollBy(options: { top: number }) {
      node.scrolled.push(options.top);
    },
    parentElement: overrides.parent ?? null,
    clientHeight: overrides.clientHeight ?? 0,
    scrollHeight: overrides.scrollHeight ?? 0,
    overflowY: overrides.overflowY ?? "visible",
  };
  return node;
}

function makeDomHost(activeElement: FakeDomNode | null, withStyle: boolean) {
  return {
    activeElement,
    ...(withStyle
      ? {
          getComputedStyle: (element: FakeDomNode) => ({ overflowY: element.overflowY }),
        }
      : {}),
  };
}

describe("code-3: production panel resolver", () => {
  it("resolves the scrollable viewport, not the focused input inside it", () => {
    // code-3: a focused single-line composer exposes scrollBy but does not
    // overflow; scrolling must move the timeline viewport behind it.
    const viewport = makeDomNode({ clientHeight: 800, scrollHeight: 2000, overflowY: "auto" });
    const input = makeDomNode({ clientHeight: 24, scrollHeight: 24, parent: viewport });
    const resolver = createDomPanelResolver(makeDomHost(input, true));
    const panel = resolver?.resolveFocusedScrollablePanel();
    expect(panel?.viewportHeight).toBe(800);
    panel?.scrollBy(800);
    expect(viewport.scrolled).toEqual([800]);
    expect(input.scrolled).toEqual([]);
  });

  it("resolves a focused multiline composer itself when it overflows", () => {
    const viewport = makeDomNode({ clientHeight: 800, scrollHeight: 2000, overflowY: "auto" });
    const composer = makeDomNode({
      clientHeight: 120,
      scrollHeight: 300,
      overflowY: "auto",
      parent: viewport,
    });
    const resolver = createDomPanelResolver(makeDomHost(composer, true));
    const panel = resolver?.resolveFocusedScrollablePanel();
    expect(panel?.viewportHeight).toBe(120);
    panel?.scrollBy(120);
    expect(composer.scrolled).toEqual([120]);
    expect(viewport.scrolled).toEqual([]);
  });

  it("skips overflow-hidden content and resolves nothing without a viewport", () => {
    const clipped = makeDomNode({ clientHeight: 800, scrollHeight: 2000, overflowY: "hidden" });
    const button = makeDomNode({ clientHeight: 32, scrollHeight: 32, parent: clipped });
    const resolver = createDomPanelResolver(makeDomHost(button, true));
    expect(resolver?.resolveFocusedScrollablePanel()).toBeNull();
  });

  it("resolves by dimensions alone where no style info exists", () => {
    const viewport = makeDomNode({ clientHeight: 800, scrollHeight: 2000 });
    const input = makeDomNode({ clientHeight: 24, scrollHeight: 24, parent: viewport });
    const panel = createDomPanelResolver(
      makeDomHost(input, false),
    )?.resolveFocusedScrollablePanel();
    expect(panel?.viewportHeight).toBe(800);
  });

  it("returns null without a focused element or document", () => {
    expect(
      createDomPanelResolver(makeDomHost(null, true))?.resolveFocusedScrollablePanel(),
    ).toBeNull();
  });
});

describe("code-4/S2: production panel navigator", () => {
  it("drives back/forward through the real session history", () => {
    const calls: string[] = [];
    const navigator = createWebPanelNavigator({
      history: {
        back: () => calls.push("back"),
        forward: () => calls.push("forward"),
      },
    });
    expect(navigator).not.toBeNull();
    navigator?.goBack();
    navigator?.goForward();
    expect(calls).toEqual(["back", "forward"]);
  });

  it("reports history/sidebar unsupported instead of silently succeeding", () => {
    const navigator = createWebPanelNavigator({
      history: {
        back: () => {},
        forward: () => {},
      },
    });
    expect(() => navigator?.openHistory()).toThrow(ClientActionsPartUnavailableError);
    expect(() => navigator?.openHistory()).toThrow(/not wired/);
    expect(() => navigator?.openSidebar()).toThrow(ClientActionsPartUnavailableError);
    expect(() => navigator?.openSidebar()).toThrow(/not wired/);
  });

  it("returns null without usable history", () => {
    expect(createWebPanelNavigator({})).toBeNull();
    expect(createWebPanelNavigator({ history: undefined })).toBeNull();
  });
});
