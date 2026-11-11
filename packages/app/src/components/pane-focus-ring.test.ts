import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  PANE_FOCUS_RING_TEST_ID,
  resolvePaneFocusRingVisible,
} from "./pane-focus-ring";

function readSource(path: string): string {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

function rendersComponent(source: string, name: string): boolean {
  const file = ts.createSourceFile("check.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let found = false;
  function visit(node: ts.Node) {
    if (
      (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) &&
      node.tagName.getText(file) === name
    ) {
      found = true;
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return found;
}

describe("resolvePaneFocusRingVisible", () => {
  it("shows the ring only when the pane and its workspace route are both focused", () => {
    expect(resolvePaneFocusRingVisible({ isWorkspaceFocused: true, isPaneFocused: true })).toBe(
      true,
    );
    expect(resolvePaneFocusRingVisible({ isWorkspaceFocused: true, isPaneFocused: false })).toBe(
      false,
    );
    expect(resolvePaneFocusRingVisible({ isWorkspaceFocused: false, isPaneFocused: true })).toBe(
      false,
    );
    expect(resolvePaneFocusRingVisible({ isWorkspaceFocused: false, isPaneFocused: false })).toBe(
      false,
    );
  });
});

describe("pane focus ring placement", () => {
  it("names the shared test id for the default ring", () => {
    expect(PANE_FOCUS_RING_TEST_ID).toBe("pane-focus-ring");
  });

  it("renders the ring in every desktop workspace pane", () => {
    const source = readSource("./split-container.tsx");
    expect(rendersComponent(source, "PaneFocusRing")).toBe(true);
    expect(source).toContain("resolvePaneFocusRingVisible");
  });

  it("renders the ring in the explorer sidebar dock", () => {
    const source = readSource("../screens/workspace/explorer-sidebar.tsx");
    expect(rendersComponent(source, "PaneFocusRing")).toBe(true);
    expect(source).toContain("testID=\"workspace-explorer-focus-ring\"");
  });

  it("threads real pane focus into the explorer dock instead of a hardcoded true", () => {
    const dockSource = readSource("../screens/workspace/explorer-sidebar.tsx");
    expect(dockSource).toContain("isPaneFocused={isPaneFocused}");
    expect(dockSource).not.toMatch(/isPaneFocused\s*\n/);
    const screenSource = readSource("../screens/workspace/workspace-screen.tsx");
    expect(screenSource).toContain("isExplorerPaneFocused");
    expect(screenSource).toContain("onFocusPane={handleFocusPane}");
  });
});
