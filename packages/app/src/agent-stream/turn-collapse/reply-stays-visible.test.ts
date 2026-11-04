import { describe, expect, it } from "vitest";
import {
  prepareToolCallHistory,
  projectToolCallDetailLevel,
} from "@/tool-calls/detail-level/projection";
import type { StreamItem } from "@/types/stream";
import { collapseTurns, type CollapseTurnsInput } from "./model";

const at = new Date("2026-01-01T00:00:00.000Z");

function user(id: string): StreamItem {
  return { kind: "user_message", id, text: id, timestamp: at, turnId: "turn" };
}

function reply(id: string, text = id): StreamItem {
  return {
    kind: "assistant_message",
    id,
    text,
    timestamp: at,
    turnId: "turn",
  };
}

function thought(id: string): StreamItem {
  return { kind: "thought", id, text: id, timestamp: at, status: "ready", turnId: "turn" };
}

/** A Gas City work card as the app sees it: the gascity transformer replaced the call. */
function workCard(id: string): StreamItem {
  return {
    kind: "plugin",
    id,
    timestamp: at,
    pluginId: "gascity",
    pluginItemId: id,
    itemKind: "gascity-work-card",
    version: 1,
    data: {},
    turnId: "turn",
  } as StreamItem;
}

/**
 * The pa-2rx2y4 screenshot shape: thinking, Gas City work cards, then the long
 * trailing reply. In the app the reply had same-turn rows after it (no
 * terminating turn boundary), so the fold treated it as mid-turn text and hid
 * it with the fold.
 */
function screenshotTurn(): StreamItem[] {
  return [
    user("prompt"),
    thought("t1"),
    workCard("note-ft-me8i"),
    thought("t2"),
    workCard("show-ft-me8i"),
    thought("t3"),
    workCard("create-ft-1aoy"),
    workCard("update-ft-1aoy"),
    workCard("note-ft-vrg"),
    reply("answer", "Du har rätt: med en enda Dolt-server ..."),
  ];
}

function present(tail: StreamItem[], expandedHostIds: ReadonlySet<string> = new Set()) {
  const prepared = prepareToolCallHistory("overview", tail, false);
  const projection = projectToolCallDetailLevel({
    level: "overview",
    tail,
    head: [],
    preparedHistory: prepared,
    isTurnActive: false,
  });
  const input: CollapseTurnsInput = {
    tail: projection.tail,
    isLatestTurnOpen: false,
    expandedHostIds,
    getGroupedCalls: (itemId) => projection.groupsByHostId.get(itemId)?.run.calls,
  };
  return collapseTurns(input);
}

const ids = (items: StreamItem[]) => items.map((item) => item.id);

describe("pa-2rx2y4: assistant text stays outside the fold", () => {
  it("keeps the trailing reply after thinking and work cards at turn level", () => {
    const result = present(screenshotTurn());

    expect(ids(result.tail)).toEqual([
      "prompt",
      "t1",
      "note-ft-me8i",
      "t2",
      "show-ft-me8i",
      "t3",
      "create-ft-1aoy",
      "update-ft-1aoy",
      "note-ft-vrg",
      "answer",
    ]);
    expect(result.hostIdByHiddenRowId.has("answer")).toBe(false);
  });

  it("keeps mid-turn text visible at turn level when the turn folds", () => {
    const tail: StreamItem[] = [
      user("prompt"),
      thought("t1"),
      reply("mid", "mid-turn note"),
      workCard("note-x"),
      reply("answer", "final reply"),
    ];
    const result = present(tail);

    // Only work folds; both text blocks stay at turn level.
    expect(ids(result.tail)).toEqual(["prompt", "mid", "answer"]);
    expect(result.hostIdByHiddenRowId.has("mid")).toBe(false);
    expect(result.hostIdByHiddenRowId.has("answer")).toBe(false);
    expect(result.hostIdByHiddenRowId.get("note-x")).toBe("prompt");
  });

  it("nests only work rows inside an opened turn, never text", () => {
    const tail: StreamItem[] = [
      user("prompt"),
      thought("t1"),
      reply("mid", "mid-turn note"),
      workCard("note-x"),
      reply("answer", "final reply"),
    ];
    const open = present(tail, new Set(["prompt"]));

    expect(ids(open.tail)).toEqual(["prompt", "t1", "mid", "note-x", "answer"]);
    expect([...open.nestedItemIds]).toEqual(["t1", "note-x"]);
    expect(open.turnsByHostId.get("prompt")?.expanded).toBe(true);
  });
});
