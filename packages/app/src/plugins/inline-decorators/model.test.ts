import { describe, expect, it, vi } from "vitest";
import {
  combineLinkRecognition,
  createInlineDecorator,
  findInlineDecorator,
  resolveInlineDecoration,
  validateInlineDecoratorPattern,
} from "./model";

const BEAD = /\b(?:ft|pa)-[a-z0-9]{2,}(?:\.\d+)*\b/;

function decorator(overrides: Record<string, unknown> = {}) {
  return createInlineDecorator({ id: "bead", pattern: BEAD, onPress() {}, ...overrides }, "bead");
}

describe("inline decorator patterns", () => {
  it("rejects flags, lookbehind, empty matches and long patterns", () => {
    expect(() => validateInlineDecoratorPattern("a", /x/i)).toThrow("g flag");
    expect(() => validateInlineDecoratorPattern("a", /(?<=x)y/)).toThrow("lookbehind");
    expect(() => validateInlineDecoratorPattern("a", /x*/)).toThrow("empty");
    expect(() => validateInlineDecoratorPattern("a", new RegExp("x".repeat(201)))).toThrow(
      "longer",
    );
    expect(() => validateInlineDecoratorPattern("a", "pa-1")).toThrow("no pattern");
    expect(validateInlineDecoratorPattern("a", /pa-\d+/g)).toBe("pa-\\d+");
  });

  it("puts decorators before file paths and keeps the base patterns", () => {
    const base = { text: /files/g, inlineCode: /^(?:https?:\/\/\S+)$/ };
    const recognition = combineLinkRecognition(base, [
      decorator(),
      decorator({ inlineCode: false }),
    ]);
    expect(recognition.text?.source.startsWith(`(?:${BEAD.source})|`)).toBe(true);
    expect(recognition.text?.source.endsWith("|files")).toBe(true);
    expect(recognition.text?.flags).toBe("g");
    expect(recognition.inlineCode?.test("pa-k1q")).toBe(true);
    expect(recognition.inlineCode?.test("https://x.dev")).toBe(true);
    expect(recognition.inlineCode?.test("see pa-k1q")).toBe(false);
    expect(combineLinkRecognition(base, [])).toBe(base);
  });

  it("finds the decorator for a whole recognized match only", () => {
    const entries = [{ decorator: decorator() }];
    expect(findInlineDecorator(entries, "ft-0r5.4")).toBe(entries[0]);
    expect(findInlineDecorator(entries, "see ft-0r5.4")).toBeUndefined();
    expect(findInlineDecorator(entries, "src/app.ts")).toBeUndefined();
  });
});

describe("resolveInlineDecoration", () => {
  const match = { text: "pa-k1q", serverId: "local" };

  it("keeps null as plain text and undefined as a link without data", () => {
    expect(resolveInlineDecoration(decorator({ resolve: () => null }), match)).toBeNull();
    expect(resolveInlineDecoration(decorator({ resolve: () => undefined }), match)).toBeUndefined();
    expect(resolveInlineDecoration(decorator(), match)).toBeUndefined();
  });

  it("keeps known fields and drops unknown tones", () => {
    const resolve = () => ({ label: "pa-k1q", icon: "CircleDot", tone: "loud", tooltip: "Title" });
    expect(resolveInlineDecoration(decorator({ resolve }), match)).toEqual({
      label: "pa-k1q",
      icon: "CircleDot",
      tone: undefined,
      tooltip: "Title",
    });
  });

  it("reports a throwing resolver and falls back to a plain link", () => {
    const report = vi.fn();
    const resolve = () => {
      throw new Error("cache");
    };
    expect(resolveInlineDecoration(decorator({ resolve }), match, report)).toBeUndefined();
    expect(report).toHaveBeenCalledOnce();
  });
});

describe("invalidate", () => {
  it("bumps only the named texts, or everything when none are named", () => {
    const subject = decorator();
    const listener = vi.fn();
    subject.subscribe(listener);
    const before = [subject.getRevision("pa-a1"), subject.getRevision("pa-b2")];
    subject.invalidate(["pa-a1"]);
    expect(subject.getRevision("pa-a1")).not.toBe(before[0]);
    expect(subject.getRevision("pa-b2")).toBe(before[1]);
    subject.invalidate();
    expect(subject.getRevision("pa-b2")).not.toBe(before[1]);
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
