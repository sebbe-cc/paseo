import type {
  PluginTimelineSelection,
  PluginTimelineSelectionSegment,
} from "@getpaseo/plugin/client";
import { freezeTimelineSelection } from "./snapshot";

const SOURCE = "[data-timeline-item-id][data-timeline-surface-id]";

function sourceFor(node: Node): HTMLElement | null {
  const element = node instanceof Element ? node : node.parentElement;
  return element?.closest<HTMLElement>(SOURCE) ?? null;
}

export function snapshotTimelineSelection(
  selection: Selection | null,
  root: HTMLElement,
): PluginTimelineSelection | null {
  if (!selection || selection.rangeCount !== 1 || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  if (!selectionBelongsToRoot(range, root)) return null;
  const text = selection.toString();
  if (!text.trim()) return null;
  const segments: PluginTimelineSelectionSegment[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  let lastSource: HTMLElement | null = null;
  while (node) {
    const source = sourceFor(node);
    if (range.intersectsNode(node) && node.textContent && source) {
      const selected = document.createRange();
      selected.selectNodeContents(node);
      if (node === range.startContainer) selected.setStart(node, range.startOffset);
      if (node === range.endContainer) selected.setEnd(node, range.endOffset);
      const quote = selected.toString();
      if (quote) {
        const before = document.createRange();
        before.selectNodeContents(source);
        before.setEnd(selected.startContainer, selected.startOffset);
        const start = before.toString().length;
        const end = start + quote.length;
        const fullText = source.textContent ?? "";
        const previous = segments.at(-1);
        if (previous && lastSource === source) {
          segments[segments.length - 1] = {
            ...previous,
            text: previous.text + quote,
            end,
            suffix: fullText.slice(end, end + 32),
          };
        } else {
          segments.push({
            itemId: source.dataset.timelineItemId!,
            surfaceId: source.dataset.timelineSurfaceId!,
            text: quote,
            start,
            end,
            prefix: fullText.slice(Math.max(0, start - 32), start),
            suffix: fullText.slice(end, end + 32),
          });
        }
        lastSource = source;
      }
    }
    node = walker.nextNode();
  }
  return segments.length ? freezeTimelineSelection({ text, segments }) : null;
}

function selectionBelongsToRoot(range: Range, root: HTMLElement): boolean {
  const startSource = sourceFor(range.startContainer);
  const endSource = sourceFor(range.endContainer);
  if (!startSource || !endSource || !root.contains(startSource) || !root.contains(endSource))
    return false;
  if (
    startSource.closest("[data-timeline-selection-root]") !== root ||
    endSource.closest("[data-timeline-selection-root]") !== root
  )
    return false;
  return true;
}
