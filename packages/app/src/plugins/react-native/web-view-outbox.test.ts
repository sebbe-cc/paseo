import { describe, expect, it } from "vitest";
import { createWebViewOutbox } from "./web-view-outbox";

describe("createWebViewOutbox", () => {
  it("holds messages until the document has loaded, then delivers them in order", () => {
    const delivered: string[] = [];
    const outbox = createWebViewOutbox((data) => delivered.push(data));
    outbox.post("one");
    outbox.post("two");
    expect(delivered).toEqual([]);
    outbox.loaded();
    expect(delivered).toEqual(["one", "two"]);
    outbox.post("three");
    expect(delivered).toEqual(["one", "two", "three"]);
  });

  it("holds messages again after a new document starts loading", () => {
    const delivered: string[] = [];
    const outbox = createWebViewOutbox((data) => delivered.push(data));
    outbox.loaded();
    outbox.reset();
    outbox.post("for the next document");
    expect(delivered).toEqual([]);
    outbox.loaded();
    expect(delivered).toEqual(["for the next document"]);
  });
});
