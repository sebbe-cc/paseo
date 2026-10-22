import { z } from "zod";

export const PROJECT_NOTE_TITLE_MAX_LENGTH = 200;
export const PROJECT_NOTE_BODY_MAX_LENGTH = 200_000;
export const PROJECT_TODO_TEXT_MAX_LENGTH = 2_000;
export const PROJECT_CONTEXT_MAX_LENGTH = 64_000;

export const PROJECT_CONTAINER_FILES_ERROR_CODES = [
  "project_note_not_found",
  "project_todo_not_found",
  "project_container_entity_invalid",
  "project_container_conflict",
] as const;
export type ProjectContainerFilesErrorCode = (typeof PROJECT_CONTAINER_FILES_ERROR_CODES)[number];

export const PROJECT_NOTE_ID_PREFIX = "note_";
export const PROJECT_TODO_ID_PREFIX = "todo_";

export const ProjectNoteSchema = z.object({
  id: z.string(),
  title: z.string(),
  body: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ProjectNote = z.infer<typeof ProjectNoteSchema>;

export const ProjectTodoSchema = z.object({
  id: z.string(),
  text: z.string(),
  done: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
  doneAt: z.string().optional(),
});
export type ProjectTodo = z.infer<typeof ProjectTodoSchema>;

/** Everything a project holds besides its repositories. Arrays are in display order. */
const FilesFields = {
  containerId: z.string(),
  notes: z.array(ProjectNoteSchema),
  todos: z.array(ProjectTodoSchema),
  context: z.string(),
  contextUpdatedAt: z.string().nullable(),
  revision: z.number().int().nonnegative(),
};
export const ProjectContainerFilesSchema = z.object(FilesFields);
export type ProjectContainerFiles = z.infer<typeof ProjectContainerFilesSchema>;

const request = <T extends string, S extends z.ZodRawShape>(type: T, shape: S) =>
  z.object({ type: z.literal(type), requestId: z.string(), containerId: z.string(), ...shape });
const response = <T extends string, S extends z.ZodRawShape>(type: T, shape: S) =>
  z.object({ type: z.literal(type), payload: z.object({ requestId: z.string(), ...shape }) });

export const ProjectContainerFilesGetRequestSchema = request(
  "project.container.files.get.request",
  { subscribe: z.object({ subscriptionId: z.string().optional() }).optional() },
);
export const ProjectNoteCreateRequestSchema = request("project.container.note.create.request", {
  title: z.string(),
  body: z.string(),
  index: z.number().int().nonnegative().optional(),
});
/** `expectedUpdatedAt` is the optimistic token: a mismatch fails with `project_container_conflict`. */
export const ProjectNoteUpdateRequestSchema = request("project.container.note.update.request", {
  noteId: z.string(),
  title: z.string().optional(),
  body: z.string().optional(),
  expectedUpdatedAt: z.string().optional(),
});
/** Adds `text` as a new paragraph at the end of the body; never replaces. */
export const ProjectNoteAppendRequestSchema = request("project.container.note.append.request", {
  noteId: z.string(),
  text: z.string(),
});
export const ProjectNoteDeleteRequestSchema = request("project.container.note.delete.request", {
  noteId: z.string(),
});
export const ProjectNoteReorderRequestSchema = request("project.container.note.reorder.request", {
  noteIds: z.array(z.string()),
});
export const ProjectTodoCreateRequestSchema = request("project.container.todo.create.request", {
  text: z.string(),
  index: z.number().int().nonnegative().optional(),
});
export const ProjectTodoUpdateRequestSchema = request("project.container.todo.update.request", {
  todoId: z.string(),
  text: z.string().optional(),
  done: z.boolean().optional(),
  expectedUpdatedAt: z.string().optional(),
});
export const ProjectTodoDeleteRequestSchema = request("project.container.todo.delete.request", {
  todoId: z.string(),
});
export const ProjectTodoReorderRequestSchema = request("project.container.todo.reorder.request", {
  todoIds: z.array(z.string()),
});
/** A null `expectedUpdatedAt` asserts the context was never written. */
export const ProjectContextWriteRequestSchema = request("project.container.context.write.request", {
  content: z.string(),
  expectedUpdatedAt: z.string().nullable().optional(),
});

export const ProjectContainerFilesGetResponseSchema = response(
  "project.container.files.get.response",
  { subscriptionId: z.string().optional(), ...FilesFields },
);
/** Whole-snapshot push to `files.get` subscribers of that container after every change. */
export const ProjectContainerFilesUpdateSchema = z.object({
  type: z.literal("project.container.files.update"),
  payload: z.object({ subscriptionId: z.string().optional(), ...FilesFields }),
});
export const ProjectNoteCreateResponseSchema = response("project.container.note.create.response", {
  note: ProjectNoteSchema,
});
export const ProjectNoteUpdateResponseSchema = response("project.container.note.update.response", {
  note: ProjectNoteSchema,
});
export const ProjectNoteAppendResponseSchema = response("project.container.note.append.response", {
  note: ProjectNoteSchema,
});
export const ProjectNoteDeleteResponseSchema = response("project.container.note.delete.response", {
  noteId: z.string(),
});
export const ProjectNoteReorderResponseSchema = response(
  "project.container.note.reorder.response",
  { noteIds: z.array(z.string()) },
);
export const ProjectTodoCreateResponseSchema = response("project.container.todo.create.response", {
  todo: ProjectTodoSchema,
});
export const ProjectTodoUpdateResponseSchema = response("project.container.todo.update.response", {
  todo: ProjectTodoSchema,
});
export const ProjectTodoDeleteResponseSchema = response("project.container.todo.delete.response", {
  todoId: z.string(),
});
export const ProjectTodoReorderResponseSchema = response(
  "project.container.todo.reorder.response",
  { todoIds: z.array(z.string()) },
);
export const ProjectContextWriteResponseSchema = response(
  "project.container.context.write.response",
  { contextUpdatedAt: z.string().nullable() },
);

export const PROJECT_CONTAINER_FILES_INBOUND = [
  ProjectContainerFilesGetRequestSchema,
  ProjectNoteCreateRequestSchema,
  ProjectNoteUpdateRequestSchema,
  ProjectNoteAppendRequestSchema,
  ProjectNoteDeleteRequestSchema,
  ProjectNoteReorderRequestSchema,
  ProjectTodoCreateRequestSchema,
  ProjectTodoUpdateRequestSchema,
  ProjectTodoDeleteRequestSchema,
  ProjectTodoReorderRequestSchema,
  ProjectContextWriteRequestSchema,
] as const;

export const PROJECT_CONTAINER_FILES_OUTBOUND = [
  ProjectContainerFilesGetResponseSchema,
  ProjectContainerFilesUpdateSchema,
  ProjectNoteCreateResponseSchema,
  ProjectNoteUpdateResponseSchema,
  ProjectNoteAppendResponseSchema,
  ProjectNoteDeleteResponseSchema,
  ProjectNoteReorderResponseSchema,
  ProjectTodoCreateResponseSchema,
  ProjectTodoUpdateResponseSchema,
  ProjectTodoDeleteResponseSchema,
  ProjectTodoReorderResponseSchema,
  ProjectContextWriteResponseSchema,
] as const;

/** Appends `text` as its own paragraph, the only way agents may change an existing note. */
export function appendNoteParagraph(body: string, text: string): string {
  const addition = text.trim();
  if (!addition) return body;
  const base = body.replace(/\s+$/, "");
  return base ? `${base}\n\n${addition}` : addition;
}
