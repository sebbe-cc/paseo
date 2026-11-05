import { describe, expect, it, vi } from "vitest";
import {
  ClientActionsPartUnavailableError,
  createAppClientActionsCapability,
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
