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

const escapeInput = {
  code: "Escape",
  key: "Escape",
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  repeat: false,
};

test("rejects plain keys unless the contribution allows them", () => {
  expect(() =>
    pluginKeyboardShortcuts.add("host-a", "example", {
      combo: "Escape",
      onPress: () => true,
    }),
  ).toThrow("Plugin shortcuts require a modifier");
  removers.push(
    pluginKeyboardShortcuts.add("host-a", "example", {
      combo: "Escape",
      allowPlainKey: true,
      onPress: () => true,
    }),
  );
  expect(() =>
    pluginKeyboardShortcuts.add("host-a", "example", {
      combo: "Alt+Q",
      phase: "sideways" as unknown as "capture",
      onPress: () => true,
    }),
  ).toThrow('Plugin shortcut phase must be "capture" or "after-screen"');
});

test("dispatches after-screen shortcuts only in the after-screen pass", () => {
  const afterScreen = vi.fn(() => true);
  const capture = vi.fn(() => true);
  removers.push(
    pluginKeyboardShortcuts.add("host-a", "example", {
      combo: "Escape",
      allowPlainKey: true,
      phase: "after-screen",
      onPress: afterScreen,
    }),
    pluginKeyboardShortcuts.add("host-a", "example", {
      combo: "Escape",
      allowPlainKey: true,
      onPress: capture,
    }),
  );

  expect(pluginKeyboardShortcuts.dispatch(escapeInput, true)).toBe(true);
  expect(capture).toHaveBeenCalledOnce();
  expect(afterScreen).not.toHaveBeenCalled();
  expect(pluginKeyboardShortcuts.dispatchAfterScreen(escapeInput, true)).toBe(true);
  expect(afterScreen).toHaveBeenCalledOnce();
});

test("accepts a plain settings override only when the contribution allows it", () => {
  const allowed = vi.fn(() => true);
  removers.push(
    pluginKeyboardShortcuts.add("host-a", "plain", {
      id: "plain-key",
      label: "Plain key",
      combo: "Alt+X",
      allowPlainKey: true,
      onPress: allowed,
    }),
    pluginKeyboardShortcuts.add("host-a", "modified", {
      id: "plain-key",
      label: "Plain key",
      combo: "Alt+X",
      onPress: () => true,
    }),
  );
  const allowedBinding = pluginKeyboardShortcuts
    .list()
    .find((binding) => binding.bindingId === "plugin:host-a:plain:plain-key")!;
  const deniedBinding = pluginKeyboardShortcuts
    .list()
    .find((binding) => binding.bindingId === "plugin:host-a:modified:plain-key")!;
  const plainY = {
    code: "KeyY",
    key: "y",
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    repeat: false,
  };
  const overrides = {
    [allowedBinding.bindingId!]: "Y",
    [deniedBinding.bindingId!]: "Y",
  };
  expect(pluginKeyboardShortcuts.dispatch(plainY, true, overrides)).toBe(true);
  expect(allowed).toHaveBeenCalledOnce();
  expect(pluginKeyboardShortcuts.dispatch(plainY, true, { [deniedBinding.bindingId!]: "Y" })).toBe(
    false,
  );
});

test("releases a plain shortcut on its own key", () => {
  const release = vi.fn();
  const other = vi.fn();
  removers.push(
    pluginKeyboardShortcuts.add("host-a", "example", {
      combo: "Escape",
      allowPlainKey: true,
      onPress: () => true,
      onRelease: release,
    }),
    pluginKeyboardShortcuts.add("host-a", "example", {
      combo: "Alt+Tab",
      onPress: () => true,
      onRelease: other,
    }),
  );
  pluginKeyboardShortcuts.release("Alt", true);
  expect(release).not.toHaveBeenCalled();
  expect(other).toHaveBeenCalledOnce();
  pluginKeyboardShortcuts.release("Escape", true);
  expect(release).toHaveBeenCalledOnce();
});

test("keeps after-screen shortcuts out of browser tab prefixes", () => {
  removers.push(
    pluginKeyboardShortcuts.add("host-a", "example", {
      combo: "Escape",
      allowPlainKey: true,
      phase: "after-screen",
      onPress: () => true,
    }),
  );
  expect(pluginKeyboardShortcuts.browserPrefixes(true)).toEqual([]);
});
