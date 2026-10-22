import { afterEach, describe, expect, it } from "vitest";
import { snapshotTimelineSelection } from "./selection.web";

function mount(markup: string): HTMLElement {
  const root = document.createElement("div");
  root.dataset.timelineSelectionRoot = "";
  root.innerHTML = markup;
  document.body.append(root);
  return root;
}

function select(
  start: Node,
  startOffset: number,
  end = start,
  endOffset = start.textContent!.length,
) {
  const range = document.createRange();
  range.setStart(start, startOffset);
  range.setEnd(end, endOffset);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  return selection;
}

function text(root: HTMLElement, selector: string): Node {
  return root.querySelector(selector)!.firstChild!;
}

afterEach(() => {
  window.getSelection()?.removeAllRanges();
  document.body.replaceChildren();
});

describe("timeline selection snapshots", () => {
  it("keeps repeated text offsets and freezes streamed text before focus changes", () => {
    const root = mount(
      '<div data-timeline-item-id="one" data-timeline-surface-id="assistant_message">same then same tail</div>',
    );
    const node = root.firstChild!.firstChild!;
    const snapshot = snapshotTimelineSelection(select(node, 10, node, 14), root)!;
    expect(snapshot).toEqual({
      text: "same",
      segments: [
        {
          itemId: "one",
          surfaceId: "assistant_message",
          text: "same",
          start: 10,
          end: 14,
          prefix: "same then ",
          suffix: " tail",
        },
      ],
    });
    node.textContent = "streamed replacement";
    window.getSelection()!.removeAllRanges();
    expect(snapshot.text).toBe("same");
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.segments[0])).toBe(true);
  });

  it("keeps exact browser quote and source order across message, code and tool rows", () => {
    const root = mount(
      '<div data-timeline-item-id="one" data-timeline-surface-id="assistant_message"><p id="first">before quote</p><pre id="code">x = 1;\ny = 2;</pre></div><div data-timeline-item-id="two" data-timeline-surface-id="tool_call"><p id="last">tool result</p></div>',
    );
    const selection = select(text(root, "#first"), 7, text(root, "#last"), 4);
    const exact = selection.toString();
    const snapshot = snapshotTimelineSelection(selection, root)!;
    expect(snapshot.text).toBe(exact);
    expect(snapshot.text).toContain("x = 1;\ny = 2;");
    expect(snapshot.segments.map((segment) => segment.itemId)).toEqual(["one", "two"]);
    expect(snapshot.segments[1].text).toBe("tool");
  });

  it("uses the inner tool identity inside grouped rows", () => {
    const root = mount(
      '<div data-timeline-item-id="group" data-timeline-surface-id="tool_call"><span id="label">Group</span><div data-timeline-item-id="actual-tool" data-timeline-surface-id="tool_call"><code id="result">result text</code></div></div>',
    );
    const snapshot = snapshotTimelineSelection(select(text(root, "#result"), 0), root)!;
    expect(snapshot.segments[0].itemId).toBe("actual-tool");
  });

  it("rejects selections extending into another timeline or composer", () => {
    const root = mount(
      '<div data-timeline-item-id="one" data-timeline-surface-id="message">first</div>',
    );
    const other = mount(
      '<div data-timeline-item-id="two" data-timeline-surface-id="message">second</div>',
    );
    expect(
      snapshotTimelineSelection(
        select(root.firstChild!.firstChild!, 0, other.firstChild!.firstChild!, 3),
        root,
      ),
    ).toBeNull();
    const composer = document.createElement("span");
    composer.textContent = "draft";
    root.append(composer);
    expect(
      snapshotTimelineSelection(
        select(root.firstChild!.firstChild!, 0, composer.firstChild!, 3),
        root,
      ),
    ).toBeNull();
  });

  it("rejects collapsed and whitespace selections", () => {
    const root = mount(
      '<div data-timeline-item-id="one" data-timeline-surface-id="message">  text</div>',
    );
    const node = root.firstChild!.firstChild!;
    expect(snapshotTimelineSelection(select(node, 0, node, 0), root)).toBeNull();
    expect(snapshotTimelineSelection(select(node, 0, node, 2), root)).toBeNull();
  });
});
