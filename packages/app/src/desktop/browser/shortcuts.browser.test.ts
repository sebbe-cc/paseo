import { afterEach, expect, it } from "vitest";
import { isReplayedPluginInput, replayForwardedPluginInput } from "./shortcuts";

let listener: ((event: KeyboardEvent) => void) | null = null;
afterEach(() => {
  if (listener) window.removeEventListener("keydown", listener, true);
  listener = null;
});

it("replays forwarded ⌥P on the app window, marked so app shortcuts skip it", () => {
  const seen: KeyboardEvent[] = [];
  listener = (event) => seen.push(event);
  window.addEventListener("keydown", listener, true);

  replayForwardedPluginInput({
    key: "π",
    code: "KeyP",
    altKey: true,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    repeat: false,
  });

  expect(seen).toHaveLength(1);
  const [event] = seen;
  expect([event.code, event.key, event.altKey, event.metaKey, event.repeat]).toEqual([
    "KeyP",
    "π",
    true,
    false,
    false,
  ]);
  expect(isReplayedPluginInput(event)).toBe(true);
  expect(isReplayedPluginInput(new KeyboardEvent("keydown", { code: "KeyP" }))).toBe(false);
});
