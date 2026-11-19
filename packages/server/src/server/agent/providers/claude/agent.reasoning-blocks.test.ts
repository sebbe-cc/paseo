import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { createTestLogger } from "../../../../test-utils/test-logger.js";
import { ClaudeAgentClient } from "./agent.js";
import { streamSession } from "../test-utils/session-stream-adapter.js";
import type { AgentStreamEvent } from "../../agent-sdk-types.js";

const SESSION_ID = "reasoning-blocks-session";
const MESSAGE_ID = "msg_reasoning_blocks";
const ENGLISH = "Everything respawned cleanly. Now I need to run gc doctor --fix.";
const SWEDISH = "Alla noder har startat om på beads 1.3.2. Nu kör jag gc doctor --fix.";

const sdkQueryFactory = vi.fn();

function streamEvent(event: Record<string, unknown>) {
  return { type: "stream_event", session_id: SESSION_ID, parent_tool_use_id: null, event };
}

// Claude Code's SDK yields one assistant message per finished content block, same message id.
function assistantBlock(block: Record<string, unknown>) {
  return {
    type: "assistant",
    session_id: SESSION_ID,
    parent_tool_use_id: null,
    message: { id: MESSAGE_ID, role: "assistant", model: "opus", content: [block] },
  };
}

function streamedBlock(
  index: number,
  block: Record<string, unknown>,
  delta: Record<string, unknown>,
) {
  return [
    streamEvent({ type: "content_block_start", index, content_block: block }),
    streamEvent({ type: "content_block_delta", index, delta }),
    streamEvent({ type: "content_block_stop", index }),
  ];
}

function mockQuery(turn: Record<string, unknown>[]) {
  sdkQueryFactory.mockImplementation(({ prompt }: { prompt: AsyncIterable<unknown> }) => {
    const promptIterator = prompt[Symbol.asyncIterator]();
    const queue: Array<() => Promise<Record<string, unknown>>> = [
      async () => ({ type: "system", subtype: "init", session_id: SESSION_ID, model: "opus" }),
      async () => {
        const next = await promptIterator.next();
        const uuid = (next.value as { uuid?: string } | undefined)?.uuid ?? "prompt-uuid";
        return {
          type: "user",
          message: { role: "user", content: "restart the nodes" },
          parent_tool_use_id: null,
          uuid,
          session_id: SESSION_ID,
        };
      },
      ...turn.map((value) => async () => value),
      async () => ({
        type: "result",
        subtype: "success",
        usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 },
        total_cost_usd: 0,
      }),
    ];
    return {
      next: vi.fn(async () => {
        const step = queue.shift();
        return step ? { done: false, value: await step() } : { done: true, value: undefined };
      }),
      interrupt: vi.fn(async () => undefined),
      return: vi.fn(async () => undefined),
      close: vi.fn(() => undefined),
      setPermissionMode: vi.fn(async () => undefined),
      setModel: vi.fn(async () => undefined),
      getContextUsage: vi.fn(async () => undefined),
      supportedModels: vi.fn(async () => [{ value: "opus", displayName: "Opus" }]),
      supportedCommands: vi.fn(async () => []),
      rewindFiles: vi.fn(async () => ({ canRewind: true })),
      [Symbol.asyncIterator]() {
        return this;
      },
    };
  });
}

async function runTurn(): Promise<{ reasoning: string[]; assistant: string[] }> {
  const client = new ClaudeAgentClient({
    logger: createTestLogger(),
    queryFactory: sdkQueryFactory,
    resolveBinary: async () => "/test/claude/bin",
  });
  const session = await client.createSession({ provider: "claude", cwd: process.cwd() });
  const reasoning: string[] = [];
  const assistant: string[] = [];
  try {
    for await (const event of streamSession(session, "restart the nodes")) {
      if (event.type === "timeline" && event.item.type === "reasoning") {
        reasoning.push(event.item.text);
      }
      if (event.type === "timeline" && event.item.type === "assistant_message") {
        assistant.push(event.item.text);
      }
      if (isTerminal(event)) break;
    }
  } finally {
    await session.close();
  }
  return { reasoning, assistant };
}

function isTerminal(event: AgentStreamEvent): boolean {
  return (
    event.type === "turn_completed" ||
    event.type === "turn_failed" ||
    event.type === "turn_canceled"
  );
}

beforeEach(() => {
  sdkQueryFactory.mockReset();
});

afterEach(() => {
  sdkQueryFactory.mockReset();
});

test("a second streamed thinking block is shown once, and visible text stays out of it", async () => {
  mockQuery([
    streamEvent({ type: "message_start", message: { id: MESSAGE_ID, role: "assistant" } }),
    ...streamedBlock(
      0,
      { type: "thinking", thinking: "" },
      { type: "thinking_delta", thinking: ENGLISH },
    ),
    assistantBlock({ type: "thinking", thinking: ENGLISH, signature: "sig-1" }),
    ...streamedBlock(
      1,
      { type: "thinking", thinking: "" },
      { type: "thinking_delta", thinking: SWEDISH },
    ),
    assistantBlock({ type: "thinking", thinking: SWEDISH, signature: "sig-2" }),
    ...streamedBlock(2, { type: "text", text: "" }, { type: "text_delta", text: SWEDISH }),
    assistantBlock({ type: "text", text: SWEDISH }),
    streamEvent({ type: "message_stop" }),
  ]);

  const { reasoning, assistant } = await runTurn();

  expect(reasoning.join("")).toBe(ENGLISH + SWEDISH);
  expect(assistant.join("")).toBe(SWEDISH);
});

test("consecutive text blocks in one message are each shown once", async () => {
  mockQuery([
    streamEvent({ type: "message_start", message: { id: MESSAGE_ID, role: "assistant" } }),
    ...streamedBlock(0, { type: "text", text: "" }, { type: "text_delta", text: "First. " }),
    assistantBlock({ type: "text", text: "First. " }),
    ...streamedBlock(1, { type: "text", text: "" }, { type: "text_delta", text: "Second." }),
    assistantBlock({ type: "text", text: "Second." }),
    streamEvent({ type: "message_stop" }),
  ]);

  const { reasoning, assistant } = await runTurn();

  expect(assistant.join("")).toBe("First. Second.");
  expect(reasoning).toEqual([]);
});

test("an assistant message that repeats every block so far adds nothing new", async () => {
  mockQuery([
    streamEvent({ type: "message_start", message: { id: MESSAGE_ID, role: "assistant" } }),
    ...streamedBlock(
      0,
      { type: "thinking", thinking: "" },
      { type: "thinking_delta", thinking: ENGLISH },
    ),
    ...streamedBlock(
      1,
      { type: "thinking", thinking: "" },
      { type: "thinking_delta", thinking: SWEDISH },
    ),
    {
      ...assistantBlock({ type: "thinking", thinking: ENGLISH }),
      message: {
        id: MESSAGE_ID,
        role: "assistant",
        model: "opus",
        content: [
          { type: "thinking", thinking: ENGLISH },
          { type: "thinking", thinking: SWEDISH },
        ],
      },
    },
    streamEvent({ type: "message_stop" }),
  ]);

  const { reasoning } = await runTurn();

  expect(reasoning.join("")).toBe(ENGLISH + SWEDISH);
});
