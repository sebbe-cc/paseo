import { describe, expect, test } from "vitest";
import { SessionInboundMessageSchema, SessionOutboundMessageSchema } from "./messages.js";
import { appendNoteParagraph } from "./project-container-files.js";

const containerId = "pcnt_0123456789abcdef";
const at = "2026-09-25T00:00:00.000Z";
const note = {
  id: "note_0123456789ab",
  title: "Plan",
  body: "Ship it",
  createdAt: at,
  updatedAt: at,
};
const todo = {
  id: "todo_0123456789ab",
  text: "Write tests",
  done: false,
  createdAt: at,
  updatedAt: at,
};
const files = {
  containerId,
  notes: [note],
  todos: [todo, { ...todo, id: "todo_ba9876543210", done: true, doneAt: at }],
  context: "# Heads",
  contextUpdatedAt: at,
  revision: 2,
};

describe("project container files wire schemas", () => {
  test("parses every request", () => {
    const base = { requestId: "r", containerId };
    const requests = [
      { type: "project.container.files.get.request", ...base },
      { type: "project.container.files.get.request", ...base, subscribe: {} },
      { type: "project.container.note.create.request", ...base, title: "A", body: "" },
      { type: "project.container.note.create.request", ...base, title: "A", body: "", index: 0 },
      { type: "project.container.note.update.request", ...base, noteId: note.id, body: "x" },
      {
        type: "project.container.note.update.request",
        ...base,
        noteId: note.id,
        title: "B",
        expectedUpdatedAt: at,
      },
      { type: "project.container.note.append.request", ...base, noteId: note.id, text: "more" },
      { type: "project.container.note.delete.request", ...base, noteId: note.id },
      { type: "project.container.note.reorder.request", ...base, noteIds: [note.id] },
      { type: "project.container.todo.create.request", ...base, text: "Do" },
      { type: "project.container.todo.update.request", ...base, todoId: todo.id, done: true },
      { type: "project.container.todo.delete.request", ...base, todoId: todo.id },
      { type: "project.container.todo.reorder.request", ...base, todoIds: [todo.id] },
      { type: "project.container.context.write.request", ...base, content: "# Heads" },
      {
        type: "project.container.context.write.request",
        ...base,
        content: "",
        expectedUpdatedAt: null,
      },
    ];
    for (const request of requests) {
      expect(SessionInboundMessageSchema.parse(request)).toEqual(request);
    }
  });

  test("parses every response and the snapshot push", () => {
    const outbound = [
      { type: "project.container.files.get.response", payload: { requestId: "r", ...files } },
      { type: "project.container.files.update", payload: { subscriptionId: "s", ...files } },
      { type: "project.container.note.create.response", payload: { requestId: "r", note } },
      { type: "project.container.note.update.response", payload: { requestId: "r", note } },
      { type: "project.container.note.append.response", payload: { requestId: "r", note } },
      { type: "project.container.note.delete.response", payload: { requestId: "r", noteId: "n" } },
      {
        type: "project.container.note.reorder.response",
        payload: { requestId: "r", noteIds: [note.id] },
      },
      { type: "project.container.todo.create.response", payload: { requestId: "r", todo } },
      { type: "project.container.todo.update.response", payload: { requestId: "r", todo } },
      { type: "project.container.todo.delete.response", payload: { requestId: "r", todoId: "t" } },
      {
        type: "project.container.todo.reorder.response",
        payload: { requestId: "r", todoIds: [todo.id] },
      },
      {
        type: "project.container.context.write.response",
        payload: { requestId: "r", contextUpdatedAt: null },
      },
    ];
    for (const message of outbound) {
      expect(SessionOutboundMessageSchema.parse(message)).toEqual(message);
    }
  });
});

describe("appendNoteParagraph", () => {
  test("adds a paragraph after trimming trailing whitespace", () => {
    expect(appendNoteParagraph("First\n\n", "  Second ")).toBe("First\n\nSecond");
    expect(appendNoteParagraph("", "Only")).toBe("Only");
    expect(appendNoteParagraph("Same", "   ")).toBe("Same");
  });
});
