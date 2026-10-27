import { findAdjacentBounds, type PaneBounds, type PaneDirection } from "@/utils/split-navigation";

export type FocusRegionKind = "sidebar" | "explorer" | "pane" | "timeline" | "composer";

const REGION_SELECTOR = "[data-focus-region]";
const ROW_SELECTOR = "[data-nav-row]";
const DOM_TOLERANCE = 1;

const focusTargets = new Map<Element, () => void>();
let lastPaneRegion: Element | null = null;
let keyboardRegion: Element | null = null;

if (typeof document !== "undefined") {
  document.addEventListener("focusin", (event) => {
    const region = event.target instanceof Element ? event.target.closest(REGION_SELECTOR) : null;
    if (region && !isSideRegion(region)) lastPaneRegion = resolveLeaf(region);
  });
  // A click hands focus back to the app's own rules.
  document.addEventListener("pointerdown", releaseKeyboardFocus, true);
}

/** Lets a panel inside a region take focus its own way, e.g. the terminal. */
export function registerFocusTarget(element: unknown, focus: () => void): () => void {
  if (!(element instanceof Element)) return () => {};
  focusTargets.set(element, focus);
  return () => {
    if (focusTargets.get(element) === focus) focusTargets.delete(element);
  };
}

export function regionKind(element: Element): FocusRegionKind | null {
  const kind = element.getAttribute("data-focus-region");
  if (
    kind === "sidebar" ||
    kind === "explorer" ||
    kind === "pane" ||
    kind === "timeline" ||
    kind === "composer"
  ) {
    return kind;
  }
  return null;
}

/** True while a region reached with ⌥H/J/K/L still holds focus and `element` is outside it. */
export function keyboardFocusHeldElsewhere(element: unknown): boolean {
  const region = keyboardRegion;
  if (!region?.isConnected || !region.contains(document.activeElement)) return false;
  return !(element instanceof Node && region.contains(element));
}

/** Hands focus back to the app's own autofocus, e.g. before opening what a row points to. */
export function releaseKeyboardFocus(): void {
  keyboardRegion = null;
}

function isSideRegion(element: Element): boolean {
  const kind = regionKind(element);
  return kind === "sidebar" || kind === "explorer";
}

function isVisible(element: Element): boolean {
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

/** An agent pane is its timeline and composer; its root only counts when focus sits in its tab row. */
function resolveLeaf(region: Element): Element {
  if (regionKind(region) !== "pane") return region;
  const inner = Array.from(region.querySelectorAll(REGION_SELECTOR)).filter(isVisible);
  return inner.find((element) => regionKind(element) === "composer") ?? inner[0] ?? region;
}

export function currentRegion(): Element | null {
  const active = document.activeElement;
  const fromActive = active && active !== document.body ? active.closest(REGION_SELECTOR) : null;
  if (fromActive) return resolveLeaf(fromActive);
  const focusedPane = Array.from(document.querySelectorAll("[data-focused-pane='true']")).find(
    isVisible,
  );
  return focusedPane ? resolveLeaf(focusedPane) : null;
}

function leafRegions(): Element[] {
  const regions = Array.from(document.querySelectorAll(REGION_SELECTOR)).filter(isVisible);
  return regions.filter(
    (element) => !regions.some((other) => other !== element && element.contains(other)),
  );
}

function toBounds(element: Element, id: string): PaneBounds {
  const rect = element.getBoundingClientRect();
  return {
    paneId: id,
    left: rect.left,
    top: rect.top,
    right: rect.right,
    bottom: rect.bottom,
    centerX: (rect.left + rect.right) / 2,
    centerY: (rect.top + rect.bottom) / 2,
  };
}

function pickAdjacent(
  candidates: Element[],
  from: Element,
  direction: PaneDirection,
): Element | null {
  const bounds = candidates.map((element, index) => toBounds(element, String(index)));
  const id = findAdjacentBounds(bounds, String(candidates.indexOf(from)), direction, DOM_TOLERANCE);
  return id === null ? null : (candidates[Number(id)] ?? null);
}

/** The region `direction` leads to from `from`, or null at an edge. */
export function findAdjacentRegion(
  regions: Element[],
  from: Element,
  direction: PaneDirection,
): Element | null {
  if (!regions.includes(from)) return null;
  const target = pickAdjacent(regions, from, direction);
  const fromKind = regionKind(from);
  const targetKind = target ? regionKind(target) : null;
  const sideways = direction === "left" || direction === "right";
  const agentParts = new Set<FocusRegionKind | null>(["timeline", "composer"]);
  if (!target || !sideways || !agentParts.has(fromKind) || !agentParts.has(targetKind)) {
    return target;
  }
  // Sideways between agent panes, stay on the same part: composer to composer.
  const pane = target.closest("[data-focus-region='pane']");
  const sameKind = pane?.querySelector(`[data-focus-region='${fromKind}']`);
  return sameKind && regions.includes(sameKind) ? sameKind : target;
}

function focusElement(element: HTMLElement | null): boolean {
  if (!element) return false;
  element.focus({ preventScroll: true });
  return element.contains(document.activeElement);
}

function focusRegion(region: Element): void {
  for (const [element, focus] of focusTargets) {
    if (region.contains(element) && isVisible(element)) {
      focus();
      return;
    }
  }
  const kind = regionKind(region);
  if (kind === "sidebar" || kind === "explorer") {
    // Retained tabs keep hidden rows mounted, so only visible rows count.
    const rows = Array.from(region.querySelectorAll<HTMLElement>(ROW_SELECTOR)).filter(isVisible);
    const selected = rows.find((row) => row.getAttribute("aria-selected") === "true");
    if (focusElement(selected ?? null) || focusElement(rows[0] ?? null)) return;
  }
  if (kind === "composer" && focusElement(region.querySelector("textarea"))) {
    return;
  }
  if (region instanceof HTMLElement) {
    region.focus({ preventScroll: true });
  }
}

/** Moves DOM focus like vim's window motions; false at an edge, where the key is still consumed. */
export function moveFocus(direction: PaneDirection): boolean {
  const from = currentRegion();
  if (!from) return false;
  const regions = leafRegions();
  if (!regions.includes(from)) regions.push(from);

  let target = findAdjacentRegion(regions, from, direction);
  // Leaving a sidebar goes back to the region you entered it from.
  const last = lastPaneRegion;
  if (target && isSideRegion(from) && !isSideRegion(target) && last && regions.includes(last)) {
    target = pickAdjacent([from, last], from, direction) ?? target;
  }
  if (!target) return false;
  keyboardRegion = target;
  focusRegion(target);
  return true;
}
