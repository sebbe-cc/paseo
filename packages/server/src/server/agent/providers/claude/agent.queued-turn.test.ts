import { afterEach, expect, test, vi } from "vitest";

import { createTestLogger } from "../../../../test-utils/test-logger.js";
import { ClaudeAgentClient } from "./agent.js";
import type { AgentStreamEvent } from "../../agent-sdk-types.js";

interface PromptRecord {
  text: string;
  uuid: string | null;
}

interface AsyncQueue<T> {
  push: (value: T) => void;
  next: () => Promise<IteratorResult<T, void>>;
  end: () => void;
}

interface ScriptedQuery {
  next: ReturnType<typeof vi.fn>;
  interrupt: ReturnType<typeof vi.fn>;
  return: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  setPermissionMode: ReturnType<typeof vi.fn>;
  setModel: ReturnType<typeof vi.fn>;
  supportedModels: ReturnType<typeof vi.fn>;
  supportedCommands: ReturnType<typeof vi.fn>;
  rewindFiles: ReturnType<typeof vi.fn>;
  cancelAsyncMessage: ReturnType<typeof vi.fn>;
  [Symbol.asyncIterator]: () => AsyncIterator<Record<string, unknown>, void>;
  emit: (message: Record<string, unknown>) => void;
  end: () => void;
  prompts: PromptRecord[];
}

const SESSION_ID = "queued-turn-session";

function createAsyncQueue<T>(): AsyncQueue<T> {
  const items: T[] = [];
  const resolvers: Array<(value: IteratorResult<T, void>) => void> = [];
  let ended = false;

  return {
    push(value) {
      if (ended) {
        return;
      }
      const resolve = resolvers.shift();
      if (resolve) {
        resolve({ value, done: false });
        return;
      }
      items.push(value);
    },
    async next() {
      const value = items.shift();
      if (value !== undefined) {
        return { value, done: false };
      }
      if (ended) {
        return { value: undefined, done: true };
      }
      return await new Promise<IteratorResult<T, void>>((resolve) => {
        resolvers.push(resolve);
      });
    },
    end() {
      ended = true;
      while (resolvers.length > 0) {
        const resolve = resolvers.shift();
        resolve?.({ value: undefined, done: true });
      }
    },
  };
}

function extractPromptText(message: Record<string, unknown>): string {
  const content = (message.message as { content?: unknown } | undefined)?.content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .flatMap((block) => {
      if (!block || typeof block !== "object") {
        return [];
      }
      const text = (block as { text?: unknown }).text;
      return typeof text === "string" ? [text] : [];
    })
    .join("");
}

function createScriptedQuery(params: { prompt: AsyncIterable<unknown> }): ScriptedQuery {
  const output = createAsyncQueue<Record<string, unknown>>();
  const prompts: PromptRecord[] = [];

  const scriptedQuery = {
    next: vi.fn(() => output.next()),
    interrupt: vi.fn(async () => undefined),
    return: vi.fn(async () => {
      output.end();
    }),
    close: vi.fn(() => undefined),
    setPermissionMode: vi.fn(async () => undefined),
    setModel: vi.fn(async () => undefined),
    supportedModels: vi.fn(async () => [{ value: "opus", displayName: "Opus" }]),
    supportedCommands: vi.fn(async () => []),
    rewindFiles: vi.fn(async () => ({ canRevert: true })),
    cancelAsyncMessage: vi.fn(async () => true),
    emit: (message: Record<string, unknown>) => {
      output.push(message);
    },
    end: () => {
      output.end();
    },
    prompts,
    [Symbol.asyncIterator]() {
      return this;
    },
  } satisfies ScriptedQuery;

  scriptedQuery.emit({
    type: "system",
    subtype: "init",
    session_id: SESSION_ID,
    permissionMode: "default",
    model: "opus",
  });

  void (async () => {
    for await (const prompt of params.prompt) {
      const promptMessage = prompt as Record<string, unknown>;
      prompts.push({
        text: extractPromptText(promptMessage),
        uuid: typeof promptMessage.uuid === "string" ? promptMessage.uuid : null,
      });
    }
  })();

  return scriptedQuery;
}

function buildSuccessResult() {
  return {
    type: "result",
    subtype: "success",
    usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 },
    total_cost_usd: 0,
    session_id: SESSION_ID,
  };
}

async function waitFor(
  predicate: () => boolean,
  options?: { timeoutMs?: number; intervalMs?: number },
): Promise<void> {
  const timeoutMs = options?.timeoutMs ?? 2_000;
  const intervalMs = options?.intervalMs ?? 5;
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

function userMessageClientIds(events: AgentStreamEvent[]): Array<string | undefined> {
  return events.flatMap((event) => {
    if (event.type !== "timeline" || event.item.type !== "user_message") {
      return [];
    }
    return [event.item.clientMessageId];
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

test("queues messages sent to a busy turn and delivers them in order", async () => {
  const logger = createTestLogger();
  const queryFactory = vi.fn();
  const queries: ScriptedQuery[] = [];
  queryFactory.mockImplementation(({ prompt }: { prompt: AsyncIterable<unknown> }) => {
    const scriptedQuery = createScriptedQuery({ prompt });
    queries.push(scriptedQuery);
    return scriptedQuery;
  });

  const session = await new ClaudeAgentClient({
    logger,
    queryFactory,
    resolveBinary: async () => "/test/claude/bin",
  }).createSession({ provider: "claude", cwd: process.cwd() });
  const events: AgentStreamEvent[] = [];
  const unsubscribe = session.subscribe((event) => events.push(event));

  try {
    const first = await session.startTurn("first", { clientMessageId: "c1" });
    await waitFor(() => (queries[0]?.prompts.length ?? 0) === 1);

    // The turn is still active: these must wait, never throw.
    const second = await session.startTurn("second", { clientMessageId: "c2" });
    const third = await session.startTurn("third", { clientMessageId: "c3" });
    expect(second.turnId).not.toBe(first.turnId);
    expect(third.turnId).not.toBe(first.turnId);
    expect(third.turnId).not.toBe(second.turnId);

    queries[0]?.emit(buildSuccessResult());
    await waitFor(() => (queries[0]?.prompts.length ?? 0) === 2);
    queries[0]?.emit(buildSuccessResult());
    await waitFor(() => (queries[0]?.prompts.length ?? 0) === 3);
    queries[0]?.emit(buildSuccessResult());

    await waitFor(
      () => events.filter((event) => event.type === "turn_completed").length === 3,
    );

    expect(queries[0]?.prompts.map((prompt) => prompt.text)).toEqual([
      "first",
      "second",
      "third",
    ]);
    // Each queued turn echoes its own client message when it actually
    // starts. The first turn's echo can lose a race with its instant
    // completion in this harness, so only the queued echoes are asserted.
    expect(
      userMessageClientIds(events).filter(
        (id): id is string => id === "c2" || id === "c3",
      ),
    ).toEqual(["c2", "c3"]);
  } finally {
    unsubscribe();
    await session.close();
  }
});

test("an interrupt does not withdraw the queued turn that follows it", async () => {
  const logger = createTestLogger();
  const queryFactory = vi.fn();
  const queries: ScriptedQuery[] = [];
  queryFactory.mockImplementation(({ prompt }: { prompt: AsyncIterable<unknown> }) => {
    const scriptedQuery = createScriptedQuery({ prompt });
    queries.push(scriptedQuery);
    return scriptedQuery;
  });

  const session = await new ClaudeAgentClient({
    logger,
    queryFactory,
    resolveBinary: async () => "/test/claude/bin",
  }).createSession({ provider: "claude", cwd: process.cwd() });
  const events: AgentStreamEvent[] = [];
  const unsubscribe = session.subscribe((event) => events.push(event));

  try {
    const first = await session.startTurn("first");
    await waitFor(() => (queries[0]?.prompts.length ?? 0) === 1);
    const second = await session.startTurn("second");
    expect(second.turnId).not.toBe(first.turnId);

    await session.interrupt();
    expect(events).toContainEqual(expect.objectContaining({ type: "turn_canceled" }));

    // The abort settles first; only then does the queued turn start, so the
    // withdrawal never sees its message.
    await waitFor(() => (queries[0]?.prompts.length ?? 0) === 2);
    const withdrawn = queries[0]?.cancelAsyncMessage.mock.calls.map((call) => call[0]) ?? [];
    const firstUuid = queries[0]?.prompts[0]?.uuid;
    const secondUuid = queries[0]?.prompts[1]?.uuid;
    expect(firstUuid).toBeTruthy();
    expect(secondUuid).toBeTruthy();
    expect(withdrawn).toContain(firstUuid);
    expect(withdrawn).not.toContain(secondUuid);

    queries[0]?.emit(buildSuccessResult());
    await waitFor(
      () => events.filter((event) => event.type === "turn_completed").length === 1,
    );
    expect(queries[0]?.prompts.map((prompt) => prompt.text)).toEqual(["first", "second"]);
  } finally {
    unsubscribe();
    await session.close();
  }
});

test("clearStuckTurn leaves a healthy active turn alone", async () => {
  const logger = createTestLogger();
  const queryFactory = vi.fn();
  const queries: ScriptedQuery[] = [];
  queryFactory.mockImplementation(({ prompt }: { prompt: AsyncIterable<unknown> }) => {
    const scriptedQuery = createScriptedQuery({ prompt });
    queries.push(scriptedQuery);
    return scriptedQuery;
  });

  const session = await new ClaudeAgentClient({
    logger,
    queryFactory,
    resolveBinary: async () => "/test/claude/bin",
  }).createSession({ provider: "claude", cwd: process.cwd() });
  const events: AgentStreamEvent[] = [];
  const unsubscribe = session.subscribe((event) => events.push(event));

  try {
    await session.startTurn("healthy");
    await waitFor(() => (queries[0]?.prompts.length ?? 0) === 1);

    expect(session.clearStuckTurn?.("resume")).toBeNull();

    queries[0]?.emit(buildSuccessResult());
    await waitFor(
      () => events.filter((event) => event.type === "turn_completed").length === 1,
    );
    expect(
      events.some((event) => event.type === "turn_failed" || event.type === "turn_canceled"),
    ).toBe(false);
  } finally {
    unsubscribe();
    await session.close();
  }
});

test("resume sweep clears a turn stranded by a dead transport, then three messages deliver", async () => {
  const logger = createTestLogger();
  const queryFactory = vi.fn();
  const queries: ScriptedQuery[] = [];
  queryFactory.mockImplementation(({ prompt }: { prompt: AsyncIterable<unknown> }) => {
    const scriptedQuery = createScriptedQuery({ prompt });
    queries.push(scriptedQuery);
    return scriptedQuery;
  });

  const session = await new ClaudeAgentClient({
    logger,
    queryFactory,
    resolveBinary: async () => "/test/claude/bin",
  }).createSession({ provider: "claude", cwd: process.cwd() });
  const events: AgentStreamEvent[] = [];
  const unsubscribe = session.subscribe((event) => events.push(event));

  try {
    const doomed = await session.startTurn("doomed", { clientMessageId: "c0" });
    await waitFor(() => (queries[0]?.prompts.length ?? 0) === 1);

    // A daemon restart kills the SDK child while its pump is already gone.
    // retireQuery is the production teardown: it drops the query, the input
    // and the pump while the turn stays marked active.
    await (
      session as unknown as { retireQuery(): Promise<void> }
    ).retireQuery();

    // The sweep may race the orphaned pump's exit, so retry until it reports.
    let cleared: string | null = null;
    await waitFor(
      () => {
        cleared = session.clearStuckTurn?.("resume") ?? null;
        return cleared !== null;
      },
      { timeoutMs: 5_000 },
    );
    expect(cleared).toBe(doomed.turnId);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "turn_failed", turnId: doomed.turnId }),
    );

    for (const [text, clientMessageId] of [
      ["one", "c1"],
      ["two", "c2"],
      ["three", "c3"],
    ] as const) {
      const started = await session.startTurn(text, { clientMessageId });
      expect(started.turnId).toBeTruthy();
      const live = queries[queries.length - 1];
      await waitFor(() => (live?.prompts.length ?? 0) > 0, { timeoutMs: 5_000 });
      // Let the submitted-message echo land while the turn is still active:
      // the echo timer must win against nothing here, so this is exact.
      await waitFor(() => userMessageClientIds(events).includes(clientMessageId), {
        timeoutMs: 5_000,
      });
      live?.emit(buildSuccessResult());
      await waitFor(
        () =>
          events.filter((event) => event.type === "turn_completed").length >=
          ["c1", "c2", "c3"].indexOf(clientMessageId) + 1,
        { timeoutMs: 5_000 },
      );
    }

    const delivered = queries[queries.length - 1]?.prompts.map((prompt) => prompt.text);
    expect(delivered).toEqual(["one", "two", "three"]);
    // The doomed turn never echoes: its echo timer loses to the sweep by
    // design. The three post-resume messages echo in order as they start.
    expect(userMessageClientIds(events)).toEqual(["c1", "c2", "c3"]);
  } finally {
    unsubscribe();
    await session.close();
  }
});
