import React, { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { FlatList, Pressable, Text } from "react-native";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ListKeyboardActionId } from "@/keyboard/actions";
import {
  KeyboardActionDispatcherProvider,
  useKeyboardActionDispatcher,
} from "@/keyboard/keyboard-action-dispatcher-context";
import { NAV_ROW_DATASET, NAV_ROW_LIST_DATASET } from "./nav-row-markers";
import { useRowNavigation } from "./row-navigation.web";

// App sources compile against the classic JSX runtime, which expects React on the global.
beforeEach(() => vi.stubGlobal("React", React));

let dispatch: (id: ListKeyboardActionId) => boolean = () => false;
function Navigation() {
  const dispatcher = useKeyboardActionDispatcher();
  dispatch = (id) => dispatcher.dispatch({ id, scope: "list" });
  useRowNavigation();
  return null;
}

let root: Root | null = null;

function mount(children?: ReactNode): HTMLElement {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root?.render(
      <KeyboardActionDispatcherProvider>
        <Navigation />
        {children}
      </KeyboardActionDispatcherProvider>,
    );
  });
  return host;
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
});

function press(id: ListKeyboardActionId): boolean {
  let handled = false;
  act(() => {
    handled = dispatch(id);
  });
  return handled;
}

function byId(parent: ParentNode, selector: string): HTMLElement {
  const element = parent.querySelector<HTMLElement>(selector);
  if (!element) throw new Error(`${selector} did not render`);
  return element;
}

// Shaped like the sidebar: a header row, a project group, a row hidden by a retained tab.
function sidebar() {
  const list = document.createElement("div");
  list.dataset.keyboardList = "rows";
  list.innerHTML = `
    <div data-nav-row tabindex="0" id="home">Home</div>
    <div data-nav-row tabindex="0" id="group" aria-expanded="true">Project</div>
    <div data-nav-row tabindex="0" id="hidden" style="display:none">Hidden</div>
    <div data-nav-row tabindex="0" id="workspace">Workspace <button id="menu">menu</button></div>`;
  mount().append(list);
  const row = (id: string) => byId(list, `#${id}`);
  const clicks = { group: 0, workspace: 0 };
  row("group").addEventListener("click", () => {
    clicks.group += 1;
    const expanded = row("group").getAttribute("aria-expanded") === "true";
    row("group").setAttribute("aria-expanded", String(!expanded));
  });
  row("workspace").addEventListener("click", () => {
    clicks.workspace += 1;
  });
  return { row, clicks };
}

it("steps through the visible rows and stops at the ends", () => {
  const { row } = sidebar();
  row("home").focus();

  expect(press("list.next")).toBe(true);
  expect(document.activeElement).toBe(row("group"));
  press("list.next");
  expect(document.activeElement).toBe(row("workspace"));
  expect(press("list.next")).toBe(true);
  expect(document.activeElement).toBe(row("workspace"));

  press("list.prev");
  expect(document.activeElement).toBe(row("group"));
  press("list.first");
  expect(document.activeElement).toBe(row("home"));
  press("list.last");
  expect(document.activeElement).toBe(row("workspace"));
});

it("expands and collapses a group only when its state differs", () => {
  const { row, clicks } = sidebar();
  row("group").focus();

  expect(press("list.expand")).toBe(true);
  expect(clicks.group).toBe(0);
  press("list.collapse");
  expect(row("group").getAttribute("aria-expanded")).toBe("false");
  press("list.collapse");
  expect(clicks.group).toBe(1);
  press("list.expand");
  expect(row("group").getAttribute("aria-expanded")).toBe("true");

  row("home").focus();
  expect(press("list.expand")).toBe(false);
});

it("opens the focused row with Enter, but leaves a focused button inside it alone", () => {
  const { row, clicks } = sidebar();
  row("workspace").focus();
  expect(press("list.open")).toBe(true);
  expect(clicks.workspace).toBe(1);

  byId(row("workspace"), "#menu").focus();
  expect(press("list.open")).toBe(false);
  expect(clicks.workspace).toBe(1);
});

it("leaves the timeline and plain focus alone", () => {
  const host = mount();
  host.innerHTML = `<div data-keyboard-list="timeline" tabindex="-1" id="timeline">
    <div data-nav-row tabindex="0">block</div></div><button id="outside">x</button>`;
  byId(host, "#timeline").focus();
  expect(press("list.next")).toBe(false);
  byId(host, "#outside").focus();
  expect(press("list.next")).toBe(false);
});

const ITEMS = Array.from({ length: 300 }, (_, index) => index);
const LIST_STYLE = { height: 200 };
const ITEM_STYLE = { height: 20 };
const keyExtractor = (item: number) => String(item);
function renderItem({ item }: { item: number }) {
  return (
    <Pressable style={ITEM_STYLE} dataSet={NAV_ROW_DATASET} testID={`item-${item}`}>
      <Text>{`item ${item}`}</Text>
    </Pressable>
  );
}

// The Explorer tree's FlatList settings: rows mount in batches as it scrolls.
function windowedList(): HTMLElement {
  const host = mount(
    <FlatList
      data={ITEMS}
      renderItem={renderItem}
      keyExtractor={keyExtractor}
      style={LIST_STYLE}
      dataSet={NAV_ROW_LIST_DATASET}
      initialNumToRender={24}
      maxToRenderPerBatch={40}
      windowSize={12}
    />,
  );
  expect(host.querySelector("[data-testid='item-299']")).toBeNull();
  return host;
}

function focusedItem(): string | null {
  return document.activeElement?.getAttribute("data-testid") ?? null;
}

it("jumps to either end of a windowed list once the rows mount", async () => {
  const host = windowedList();
  byId(host, "[data-testid='item-0']").focus();

  expect(press("list.last")).toBe(true);
  await vi.waitFor(() => expect(focusedItem()).toBe("item-299"), { timeout: 4000 });
  press("list.prev");
  expect(focusedItem()).toBe("item-298");

  press("list.first");
  await vi.waitFor(() => expect(focusedItem()).toBe("item-0"), { timeout: 4000 });
});

it("keeps stepping as a windowed list mounts more rows", async () => {
  const host = windowedList();
  byId(host, "[data-testid='item-0']").focus();

  for (let index = 1; index <= 60; index += 1) {
    press("list.next");
    await vi.waitFor(() => expect(focusedItem()).toBe(`item-${index}`));
  }
  const scroller = byId(host, "[data-keyboard-list='rows']");
  const rect = byId(host, "[data-testid='item-60']").getBoundingClientRect();
  expect(rect.bottom).toBeLessThanOrEqual(scroller.getBoundingClientRect().bottom + 1);
});
