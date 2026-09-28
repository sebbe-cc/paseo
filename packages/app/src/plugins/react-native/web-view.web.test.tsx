// @vitest-environment jsdom
import React, { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebViewHandle } from "@getpaseo/plugin/client/react-native";
import { WebView } from "./web-view";

Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });

async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for the frame");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function collectPageMessages(frame: HTMLIFrameElement, received: string[]): void {
  frame.addEventListener("load", () => {
    frame.contentWindow?.addEventListener("message", (event) => received.push(event.data));
  });
}

describe("plugin WebView on web", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function frame(): HTMLIFrameElement {
    const element = container.querySelector("iframe");
    if (!element) throw new Error("No frame rendered");
    return element;
  }

  it("renders the document in a sandboxed frame with the message bridge", () => {
    act(() => root.render(<WebView html="<p>hello</p>" testID="frame" />));
    expect(frame().getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame().getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(frame().getAttribute("srcdoc")).toBe(
      '<!doctype html><script>window.ReactNativeWebView={postMessage:function(d){parent.postMessage(String(d),"*")}}</script><p>hello</p>',
    );
    expect(container.querySelector('[data-testid="frame"]')).not.toBeNull();
  });

  it("passes text from its own frame to onMessage and nothing else", () => {
    const onMessage = vi.fn();
    act(() => root.render(<WebView html="<p>hello</p>" onMessage={onMessage} />));
    const source = frame().contentWindow;
    act(() => {
      window.dispatchEvent(new MessageEvent("message", { data: "from the page", source }));
      window.dispatchEvent(new MessageEvent("message", { data: { type: "object" }, source }));
      window.dispatchEvent(new MessageEvent("message", { data: "elsewhere", source: window }));
    });
    expect(onMessage.mock.calls).toEqual([["from the page"]]);
  });

  it("delivers messages posted before the document loads once it has loaded", async () => {
    const ref = createRef<WebViewHandle>();
    const received: string[] = [];
    act(() => root.render(<WebView ref={ref} html="<p>hello</p>" />));
    collectPageMessages(frame(), received);
    ref.current?.postMessage("early");
    await until(() => received.length > 0);
    ref.current?.postMessage("late");
    await until(() => received.length > 1);
    expect(received).toEqual(["early", "late"]);
  });
});
