import { describe, expect, it } from "vitest";
import { allowsWebViewNavigation } from "./web-view-navigation";

describe("allowsWebViewNavigation", () => {
  it("lets the top frame load the initial document and fragments", () => {
    expect(allowsWebViewNavigation({ url: "about:blank", isTopFrame: true })).toBe(true);
    expect(allowsWebViewNavigation({ url: "about:srcdoc", isTopFrame: true })).toBe(true);
    expect(allowsWebViewNavigation({ url: "", isTopFrame: true })).toBe(true);
    expect(allowsWebViewNavigation({ url: "about:blank#section", isTopFrame: true })).toBe(true);
  });

  it("refuses every other top-frame navigation", () => {
    expect(allowsWebViewNavigation({ url: "https://example.com/leak", isTopFrame: true })).toBe(
      false,
    );
    expect(allowsWebViewNavigation({ url: "data:text/html,<p>x</p>", isTopFrame: true })).toBe(
      false,
    );
    expect(allowsWebViewNavigation({ url: "blob:https://example.com/id", isTopFrame: true })).toBe(
      false,
    );
  });

  it("leaves sub-frame loads to the page's own policy", () => {
    expect(allowsWebViewNavigation({ url: "about:srcdoc", isTopFrame: false })).toBe(true);
    expect(allowsWebViewNavigation({ url: "https://example.com/embed", isTopFrame: false })).toBe(
      true,
    );
  });

  it("holds a request without frame information to the top-frame rule", () => {
    expect(allowsWebViewNavigation({ url: "about:srcdoc", isTopFrame: undefined })).toBe(true);
    expect(
      allowsWebViewNavigation({ url: "https://example.com/leak", isTopFrame: undefined }),
    ).toBe(false);
  });
});
