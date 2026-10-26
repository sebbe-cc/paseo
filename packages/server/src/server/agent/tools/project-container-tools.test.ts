import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { z } from "zod";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import { createProjectContainerCwdLookup } from "../../project-containers/cwd-lookup.js";
import {
  createProjectContainerFilesService,
  createProjectContainerService,
  type ProjectContainerFilesService,
  type ProjectContainerService,
} from "../../project-containers/index.js";
import {
  createPersistedProjectRecord,
  createPersistedWorkspaceRecord,
  FileBackedProjectRegistry,
  FileBackedWorkspaceRegistry,
} from "../../workspace-registry.js";
import { registerProjectContainerTools } from "./project-container-tools.js";
import type { PaseoToolConfig, PaseoToolResult } from "./types.js";

const T = "2026-09-25T00:00:00.000Z";
type Handler = (input: unknown) => Promise<PaseoToolResult>;

describe("project container agent tools", () => {
  let paseoHome: string;
  let containers: ProjectContainerService;
  let files: ProjectContainerFilesService;
  let lookup: ReturnType<typeof createProjectContainerCwdLookup>;
  let containerId: string;
  let callerCwd: string | null;
  const tools = new Map<string, { config: PaseoToolConfig; handler: Handler }>();

  async function call(name: string, input: unknown = {}): Promise<Record<string, unknown>> {
    const tool = tools.get(name)!;
    const parsed = z.object(tool.config.inputSchema as z.ZodRawShape).parse(input);
    const result = await tool.handler(parsed);
    z.object(tool.config.outputSchema!).strict().parse(result.structuredContent);
    return result.structuredContent as Record<string, unknown>;
  }

  beforeEach(async () => {
    paseoHome = await mkdtemp(join(tmpdir(), "paseo-container-tools-"));
    const logger = createTestLogger();
    const projects = new FileBackedProjectRegistry(join(paseoHome, "projects.json"), logger);
    const workspaces = new FileBackedWorkspaceRegistry(join(paseoHome, "workspaces.json"), logger);
    for (const id of ["prj_heads", "prj_loose"]) {
      await projects.upsert(
        createPersistedProjectRecord({
          projectId: id,
          rootPath: `/repos/${id}`,
          kind: "git",
          displayName: id,
          createdAt: T,
          updatedAt: T,
        }),
      );
      await workspaces.upsert(
        createPersistedWorkspaceRecord({
          workspaceId: `ws_${id}`,
          projectId: id,
          cwd: `/repos/${id}`,
          kind: "local_checkout",
          displayName: id,
          createdAt: T,
          updatedAt: T,
        }),
      );
    }
    containers = createProjectContainerService({ paseoHome, projectRegistry: projects });
    await containers.initialize();
    containerId = (await containers.create({ name: "heads", projectIds: ["prj_heads"] })).id;
    files = createProjectContainerFilesService({ paseoHome, containers });
    await files.initialize();
    lookup = createProjectContainerCwdLookup({ workspaceRegistry: workspaces, containers, files });
    callerCwd = "/repos/prj_heads/packages/app";
    tools.clear();
    registerProjectContainerTools((name, config, handler) => tools.set(name, { config, handler }), {
      lookup,
      files,
      resolveCallerCwd: () => callerCwd,
    });
  });

  afterEach(async () => {
    files.dispose();
    containers.dispose();
    await rm(paseoHome, { recursive: true, force: true });
  });

  test("exposes read and add tools only", () => {
    expect([...tools.keys()].sort()).toEqual([
      "project_context_read",
      "project_note_append",
      "project_note_create",
      "project_note_read",
      "project_notes_list",
      "project_todo_add",
      "project_todo_set_done",
      "project_todos_list",
    ]);
  });

  test("notes: create, list, append, read", async () => {
    const { note } = (await call("project_note_create", { title: "Plan", body: "First" })) as {
      note: { id: string };
    };
    expect(await call("project_notes_list")).toMatchObject({
      project: { id: containerId, name: "heads" },
      notes: [{ id: note.id, title: "Plan" }],
    });
    await call("project_note_append", { noteId: note.id, text: "Second" });
    expect(await call("project_note_read", { noteId: note.id })).toMatchObject({
      note: { body: "First\n\nSecond" },
    });
  });

  test("todos hide done items unless asked", async () => {
    const { todo } = (await call("project_todo_add", { text: "Ship" })) as { todo: { id: string } };
    await call("project_todo_add", { text: "Test" });
    await call("project_todo_set_done", { todoId: todo.id, done: true });
    const open = (await call("project_todos_list")) as { todos: { text: string }[] };
    expect(open.todos.map((item) => item.text)).toEqual(["Test"]);
    const all = (await call("project_todos_list", { includeDone: true })) as { todos: unknown[] };
    expect(all.todos).toHaveLength(2);
  });

  test("context is readable by tools and becomes the prompt block", async () => {
    expect(await lookup.contextPromptForCwd("/repos/prj_heads")).toBeNull();
    await files.writeContext({ containerId, content: "Use pnpm.\n" });
    expect(await call("project_context_read")).toEqual({
      project: { id: containerId, name: "heads" },
      context: "Use pnpm.\n",
    });
    expect(await lookup.contextPromptForCwd("/repos/prj_heads/src")).toBe(
      "# Project: heads\nUse pnpm.",
    );
    expect(await lookup.contextPromptForCwd("/repos/prj_loose")).toBeNull();
  });

  test("an ungrouped or unknown cwd reports no_project", async () => {
    for (const cwd of ["/repos/prj_loose", "/elsewhere", null]) {
      callerCwd = cwd;
      expect(await call("project_todos_list")).toMatchObject({ error: "no_project" });
    }
  });
});
