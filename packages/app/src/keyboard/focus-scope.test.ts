import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveKeyboardFocusScope } from "./focus-scope";

class FakeNode {
  parentElement: FakeElement | null = null;
}

class FakeElement extends FakeNode {
  tagName: string;
  isContentEditable = false;
  private selectors: Set<string>;

  constructor(input?: { tagName?: string; selectors?: string[]; isContentEditable?: boolean }) {
    super();
    this.tagName = (input?.tagName ?? "div").toUpperCase();
    this.selectors = new Set(input?.selectors ?? []);
    if (input?.isContentEditable) {
      this.isContentEditable = true;
    }
  }

  closest(selector: string): FakeElement | null {
    if (this.selectors.has(selector)) {
      return this;
    }
    return this.parentElement?.closest(selector) ?? null;
  }
}

describe("resolveKeyboardFocusScope", () => {
  const globalRef = globalThis as {
    Element?: unknown;
    Node?: unknown;
    document?: { activeElement?: unknown };
  };
  const originalElement = globalRef.Element;
  const originalNode = globalRef.Node;
  const originalDocument = globalRef.document;

  beforeEach(() => {
    globalRef.Element = FakeElement;
    globalRef.Node = FakeNode;
    globalRef.document = { activeElement: null };
  });

  afterEach(() => {
    globalRef.Element = originalElement;
    globalRef.Node = originalNode;
    globalRef.document = originalDocument;
  });

  it("resolves terminal scope from the direct keyboard event target", () => {
    const target = new FakeElement({ selectors: [".xterm"] });
    const scope = resolveKeyboardFocusScope({
      target: target as unknown as EventTarget,
      commandCenterOpen: false,
    });
    expect(scope).toBe("terminal");
  });

  it("falls back to activeElement when target is not an Element", () => {
    const activeElement = new FakeElement({ selectors: [".xterm"] });
    globalRef.document = { activeElement };
    const scope = resolveKeyboardFocusScope({
      target: null,
      commandCenterOpen: false,
    });
    expect(scope).toBe("terminal");
  });

  it("detects editable scope from activeElement fallback", () => {
    const activeElement = new FakeElement({ tagName: "input" });
    globalRef.document = { activeElement };
    const scope = resolveKeyboardFocusScope({
      target: null,
      commandCenterOpen: false,
    });
    expect(scope).toBe("editable");
  });

  it("resolves list scope inside a keyboard list, but not for its text fields", () => {
    const list = new FakeElement({ selectors: ["[data-keyboard-list]"] });
    const row = new FakeElement();
    row.parentElement = list;
    const input = new FakeElement({ tagName: "input" });
    input.parentElement = list;
    const resolve = (target: FakeElement, commandCenterOpen = false) =>
      resolveKeyboardFocusScope({ target: target as unknown as EventTarget, commandCenterOpen });

    expect(resolve(row)).toBe("list");
    expect(resolve(input)).toBe("editable");
    expect(resolve(row, true)).toBe("command-center");
  });
});
