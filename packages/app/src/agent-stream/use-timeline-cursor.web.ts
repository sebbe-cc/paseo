import type React from "react";
import { useEffect, useId, useLayoutEffect, useMemo, useRef } from "react";
import type { Virtualizer } from "@tanstack/react-virtual";
import { useKeyboardActionHandler } from "@/hooks/use-keyboard-action-handler";
import { useStableEvent } from "@/hooks/use-stable-event";
import type { ListKeyboardActionId } from "@/keyboard/actions";
import { releaseKeyboardFocus } from "@/keyboard/focus-regions";
import type { StreamRenderSegments } from "./model";
import {
  bottomVisibleTimelineRowId,
  findTimelineComposerInput,
  findTimelineRow,
  isTimelineRowVisible,
  scrollTimelineRowIntoView,
  scrollWithinTimelineRow,
} from "./timeline-cursor-dom.web";

/** A new object per move, so moving onto the same row still reveals it. */
export interface TimelineCursor {
  rowId: string;
  reveal: boolean;
}

interface UseTimelineCursorInput {
  active: boolean;
  scrollContainerRef: React.RefObject<HTMLElement | null>;
  segments: StreamRenderSegments;
  rowVirtualizer: Virtualizer<HTMLElement, Element>;
  cursor: TimelineCursor | null;
  setCursor: (cursor: TimelineCursor | null) => void;
  hasOlderHistory: boolean;
  isLoadingOlderRows: boolean;
  stopFollowingOutput: () => void;
  pinToBottom: () => void;
  requestOlderHistory: () => void;
}

const TIMELINE_ACTIONS: readonly ListKeyboardActionId[] = [
  "list.next",
  "list.prev",
  "list.first",
  "list.last",
  "list.prompt.next",
  "list.prompt.prev",
  "list.open",
  "list.expand",
  "list.collapse",
  "list.insert",
];
const REVEAL_FRAME_BUDGET = 24;
const SCROLL_KEYS = new Set(["ArrowDown", "ArrowUp", "End", "Home", "PageDown", "PageUp", " "]);
const CURSOR_STYLE =
  "{box-shadow:inset 2px 0 0 var(--colors-accent);border-radius:4px;" +
  "background-color:color-mix(in srgb,var(--colors-accent) 8%,transparent);}";

/** Vim-style normal mode for a focused timeline: one step is one rendered row. */
export function useTimelineCursor(input: UseTimelineCursorInput): { scopeId: string; css: string } {
  const { active, scrollContainerRef, segments, cursor, isLoadingOlderRows } = input;
  const scopeId = useId();
  const rows = useMemo(
    () => [...segments.historyVirtualized, ...segments.historyMounted, ...segments.liveHead],
    [segments.historyMounted, segments.historyVirtualized, segments.liveHead],
  );
  // Set when the reader scrolls by hand; the next step starts from what is on screen.
  const detachedRef = useRef(false);
  // The first loaded row when k asked for older history; its new predecessor is the next step.
  const pendingOlderRef = useRef<string | null>(null);
  // A click hides the cursor; the next j/k starts from the clicked row.
  const clickedRowRef = useRef<string | null>(null);

  const moveTo = useStableEvent((rowId: string, reveal?: boolean) => {
    const container = scrollContainerRef.current;
    pendingOlderRef.current = null;
    clickedRowRef.current = null;
    detachedRef.current = false;
    input.stopFollowingOutput();
    if (container && document.activeElement !== container) container.focus({ preventScroll: true });
    input.setCursor({ rowId, reveal: reveal ?? true });
  });

  const cursorIndex = useStableEvent((): number | null => {
    const container = scrollContainerRef.current;
    if (!container || !cursor) return null;
    const index = rows.findIndex((row) => row.id === cursor.rowId);
    if (index < 0) return null;
    if (detachedRef.current) {
      const element = findTimelineRow(container, cursor.rowId);
      if (!element || !isTimelineRowVisible(container, element)) return null;
    }
    return index;
  });

  /** Puts the cursor on the bottom-most row on screen; its index, or null for an empty timeline. */
  const anchorToView = useStableEvent((): number | null => {
    const container = scrollContainerRef.current;
    if (!container || rows.length === 0) return null;
    const clicked = clickedRowRef.current
      ? findTimelineRow(container, clickedRowRef.current)
      : null;
    const visibleId =
      clicked && isTimelineRowVisible(container, clicked)
        ? clickedRowRef.current
        : bottomVisibleTimelineRowId(container);
    const index = visibleId ? rows.findIndex((row) => row.id === visibleId) : -1;
    const anchored = index >= 0 ? index : rows.length - 1;
    const row = rows[anchored];
    if (row) moveTo(row.id);
    return anchored;
  });

  const step = useStableEvent((delta: 1 | -1) => {
    const container = scrollContainerRef.current;
    const index = cursorIndex();
    if (!container || index === null || !cursor) {
      anchorToView();
      return;
    }
    const current = findTimelineRow(container, cursor.rowId);
    if (current && scrollWithinTimelineRow(container, current, delta)) {
      input.stopFollowingOutput();
      return;
    }
    const next = rows[index + delta];
    if (next) {
      moveTo(next.id);
      return;
    }
    const first = rows[0];
    if (delta < 0 && first && input.hasOlderHistory) {
      pendingOlderRef.current = first.id;
      input.stopFollowingOutput();
      input.requestOlderHistory();
    }
  });

  const jumpToPrompt = useStableEvent((delta: 1 | -1) => {
    const start = cursorIndex() ?? anchorToView();
    if (start === null) return;
    for (let index = start + delta; index >= 0 && index < rows.length; index += delta) {
      const row = rows[index];
      if (row?.kind === "user_message") {
        moveTo(row.id);
        return;
      }
    }
  });

  const toggle = useStableEvent((mode: "toggle" | "expand" | "collapse"): boolean => {
    const container = scrollContainerRef.current;
    const row = container && cursor ? findTimelineRow(container, cursor.rowId) : null;
    const control = row?.querySelector<HTMLElement>("[aria-expanded]");
    if (!control) return false;
    const expanded = control.getAttribute("aria-expanded") === "true";
    if (mode === "toggle" || (mode === "expand") !== expanded) control.click();
    return true;
  });

  const handle = useStableEvent((id: string): boolean => {
    const container = scrollContainerRef.current;
    if (!container) return false;
    // A focused button inside a row keeps its own Enter.
    if (id === "list.open" && document.activeElement !== container) return false;
    switch (id) {
      case "list.next":
      case "list.prev":
        step(id === "list.next" ? 1 : -1);
        return true;
      case "list.first": {
        const first = rows[0];
        if (first) moveTo(first.id);
        return true;
      }
      case "list.last": {
        const last = rows.at(-1);
        if (last) moveTo(last.id, false);
        input.pinToBottom();
        return true;
      }
      case "list.prompt.next":
      case "list.prompt.prev":
        jumpToPrompt(id === "list.prompt.next" ? 1 : -1);
        return true;
      case "list.open":
        return toggle("toggle");
      case "list.expand":
        return toggle("expand");
      case "list.collapse":
        return toggle("collapse");
      case "list.insert": {
        const composer = findTimelineComposerInput(container);
        if (!composer) return false;
        releaseKeyboardFocus();
        composer.focus();
        return true;
      }
      default:
        return false;
    }
  });

  useKeyboardActionHandler({
    handlerId: `timeline-cursor:${scopeId}`,
    actions: TIMELINE_ACTIONS,
    enabled: active,
    priority: 0,
    isActive: () => Boolean(scrollContainerRef.current?.contains(document.activeElement)),
    handle: (action) => handle(action.id),
  });

  const reveal = useStableEvent((rowId: string): boolean => {
    const container = scrollContainerRef.current;
    if (!container) return true;
    const row = findTimelineRow(container, rowId);
    if (row) return scrollTimelineRowIntoView(container, row);
    const index = segments.historyVirtualized.findIndex((item) => item.id === rowId);
    if (index >= 0) input.rowVirtualizer.scrollToIndex(index, { align: "auto" });
    return index < 0;
  });

  // A far row mounts at an estimated offset and moves as rows around it get measured.
  useLayoutEffect(() => {
    if (!cursor?.reveal) return;
    let frame = 0;
    let stableFrames = 0;
    let budget = REVEAL_FRAME_BUDGET;
    const settle = () => {
      stableFrames = reveal(cursor.rowId) ? stableFrames + 1 : 0;
      budget -= 1;
      if (stableFrames < 2 && budget > 0 && !detachedRef.current) {
        frame = window.requestAnimationFrame(settle);
      }
    };
    settle();
    return () => window.cancelAnimationFrame(frame);
  }, [cursor, reveal]);

  useEffect(() => {
    const anchor = pendingOlderRef.current;
    if (!anchor || isLoadingOlderRows) return;
    pendingOlderRef.current = null;
    const index = rows.findIndex((row) => row.id === anchor);
    const previous = index > 0 ? rows[index - 1] : undefined;
    if (previous) moveTo(previous.id);
  }, [isLoadingOlderRows, moveTo, rows]);

  // Arriving from the keyboard (⌥K) shows the cursor at once; a click hides it until j/k.
  const handleFocus = useStableEvent((event: FocusEvent) => {
    const container = scrollContainerRef.current;
    if (!container || event.target !== container || !container.matches(":focus-visible")) return;
    input.stopFollowingOutput();
    detachedRef.current = true;
    if (cursorIndex() === null) anchorToView();
  });
  const handlePointerDown = useStableEvent((event: PointerEvent) => {
    detachedRef.current = true;
    const row =
      event.target instanceof Element ? event.target.closest("[data-history-row-id]") : null;
    clickedRowRef.current = row?.getAttribute("data-history-row-id") ?? null;
    if (cursor) input.setCursor(null);
  });

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!active || !container) return;
    const detach = () => {
      detachedRef.current = true;
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (SCROLL_KEYS.has(event.key)) detach();
    };
    container.addEventListener("focus", handleFocus);
    container.addEventListener("wheel", detach, { passive: true });
    container.addEventListener("touchstart", detach, { passive: true });
    container.addEventListener("pointerdown", handlePointerDown);
    container.addEventListener("keydown", handleKeyDown);
    return () => {
      container.removeEventListener("focus", handleFocus);
      container.removeEventListener("wheel", detach);
      container.removeEventListener("touchstart", detach);
      container.removeEventListener("pointerdown", handlePointerDown);
      container.removeEventListener("keydown", handleKeyDown);
    };
  }, [active, handleFocus, handlePointerDown, scrollContainerRef]);

  if (!cursor) return { scopeId, css: "" };
  const scope = `[data-timeline-cursor="${CSS.escape(scopeId)}"]:focus-within`;
  return {
    scopeId,
    css: `${scope} [data-history-row-id="${CSS.escape(cursor.rowId)}"]${CURSOR_STYLE}`,
  };
}
