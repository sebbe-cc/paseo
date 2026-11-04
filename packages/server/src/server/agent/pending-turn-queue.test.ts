import { describe, expect, test } from "vitest";

import { PendingTurnQueue } from "./pending-turn-queue.js";

describe("PendingTurnQueue", () => {
  test("reserves a turn id per enqueue and drains FIFO", () => {
    let next = 0;
    const queue = new PendingTurnQueue(() => `turn-${(next += 1)}`);

    const first = queue.enqueue("first");
    const second = queue.enqueue("second", { clientMessageId: "c2" });

    expect(first).toBe("turn-1");
    expect(second).toBe("turn-2");
    expect(queue.size).toBe(2);

    expect(queue.dequeue()).toMatchObject({ turnId: "turn-1", prompt: "first" });
    expect(queue.dequeue()).toMatchObject({
      turnId: "turn-2",
      prompt: "second",
      options: { clientMessageId: "c2" },
    });
    expect(queue.dequeue()).toBeUndefined();
    expect(queue.size).toBe(0);
  });

  test("clear drops every queued turn and reports them", () => {
    const queue = new PendingTurnQueue(() => "turn-x");
    queue.enqueue("a");
    queue.enqueue("b");

    const cleared = queue.clear();

    expect(cleared.map((entry) => entry.prompt)).toEqual(["a", "b"]);
    expect(queue.size).toBe(0);
    expect(queue.dequeue()).toBeUndefined();
  });
});
