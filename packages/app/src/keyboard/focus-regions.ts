import type { PaneDirection } from "@/utils/split-navigation";

// Native has no DOM focus to move; the workspace falls back to the split layout.
export function registerFocusTarget(_element: unknown, _focus: () => void): () => void {
  return () => {};
}

export function keyboardFocusHeldElsewhere(_element: unknown): boolean {
  return false;
}

export function releaseKeyboardFocus(): void {}

export function moveFocus(_direction: PaneDirection): boolean {
  return false;
}
