import { expect, test } from "vitest";
import type { ToolCallTimelineItem } from "../../agent/agent-sdk-types.js";
import { ToolCallHookTracker } from "./tool-call-events.js";

function running(callId: string, name = "read"): ToolCallTimelineItem {
  return {
    type: "tool_call",
    callId,
    name,
    status: "running",
    error: null,
    detail: { type: "read", filePath: "/repo/x.ts" },
  };
}

function terminal(
  callId: string,
  status: "completed" | "failed" | "canceled",
  name = "read",
): ToolCallTimelineItem {
  return {
    type: "tool_call",
    callId,
    name,
    status,
    error: status === "failed" ? { message: "boom" } : null,
    detail: { type: "read", filePath: "/repo/x.ts" },
  };
}

test("repeated running rows emit started once, terminal rows emit ended once", () => {
  const tracker = new ToolCallHookTracker();
  expect(tracker.noteTimelineItem("a", running("c1"), "t1")).toBe("started");
  expect(tracker.noteTimelineItem("a", running("c1"), "t1")).toBeNull();
  expect(tracker.noteTimelineItem("a", running("c1"), "t1")).toBeNull();
  expect(tracker.openCallCount("a")).toBe(1);
  expect(tracker.noteTimelineItem("a", terminal("c1", "completed"), "t1")).toBe("ended");
  expect(tracker.noteTimelineItem("a", terminal("c1", "completed"), "t1")).toBeNull();
  expect(tracker.openCallCount("a")).toBe(0);
});

test("a terminal row without a prior running row still ends once", () => {
  const tracker = new ToolCallHookTracker();
  expect(tracker.noteTimelineItem("a", terminal("c9", "failed"), "t1")).toBe("ended");
  expect(tracker.noteTimelineItem("a", terminal("c9", "failed"), "t1")).toBeNull();
});

test("interleaved parallel calls keep stable identities", () => {
  const tracker = new ToolCallHookTracker();
  expect(tracker.noteTimelineItem("a", running("c1", "read"), "t1")).toBe("started");
  expect(tracker.noteTimelineItem("a", running("c2", "shell"), "t1")).toBe("started");
  expect(tracker.noteTimelineItem("a", terminal("c2", "completed", "shell"), "t1")).toBe("ended");
  expect(tracker.noteTimelineItem("a", terminal("c1", "canceled", "read"), "t1")).toBe("ended");
  expect(tracker.openCallCount("a")).toBe(0);
});

test("closeTurn synthesizes ends for its own turn only", () => {
  const tracker = new ToolCallHookTracker();
  tracker.noteTimelineItem("a", running("c1"), "t1");
  tracker.noteTimelineItem("a", running("c2"), "t2");
  const closed = tracker.closeTurn("a", "t1");
  expect(closed.map((call) => call.callId)).toEqual(["c1"]);
  expect(closed[0]?.turnId).toBe("t1");
  expect(closed[0]?.detail).toEqual({ type: "read", filePath: "/repo/x.ts" });
  expect(tracker.openCallCount("a")).toBe(1);
  // A late terminal row for the synthesized call is a re-emission, not a second end.
  expect(tracker.noteTimelineItem("a", terminal("c1", "completed"), "t1")).toBeNull();
  expect(tracker.closeTurn("a", "t1")).toEqual([]);
});

test("calls without a turn close under a null turn", () => {
  const tracker = new ToolCallHookTracker();
  tracker.noteTimelineItem("a", running("c1"), null);
  expect(tracker.closeTurn("a", null).map((call) => call.callId)).toEqual(["c1"]);
});

test("dropAgent clears open and settled state", () => {
  const tracker = new ToolCallHookTracker();
  tracker.noteTimelineItem("a", running("c1"), "t1");
  tracker.noteTimelineItem("a", terminal("c1", "completed"), "t1");
  tracker.dropAgent("a");
  expect(tracker.noteTimelineItem("a", running("c1"), "t2")).toBe("started");
  expect(tracker.noteTimelineItem("a", terminal("c1", "completed"), "t2")).toBe("ended");
});

test("state is tracked per agent", () => {
  const tracker = new ToolCallHookTracker();
  tracker.noteTimelineItem("a", running("c1"), "t1");
  expect(tracker.noteTimelineItem("b", running("c1"), "t1")).toBe("started");
  expect(tracker.openCallCount("a")).toBe(1);
  expect(tracker.openCallCount("b")).toBe(1);
});
