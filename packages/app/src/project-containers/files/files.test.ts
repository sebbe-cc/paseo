import { describe, expect, it } from "vitest";
import type { ProjectTodo } from "@getpaseo/protocol/project-container-files";
import { moveId, reorderVisibleTodos, visibleTodos } from "./order";

function todo(id: string, done = false): ProjectTodo {
  const now = "2026-09-25T00:00:00.000Z";
  return { id, text: id, done, createdAt: now, updatedAt: now };
}

describe("moveId", () => {
  it("swaps with the neighbour in the given direction", () => {
    expect(moveId(["a", "b", "c"], 1, -1)).toEqual(["b", "a", "c"]);
    expect(moveId(["a", "b", "c"], 1, 1)).toEqual(["a", "c", "b"]);
  });

  it("refuses moves past either end", () => {
    expect(moveId(["a", "b"], 0, -1)).toBeNull();
    expect(moveId(["a", "b"], 1, 1)).toBeNull();
  });
});

describe("visibleTodos", () => {
  const todos = [todo("done-1", true), todo("open-1"), todo("open-2")];

  it("hides done todos unless asked", () => {
    expect(visibleTodos(todos, false).map((t) => t.id)).toEqual(["open-1", "open-2"]);
  });

  it("lists done todos after open ones", () => {
    expect(visibleTodos(todos, true).map((t) => t.id)).toEqual(["open-1", "open-2", "done-1"]);
  });
});

describe("reorderVisibleTodos", () => {
  it("keeps hidden done todos after the reordered open ones", () => {
    const todos = [todo("done-1", true), todo("open-1"), todo("open-2")];
    const visible = visibleTodos(todos, false);
    expect(reorderVisibleTodos(todos, visible, 1, -1)).toEqual(["open-2", "open-1", "done-1"]);
  });
});
