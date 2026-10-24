import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { HostFenceError } from "../plugins/host-inventory-fence.js";

import type { AgentProvider, AgentStreamEvent } from "./agent-sdk-types.js";
import {
  AGENT_STREAM_COALESCE_DEFAULT_WINDOW_MS,
  AGENT_FENCE_QUEUE_BYTES,
  GLOBAL_FENCE_QUEUE_BYTES,
  AgentStreamCoalescer,
  type AgentStreamCoalescerFlush,
  type AgentStreamCoalescerTimers,
} from "./agent-stream-coalescer.js";

function createHarness(windowMs?: number) {
  const flushes: AgentStreamCoalescerFlush[] = [];
  const timers: AgentStreamCoalescerTimers = {
    setTimeout,
    clearTimeout,
  };
  const coalescer = new AgentStreamCoalescer({
    ...(windowMs !== undefined ? { windowMs } : {}),
    timers,
    onFlush: (payload) => {
      flushes.push(payload);
    },
  });

  return { coalescer, flushes };
}

// Consume the leading-edge flush for an agent and clear it from the record, so a
// test can assert trailing-window batching on its own. Leaves the coalescer
// inside the window, which is where the trailing timer governs.
function primeLeadingEdge(
  coalescer: AgentStreamCoalescer,
  flushes: AgentStreamCoalescerFlush[],
  agentId = "agent-1",
): void {
  coalescer.handle(agentId, assistant("prime"));
  const index = flushes.findIndex(
    (flush) => flush.agentId === agentId && flush.item.type === "assistant_message",
  );
  if (index === -1) {
    throw new Error(`expected a leading-edge flush for ${agentId}`);
  }
  flushes.splice(index, 1);
}

function timeline(
  item: Extract<AgentStreamEvent, { type: "timeline" }>["item"],
  options?: {
    provider?: AgentProvider;
    turnId?: string;
  },
): Extract<AgentStreamEvent, { type: "timeline" }> {
  return {
    type: "timeline",
    item,
    provider: options?.provider ?? "codex",
    ...(options?.turnId !== undefined ? { turnId: options.turnId } : {}),
  };
}

function assistant(
  text: string,
  options?: {
    provider?: AgentProvider;
    turnId?: string;
    messageId?: string;
  },
): Extract<AgentStreamEvent, { type: "timeline" }> {
  return timeline(
    {
      type: "assistant_message",
      text,
      ...(options?.messageId !== undefined ? { messageId: options.messageId } : {}),
    },
    options,
  );
}

function reasoning(
  text: string,
  options?: {
    provider?: AgentProvider;
    turnId?: string;
  },
): Extract<AgentStreamEvent, { type: "timeline" }> {
  return timeline({ type: "reasoning", text }, options);
}

function toolCall(options?: {
  callId?: string;
  status?: "running" | "completed" | "failed" | "canceled";
  output?: string;
  provider?: AgentProvider;
  turnId?: string;
  error?: unknown;
}): Extract<AgentStreamEvent, { type: "timeline" }> {
  const status = options?.status ?? "running";
  return timeline(
    {
      type: "tool_call",
      callId: options?.callId ?? "tool-1",
      name: "shell",
      status,
      error: status === "failed" ? (options?.error ?? "failed") : null,
      detail: {
        type: "shell",
        command: "printf ok",
        output: options?.output ?? "",
        exitCode: status === "completed" ? 0 : null,
      },
    },
    options,
  );
}

describe("AgentStreamCoalescer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("a blocked timer warns once, interrupts at 30 seconds and can resume", () => {
    const errors = vi.fn();
    const saturated = vi.fn();
    const flushes: AgentStreamCoalescerFlush[] = [];
    let blocked = true;
    const coalescer = new AgentStreamCoalescer({
      timers: { setTimeout, clearTimeout },
      onError: errors,
      onSaturated: saturated,
      onFlush: (payload) => {
        if (blocked && payload.agentId === "blocked")
          throw new HostFenceError("HOST_FENCE_BUSY", "publication");
        flushes.push(payload);
      },
    });
    coalescer.handle("blocked", assistant("queued"));
    coalescer.handle("other", assistant("unaffected"));
    vi.advanceTimersByTime(29_999);
    expect(errors).toHaveBeenCalledTimes(1);
    expect(saturated).not.toHaveBeenCalled();
    vi.advanceTimersByTime(61);
    expect(saturated).toHaveBeenCalledExactlyOnceWith(
      "blocked",
      expect.objectContaining({ code: "HOST_FENCE_SATURATED" }),
    );
    expect(flushes.map((row) => row.agentId)).toEqual(["other"]);
    blocked = false;
    coalescer.handle("blocked", assistant("resumed"));
    expect(flushes.map((row) => row.item)).toEqual([
      assistant("unaffected").item,
      assistant("resumed").item,
    ]);
    coalescer.flushAll();
  });

  test("per-agent and global byte ceilings report saturation without growing the backlog", () => {
    const saturated = vi.fn();
    const coalescer = new AgentStreamCoalescer({
      timers: { setTimeout, clearTimeout },
      onSaturated: saturated,
      onFlush: () => {
        throw new HostFenceError("HOST_FENCE_BUSY", "publication");
      },
    });
    coalescer.handle("oversized", assistant("x".repeat(AGENT_FENCE_QUEUE_BYTES)));
    expect(saturated).toHaveBeenCalledExactlyOnceWith(
      "oversized",
      expect.objectContaining({ code: "HOST_FENCE_SATURATED" }),
    );
    saturated.mockClear();
    const count = GLOBAL_FENCE_QUEUE_BYTES / AGENT_FENCE_QUEUE_BYTES;
    for (let i = 0; i <= count; i++)
      coalescer.handle(`agent-${i}`, assistant("x".repeat(AGENT_FENCE_QUEUE_BYTES / 2 - 1024)));
    expect(saturated).toHaveBeenCalledExactlyOnceWith(
      `agent-${count}`,
      expect.objectContaining({ code: "HOST_FENCE_SATURATED" }),
    );
    for (let i = 0; i <= count; i++) coalescer.discard(`agent-${i}`);
    expect(vi.getTimerCount()).toBe(0);
  });

  test("timer callback errors are reported without replaying already committed rows", () => {
    const onError = vi.fn();
    const rows: string[] = [];
    const coalescer = new AgentStreamCoalescer({
      timers: { setTimeout, clearTimeout },
      onError,
      onFlush: ({ item }) => {
        rows.push(item.type);
        if (rows.length === 2) throw new Error("subscriber failed after commit");
      },
    });
    coalescer.handle("agent", assistant("first"));
    coalescer.handle("agent", assistant("second"));
    expect(() => vi.advanceTimersByTime(60)).not.toThrow();
    expect(onError).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ message: "subscriber failed after commit" }),
      "agent",
    );
    coalescer.flushFor("agent");
    expect(rows).toEqual(["assistant_message", "assistant_message"]);
  });

  test("flushes the first chunk of a burst on the leading edge", () => {
    const { coalescer, flushes } = createHarness();

    expect(coalescer.handle("agent-1", assistant("hel"))).toBe(true);
    expect(flushes).toEqual([
      {
        agentId: "agent-1",
        item: { type: "assistant_message", text: "hel" },
        provider: "codex",
      },
    ]);
  });

  test("coalesces the rest of a burst until the configured window elapses", async () => {
    const { coalescer, flushes } = createHarness();
    primeLeadingEdge(coalescer, flushes);

    expect(coalescer.handle("agent-1", assistant("hel"))).toBe(true);
    expect(coalescer.handle("agent-1", assistant("lo"))).toBe(true);

    expect(flushes).toEqual([]);
    await vi.advanceTimersByTimeAsync(59);
    expect(flushes).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    expect(flushes).toEqual([
      {
        agentId: "agent-1",
        item: { type: "assistant_message", text: "hello" },
        provider: "codex",
      },
    ]);
  });

  test("leads again after an idle window", async () => {
    const { coalescer, flushes } = createHarness();

    coalescer.handle("agent-1", assistant("first"));
    expect(flushes).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(60);
    coalescer.handle("agent-1", assistant("second"));

    expect(flushes.map((flush) => flush.item)).toEqual([
      { type: "assistant_message", text: "first" },
      { type: "assistant_message", text: "second" },
    ]);
  });

  test("uses constructor windowMs instead of a hard-coded value", async () => {
    const { coalescer, flushes } = createHarness(10);

    expect(AGENT_STREAM_COALESCE_DEFAULT_WINDOW_MS).toBe(60);
    primeLeadingEdge(coalescer, flushes);
    expect(coalescer.handle("agent-1", assistant("fast"))).toBe(true);

    await vi.advanceTimersByTimeAsync(9);
    expect(flushes).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    expect(flushes).toEqual([
      {
        agentId: "agent-1",
        item: { type: "assistant_message", text: "fast" },
        provider: "codex",
      },
    ]);
  });

  test("flushFor drains pending coalesced events", () => {
    const { coalescer, flushes } = createHarness();

    expect(coalescer.handle("agent-1", assistant("before"))).toBe(true);
    coalescer.flushFor("agent-1");

    expect(flushes).toEqual([
      {
        agentId: "agent-1",
        item: { type: "assistant_message", text: "before" },
        provider: "codex",
      },
    ]);
    expect(coalescer.handle("agent-1", toolCall())).toBe(true);
  });

  test("does not consume non-chunkable events", () => {
    const { coalescer, flushes } = createHarness();
    const nonChunkableEvents: AgentStreamEvent[] = [
      timeline({ type: "todo", items: [{ text: "ship it", completed: false }] }),
      timeline({ type: "user_message", text: "hi", messageId: "message-1" }),
      timeline({ type: "error", message: "boom" }),
      timeline({ type: "compaction", status: "loading", trigger: "auto" }),
      { type: "thread_started", provider: "codex", sessionId: "session-1" },
      { type: "turn_started", provider: "codex", turnId: "turn-1" },
      { type: "turn_completed", provider: "codex", turnId: "turn-1" },
      { type: "turn_failed", provider: "codex", error: "failed", turnId: "turn-1" },
      { type: "turn_canceled", provider: "codex", reason: "canceled", turnId: "turn-1" },
      { type: "usage_updated", provider: "codex", usage: { inputTokens: 1 }, turnId: "turn-1" },
      {
        type: "permission_requested",
        provider: "codex",
        turnId: "turn-1",
        request: {
          id: "permission-1",
          provider: "codex",
          name: "shell",
          kind: "tool",
        },
      },
      {
        type: "permission_resolved",
        provider: "codex",
        turnId: "turn-1",
        requestId: "permission-1",
        resolution: { behavior: "allow" },
      },
      {
        type: "attention_required",
        provider: "codex",
        reason: "permission",
        timestamp: "2026-04-18T00:00:00.000Z",
      },
    ];

    for (const event of nonChunkableEvents) {
      expect(coalescer.handle("agent-1", event)).toBe(false);
    }
    expect(flushes).toEqual([]);
  });

  test("preserves kind boundaries", async () => {
    const { coalescer, flushes } = createHarness();

    coalescer.handle("agent-1", assistant("a1"));
    coalescer.handle("agent-1", reasoning("r1"));
    coalescer.handle("agent-1", assistant("a2"));

    await vi.advanceTimersByTimeAsync(60);
    expect(flushes).toEqual([
      {
        agentId: "agent-1",
        item: { type: "assistant_message", text: "a1" },
        provider: "codex",
      },
      {
        agentId: "agent-1",
        item: { type: "reasoning", text: "r1" },
        provider: "codex",
      },
      {
        agentId: "agent-1",
        item: { type: "assistant_message", text: "a2" },
        provider: "codex",
      },
    ]);
  });

  test("preserves strict alternating assistant/reasoning order", async () => {
    const { coalescer, flushes } = createHarness();

    coalescer.handle("agent-1", assistant("a1"));
    coalescer.handle("agent-1", reasoning("r1"));
    coalescer.handle("agent-1", assistant("a2"));
    coalescer.handle("agent-1", reasoning("r2"));

    await vi.advanceTimersByTimeAsync(60);
    expect(flushes.map((flush) => flush.item)).toEqual([
      { type: "assistant_message", text: "a1" },
      { type: "reasoning", text: "r1" },
      { type: "assistant_message", text: "a2" },
      { type: "reasoning", text: "r2" },
    ]);
  });

  test("does not collapse across provider boundaries", async () => {
    const { coalescer, flushes } = createHarness();

    coalescer.handle("agent-1", assistant("c", { provider: "codex" }));
    coalescer.handle("agent-1", assistant("o", { provider: "opencode" }));

    await vi.advanceTimersByTimeAsync(60);
    expect(flushes).toEqual([
      {
        agentId: "agent-1",
        item: { type: "assistant_message", text: "c" },
        provider: "codex",
      },
      {
        agentId: "agent-1",
        item: { type: "assistant_message", text: "o" },
        provider: "opencode",
      },
    ]);
  });

  test("does not collapse across turnId boundaries", async () => {
    const { coalescer, flushes } = createHarness();

    coalescer.handle("agent-1", assistant("one", { turnId: "turn-1" }));
    coalescer.handle("agent-1", assistant("two", { turnId: "turn-2" }));

    await vi.advanceTimersByTimeAsync(60);
    expect(flushes).toEqual([
      {
        agentId: "agent-1",
        item: { type: "assistant_message", text: "one" },
        provider: "codex",
        turnId: "turn-1",
      },
      {
        agentId: "agent-1",
        item: { type: "assistant_message", text: "two" },
        provider: "codex",
        turnId: "turn-2",
      },
    ]);
  });

  test("does not splice concurrent assistant message ids together", async () => {
    const { coalescer, flushes } = createHarness();

    coalescer.handle("agent-1", assistant("The", { turnId: "turn-1", messageId: "message-a" }));
    coalescer.handle("agent-1", assistant("0po", { turnId: "turn-1", messageId: "message-b" }));
    coalescer.handle("agent-1", assistant(" exact", { turnId: "turn-1", messageId: "message-a" }));
    coalescer.handle("agent-1", assistant("7/fr", { turnId: "turn-1", messageId: "message-b" }));

    await vi.advanceTimersByTimeAsync(60);
    expect(flushes.map((flush) => flush.item)).toEqual([
      { type: "assistant_message", messageId: "message-a", text: "The" },
      { type: "assistant_message", messageId: "message-b", text: "0po" },
      { type: "assistant_message", messageId: "message-a", text: " exact" },
      { type: "assistant_message", messageId: "message-b", text: "7/fr" },
    ]);
  });

  test("drops empty text chunks", async () => {
    const { coalescer, flushes } = createHarness();

    expect(coalescer.handle("agent-1", assistant(""))).toBe(true);
    expect(coalescer.handle("agent-2", reasoning(""))).toBe(true);

    await vi.advanceTimersByTimeAsync(60);
    expect(flushes).toEqual([]);
  });

  test("preserves whitespace byte-exactly", async () => {
    const { coalescer, flushes } = createHarness();
    primeLeadingEdge(coalescer, flushes);

    coalescer.handle("agent-1", assistant(" "));
    coalescer.handle("agent-1", assistant("\n"));
    coalescer.handle("agent-1", assistant("\t"));
    coalescer.handle("agent-1", assistant(" mixed \n\t whitespace "));

    await vi.advanceTimersByTimeAsync(60);
    expect(flushes).toEqual([
      {
        agentId: "agent-1",
        item: {
          type: "assistant_message",
          text: " \n\t mixed \n\t whitespace ",
        },
        provider: "codex",
      },
    ]);
  });

  test("reconstructs bytes exactly for fragmented text", async () => {
    const { coalescer, flushes } = createHarness();
    primeLeadingEdge(coalescer, flushes);
    const text = "Hello, 世界.\nPunctuation: ,.!?;: — but JS strings stay intact.\n";
    const chunks = [
      "Hello",
      ", ",
      "世界",
      ".\n",
      "Punctuation: ,.!?;: ",
      "—",
      " but JS strings stay intact.\n",
    ];

    for (const chunk of chunks) {
      coalescer.handle("agent-1", assistant(chunk));
    }

    await vi.advanceTimersByTimeAsync(60);
    expect(flushes).toEqual([
      {
        agentId: "agent-1",
        item: { type: "assistant_message", text },
        provider: "codex",
      },
    ]);
  });

  test("isolates buffers per agent", async () => {
    const { coalescer, flushes } = createHarness();
    primeLeadingEdge(coalescer, flushes, "agent-1");
    primeLeadingEdge(coalescer, flushes, "agent-2");

    coalescer.handle("agent-1", assistant("a"));
    coalescer.handle("agent-2", assistant("x"));
    coalescer.handle("agent-1", assistant("b"));
    coalescer.handle("agent-2", assistant("y"));

    await vi.advanceTimersByTimeAsync(60);
    expect(flushes).toEqual([
      {
        agentId: "agent-1",
        item: { type: "assistant_message", text: "ab" },
        provider: "codex",
      },
      {
        agentId: "agent-2",
        item: { type: "assistant_message", text: "xy" },
        provider: "codex",
      },
    ]);
  });

  test("flushAll flushes every pending agent once", () => {
    const { coalescer, flushes } = createHarness();

    coalescer.handle("agent-1", assistant("a"));
    coalescer.handle("agent-2", assistant("b"));

    coalescer.flushAll();
    coalescer.flushAll();

    expect(flushes).toEqual([
      {
        agentId: "agent-1",
        item: { type: "assistant_message", text: "a" },
        provider: "codex",
      },
      {
        agentId: "agent-2",
        item: { type: "assistant_message", text: "b" },
        provider: "codex",
      },
    ]);
  });

  test("flushFor is idempotent", () => {
    const { coalescer, flushes } = createHarness();

    coalescer.handle("agent-1", assistant("once"));
    coalescer.flushFor("agent-1");
    coalescer.flushFor("agent-1");

    expect(flushes).toEqual([
      {
        agentId: "agent-1",
        item: { type: "assistant_message", text: "once" },
        provider: "codex",
      },
    ]);
  });

  test("chunks appended during onFlush use a later buffer", async () => {
    const flushes: AgentStreamCoalescerFlush[] = [];
    let coalescer!: AgentStreamCoalescer;
    coalescer = new AgentStreamCoalescer({
      timers: {
        setTimeout,
        clearTimeout,
      },
      onFlush: (payload) => {
        flushes.push(payload);
        if (payload.agentId === "agent-1" && payload.item.text === "first") {
          coalescer.handle("agent-1", assistant("second"));
        }
      },
    });

    primeLeadingEdge(coalescer, flushes);
    coalescer.handle("agent-1", assistant("first"));
    coalescer.flushFor("agent-1");

    expect(flushes).toEqual([
      {
        agentId: "agent-1",
        item: { type: "assistant_message", text: "first" },
        provider: "codex",
      },
    ]);

    await vi.advanceTimersByTimeAsync(60);
    expect(flushes).toEqual([
      {
        agentId: "agent-1",
        item: { type: "assistant_message", text: "first" },
        provider: "codex",
      },
      {
        agentId: "agent-1",
        item: { type: "assistant_message", text: "second" },
        provider: "codex",
      },
    ]);
  });

  test("manual flush prevents late duplicate output after timers advance", async () => {
    const { coalescer, flushes } = createHarness();

    coalescer.handle("agent-1", assistant("manual"));
    coalescer.flushFor("agent-1");

    await vi.advanceTimersByTimeAsync(60);
    expect(flushes).toEqual([
      {
        agentId: "agent-1",
        item: { type: "assistant_message", text: "manual" },
        provider: "codex",
      },
    ]);
  });

  test("flushAndDiscard flushes, clears timer, and invalidates stale callbacks", async () => {
    const { coalescer, flushes } = createHarness();

    coalescer.handle("agent-1", assistant("durable"));
    coalescer.flushAndDiscard("agent-1");

    await vi.advanceTimersByTimeAsync(60);
    expect(flushes).toEqual([
      {
        agentId: "agent-1",
        item: { type: "assistant_message", text: "durable" },
        provider: "codex",
      },
    ]);
  });

  test("stale timers cannot flush reused agent ids", () => {
    const scheduled: Array<() => void> = [];
    const flushes: AgentStreamCoalescerFlush[] = [];
    const setTimeoutShim: AgentStreamCoalescerTimers["setTimeout"] = (callback, delay) => {
      scheduled.push(() => {
        callback();
      });
      return setTimeout(callback, delay);
    };
    const coalescer = new AgentStreamCoalescer({
      timers: {
        setTimeout: setTimeoutShim,
        clearTimeout,
      },
      onFlush: (payload) => {
        flushes.push(payload);
      },
    });

    primeLeadingEdge(coalescer, flushes);
    coalescer.handle("agent-1", assistant("old"));
    const oldTimerCallback = scheduled[0];
    coalescer.flushAndDiscard("agent-1");
    coalescer.handle("agent-1", assistant("new"));

    oldTimerCallback();
    coalescer.flushFor("agent-1");

    expect(flushes).toEqual([
      {
        agentId: "agent-1",
        item: { type: "assistant_message", text: "old" },
        provider: "codex",
      },
      {
        agentId: "agent-1",
        item: { type: "assistant_message", text: "new" },
        provider: "codex",
      },
    ]);
  });

  test("preserves first chunk item shape and replaces only text on collapse", async () => {
    const { coalescer, flushes } = createHarness();
    primeLeadingEdge(coalescer, flushes);
    const firstItem = {
      type: "assistant_message" as const,
      text: "he",
      futureOptionalField: { preserved: true },
    };

    coalescer.handle("agent-1", timeline(firstItem));
    coalescer.handle("agent-1", assistant("llo"));

    await vi.advanceTimersByTimeAsync(60);
    expect(flushes).toEqual([
      {
        agentId: "agent-1",
        item: {
          type: "assistant_message",
          text: "hello",
          futureOptionalField: { preserved: true },
        },
        provider: "codex",
      },
    ]);
  });

  test("coalesces tool call updates by callId with latest snapshot winning", async () => {
    const { coalescer, flushes } = createHarness();
    primeLeadingEdge(coalescer, flushes);

    expect(coalescer.handle("agent-1", toolCall({ output: "first" }))).toBe(true);
    expect(coalescer.handle("agent-1", toolCall({ output: "second" }))).toBe(true);

    await vi.advanceTimersByTimeAsync(60);

    expect(flushes).toEqual([
      {
        agentId: "agent-1",
        item: {
          type: "tool_call",
          callId: "tool-1",
          name: "shell",
          status: "running",
          error: null,
          detail: {
            type: "shell",
            command: "printf ok",
            output: "second",
            exitCode: null,
          },
        },
        provider: "codex",
      },
    ]);
  });

  test("coalesces interleaved tool call updates independently by callId", async () => {
    const { coalescer, flushes } = createHarness();
    primeLeadingEdge(coalescer, flushes);

    coalescer.handle("agent-1", toolCall({ callId: "tool-1", output: "one-a" }));
    coalescer.handle("agent-1", toolCall({ callId: "tool-2", output: "two-a" }));
    coalescer.handle("agent-1", toolCall({ callId: "tool-1", output: "one-b" }));
    coalescer.handle("agent-1", toolCall({ callId: "tool-2", output: "two-b" }));

    await vi.advanceTimersByTimeAsync(60);

    expect(flushes.map((flush) => flush.item)).toEqual([
      {
        type: "tool_call",
        callId: "tool-1",
        name: "shell",
        status: "running",
        error: null,
        detail: {
          type: "shell",
          command: "printf ok",
          output: "one-b",
          exitCode: null,
        },
      },
      {
        type: "tool_call",
        callId: "tool-2",
        name: "shell",
        status: "running",
        error: null,
        detail: {
          type: "shell",
          command: "printf ok",
          output: "two-b",
          exitCode: null,
        },
      },
    ]);
  });

  test("terminal tool call statuses flush immediately", () => {
    const { coalescer, flushes } = createHarness();
    primeLeadingEdge(coalescer, flushes);

    coalescer.handle("agent-1", toolCall({ output: "running" }));
    expect(flushes).toEqual([]);

    expect(coalescer.handle("agent-1", toolCall({ status: "completed", output: "done" }))).toBe(
      true,
    );

    expect(flushes.map((flush) => flush.item)).toEqual([
      {
        type: "tool_call",
        callId: "tool-1",
        name: "shell",
        status: "completed",
        error: null,
        detail: {
          type: "shell",
          command: "printf ok",
          output: "done",
          exitCode: 0,
        },
      },
    ]);
  });

  test("keeps a known tool call detail when a later update in the window has none", () => {
    const { coalescer, flushes } = createHarness();
    primeLeadingEdge(coalescer, flushes);

    coalescer.handle(
      "agent-1",
      timeline({
        type: "tool_call",
        callId: "agent-call",
        name: "Task",
        status: "running",
        error: null,
        detail: {
          type: "sub_agent",
          subAgentType: "general-purpose",
          description: "List files",
          log: "",
          actions: [],
        },
      }),
    );
    coalescer.handle(
      "agent-1",
      timeline({
        type: "tool_call",
        callId: "agent-call",
        name: "Agent",
        status: "completed",
        error: null,
        detail: { type: "unknown", input: { description: "List files" }, output: null },
      }),
    );

    expect(flushes.map((flush) => flush.item)).toEqual([
      {
        type: "tool_call",
        callId: "agent-call",
        name: "Agent",
        status: "completed",
        error: null,
        detail: {
          type: "sub_agent",
          subAgentType: "general-purpose",
          description: "List files",
          log: "",
          actions: [],
        },
      },
    ]);
  });

  test("preserves mixed text and tool call arrival order within a flush", async () => {
    const { coalescer, flushes } = createHarness();
    primeLeadingEdge(coalescer, flushes);

    coalescer.handle("agent-1", assistant("a"));
    coalescer.handle("agent-1", toolCall({ output: "running" }));
    coalescer.handle("agent-1", reasoning("r"));
    coalescer.handle("agent-1", toolCall({ output: "latest" }));
    coalescer.handle("agent-1", assistant("b"));

    await vi.advanceTimersByTimeAsync(60);

    expect(flushes.map((flush) => flush.item)).toEqual([
      { type: "assistant_message", text: "a" },
      {
        type: "tool_call",
        callId: "tool-1",
        name: "shell",
        status: "running",
        error: null,
        detail: {
          type: "shell",
          command: "printf ok",
          output: "latest",
          exitCode: null,
        },
      },
      { type: "reasoning", text: "r" },
      { type: "assistant_message", text: "b" },
    ]);
  });
});
