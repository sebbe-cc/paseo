/** @vitest-environment jsdom */
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, test, vi } from "vitest";
import { LiveSettings } from "../../../../plugin-examples/codex-live/client/settings";
import {
  previewText,
  previewUnavailableMessage,
} from "../../../../plugin-examples/codex-live/shared/preview";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";

const host = vi.hoisted(() => ({
  preview: vi.fn(),
  save: vi.fn(),
  settings: {
    status: "ready",
    values: { voice: "maple" },
    revision: "saved",
    saving: false,
  },
}));
vi.mock("@getpaseo/plugin/client", () => ({
  useSettings: () => ({ ...host.settings, save: host.save }),
  usePaseo: () => ({}),
  useRpc: () => host.preview,
}));
// Host chrome is supplied by the app; keep the plugin, React and mutation lifecycle real.
vi.mock("@getpaseo/plugin/client/ui", () => ({
  SettingsSection: ({ children }: React.PropsWithChildren) => <section>{children}</section>,
  SettingsCard: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  SettingsSelect: ({ value, disabled }: { value: string; disabled: boolean }) => (
    <select aria-label="Voice" disabled={disabled} defaultValue={value}>
      <option value="maple">Maple</option>
    </select>
  ),
  SettingsAction: ({
    actionLabel,
    hint,
    disabled,
    onPress,
  }: {
    actionLabel: string;
    hint?: string;
    disabled: boolean;
    onPress(): void;
  }) => (
    <div>
      <span>{hint}</span>
      <button type="button" disabled={disabled} onClick={onPress}>
        {actionLabel}
      </button>
    </div>
  ),
}));

const surfaces: Array<() => void> = [];
afterEach(() => {
  for (const dispose of surfaces.splice(0)) dispose();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

async function mount(playAudio: (source: { base64: string; mimeType: string }) => Promise<void>) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
  const props: PluginSurfaceProps = {
    theme: {
      colors: {
        surface0: "#000",
        surface1: "#111",
        surface2: "#222",
        border: "#333",
        foreground: "#fff",
        foregroundMuted: "#aaa",
        accent: "#08f",
        accentForeground: "#fff",
        statusSuccess: "#0f0",
        statusWarning: "#ff0",
        statusDanger: "#f00",
      },
    },
    host: { id: "test", label: "Test" },
    layout: { compact: true, platform: "web" },
  };
  await act(async () =>
    root.render(
      <QueryClientProvider client={queryClient}>
        <LiveSettings {...props} playAudio={playAudio} />
      </QueryClientProvider>,
    ),
  );
  surfaces.push(() => {
    act(() => root.unmount());
    queryClient.clear();
    container.remove();
  });
  function previewButton() {
    const button = Array.from(container.querySelectorAll("button")).find((entry) =>
      entry.textContent?.startsWith("Provlyss"),
    );
    if (!button) throw new Error("Preview button missing");
    return button;
  }
  return { container, previewButton };
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

test("previews the selected voice, prevents overlap, and acknowledges completed playback", async () => {
  const clip = { base64: "recorded-mp3", mimeType: "audio/mpeg" };
  host.preview.mockResolvedValue(clip);
  let finish = () => {};
  const playAudio = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const { container, previewButton } = await mount(playAudio);
  expect(container.textContent).toContain(previewText);
  await act(async () => previewButton().click());
  await settle();
  expect(host.preview).toHaveBeenCalledExactlyOnceWith({ voice: "maple" });
  expect(playAudio).toHaveBeenCalledExactlyOnceWith(clip);
  expect(previewButton().disabled).toBe(true);
  expect(previewButton().textContent).toBe("Provlyssnar…");
  expect(container.querySelector("select")?.disabled).toBe(true);
  expect(host.save).not.toHaveBeenCalled();
  await act(async () => finish());
  await settle();
  expect(previewButton().disabled).toBe(false);
  expect(container.textContent).toContain("Röstprovet spelades upp.");
});

test.each(["fetch", "playback"])("shows a retryable error after %s failure", async (failure) => {
  const playAudio = vi.fn(async () => {});
  if (failure === "fetch") host.preview.mockRejectedValue(new Error("Host offline"));
  else {
    host.preview.mockResolvedValue({
      base64: "recorded-mp3",
      mimeType: "audio/mpeg",
    });
    playAudio.mockRejectedValue(new Error("Playback blocked"));
  }
  const { container, previewButton } = await mount(playAudio);
  await act(async () => previewButton().click());
  await settle();
  expect(container.textContent).toContain("Kunde inte spela röstprovet. Försök igen.");
  expect(previewButton().disabled).toBe(false);
  expect(container.textContent).not.toContain("Röstprovet spelades upp.");
  host.preview.mockResolvedValue({
    base64: "recorded-mp3",
    mimeType: "audio/mpeg",
  });
  playAudio.mockResolvedValue();
  await act(async () => previewButton().click());
  await settle();
  expect(container.textContent).not.toContain("Kunde inte spela röstprovet");
  expect(container.textContent).toContain("Röstprovet spelades upp.");
});

test("explains unavailable voices without playing a substitute", async () => {
  host.preview.mockResolvedValue({ unavailable: true });
  const playAudio = vi.fn(async () => {});
  const { container, previewButton } = await mount(playAudio);
  await act(async () => previewButton().click());
  await settle();
  expect(container.textContent).toContain(previewUnavailableMessage);
  expect(playAudio).not.toHaveBeenCalled();
  expect(previewButton().disabled).toBe(false);
});
