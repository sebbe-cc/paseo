import React, { act, useCallback, useMemo, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { defaultRangeExtractor, useVirtualizer, type Range } from "@tanstack/react-virtual";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  KeyboardActionDispatcherProvider,
  useKeyboardActionDispatcher,
} from "@/keyboard/keyboard-action-dispatcher-context";
import type { ListKeyboardActionId } from "@/keyboard/actions";
import type { StreamItem } from "@/types/stream";
import { useTimelineCursor, type TimelineCursor } from "./use-timeline-cursor.web";

// App sources compile against the classic JSX runtime, which expects React on the global.
beforeEach(() => vi.stubGlobal("React", React));

// strategy-web reaches expo-router, which the browser runner cannot bundle, so this harness
// mirrors its wiring: virtualized rows, then mounted rows, with the cursor row kept mounted.
const ROW_HEIGHT = 40;
const MOUNTED_COUNT = 20;
const ROW_STYLE = { height: ROW_HEIGHT };
const SCROLL_STYLE = { height: 400, overflowY: "auto" } as const;
const FRAME_STYLE = { "--colors-accent": "rgb(255, 0, 0)" } as React.CSSProperties;

function item(index: number): StreamItem {
  const timestamp = new Date(Date.UTC(2026, 8, 28) + index * 1000);
  return index % 5 === 0
    ? { kind: "user_message", id: `row-${index}`, text: `Prompt ${index}`, timestamp }
    : { kind: "assistant_message", id: `row-${index}`, text: `Block ${index}`, timestamp };
}

function Toggle() {
  const [open, setOpen] = useState(false);
  const toggle = useCallback(() => setOpen((value) => !value), []);
  return (
    <button type="button" aria-expanded={open} onClick={toggle}>
      details
    </button>
  );
}

function Row({ item: streamItem, top }: { item: StreamItem; top?: number }) {
  const style = useMemo(
    () =>
      top === undefined ? ROW_STYLE : { ...ROW_STYLE, position: "absolute", top, width: "100%" },
    [top],
  ) as React.CSSProperties;
  return (
    <div data-history-row-id={streamItem.id} style={style}>
      {streamItem.id}
      {streamItem.id === "row-7" ? <Toggle /> : null}
    </div>
  );
}

interface HarnessProps {
  items: StreamItem[];
  hasOlderHistory: boolean;
  requestOlderHistory: () => void;
  pinToBottom: () => void;
}

function Harness({ items, hasOlderHistory, requestOlderHistory, pinToBottom }: HarnessProps) {
  const scrollContainerRef = useRef<HTMLElement | null>(null);
  const [cursor, setCursor] = useState<TimelineCursor | null>(null);
  const segments = useMemo(
    () => ({
      historyVirtualized: items.slice(0, -MOUNTED_COUNT),
      historyMounted: items.slice(-MOUNTED_COUNT),
      liveHead: [],
    }),
    [items],
  );
  const cursorIndex = segments.historyVirtualized.findIndex((entry) => entry.id === cursor?.rowId);
  const rangeExtractor = useCallback(
    (range: Range) => {
      const visible = defaultRangeExtractor(range);
      if (cursorIndex < 0) return visible;
      return [...new Set([...visible, cursorIndex])].sort((left, right) => left - right);
    },
    [cursorIndex],
  );
  const rowVirtualizer = useVirtualizer({
    count: segments.historyVirtualized.length,
    getScrollElement: () => scrollContainerRef.current,
    getItemKey: (index: number) => segments.historyVirtualized[index]?.id ?? index,
    estimateSize: () => ROW_HEIGHT,
    rangeExtractor,
    overscan: 2,
  });
  const view = useTimelineCursor({
    active: true,
    scrollContainerRef,
    segments,
    rowVirtualizer,
    cursor,
    setCursor,
    hasOlderHistory,
    isLoadingOlderRows: false,
    stopFollowingOutput: () => {},
    pinToBottom,
    requestOlderHistory,
  });
  const totalSize = rowVirtualizer.getTotalSize();
  const virtualStyle = useMemo(
    () => ({ position: "relative", height: totalSize }) as const,
    [totalSize],
  );
  const setScrollContainer = useCallback((node: HTMLElement | null) => {
    scrollContainerRef.current = node;
  }, []);
  return (
    <div data-focus-region="pane" style={FRAME_STYLE}>
      {view.css ? <style>{view.css}</style> : null}
      <div
        ref={setScrollContainer}
        data-testid="timeline"
        data-timeline-cursor={view.scopeId}
        tabIndex={-1}
        style={SCROLL_STYLE}
      >
        <div style={virtualStyle}>
          {rowVirtualizer.getVirtualItems().map((virtualRow) => {
            const entry = segments.historyVirtualized[virtualRow.index];
            return entry ? <Row key={entry.id} item={entry} top={virtualRow.start} /> : null;
          })}
        </div>
        {segments.historyMounted.map((entry) => (
          <Row key={entry.id} item={entry} />
        ))}
      </div>
      <div data-focus-region="composer">
        <textarea data-testid="composer" />
      </div>
    </div>
  );
}

let dispatch: (id: ListKeyboardActionId) => boolean = () => false;
function DispatcherProbe() {
  const dispatcher = useKeyboardActionDispatcher();
  dispatch = (id) => dispatcher.dispatch({ id, scope: "list" });
  return null;
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function render(props: HarnessProps): void {
  act(() => {
    root?.render(
      <KeyboardActionDispatcherProvider>
        <DispatcherProbe />
        <Harness {...props} />
      </KeyboardActionDispatcherProvider>,
    );
  });
}

function mount(props: Partial<HarnessProps> = {}): HTMLElement {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  render({
    items: ITEMS,
    hasOlderHistory: false,
    requestOlderHistory: () => {},
    pinToBottom: () => {},
    ...props,
  });
  const scroll = host.querySelector<HTMLElement>("[data-testid='timeline']");
  if (!scroll) throw new Error("timeline did not render");
  act(() => {
    scroll.scrollTop = scroll.scrollHeight;
    scroll.focus();
  });
  return scroll;
}

function press(id: ListKeyboardActionId): boolean {
  let handled = false;
  act(() => {
    handled = dispatch(id);
  });
  return handled;
}

function cursorRowId(): string | null {
  const css = host?.querySelector("style")?.textContent ?? "";
  return /data-history-row-id="([^"]+)"/.exec(css)?.[1] ?? null;
}

function row(scroll: HTMLElement, id: string): HTMLElement | null {
  return scroll.querySelector<HTMLElement>(`[data-history-row-id="${id}"]`);
}

function isOnScreen(scroll: HTMLElement, id: string): boolean {
  const element = row(scroll, id);
  if (!element) return false;
  const view = scroll.getBoundingClientRect();
  const rect = element.getBoundingClientRect();
  return rect.top >= view.top && rect.bottom <= view.bottom;
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

const ITEMS = Array.from({ length: 150 }, (_, index) => item(index));

it("steps one row at a time across virtualized rows and keeps the cursor row mounted", async () => {
  const scroll = mount();
  expect(press("list.next")).toBe(true);
  expect(cursorRowId()).toBe("row-149");

  press("list.first");
  expect(cursorRowId()).toBe("row-0");
  await vi.waitFor(() => expect(isOnScreen(scroll, "row-0")).toBe(true));
  press("list.next");
  press("list.next");
  expect(cursorRowId()).toBe("row-2");
  expect(getComputedStyle(row(scroll, "row-2")!).boxShadow).toContain("rgb(255, 0, 0)");

  act(() => {
    scroll.scrollTop = scroll.scrollHeight;
  });
  await vi.waitFor(() => expect(isOnScreen(scroll, "row-149")).toBe(true));
  expect(row(scroll, "row-2")).not.toBeNull();
  press("list.next");
  expect(cursorRowId()).toBe("row-3");
  await vi.waitFor(() => expect(isOnScreen(scroll, "row-3")).toBe(true));
});

it("jumps between prompts, toggles a block and re-pins to the bottom with G", async () => {
  const pinToBottom = vi.fn();
  const scroll = mount({ pinToBottom });
  press("list.first");
  press("list.prompt.next");
  expect(cursorRowId()).toBe("row-5");
  press("list.next");
  press("list.next");
  expect(cursorRowId()).toBe("row-7");
  await vi.waitFor(() => expect(isOnScreen(scroll, "row-7")).toBe(true));

  const toggle = () => row(scroll, "row-7")!.querySelector("[aria-expanded]")!;
  press("list.open");
  expect(toggle().getAttribute("aria-expanded")).toBe("true");
  press("list.expand");
  expect(toggle().getAttribute("aria-expanded")).toBe("true");
  press("list.collapse");
  expect(toggle().getAttribute("aria-expanded")).toBe("false");
  press("list.prompt.prev");
  expect(cursorRowId()).toBe("row-5");

  press("list.last");
  expect(cursorRowId()).toBe("row-149");
  expect(pinToBottom).toHaveBeenCalledTimes(1);
});

it("asks for older history from the first row and steps onto the row before it", async () => {
  const older = Array.from({ length: 10 }, (_, index) => item(index - 10));
  const requestOlderHistory = vi.fn(() => {
    queueMicrotask(() => render({ ...props, items: [...older, ...ITEMS], hasOlderHistory: false }));
  });
  const props: HarnessProps = {
    items: ITEMS,
    hasOlderHistory: true,
    pinToBottom: () => {},
    requestOlderHistory,
  };
  const scroll = mount(props);
  press("list.first");
  await vi.waitFor(() => expect(isOnScreen(scroll, "row-0")).toBe(true));

  press("list.prev");
  expect(requestOlderHistory).toHaveBeenCalledTimes(1);
  await vi.waitFor(() => expect(cursorRowId()).toBe("row--1"));
  await vi.waitFor(() => expect(isOnScreen(scroll, "row--1")).toBe(true));
  press("list.prev");
  expect(cursorRowId()).toBe("row--2");
});

it("hands focus back to the pane's composer with i", () => {
  mount();
  press("list.next");
  expect(press("list.insert")).toBe(true);
  expect(document.activeElement).toBe(host?.querySelector("[data-testid='composer']"));
  expect(press("list.next")).toBe(false);
});
