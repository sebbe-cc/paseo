import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectNote, ProjectTodo } from "@getpaseo/protocol/project-container-files";
import { render } from "../../../output/index.js";
import {
  runContextSet,
  runContextShow,
  runNoteAppend,
  runNoteCreate,
  runNoteLs,
  runNoteShow,
  runNoteUpdate,
} from "./notes.js";
import { runTodoDone, runTodoLs, runTodoOrder } from "./todos.js";

const T = "2026-09-25T00:00:00.000Z";
let notes: ProjectNote[];
let todos: ProjectTodo[];
let features: Record<string, boolean>;
const container = { id: "pcnt_heads", name: "Heads", projectIds: [], createdAt: T, updatedAt: T };
const note = (id: string, title: string, body = ""): ProjectNote => ({
  id,
  title,
  body,
  createdAt: T,
  updatedAt: T,
});
const todo = (id: string, text: string, done = false): ProjectTodo => ({
  id,
  text,
  done,
  createdAt: T,
  updatedAt: T,
});
const client = {
  getLastServerInfoMessage: () => ({ features }),
  listProjectContainers: vi.fn(async () => ({ containers: [container], revision: 1 })),
  getProjectContainerFiles: vi.fn(async () => ({
    requestId: "r",
    containerId: container.id,
    notes,
    todos,
    context: "Use pnpm.",
    contextUpdatedAt: T,
    revision: 3,
  })),
  createProjectNote: vi.fn(async (input: { title: string; body: string }) => ({
    note: note("note_new", input.title, input.body),
  })),
  updateProjectNote: vi.fn(async (input: { noteId: string; title?: string; body?: string }) => ({
    note: note(input.noteId, input.title ?? "Plan", input.body ?? ""),
  })),
  appendProjectNote: vi.fn(async (input: { noteId: string; text: string }) => ({
    note: note(input.noteId, "Plan", `one\n\n${input.text}`),
  })),
  updateProjectTodo: vi.fn(async (input: { todoId: string; done?: boolean }) => ({
    todo: todo(input.todoId, "x", input.done),
  })),
  reorderProjectTodos: vi.fn(async () => ({})),
  writeProjectContext: vi.fn(async () => ({ contextUpdatedAt: T })),
  close: vi.fn(async () => undefined),
};

vi.mock("../../../utils/client.js", () => ({
  buildDaemonConnectionCommandError: vi.fn(({ error }: { error: unknown }) => error),
  connectToDaemon: vi.fn(async () => client),
}));

const options = { daemonTarget: { kind: "instance", home: "/tmp/container-test" } } as never;

beforeEach(() => {
  vi.clearAllMocks();
  features = { projectContainers: true, projectContainerFiles: true };
  notes = [note("note_a", "Plan", "one"), note("note_b", "Log")];
  todos = [todo("todo_a", "Ship"), todo("todo_b", "Test", true), todo("todo_c", "Docs")];
});

describe("project notes, todos and context commands", () => {
  it("lists notes and prints one as Markdown, by position or title", async () => {
    expect((await runNoteLs("heads", options)).data.map((n) => n.id)).toEqual(["note_a", "note_b"]);
    expect(render(await runNoteShow("heads", "1", options))).toBe("# Plan\n\none");
    expect((await runNoteShow("heads", "log", options)).data.id).toBe("note_b");
    await expect(runNoteShow("heads", "9", options)).rejects.toMatchObject({
      code: "NOTE_NOT_FOUND",
    });
  });

  it("creates from --body-file and updates with the optimistic token", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "paseo-note-")), "body.md");
    await writeFile(path, "From disk");
    await runNoteCreate("heads", { ...(options as object), title: "New", bodyFile: path } as never);
    expect(client.createProjectNote).toHaveBeenCalledWith({
      containerId: "pcnt_heads",
      title: "New",
      body: "From disk",
    });
    await runNoteUpdate("heads", "note_a", { ...(options as object), body: "two" } as never);
    expect(client.updateProjectNote).toHaveBeenCalledWith({
      containerId: "pcnt_heads",
      noteId: "note_a",
      body: "two",
      expectedUpdatedAt: T,
    });
    await runNoteAppend("heads", "Plan", "more", options);
    expect(client.appendProjectNote).toHaveBeenCalledWith({
      containerId: "pcnt_heads",
      noteId: "note_a",
      text: "more",
    });
  });

  it("hides done todos by default, completes by position, and orders", async () => {
    expect((await runTodoLs("heads", options)).data.map((t) => t.id)).toEqual(["todo_a", "todo_c"]);
    const all = await runTodoLs("heads", { ...(options as object), all: true } as never);
    expect(all.data).toHaveLength(3);
    await runTodoDone("heads", "3", options);
    expect(client.updateProjectTodo).toHaveBeenCalledWith({
      containerId: "pcnt_heads",
      todoId: "todo_c",
      done: true,
    });
    await runTodoOrder("heads", ["todo_c"], options);
    expect(client.reorderProjectTodos).toHaveBeenCalledWith({
      containerId: "pcnt_heads",
      todoIds: ["todo_c", "todo_a", "todo_b"],
    });
  });

  it("shows and sets the context", async () => {
    expect(render(await runContextShow("heads", options))).toBe("Use pnpm.");
    await runContextSet("heads", "# New", options);
    expect(client.writeProjectContext).toHaveBeenCalledWith({
      containerId: "pcnt_heads",
      content: "# New",
    });
  });

  it("refuses hosts without project notes", async () => {
    features = { projectContainers: true };
    await expect(runNoteLs("heads", options)).rejects.toMatchObject({
      code: "PROJECT_FILES_UNSUPPORTED",
    });
  });
});
