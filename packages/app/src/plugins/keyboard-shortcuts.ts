import type { PluginKeyboardShortcutContribution } from "@getpaseo/plugin/client";
import { parseShortcutString, type KeyCombo } from "@/keyboard/shortcut-string";
import type { KeyboardShortcutInput } from "@/keyboard/keyboard-shortcuts";
import type { ShortcutOverrides } from "@/keyboard/keyboard-shortcuts";
import type { BrowserShortcutPrefix } from "@/desktop/browser/shortcuts";
import { pluginRecentNavigation } from "./recent-navigation";

interface Registration extends PluginKeyboardShortcutContribution {
  serverId: string;
  pluginId: string;
  bindingId: string | null;
  parsed: KeyCombo;
}

const registrations = new Set<Registration>();
const listeners = new Set<() => void>();
let version = 0;

function notify(): void {
  version += 1;
  for (const listener of listeners) listener();
}

function hasShortcutModifier(combo: KeyCombo): boolean {
  return combo.alt === true || combo.ctrl === true || combo.meta === true || combo.mod === true;
}

function effectiveCombo(registration: Registration, overrides: ShortcutOverrides): KeyCombo | null {
  const override = registration.bindingId ? overrides[registration.bindingId] : undefined;
  if (override === null || override === "") return null;
  if (typeof override === "string") {
    try {
      if (override.includes(" ")) return registration.parsed;
      const parsed = parseShortcutString(override);
      if (hasShortcutModifier(parsed) || registration.allowPlainKey === true) return parsed;
    } catch {
      return registration.parsed;
    }
  }
  return registration.parsed;
}

function matches(input: KeyboardShortcutInput, combo: KeyCombo, isMac: boolean): boolean {
  return (
    input.code === combo.code &&
    input.altKey === (combo.alt === true) &&
    input.ctrlKey === (combo.ctrl === true || (!isMac && combo.mod === true)) &&
    input.metaKey === (combo.meta === true || (isMac && combo.mod === true)) &&
    input.shiftKey === (combo.shift === true)
  );
}

function usesModifier(combo: KeyCombo, key: string, isMac: boolean): boolean {
  if (key === "Alt") return combo.alt === true;
  if (key === "Control") return combo.ctrl === true || (!isMac && combo.mod === true);
  if (key === "Meta") return combo.meta === true || (isMac && combo.mod === true);
  return false;
}

/** A released key ends a plain shortcut when it names the same key. */
function matchesReleaseKey(combo: KeyCombo, key: string): boolean {
  if (key === combo.code) return true;
  return combo.key !== undefined && key.toLowerCase() === combo.key.toLowerCase();
}

function dispatchPhase(
  input: KeyboardShortcutInput,
  isMac: boolean,
  overrides: ShortcutOverrides,
  phase: "capture" | "after-screen",
): boolean {
  const activeServerId = pluginRecentNavigation.getActive()?.serverId;
  const activeRegistrations = [...registrations].filter((item) => item.serverId === activeServerId);
  for (const registration of activeRegistrations.length ? activeRegistrations : registrations) {
    if ((registration.phase ?? "capture") !== phase) continue;
    const combo = effectiveCombo(registration, overrides);
    if (!combo || !matches(input, combo, isMac)) continue;
    try {
      return registration.onPress() !== false;
    } catch (error) {
      console.warn("[Plugins] Keyboard shortcut failed", error);
      return true;
    }
  }
  return false;
}

export const pluginKeyboardShortcuts = {
  add(serverId: string, pluginId: string, contribution: PluginKeyboardShortcutContribution) {
    if (typeof contribution.onPress !== "function")
      throw new Error("Shortcut callback is required");
    if ((contribution.id === undefined) !== (contribution.label === undefined))
      throw new Error("Shortcut id and label must be provided together");
    if (contribution.id !== undefined && !/^[a-z][a-z0-9-]*$/.test(contribution.id))
      throw new Error("Shortcut id must be a stable kebab-case name");
    if (contribution.combo.includes(" ")) throw new Error("Plugin shortcuts must be a single key");
    const parsed = parseShortcutString(contribution.combo);
    if (!hasShortcutModifier(parsed) && contribution.allowPlainKey !== true) {
      throw new Error("Plugin shortcuts require a modifier");
    }
    if (
      contribution.phase !== undefined &&
      contribution.phase !== "capture" &&
      contribution.phase !== "after-screen"
    ) {
      throw new Error('Plugin shortcut phase must be "capture" or "after-screen"');
    }
    const bindingId = contribution.id ? `plugin:${serverId}:${pluginId}:${contribution.id}` : null;
    if (bindingId && [...registrations].some((item) => item.bindingId === bindingId))
      throw new Error(`Duplicate plugin shortcut: ${bindingId}`);
    const registration = {
      ...contribution,
      serverId,
      pluginId,
      bindingId,
      parsed,
    };
    registrations.add(registration);
    notify();
    return () => {
      registrations.delete(registration);
      notify();
    };
  },
  getVersion: () => version,
  list: () => [...registrations].filter((registration) => registration.bindingId !== null),
  displayCombo(registration: Registration, overrides: ShortcutOverrides): string | null {
    const parsed = effectiveCombo(registration, overrides);
    if (!parsed) return null;
    return parsed === registration.parsed
      ? registration.combo
      : (overrides[registration.bindingId!] as string);
  },
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  dispatch(
    input: KeyboardShortcutInput,
    isMac: boolean,
    overrides: ShortcutOverrides = {},
  ): boolean {
    return dispatchPhase(input, isMac, overrides, "capture");
  },
  /**
   * Runs the "after-screen" registrations: keys the focused screen saw first.
   * Callers skip this pass when the key was already handled (defaultPrevented).
   */
  dispatchAfterScreen(
    input: KeyboardShortcutInput,
    isMac: boolean,
    overrides: ShortcutOverrides = {},
  ): boolean {
    return dispatchPhase(input, isMac, overrides, "after-screen");
  },
  release(key: string | null, isMac: boolean, overrides: ShortcutOverrides = {}): void {
    for (const registration of registrations) {
      const combo = effectiveCombo(registration, overrides);
      if (key === null) {
        // Blur or hide: every held shortcut is released.
      } else if (!combo) {
        continue;
      } else if (hasShortcutModifier(combo)) {
        if (!usesModifier(combo, key, isMac)) continue;
      } else if (!matchesReleaseKey(combo, key)) {
        continue;
      }
      try {
        registration.onRelease?.();
      } catch (error) {
        console.warn("[Plugins] Keyboard shortcut release failed", error);
      }
    }
  },
  browserPrefixes(isMac: boolean, overrides: ShortcutOverrides = {}): BrowserShortcutPrefix[] {
    return [...registrations].flatMap((registration) => {
      // After-screen shortcuts belong to the app's screens; browser tabs have
      // no screen to run first, so they keep their own keys.
      if (registration.phase === "after-screen") return [];
      const parsed = effectiveCombo(registration, overrides);
      if (!parsed) return [];
      return [
        {
          alt: parsed.alt === true,
          code: parsed.code,
          control: parsed.ctrl === true || (!isMac && parsed.mod === true),
          meta: parsed.meta === true || (isMac && parsed.mod === true),
          shift: parsed.shift === true,
        },
      ];
    });
  },
};
