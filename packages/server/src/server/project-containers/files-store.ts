import { promises as fs } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  ProjectNoteSchema,
  ProjectTodoSchema,
  type ProjectNote,
  type ProjectTodo,
} from "@getpaseo/protocol/project-container-files";
import { writeFileAtomic, writeJsonFileAtomic } from "../atomic-file.js";

const NotesFileSchema = z.object({ version: z.literal(1), notes: z.array(ProjectNoteSchema) });
const TodosFileSchema = z.object({ version: z.literal(1), todos: z.array(ProjectTodoSchema) });

export interface ContainerFilesState {
  notes: ProjectNote[];
  todos: ProjectTodo[];
  context: string;
  contextUpdatedAt: string | null;
  /** In-memory change counter; subscribers use it to drop pushes older than their snapshot. */
  revision: number;
}

/** Owns `<root>/<containerId>/{notes.json,todos.json,context.md}`. Array order is display order. */
export class ProjectContainerFilesStore {
  private readonly cache = new Map<string, ContainerFilesState>();

  constructor(readonly root: string) {}

  async load(containerId: string): Promise<ContainerFilesState> {
    const cached = this.cache.get(containerId);
    if (cached) return cached;
    const dir = this.dir(containerId);
    const [notes, todos, context] = await Promise.all([
      readJson(join(dir, "notes.json"), NotesFileSchema),
      readJson(join(dir, "todos.json"), TodosFileSchema),
      readContext(join(dir, "context.md")),
    ]);
    const state: ContainerFilesState = {
      notes: notes?.notes ?? [],
      todos: todos?.todos ?? [],
      context: context?.content ?? "",
      contextUpdatedAt: context?.updatedAt ?? null,
      revision: 0,
    };
    this.cache.set(containerId, state);
    return state;
  }

  /** Each save writes first, then swaps the cache, so a failed write leaves memory matching disk. */
  async saveNotes(containerId: string, notes: ProjectNote[]): Promise<ContainerFilesState> {
    const current = await this.load(containerId);
    await writeJsonFileAtomic(join(this.dir(containerId), "notes.json"), { version: 1, notes });
    return this.swap(containerId, { ...current, notes });
  }

  async saveTodos(containerId: string, todos: ProjectTodo[]): Promise<ContainerFilesState> {
    const current = await this.load(containerId);
    await writeJsonFileAtomic(join(this.dir(containerId), "todos.json"), { version: 1, todos });
    return this.swap(containerId, { ...current, todos });
  }

  /** The file stays plain Markdown; its mtime carries `contextUpdatedAt` across restarts. */
  async saveContext(
    containerId: string,
    content: string,
    timestamp: string,
  ): Promise<ContainerFilesState> {
    const current = await this.load(containerId);
    const path = join(this.dir(containerId), "context.md");
    const at = new Date(timestamp);
    await writeFileAtomic(path, content);
    await fs.utimes(path, at, at);
    return this.swap(containerId, {
      ...current,
      context: content,
      contextUpdatedAt: at.toISOString(),
    });
  }

  async remove(containerId: string): Promise<void> {
    await fs.rm(this.dir(containerId), { recursive: true, force: true });
    this.cache.delete(containerId);
  }

  private dir(containerId: string): string {
    // Container ids come from the daemon's own catalog, but never let one escape the root.
    if (!/^[A-Za-z0-9_-]+$/.test(containerId)) throw new Error("Invalid project id");
    return join(this.root, containerId);
  }

  private swap(containerId: string, next: ContainerFilesState): ContainerFilesState {
    const state = { ...next, revision: next.revision + 1 };
    this.cache.set(containerId, state);
    return state;
  }
}

async function readJson<T>(path: string, schema: z.ZodType<T>): Promise<T | null> {
  let raw: string;
  try {
    raw = await fs.readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  return schema.parse(JSON.parse(raw));
}

async function readContext(path: string): Promise<{ content: string; updatedAt: string } | null> {
  try {
    const [content, stat] = await Promise.all([fs.readFile(path, "utf8"), fs.stat(path)]);
    return { content, updatedAt: stat.mtime.toISOString() };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
