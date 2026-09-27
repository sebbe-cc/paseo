import { promises as fs } from "node:fs";
import type { ProjectContainerCatalog } from "@getpaseo/protocol/project-containers";
import { PROJECT_CONTAINER_ID_PREFIX } from "@getpaseo/protocol/project-containers";
import {
  appendNoteParagraph,
  PROJECT_NOTE_ID_PREFIX,
  PROJECT_TODO_ID_PREFIX,
  type ProjectContainerFiles,
  type ProjectNote,
  type ProjectTodo,
} from "@getpaseo/protocol/project-container-files";
import type { ContainerFilesState, ProjectContainerFilesStore } from "./files-store.js";
import {
  generateEntityId,
  insertAt,
  reorderById,
  replaceById,
  requireBody,
  requireContext,
  requireEntity,
  requireTitle,
  requireTodoText,
  requireToken,
} from "./files-rules.js";
import { ProjectContainerError } from "./service.js";

type Listener = (files: ProjectContainerFiles) => void;
export interface ContainerCatalogSource {
  list(): Promise<ProjectContainerCatalog>;
  subscribe(
    listener: (catalog: ProjectContainerCatalog) => void,
  ): Promise<{ snapshot: ProjectContainerCatalog; unsubscribe: () => void }>;
}
interface Scope {
  containerId: string;
}
interface NoteChange extends Scope {
  noteId: string;
  title?: string;
  body?: string;
  expectedUpdatedAt?: string;
}
interface TodoChange extends Scope {
  todoId: string;
  text?: string;
  done?: boolean;
  expectedUpdatedAt?: string;
}

/** Notes, todos and agent context of each project. Mutations are serialised; every commit is pushed. */
export class ProjectContainerFilesService {
  private operations: Promise<void> = Promise.resolve();
  private readonly listeners = new Map<string, Set<Listener>>();
  private knownContainers = new Set<string>();
  private unsubscribeCatalog: (() => void) | null = null;

  constructor(
    private readonly store: ProjectContainerFilesStore,
    private readonly containers: ContainerCatalogSource,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly generateId: (prefix: string) => string = generateEntityId,
  ) {}

  /** Deletes the files of projects removed while running, and of any deleted while stopped. */
  async initialize(): Promise<void> {
    const { snapshot, unsubscribe } = await this.containers.subscribe((catalog) => {
      void this.forgetRemoved(catalog).catch(() => undefined);
    });
    this.unsubscribeCatalog = unsubscribe;
    this.knownContainers = new Set(snapshot.containers.map((container) => container.id));
    const entries = await fs.readdir(this.store.root).catch(() => [] as string[]);
    for (const id of entries) {
      if (id.startsWith(PROJECT_CONTAINER_ID_PREFIX) && !this.knownContainers.has(id)) {
        await this.exclusive(() => this.store.remove(id));
      }
    }
  }

  dispose(): void {
    this.unsubscribeCatalog?.();
    this.unsubscribeCatalog = null;
    this.listeners.clear();
  }

  async get(containerId: string): Promise<ProjectContainerFiles> {
    return this.exclusive(async () => toFiles(containerId, await this.load(containerId)));
  }

  /** Returns the snapshot and registers the listener inside one critical section, so no push is lost. */
  async subscribe(
    containerId: string,
    listener: Listener,
  ): Promise<{ snapshot: ProjectContainerFiles; unsubscribe: () => void }> {
    return this.exclusive(async () => {
      const snapshot = toFiles(containerId, await this.load(containerId));
      const set = this.listeners.get(containerId) ?? new Set<Listener>();
      set.add(listener);
      this.listeners.set(containerId, set);
      const unsubscribe = () => {
        set.delete(listener);
        if (set.size === 0 && this.listeners.get(containerId) === set) {
          this.listeners.delete(containerId);
        }
      };
      return { snapshot, unsubscribe };
    });
  }

  async createNote(
    input: Scope & { title: string; body: string; index?: number },
  ): Promise<ProjectNote> {
    return this.exclusive(async () => {
      const { notes } = await this.load(input.containerId);
      const timestamp = this.now();
      const note: ProjectNote = {
        id: this.generateId(PROJECT_NOTE_ID_PREFIX),
        title: requireTitle(input.title),
        body: requireBody(input.body),
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      await this.commitNotes(input.containerId, insertAt(notes, note, input.index));
      return note;
    });
  }

  async updateNote(input: NoteChange): Promise<ProjectNote> {
    return this.mutateNote(input, input.expectedUpdatedAt, (note) => ({
      ...note,
      title: input.title === undefined ? note.title : requireTitle(input.title),
      body: input.body === undefined ? note.body : requireBody(input.body),
    }));
  }

  /** The only change agents may make to an existing note. */
  async appendNote(input: Scope & { noteId: string; text: string }): Promise<ProjectNote> {
    return this.mutateNote(input, undefined, (note) => ({
      ...note,
      body: requireBody(appendNoteParagraph(note.body, input.text)),
    }));
  }

  async deleteNote(input: Scope & { noteId: string }): Promise<string> {
    return this.exclusive(async () => {
      const { notes } = await this.load(input.containerId);
      requireEntity(notes, input.noteId, "project_note_not_found");
      await this.commitNotes(
        input.containerId,
        notes.filter((note) => note.id !== input.noteId),
      );
      return input.noteId;
    });
  }

  async reorderNotes(input: Scope & { noteIds: string[] }): Promise<string[]> {
    return this.exclusive(async () => {
      const { notes } = await this.load(input.containerId);
      await this.commitNotes(input.containerId, reorderById(notes, input.noteIds));
      return input.noteIds;
    });
  }

  async createTodo(input: Scope & { text: string; index?: number }): Promise<ProjectTodo> {
    return this.exclusive(async () => {
      const { todos } = await this.load(input.containerId);
      const timestamp = this.now();
      const todo: ProjectTodo = {
        id: this.generateId(PROJECT_TODO_ID_PREFIX),
        text: requireTodoText(input.text),
        done: false,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      await this.commitTodos(input.containerId, insertAt(todos, todo, input.index));
      return todo;
    });
  }

  async updateTodo(input: TodoChange): Promise<ProjectTodo> {
    return this.exclusive(async () => {
      const { todos } = await this.load(input.containerId);
      const todo = requireEntity(todos, input.todoId, "project_todo_not_found");
      requireToken(todo.updatedAt, input.expectedUpdatedAt);
      const text = input.text === undefined ? todo.text : requireTodoText(input.text);
      const done = input.done ?? todo.done;
      if (text === todo.text && done === todo.done) return todo;
      const timestamp = this.now();
      const { doneAt, ...rest } = todo;
      const updated: ProjectTodo = { ...rest, text, done, updatedAt: timestamp };
      if (done) updated.doneAt = todo.done && doneAt ? doneAt : timestamp;
      await this.commitTodos(input.containerId, replaceById(todos, updated));
      return updated;
    });
  }

  async deleteTodo(input: Scope & { todoId: string }): Promise<string> {
    return this.exclusive(async () => {
      const { todos } = await this.load(input.containerId);
      requireEntity(todos, input.todoId, "project_todo_not_found");
      await this.commitTodos(
        input.containerId,
        todos.filter((todo) => todo.id !== input.todoId),
      );
      return input.todoId;
    });
  }

  async reorderTodos(input: Scope & { todoIds: string[] }): Promise<string[]> {
    return this.exclusive(async () => {
      const { todos } = await this.load(input.containerId);
      await this.commitTodos(input.containerId, reorderById(todos, input.todoIds));
      return input.todoIds;
    });
  }

  async writeContext(
    input: Scope & { content: string; expectedUpdatedAt?: string | null },
  ): Promise<string | null> {
    return this.exclusive(async () => {
      const current = await this.load(input.containerId);
      requireToken(current.contextUpdatedAt, input.expectedUpdatedAt);
      const content = requireContext(input.content);
      if (content === current.context) return current.contextUpdatedAt;
      const next = await this.store.saveContext(input.containerId, content, this.now());
      this.publish(input.containerId, next);
      return next.contextUpdatedAt;
    });
  }

  private async mutateNote(
    input: Scope & { noteId: string },
    expectedUpdatedAt: string | undefined,
    change: (note: ProjectNote) => ProjectNote,
  ): Promise<ProjectNote> {
    return this.exclusive(async () => {
      const { notes } = await this.load(input.containerId);
      const note = requireEntity(notes, input.noteId, "project_note_not_found");
      requireToken(note.updatedAt, expectedUpdatedAt);
      const changed = change(note);
      if (changed.title === note.title && changed.body === note.body) return note;
      const updated = { ...changed, updatedAt: this.now() };
      await this.commitNotes(input.containerId, replaceById(notes, updated));
      return updated;
    });
  }

  private async load(containerId: string): Promise<ContainerFilesState> {
    const catalog = await this.containers.list();
    if (!catalog.containers.some((container) => container.id === containerId)) {
      throw new ProjectContainerError("project_container_not_found", "Project not found");
    }
    return this.store.load(containerId);
  }

  private async commitNotes(containerId: string, notes: ProjectNote[]): Promise<void> {
    this.publish(containerId, await this.store.saveNotes(containerId, notes));
  }

  private async commitTodos(containerId: string, todos: ProjectTodo[]): Promise<void> {
    this.publish(containerId, await this.store.saveTodos(containerId, todos));
  }

  private publish(containerId: string, state: ContainerFilesState): void {
    const files = toFiles(containerId, state);
    for (const listener of this.listeners.get(containerId) ?? []) listener(files);
  }

  private async forgetRemoved(catalog: ProjectContainerCatalog): Promise<void> {
    const next = new Set(catalog.containers.map((container) => container.id));
    const removed = [...this.knownContainers].filter((id) => !next.has(id));
    this.knownContainers = next;
    for (const id of removed) {
      this.listeners.delete(id);
      await this.exclusive(() => this.store.remove(id));
    }
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.operations;
    let release!: () => void;
    this.operations = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

function toFiles(containerId: string, state: ContainerFilesState): ProjectContainerFiles {
  const { notes, todos, context, contextUpdatedAt, revision } = state;
  return { containerId, notes, todos, context, contextUpdatedAt, revision };
}
