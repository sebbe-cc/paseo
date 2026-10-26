/**
 * @vitest-environment jsdom
 */
import React, { useSyncExternalStore } from "react";
import { act, cleanup, fireEvent, render, waitFor, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("./evaluate", () => ({
  runPluginClientBundle: vi.fn(),
}));
vi.mock("./client-runtime", () => ({
  createPluginClientRuntime: vi.fn(),
}));

import { usePluginInstallations } from "./registry";

it("keeps plugin installation selections stable while the registry is unchanged", () => {
  const { result, rerender } = renderHook(() => usePluginInstallations("missing-plugin"));
  const initialInstallations = result.current;

  rerender();

  expect(result.current).toBe(initialInstallations);
});

import { GlobalVoiceProvider, useSelectVoiceTarget } from "@/contexts/global-voice-context";
import { SidebarGlobalVoice } from "@/components/sidebar/sidebar-global-voice";
import {
  KeyboardActionDispatcherProvider,
  useKeyboardActionDispatcher,
} from "@/keyboard/keyboard-action-dispatcher-context";
import { createVoiceRuntime, type VoiceRuntime } from "@/voice/voice-runtime";
import { useVoiceTargetStore } from "@/voice/voice-target-store";
import type { AudioEngine } from "@/audio";
import { en } from "@/i18n/resources/en";

const host = vi.hoisted(() => ({ runtime: null as VoiceRuntime | null, error: vi.fn() }));
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} },
}));
vi.mock("@/contexts/voice-context", () => ({
  useVoiceRuntimeOptional: () => host.runtime,
  useVoice: () => {
    const snapshot = useSyncExternalStore(host.runtime!.subscribe, host.runtime!.getSnapshot);
    return {
      ...snapshot,
      startVoice: host.runtime!.startVoice,
      stopVoice: host.runtime!.stopVoice,
    };
  },
}));
vi.mock("@/contexts/toast-context", () => ({ useToast: () => ({ error: host.error }) }));
vi.mock("@/hooks/use-shortcut-keys", () => ({ useShortcutKeys: () => [["Cmd", "Shift", "V"]] }));
vi.mock("react-i18next", () => ({
  initReactI18next: { type: "3rdParty", init: () => {} },
  useTranslation: () => ({
    t(key: string, values?: { name?: string }) {
      const messages: Record<string, string> = Object.fromEntries(
        Object.entries(en.globalVoice).map(([name, value]) => [`globalVoice.${name}`, value]),
      );
      return (messages[key] ?? key).replace("{{name}}", values?.name ?? "");
    },
  }),
}));
vi.mock("@/stores/session-store", () => ({
  useSessionStore: (select: (state: unknown) => unknown) => select({ sessions: {} }),
}));
beforeEach(() => vi.stubGlobal("React", React));
afterEach(async () => {
  cleanup();
  await host.runtime?.destroy();
  host.runtime = null;
  host.error.mockClear();
  useVoiceTargetStore.setState({ target: null });
  vi.unstubAllGlobals();
});
function setupGlobalVoice() {
  const engine: AudioEngine = {
    initialize: vi.fn(async () => {}),
    destroy: vi.fn(async () => {}),
    startCapture: vi.fn(async () => {}),
    stopCapture: vi.fn(async () => {}),
    toggleMute: vi.fn(() => true),
    isMuted: () => false,
    play: vi.fn(async () => 0),
    stop: vi.fn(),
    clearQueue: vi.fn(),
    isPlaying: () => false,
  };
  host.runtime = createVoiceRuntime({
    engine,
    getServerInfo: () => ({
      serverId: "host",
      hostname: "host",
      version: "0.12.0",
      capabilities: {
        voice: { voice: { enabled: true, reason: "" }, dictation: { enabled: true, reason: "" } },
      },
    }),
    activateKeepAwake: async () => {},
    deactivateKeepAwake: async () => {},
  });
  const setVoiceMode = vi.fn(async () => {});
  const abortRequest = vi.fn(async () => {});
  host.runtime.registerSession({
    serverId: "host",
    setVoiceMode,
    sendVoiceAudioChunk: async () => {},
    audioPlayed: async () => {},
    abortRequest,
    setAssistantAudioPlaying: () => {},
  });
  return { runtime: host.runtime, setVoiceMode, abortRequest, engine };
}
it("selects an agent without opening the mic, toggles by shortcut, and switches live through the same menu action", async () => {
  const { runtime, setVoiceMode, abortRequest, engine } = setupGlobalVoice();
  let dispatch: ReturnType<typeof useKeyboardActionDispatcher>["dispatch"];
  let choose: NonNullable<ReturnType<typeof useSelectVoiceTarget>>;
  function Probe() {
    dispatch = useKeyboardActionDispatcher().dispatch;
    choose = useSelectVoiceTarget()!;
    return null;
  }
  const screen = render(
    <KeyboardActionDispatcherProvider>
      <GlobalVoiceProvider>
        <Probe />
        <SidebarGlobalVoice />
      </GlobalVoiceProvider>
    </KeyboardActionDispatcherProvider>,
  );
  expect(screen.getByText("Choose a voice target from an agent tab")).toBeTruthy();
  await act(() => choose({ serverId: "host", agentId: "king", title: "King" }));
  expect(screen.getByText("Voice off · King")).toBeTruthy();
  expect(engine.startCapture).not.toHaveBeenCalled();
  act(() => {
    expect(dispatch!({ id: "voice.global.toggle", scope: "global" })).toBe(true);
  });
  await waitFor(() => expect(screen.getByText("Talking to King")).toBeTruthy());
  expect(screen.getByTestId("global-voice-active-indicator")).toBeTruthy();
  await act(() => choose({ serverId: "host", agentId: "working-agent", title: "Working agent" }));
  expect(screen.getByText("Talking to Working agent")).toBeTruthy();
  expect(setVoiceMode).toHaveBeenCalledWith(true, "working-agent");
  expect(abortRequest).not.toHaveBeenCalled();
  act(() => runtime.toggleMute());
  expect(screen.getByText("Muted · Working agent")).toBeTruthy();
  fireEvent.click(screen.getByTestId("sidebar-global-voice"));
  await waitFor(() => expect(screen.queryByTestId("global-voice-active-indicator")).toBeNull());
  expect(screen.getByText("Voice off · Working agent")).toBeTruthy();
  expect(useVoiceTargetStore.getState().target?.agentId).toBe("working-agent");
  screen.unmount();
});
it("reports startup failure and retains the selected recipient for retry", async () => {
  const { runtime, setVoiceMode } = setupGlobalVoice();
  useVoiceTargetStore.getState().setTarget({ serverId: "host", agentId: "king", title: "King" });
  setVoiceMode.mockRejectedValueOnce(new Error("Host offline"));
  const screen = render(
    <KeyboardActionDispatcherProvider>
      <GlobalVoiceProvider>
        <SidebarGlobalVoice />
      </GlobalVoiceProvider>
    </KeyboardActionDispatcherProvider>,
  );
  fireEvent.click(screen.getByTestId("sidebar-global-voice"));
  await waitFor(() => expect(host.error).toHaveBeenCalledWith("Host offline"));
  expect(runtime.getSnapshot().isVoiceMode).toBe(false);
  expect(screen.getByText("Voice off · King")).toBeTruthy();
  fireEvent.click(screen.getByTestId("sidebar-global-voice"));
  await waitFor(() => expect(screen.getByText("Talking to King")).toBeTruthy());
  screen.unmount();
});
