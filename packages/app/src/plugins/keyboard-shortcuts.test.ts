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
    pluginKeyboardShortcuts.add("host-b", "example", {
      combo: "Ctrl+Tab",
      onPress: otherHost,
    }),
  );
  removers.push(
    pluginKeyboardShortcuts.add("host-a", "example", {
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

test("releases only shortcuts using the released modifier", () => {
  const controlRelease = vi.fn();
  const altRelease = vi.fn();
  removers.push(
    pluginKeyboardShortcuts.add("host-a", "example", {
      combo: "Ctrl+Tab",
      onPress: () => true,
      onRelease: controlRelease,
    }),
    pluginKeyboardShortcuts.add("host-a", "example", {
      combo: "Alt+Tab",
      onPress: () => true,
      onRelease: altRelease,
    }),
  );

  pluginKeyboardShortcuts.release("Control", true);
  expect(controlRelease).toHaveBeenCalledOnce();
  expect(altRelease).not.toHaveBeenCalled();
  pluginKeyboardShortcuts.release(null, true);
  expect(altRelease).toHaveBeenCalledOnce();
});

test("a named plugin shortcut follows the settings override in the app and browser", () => {
  const onPress = vi.fn(() => true);
  const onRelease = vi.fn();
  removers.push(
    pluginKeyboardShortcuts.add("host-a", "recent-navigation", {
      id: "recent-tab",
      label: "Switch recent tab",
      combo: "Ctrl+Tab",
      onPress,
      onRelease,
    }),
  );
  const binding = pluginKeyboardShortcuts.list()[0];
  expect(binding?.bindingId).toBe("plugin:host-a:recent-navigation:recent-tab");
  const overrides = { [binding!.bindingId!]: "Alt+J" };
  const input = {
    code: "KeyJ",
    key: "j",
    altKey: true,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    repeat: false,
  };
  expect(pluginKeyboardShortcuts.dispatch(input, true)).toBe(false);
  expect(pluginKeyboardShortcuts.dispatch(input, true, overrides)).toBe(true);
  expect(pluginKeyboardShortcuts.browserPrefixes(true, overrides)).toContainEqual({
    code: "KeyJ",
    alt: true,
    control: false,
    meta: false,
    shift: false,
  });
  pluginKeyboardShortcuts.release("Control", true, overrides);
  expect(onRelease).not.toHaveBeenCalled();
  pluginKeyboardShortcuts.release("Alt", true, overrides);
  expect(onRelease).toHaveBeenCalledOnce();
  expect(
    pluginKeyboardShortcuts.dispatch(input, true, {
      [binding!.bindingId!]: null,
    }),
  ).toBe(false);
});
