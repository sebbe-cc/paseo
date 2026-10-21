import { afterEach, expect, test, vi } from "vitest";
import { pluginKeyboardShortcuts } from "./keyboard-shortcuts";

vi.mock("./recent-navigation", () => ({
  pluginRecentNavigation: { getActive: () => ({ serverId: "host-a" }) },
}));

const removers: Array<() => void> = [];
afterEach(() => {
  for (const remove of removers.splice(0)) remove();
});

test("forwards modified browser keys to the active host's plugin", () => {
  const otherHost = vi.fn();
  const activeHost = vi.fn();
  removers.push(
    pluginKeyboardShortcuts.add("host-b", {
      combo: "Ctrl+Tab",
      onPress: otherHost,
    }),
  );
  removers.push(
    pluginKeyboardShortcuts.add("host-a", {
      combo: "Ctrl+Tab",
      onPress: activeHost,
    }),
  );

  expect(pluginKeyboardShortcuts.browserPrefixes(true)).toContainEqual({
    code: "Tab",
    alt: false,
    control: true,
    meta: false,
    shift: false,
  });
  expect(
    pluginKeyboardShortcuts.dispatch(
      {
        code: "Tab",
        key: "Tab",
        altKey: false,
        ctrlKey: true,
        metaKey: false,
        shiftKey: false,
        repeat: false,
      },
      true,
    ),
  ).toBe(true);
  expect(activeHost).toHaveBeenCalledOnce();
  expect(otherHost).not.toHaveBeenCalled();
});
