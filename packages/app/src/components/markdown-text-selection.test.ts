import { supportsNativeTimelineSelectionOn } from "@/assistant-selection-copy/native-capability";
import { describe, expect, it } from "vitest";
import { iosMarkdownTextIsSelectable } from "./markdown-text-selection";

describe("markdown text selection", () => {
  it("supports iOS patch versions from 16 while retaining the iOS 15 floor", () => {
    expect(supportsNativeTimelineSelectionOn("ios", "16.0.1")).toBe(true);
    expect(supportsNativeTimelineSelectionOn("ios", "27.0.1")).toBe(true);
    expect(supportsNativeTimelineSelectionOn("ios", "15.1")).toBe(false);
    expect(supportsNativeTimelineSelectionOn("android", 35)).toBe(true);
  });

  it("enables iOS table selection when timeline actions are registered", () => {
    expect(iosMarkdownTextIsSelectable("table-cell", true)).toBe(true);
  });

  it("uses plain text only for iOS table cells", () => {
    expect({
      tableCell: iosMarkdownTextIsSelectable("table-cell"),
      prose: iosMarkdownTextIsSelectable("prose"),
    }).toEqual({
      tableCell: false,
      prose: true,
    });
  });
});
