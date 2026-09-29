import type { PluginKeyboardShortcutContribution } from "@getpaseo/plugin/client";
import { parseShortcutString, type KeyCombo } from "@/keyboard/shortcut-string";
import type { KeyboardShortcutInput } from "@/keyboard/keyboard-shortcuts";
import type { BrowserShortcutPrefix } from "@/desktop/browser/shortcuts";
import { pluginRecentNavigation } from "./recent-navigation";

interface Registration extends PluginKeyboardShortcutContribution {
  serverId: string;
  parsed: KeyCombo;
}

const registrations = new Set<Registration>();
const listeners = new Set<() => void>();

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

export const pluginKeyboardShortcuts = {
  add(serverId: string, contribution: PluginKeyboardShortcutContribution) {
    if (typeof contribution.onPress !== "function")
      throw new Error("Shortcut callback is required");
    if (contribution.combo.includes(" ")) throw new Error("Plugin shortcuts must be a single key");
    const parsed = parseShortcutString(contribution.combo);
    if (!parsed.alt && !parsed.ctrl && !parsed.meta && !parsed.mod) {
      throw new Error("Plugin shortcuts require a modifier");
    }
    const registration = { ...contribution, serverId, parsed };
    registrations.add(registration);
    for (const listener of listeners) listener();
    return () => {
      registrations.delete(registration);
      for (const listener of listeners) listener();
    };
  },
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  dispatch(input: KeyboardShortcutInput, isMac: boolean): boolean {
    const activeServerId = pluginRecentNavigation.getActive()?.serverId;
    const activeRegistrations = [...registrations].filter(
      (item) => item.serverId === activeServerId,
    );
    for (const registration of activeRegistrations.length ? activeRegistrations : registrations) {
      if (!matches(input, registration.parsed, isMac)) continue;
      try {
        return registration.onPress() !== false;
      } catch (error) {
        console.warn("[Plugins] Keyboard shortcut failed", error);
        return true;
      }
    }
    return false;
  },
  release(key: string | null, isMac: boolean): void {
    for (const registration of registrations) {
      if (key !== null && !usesModifier(registration.parsed, key, isMac)) continue;
      try {
        registration.onRelease?.();
      } catch (error) {
        console.warn("[Plugins] Keyboard shortcut release failed", error);
      }
    }
  },
  browserPrefixes(isMac: boolean): BrowserShortcutPrefix[] {
    return [...registrations].map(({ parsed }) => ({
      alt: parsed.alt === true,
      code: parsed.code,
      control: parsed.ctrl === true || (!isMac && parsed.mod === true),
      meta: parsed.meta === true || (isMac && parsed.mod === true),
      shift: parsed.shift === true,
    }));
  },
};
