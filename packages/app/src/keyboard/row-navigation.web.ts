import { useEffect, useRef } from "react";
import { useKeyboardActionHandler } from "@/hooks/use-keyboard-action-handler";
import type { ListKeyboardActionId } from "@/keyboard/actions";
import { releaseKeyboardFocus } from "@/keyboard/focus-regions";

const LIST_SELECTOR = "[data-keyboard-list]";
const ROW_SELECTOR = "[data-nav-row]";
// VirtualizedList renders more rows in idle-time batches after a scroll, so waits are in time.
const STEP_BUDGET_MS = 1000;
const JUMP_BUDGET_MS = 4000;
const SETTLED_MS = 250;
const ROW_ACTIONS: readonly ListKeyboardActionId[] = [
  "list.next",
  "list.prev",
  "list.first",
  "list.last",
  "list.open",
  "list.expand",
  "list.collapse",
];

type Edge = "first" | "last";

function activeRowList(): HTMLElement | null {
  const active = document.activeElement;
  const list = active instanceof Element ? active.closest<HTMLElement>(LIST_SELECTOR) : null;
  return list?.dataset.keyboardList === "rows" ? list : null;
}

function visibleRows(list: HTMLElement): HTMLElement[] {
  return Array.from(list.querySelectorAll<HTMLElement>(ROW_SELECTOR)).filter((row) => {
    const rect = row.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  });
}

function currentRow(list: HTMLElement): HTMLElement | null {
  const active = document.activeElement;
  const row = active instanceof Element ? active.closest<HTMLElement>(ROW_SELECTOR) : null;
  return row && list.contains(row) ? row : null;
}

function scrollParent(row: HTMLElement, list: HTMLElement): HTMLElement | null {
  for (let node = row.parentElement; node; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY;
    if ((overflow === "auto" || overflow === "scroll") && node.scrollHeight > node.clientHeight) {
      return node;
    }
    if (node === list) return null;
  }
  return null;
}

function atEdge(scroller: HTMLElement, edge: Edge): boolean {
  if (edge === "first") return scroller.scrollTop <= 0;
  return scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 1;
}

function focusRow(row: HTMLElement): void {
  row.focus({ preventScroll: true });
  row.scrollIntoView({ block: "nearest", inline: "nearest" });
}

function expandControl(row: HTMLElement): HTMLElement | null {
  return row.hasAttribute("aria-expanded")
    ? row
    : row.querySelector<HTMLElement>("[aria-expanded]");
}

/** Vim-style j/k for sidebar and Explorer rows: DOM focus moves, Enter clicks the row. */
export function useRowNavigation(): void {
  // A windowed list mounts rows as it scrolls, so some moves finish a few frames later.
  const frameRef = useRef(0);
  useEffect(() => () => cancelAnimationFrame(frameRef.current), []);

  const later = (run: () => void) => {
    cancelAnimationFrame(frameRef.current);
    frameRef.current = requestAnimationFrame(run);
  };

  const step = (list: HTMLElement, delta: 1 | -1): boolean => {
    const rows = visibleRows(list);
    if (rows.length === 0) return false;
    const current = currentRow(list);
    const index = current ? rows.indexOf(current) : -1;
    const entry = delta > 0 ? rows[0] : rows.at(-1);
    const next = index < 0 ? entry : rows[index + delta];
    if (next) {
      focusRow(next);
      return true;
    }
    // Past the last mounted row: either the real end, or rows the list hasn't rendered yet.
    const scroller = current ? scrollParent(current, list) : null;
    if (!current || !scroller) return true;
    scroller.scrollTop += delta * current.offsetHeight;
    const deadline = performance.now() + STEP_BUDGET_MS;
    const settle = () => {
      const mounted = visibleRows(list);
      const at = mounted.indexOf(current);
      const after = at < 0 ? undefined : mounted[at + delta];
      if (after) focusRow(after);
      else if (at >= 0 && performance.now() < deadline) later(settle);
    };
    later(settle);
    return true;
  };

  // A list without item sizes grows as it's scrolled, so the end is where the last row stops changing.
  const jump = (list: HTMLElement, edge: Edge): boolean => {
    if (visibleRows(list).length === 0) return false;
    let previous: HTMLElement | undefined;
    let stillSince = 0;
    const deadline = performance.now() + JUMP_BUDGET_MS;
    const settle = () => {
      const rows = visibleRows(list);
      const row = edge === "first" ? rows[0] : rows.at(-1);
      if (!row) return;
      if (row !== document.activeElement) focusRow(row);
      const scroller = scrollParent(row, list);
      const now = performance.now();
      const still = row === previous && (!scroller || atEdge(scroller, edge));
      if (!still) stillSince = now;
      previous = row;
      if (now - stillSince >= SETTLED_MS || now >= deadline) return;
      if (scroller) scroller.scrollTop = edge === "first" ? 0 : scroller.scrollHeight;
      later(settle);
    };
    settle();
    return true;
  };

  const toggle = (list: HTMLElement, expand: boolean): boolean => {
    const row = currentRow(list);
    const control = row ? expandControl(row) : null;
    if (!control) return false;
    if ((control.getAttribute("aria-expanded") === "true") !== expand) control.click();
    return true;
  };

  const open = (list: HTMLElement): boolean => {
    const row = currentRow(list);
    // A focused button inside a row keeps its own Enter.
    if (!row || document.activeElement !== row) return false;
    // Folders and groups toggle in place; anything else opens, and the app's autofocus may follow.
    if (!row.hasAttribute("aria-expanded")) releaseKeyboardFocus();
    row.click();
    return true;
  };

  const handle = (id: string): boolean => {
    const list = activeRowList();
    if (!list) return false;
    switch (id) {
      case "list.next":
        return step(list, 1);
      case "list.prev":
        return step(list, -1);
      case "list.first":
        return jump(list, "first");
      case "list.last":
        return jump(list, "last");
      case "list.open":
        return open(list);
      case "list.expand":
        return toggle(list, true);
      case "list.collapse":
        return toggle(list, false);
      default:
        return false;
    }
  };

  useKeyboardActionHandler({
    handlerId: "row-navigation",
    actions: ROW_ACTIONS,
    enabled: true,
    priority: 0,
    isActive: () => activeRowList() !== null,
    handle: (action) => handle(action.id),
  });
}
