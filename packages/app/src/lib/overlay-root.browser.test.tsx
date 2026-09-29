import React, { type RefCallback } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWebOverlayRegistration } from "./overlay-root";

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function OverlayHarness({
  active,
  showScope,
  manageFocus = true,
  onKeyDown = () => false,
}: {
  active: boolean;
  showScope: boolean;
  manageFocus?: boolean;
  onKeyDown?: (event: KeyboardEvent) => boolean;
}) {
  const setScope = useWebOverlayRegistration({ active, layer: 20, onKeyDown, manageFocus });
  return showScope ? (
    <div data-testid="scope" ref={setScope as RefCallback<HTMLDivElement>} tabIndex={-1}>
      <input data-testid="overlay-input" />
    </div>
  ) : null;
}

function MenuFormHarness() {
  const setScope = useWebOverlayRegistration({ active: true, layer: 20, onKeyDown: () => false });
  return (
    <div ref={setScope as RefCallback<HTMLDivElement>}>
      <button type="button">Menu backdrop</button>
      <div data-menu-surface="true">
        <textarea data-testid="form-input" />
      </div>
    </div>
  );
}

describe("useWebOverlayRegistration in the browser", () => {
  let root: Root;
  let container: HTMLDivElement;
  let opener: HTMLButtonElement;

  beforeEach(() => {
    container = document.createElement("div");
    opener = document.createElement("button");
    opener.textContent = "Open";
    document.body.append(opener, container);
    root = createRoot(container);
    opener.focus();
  });

  afterEach(() => {
    root.unmount();
    document.body.replaceChildren();
  });

  async function renderHarness(active: boolean, showScope: boolean): Promise<void> {
    flushSync(() => {
      root.render(<OverlayHarness active={active} showScope={showScope} />);
    });
    await nextFrame();
  }

  it("focuses form content instead of its backdrop when initial autofocus needs recovery", async () => {
    flushSync(() => root.render(<MenuFormHarness />));
    await nextFrame();
    expect(document.activeElement).toBe(document.querySelector('[data-testid="form-input"]'));
  });

  it("preserves timeline selection and external focus for a non-focusing menu while handling Escape", async () => {
    const range = document.createRange();
    range.selectNodeContents(opener);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    let escaped = false;
    const onKeyDown = vi.fn((event: KeyboardEvent) => {
      escaped = event.key === "Escape";
      return escaped;
    });
    flushSync(() =>
      root.render(<OverlayHarness active showScope manageFocus={false} onKeyDown={onKeyDown} />),
    );
    await nextFrame();
    expect(document.activeElement).toBe(opener);
    expect(window.getSelection()!.toString()).toBe("Open");
    const other = document.createElement("button");
    document.body.append(other);
    other.focus();
    await nextFrame();
    expect(document.activeElement).toBe(other);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(escaped).toBe(true);
    flushSync(() => root.render(null));
    expect(document.activeElement).toBe(other);
  });

  it("skips focus restoration for active scope detach but restores focus when closing", async () => {
    await renderHarness(true, true);

    const input = document.querySelector<HTMLInputElement>('[data-testid="overlay-input"]');
    expect(input).toBeTruthy();
    input?.focus();
    await nextFrame();
    expect(document.activeElement).not.toBe(opener);

    const originalFocus = opener.focus.bind(opener);
    let openerFocusCalls = 0;
    opener.focus = () => {
      openerFocusCalls += 1;
      originalFocus();
    };

    await renderHarness(true, false);

    expect(openerFocusCalls).toBe(0);

    await renderHarness(false, false);

    expect(openerFocusCalls).toBe(1);
  });
});
