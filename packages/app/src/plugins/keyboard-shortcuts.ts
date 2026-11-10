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

function effectiveCombo(registration: Registration, overrides: ShortcutOverrides): KeyCombo | null {
  const override = registration.bindingId ? overrides[registration.bindingId] : undefined;
  if (override === null || override === "") return null;
  if (typeof override === "string") {
    try {
      if (override.includes(" ")) return registration.parsed;
      const parsed = parseShortcutString(override);
      if (parsed.alt || parsed.ctrl || parsed.meta || parsed.mod) return parsed;
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
    if (!parsed.alt && !parsed.ctrl && !parsed.meta && !parsed.mod) {
      throw new Error("Plugin shortcuts require a modifier");
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
    const activeServerId = pluginRecentNavigation.getActive()?.serverId;
    const activeRegistrations = [...registrations].filter(
      (item) => item.serverId === activeServerId,
    );
    for (const registration of activeRegistrations.length ? activeRegistrations : registrations) {
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
  },
  release(key: string | null, isMac: boolean, overrides: ShortcutOverrides = {}): void {
    for (const registration of registrations) {
      const combo = effectiveCombo(registration, overrides);
      if (key !== null && (!combo || !usesModifier(combo, key, isMac))) continue;
      try {
        registration.onRelease?.();
      } catch (error) {
        console.warn("[Plugins] Keyboard shortcut release failed", error);
      }
    }
  },
  browserPrefixes(isMac: boolean, overrides: ShortcutOverrides = {}): BrowserShortcutPrefix[] {
    return [...registrations].flatMap((registration) => {
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
