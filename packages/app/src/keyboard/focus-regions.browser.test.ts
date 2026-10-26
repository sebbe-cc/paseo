import { afterEach, expect, it, vi } from "vitest";
import {
  keyboardFocusHeldElsewhere,
  moveFocus,
  registerFocusTarget,
  releaseKeyboardFocus,
} from "./focus-regions.web";

function box(
  parent: HTMLElement,
  region: string | null,
  [left, top, width, height]: [number, number, number, number],
  inner = "",
): HTMLElement {
  const element = document.createElement("div");
  if (region) element.setAttribute("data-focus-region", region);
  element.tabIndex = -1;
  element.style.cssText = `position:fixed;left:${left}px;top:${top}px;width:${width}px;height:${height}px`;
  element.innerHTML = inner;
  parent.append(element);
  return element;
}

// Sidebar | pane A | pane B | Explorer. Pane B's composer is short, so plain geometry
// would take ⌥L from A's composer into B's timeline.
function layout() {
  const root = document.body;
  const sidebar = box(
    root,
    "sidebar",
    [0, 0, 200, 600],
    `<div data-nav-row tabindex="-1">w1</div>`,
  );
  const paneA = box(root, "pane", [200, 0, 400, 600]);
  paneA.setAttribute("data-focused-pane", "true");
  const timelineA = box(paneA, "timeline", [200, 0, 400, 300]);
  const composerA = box(paneA, "composer", [200, 300, 400, 300], "<textarea></textarea>");
  const paneB = box(root, "pane", [600, 0, 400, 600]);
  const timelineB = box(paneB, "timeline", [600, 0, 400, 500]);
  const composerB = box(paneB, "composer", [600, 500, 400, 100], "<textarea></textarea>");
  const explorer = box(root, "explorer", [1000, 0, 200, 600]);
  const textarea = (composer: HTMLElement) => composer.querySelector("textarea");
  return { sidebar, timelineA, composerA, timelineB, composerB, explorer, textarea };
}

afterEach(() => {
  releaseKeyboardFocus();
  document.body.replaceChildren();
});

it("starts from the focused pane's composer and keeps to composers sideways", () => {
  const regions = layout();
  expect(moveFocus("right")).toBe(true);
  expect(document.activeElement).toBe(regions.textarea(regions.composerB));
});

it("moves up from a composer into its own timeline and stops at the top edge", () => {
  const regions = layout();
  regions.textarea(regions.composerA)?.focus();
  expect(moveFocus("up")).toBe(true);
  expect(document.activeElement).toBe(regions.timelineA);
  expect(moveFocus("up")).toBe(false);
  expect(document.activeElement).toBe(regions.timelineA);
});

it("enters the sidebar on its first row and returns to the region it came from", () => {
  const regions = layout();
  regions.textarea(regions.composerA)?.focus();
  moveFocus("left");
  expect(document.activeElement).toBe(regions.sidebar.querySelector("[data-nav-row]"));
  moveFocus("right");
  expect(document.activeElement).toBe(regions.textarea(regions.composerA));
});

it("reaches the Explorer from the rightmost pane and comes back", () => {
  const regions = layout();
  regions.timelineB.focus();
  moveFocus("right");
  expect(document.activeElement).toBe(regions.explorer);
  moveFocus("left");
  expect(document.activeElement).toBe(regions.timelineB);
});

it("lets a panel focus itself when it registered a focus target", () => {
  const regions = layout();
  const focusTerminal = vi.fn();
  const unregister = registerFocusTarget(regions.timelineB, focusTerminal);
  regions.timelineA.focus();
  moveFocus("right");
  expect(focusTerminal).toHaveBeenCalledOnce();
  unregister();
});

it("holds keyboard focus against composer autofocus until a click", () => {
  const regions = layout();
  const composer = regions.textarea(regions.composerA);
  composer?.focus();
  moveFocus("up");
  expect(keyboardFocusHeldElsewhere(composer)).toBe(true);
  expect(keyboardFocusHeldElsewhere(regions.timelineA)).toBe(false);
  document.dispatchEvent(new PointerEvent("pointerdown"));
  expect(keyboardFocusHeldElsewhere(composer)).toBe(false);
});
