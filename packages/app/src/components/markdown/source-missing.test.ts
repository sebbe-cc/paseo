import { describe, expect, it } from "vitest";
import { collectAssistantFileLinkSources, prepareMarkdownSource } from "./source";

const ROOT = "/ws";

function delinked(source: string, missing: string[]): string {
  return prepareMarkdownSource(source, ROOT, {
    missingCandidatePaths: new Set(missing),
    deLinkMissing: true,
  }).render();
}

describe("collectAssistantFileLinkSources", () => {
  it("collects inline code, authored links, and prose paths", () => {
    const text = "See `task-a-summary.md` and [the plan](docs/plan.md) plus docs/other.md.";
    const sources = collectAssistantFileLinkSources(text, ROOT);
    expect(sources).toContainEqual({
      href: "task-a-summary.md",
      text: "task-a-summary.md",
      sourceType: "inline-code",
    });
    expect(sources).toContainEqual({ href: "docs/plan.md", text: "docs/plan.md" });
    expect(sources).toContainEqual({
      href: "docs/other.md",
      text: "docs/other.md",
      markup: "linkify",
    });
  });

  it("skips external links", () => {
    const sources = collectAssistantFileLinkSources("See https://example.com/x.md.", ROOT);
    expect(sources.filter((source) => source.href.includes("example.com"))).toEqual([]);
  });
});

describe("prepareMarkdownSource de-link", () => {
  it("leaves found links untouched", () => {
    const text = "See `task-a-summary.md` for details.";
    expect(delinked(text, [])).toBe(text);
  });

  it("renders a missing inline-code path as plain code with a mark", () => {
    expect(delinked("See `gone.md` for details.", ["gone.md"])).toBe(
      "See `gone.md` (saknas) for details.",
    );
  });

  it("renders a missing authored link as code with a mark", () => {
    expect(delinked("Read [the plan](docs/plan.md) today.", ["docs/plan.md"])).toBe(
      "Read `the plan` (saknas) today.",
    );
  });

  it("renders a missing prose path as code with a mark", () => {
    expect(delinked("See docs/plan.md for details.", ["docs/plan.md"])).toBe(
      "See `docs/plan.md` (saknas) for details.",
    );
  });

  it("keeps found siblings as links", () => {
    const text = "See `kept.md` and docs/plan.md.";
    expect(delinked(text, ["docs/plan.md"])).toBe("See `kept.md` and `docs/plan.md` (saknas).");
  });

  it("does not touch code fences or link labels", () => {
    const text = "```md\n`gone.md`\n```\n\n[`gone.md`](docs/plan.md)";
    expect(delinked(text, ["gone.md"])).toBe(text);
  });
});
