import type { KeyboardFocusScope } from "../../actions";
import type { KeyboardInputEvent } from "../overlays";
export interface KeyboardSourceInput {
  event: KeyboardInputEvent;
  focusScope: KeyboardFocusScope;
  captureFocusRestore(): void;
}
export interface KeyboardSourceHandlers {
  keyDown(input: KeyboardSourceInput): void;
  keyUp(event: KeyboardInputEvent): void;
  blur(): void;
  commandCenterOpen(): boolean;
  subscribeCommandCenter(listener: () => void): () => void;
}
export function nativeKeyboardInput(
  event: KeyboardInputEvent,
  focusScope: KeyboardFocusScope,
): KeyboardSourceInput {
  return { event, focusScope, captureFocusRestore() {} };
}

import type { ChordState, ParsedShortcutBinding } from "../../keyboard-shortcuts";
import type { BrowserShortcutPrefix } from "./electron-browser";
export interface KeyboardPolicyInput {
  bindings: readonly ParsedShortcutBinding[];
  chordState?: ChordState;
  isMac: boolean;
  usesDesktopBindings: boolean;
  enabled: boolean;
  extraPrefixes?: readonly BrowserShortcutPrefix[];
}
