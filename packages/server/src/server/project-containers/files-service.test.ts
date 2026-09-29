import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { ProjectContainerFiles } from "@getpaseo/protocol/project-container-files";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { createPersistedProjectRecord, FileBackedProjectRegistry } from "../workspace-registry.js";
import {
  createProjectContainerFilesService,
  createProjectContainerService,
  type ProjectContainerFilesService,
  type ProjectContainerService,
} from "./index.js";

const T0 = "2026-09-25T00:00:00.000Z";

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

describe("project container files", () => {
  let paseoHome: string;
  let containers: ProjectContainerService;
  let files: ProjectContainerFilesService;
  let containerId: string;
  let clock: number;
  let ids: number;

  const now = () => new Date(Date.parse(T0) + clock++ * 1000).toISOString();
  const dir = () => join(paseoHome, "projects", "containers", containerId);

  async function startFiles(): Promise<ProjectContainerFilesService> {
    const service = createProjectContainerFilesService({
      paseoHome,
      containers,
      now,
      generateId: (prefix) => `${prefix}${String(++ids).padStart(12, "0")}`,
    });
    await service.initialize();
    return service;
  }

  beforeEach(async () => {
    clock = 0;
    ids = 0;
    paseoHome = await mkdtemp(join(tmpdir(), "paseo-container-files-"));
    const registry = new FileBackedProjectRegistry(
      join(paseoHome, "projects", "projects.json"),
      createTestLogger(),
    );
    await registry.upsert(
      createPersistedProjectRecord({
        projectId: "prj_a",
        rootPath: "/repos/a",
        kind: "git",
        displayName: "a",
        createdAt: T0,
        updatedAt: T0,
      }),
    );
    containers = createProjectContainerService({ paseoHome, projectRegistry: registry });
    await containers.initialize();
    containerId = (await containers.create({ name: "heads", projectIds: ["prj_a"] })).id;
    files = await startFiles();
  });

  afterEach(async () => {
    files.dispose();
    containers.dispose();
    await rm(paseoHome, { recursive: true, force: true });
  });

  test("starts empty and writes nothing until the first change", async () => {
    expect(await files.get(containerId)).toEqual({
      containerId,
      notes: [],
      todos: [],
      context: "",
      contextUpdatedAt: null,
      revision: 0,
    });
    await expect(stat(dir())).rejects.toThrow();
    await expect(files.get("pcnt_missing")).rejects.toMatchObject({
      code: "project_container_not_found",
    });
  });

  test("notes keep display order and survive a restart", async () => {
    const a = await files.createNote({ containerId, title: " Plan ", body: "one" });
    const b = await files.createNote({ containerId, title: "Log", body: "", index: 0 });
    expect(a).toMatchObject({ id: "note_000000000001", title: "Plan" });
    await files.reorderNotes({ containerId, noteIds: [a.id, b.id] });
    await expect(files.reorderNotes({ containerId, noteIds: [a.id] })).rejects.toMatchObject({
      code: "project_container_entity_invalid",
    });
    await expect(files.createNote({ containerId, title: "  ", body: "" })).rejects.toMatchObject({
      code: "project_container_entity_invalid",
    });
    const onDisk = JSON.parse(await readFile(join(dir(), "notes.json"), "utf8"));
    expect(onDisk).toMatchObject({ version: 1, notes: [{ id: a.id }, { id: b.id }] });
    files.dispose();
    files = await startFiles();
    expect((await files.get(containerId)).notes.map((note) => note.title)).toEqual(["Plan", "Log"]);
  });

  test("updates check the optimistic token and append adds a paragraph", async () => {
    const note = await files.createNote({ containerId, title: "Plan", body: "First" });
    const edited = await files.updateNote({
      containerId,
      noteId: note.id,
      body: "First line",
      expectedUpdatedAt: note.updatedAt,
    });
    expect(edited.updatedAt).not.toBe(note.updatedAt);
    await expect(
      files.updateNote({
        containerId,
        noteId: note.id,
        body: "x",
        expectedUpdatedAt: note.updatedAt,
      }),
    ).rejects.toMatchObject({ code: "project_container_conflict" });
    const appended = await files.appendNote({ containerId, noteId: note.id, text: " Second " });
    expect(appended.body).toBe("First line\n\nSecond");
    expect(appended.updatedAt > edited.updatedAt).toBe(true);
    await files.deleteNote({ containerId, noteId: note.id });
    await expect(
      files.appendNote({ containerId, noteId: note.id, text: "x" }),
    ).rejects.toMatchObject({ code: "project_note_not_found" });
  });

  test("todos track doneAt and reorder", async () => {
    const a = await files.createTodo({ containerId, text: "Write tests" });
    const b = await files.createTodo({ containerId, text: "Ship" });
    const done = await files.updateTodo({ containerId, todoId: a.id, done: true });
    expect(done).toMatchObject({ done: true, doneAt: done.updatedAt });
    const renamed = await files.updateTodo({ containerId, todoId: a.id, text: "Write more tests" });
    expect(renamed.doneAt).toBe(done.doneAt);
    const reopened = await files.updateTodo({ containerId, todoId: a.id, done: false });
    expect(reopened).not.toHaveProperty("doneAt");
    await files.reorderTodos({ containerId, todoIds: [b.id, a.id] });
    await files.deleteTodo({ containerId, todoId: b.id });
    expect((await files.get(containerId)).todos.map((todo) => todo.text)).toEqual([
      "Write more tests",
    ]);
  });

  test("context is a Markdown file whose mtime is the token", async () => {
    await expect(
      files.writeContext({ containerId, content: "x", expectedUpdatedAt: T0 }),
    ).rejects.toMatchObject({ code: "project_container_conflict" });
    const at = await files.writeContext({
      containerId,
      content: "# Heads",
      expectedUpdatedAt: null,
    });
    expect(await readFile(join(dir(), "context.md"), "utf8")).toBe("# Heads");
    files.dispose();
    files = await startFiles();
    expect(await files.get(containerId)).toMatchObject({
      context: "# Heads",
      contextUpdatedAt: at,
    });
    await expect(
      files.writeContext({ containerId, content: "", expectedUpdatedAt: null }),
    ).rejects.toMatchObject({ code: "project_container_conflict" });
  });

  test("pushes each committed change to that project's subscribers only", async () => {
    const pushes: ProjectContainerFiles[] = [];
    const other = (await containers.create({ name: "fleet" })).id;
    const { snapshot } = await files.subscribe(containerId, (next) => pushes.push(next));
    await files.subscribe(other, () => pushes.push({} as ProjectContainerFiles));
    expect(snapshot.revision).toBe(0);
    const todo = await files.createTodo({ containerId, text: "a" });
    await files.updateTodo({ containerId, todoId: todo.id, done: false });
    await files.writeContext({ containerId, content: "ctx" });
    expect(pushes.map((push) => push.revision)).toEqual([1, 2]);
    expect(pushes[1]).toMatchObject({ containerId, context: "ctx", todos: [{ text: "a" }] });
  });

  test("deleting the project deletes its directory, also when it happened while stopped", async () => {
    await files.createNote({ containerId, title: "Plan", body: "" });
    await containers.delete(containerId);
    await expect.poll(() => exists(dir())).toBe(false);

    const orphan = join(paseoHome, "projects", "containers", "pcnt_orphan");
    await mkdir(orphan, { recursive: true });
    await writeFile(join(orphan, "context.md"), "stale");
    files.dispose();
    files = await startFiles();
    await expect(stat(orphan)).rejects.toThrow();
  });
});
