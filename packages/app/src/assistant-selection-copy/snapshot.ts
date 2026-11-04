import type { PluginTimelineSelection } from "@getpaseo/plugin/client";

export function freezeTimelineSelection(
  selection: PluginTimelineSelection,
): PluginTimelineSelection {
  return Object.freeze({
    text: selection.text,
    segments: Object.freeze(selection.segments.map((segment) => Object.freeze({ ...segment }))),
  });
}
