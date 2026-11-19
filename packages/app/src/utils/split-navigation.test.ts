import { describe, expect, it } from "vitest";
import type { SplitNode } from "@/stores/workspace-layout-store";
import { findAdjacentBounds, findAdjacentPane } from "./split-navigation";

function createPaneNode(id: string, hidden = false): SplitNode {
  return {
    kind: "pane",
    pane: {
      id,
      tabIds: [],
      focusedTabId: null,
      ...(hidden ? { hidden: true } : {}),
    },
  };
}

function createGroupNode(input: {
  direction: "horizontal" | "vertical";
  sizes: number[];
  children: SplitNode[];
}): SplitNode {
  return {
    kind: "group",
    group: {
      id: `${input.direction}-group`,
      direction: input.direction,
      sizes: input.sizes,
      children: input.children,
    },
  };
}

describe("findAdjacentPane", () => {
  it("finds direct horizontal and vertical neighbors in nested layouts", () => {
    const root = createGroupNode({
      direction: "horizontal",
      sizes: [0.25, 0.5, 0.25],
      children: [
        createPaneNode("left"),
        createGroupNode({
          direction: "vertical",
          sizes: [0.5, 0.5],
          children: [createPaneNode("top-middle"), createPaneNode("bottom-middle")],
        }),
        createPaneNode("right"),
      ],
    });

    expect(findAdjacentPane(root, "top-middle", "left")).toBe("left");
    expect(findAdjacentPane(root, "top-middle", "right")).toBe("right");
    expect(findAdjacentPane(root, "top-middle", "down")).toBe("bottom-middle");
    expect(findAdjacentPane(root, "bottom-middle", "up")).toBe("top-middle");
  });

  it("returns null when there is no pane in the requested direction", () => {
    const root = createGroupNode({
      direction: "horizontal",
      sizes: [0.5, 0.5],
      children: [createPaneNode("left"), createPaneNode("right")],
    });

    expect(findAdjacentPane(root, "left", "left")).toBeNull();
    expect(findAdjacentPane(root, "right", "right")).toBeNull();
    expect(findAdjacentPane(root, "left", "up")).toBeNull();
  });

  it("prefers the closest overlapping pane when multiple candidates exist", () => {
    const root = createGroupNode({
      direction: "vertical",
      sizes: [0.5, 0.5],
      children: [
        createPaneNode("top"),
        createGroupNode({
          direction: "horizontal",
          sizes: [0.5, 0.5],
          children: [createPaneNode("bottom-left"), createPaneNode("bottom-right")],
        }),
      ],
    });

    expect(findAdjacentPane(root, "top", "down")).toBe("bottom-left");
    expect(findAdjacentPane(root, "bottom-right", "up")).toBe("top");
  });

  it("skips hidden panes", () => {
    const root = createGroupNode({
      direction: "horizontal",
      sizes: [0.3, 0.3, 0.4],
      children: [createPaneNode("left"), createPaneNode("hidden", true), createPaneNode("right")],
    });

    expect(findAdjacentPane(root, "left", "right")).toBe("right");
    expect(findAdjacentPane(root, "hidden", "right")).toBeNull();
  });
});

describe("findAdjacentBounds", () => {
  const box = (paneId: string, left: number, top: number, right: number, bottom: number) => ({
    paneId,
    left,
    top,
    right,
    bottom,
    centerX: (left + right) / 2,
    centerY: (top + bottom) / 2,
  });
  // Sidebar | two stacked panes | Explorer, in pixels; edges are off by a rounding pixel.
  const bounds = [
    box("sidebar", 0, 0, 240, 800),
    box("top", 240.5, 0, 1000, 400.5),
    box("bottom", 240.5, 400, 1000, 800),
    box("explorer", 1000, 0, 1300, 800),
  ];

  it("walks sidebar, panes and Explorer by screen position", () => {
    expect(findAdjacentBounds(bounds, "top", "left", 1)).toBe("sidebar");
    expect(findAdjacentBounds(bounds, "top", "right", 1)).toBe("explorer");
    expect(findAdjacentBounds(bounds, "top", "down", 1)).toBe("bottom");
    expect(findAdjacentBounds(bounds, "bottom", "up", 1)).toBe("top");
    expect(findAdjacentBounds(bounds, "sidebar", "right", 1)).toBe("top");
  });

  it("returns null at an edge", () => {
    expect(findAdjacentBounds(bounds, "sidebar", "left", 1)).toBeNull();
    expect(findAdjacentBounds(bounds, "explorer", "right", 1)).toBeNull();
    expect(findAdjacentBounds(bounds, "top", "up", 1)).toBeNull();
  });

  it("drops overlapping neighbours without a pixel of tolerance", () => {
    expect(findAdjacentBounds(bounds, "bottom", "up")).toBeNull();
  });
});
