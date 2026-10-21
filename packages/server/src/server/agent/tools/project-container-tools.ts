import { z } from "zod";
import { ProjectNoteSchema, ProjectTodoSchema } from "@getpaseo/protocol/project-container-files";
import type { ProjectContainer } from "@getpaseo/protocol/project-containers";
import { ensureValidJson } from "../../json-utils.js";
import type { ProjectContainerCwdLookup } from "../../project-containers/cwd-lookup.js";
import type { ProjectContainerFilesService } from "../../project-containers/index.js";
import type { PaseoToolConfig, PaseoToolResult } from "./types.js";

export interface ProjectContainerToolDependencies {
  lookup: Pick<ProjectContainerCwdLookup, "findForCwd">;
  files: ProjectContainerFilesService;
  /** The caller agent's cwd; null outside an agent-scoped session. */
  resolveCallerCwd: () => string | null;
}

type RegisterTool = (
  name: string,
  config: PaseoToolConfig,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- matches the catalog's registerTool.
  handler: (input: any) => Promise<PaseoToolResult>,
) => void;

const ProjectRefSchema = z.object({ id: z.string(), name: z.string() });
const NO_PROJECT = { error: z.literal("no_project").optional(), message: z.string().optional() };

function result(value: unknown): PaseoToolResult {
  return { content: [], structuredContent: ensureValidJson(value) };
}

/** Agents may read and add, never replace or delete; the context is read-only to them. */
export function registerProjectContainerTools(
  registerTool: RegisterTool,
  deps: ProjectContainerToolDependencies,
): void {
  async function withProject(
    run: (project: ProjectContainer) => Promise<PaseoToolResult>,
  ): Promise<PaseoToolResult> {
    const cwd = deps.resolveCallerCwd();
    const project = cwd ? await deps.lookup.findForCwd(cwd) : null;
    if (!project) {
      return result({
        error: "no_project",
        message: "This workspace's repository is not in a Paseo project.",
      });
    }
    return run(project);
  }
  const ref = (project: ProjectContainer) => ({ id: project.id, name: project.name });

  registerTool(
    "project_notes_list",
    {
      title: "List project notes",
      description:
        "List the notes of the Paseo project this workspace's repository belongs to. Returns titles only; read one with project_note_read.",
      inputSchema: {},
      outputSchema: {
        project: ProjectRefSchema.optional(),
        notes: z
          .array(ProjectNoteSchema.pick({ id: true, title: true, updatedAt: true }))
          .optional(),
        ...NO_PROJECT,
      },
    },
    () =>
      withProject(async (project) => {
        const { notes } = await deps.files.get(project.id);
        const summaries = notes.map(({ id, title, updatedAt }) => ({ id, title, updatedAt }));
        return result({ project: ref(project), notes: summaries });
      }),
  );

  registerTool(
    "project_note_read",
    {
      title: "Read project note",
      description: "Read one note of this workspace's Paseo project, including its Markdown body.",
      inputSchema: { noteId: z.string() },
      outputSchema: { note: ProjectNoteSchema.optional(), ...NO_PROJECT },
    },
    ({ noteId }: { noteId: string }) =>
      withProject(async (project) => {
        const note = (await deps.files.get(project.id)).notes.find((item) => item.id === noteId);
        if (!note) throw new Error(`Note ${noteId} not found`);
        return result({ note });
      }),
  );

  registerTool(
    "project_note_create",
    {
      title: "Create project note",
      description:
        "Create a note in this workspace's Paseo project, shared with the user and every agent in the project. The body is Markdown.",
      inputSchema: { title: z.string(), body: z.string() },
      outputSchema: { note: ProjectNoteSchema.optional(), ...NO_PROJECT },
    },
    ({ title, body }: { title: string; body: string }) =>
      withProject(async (project) =>
        result({ note: await deps.files.createNote({ containerId: project.id, title, body }) }),
      ),
  );

  registerTool(
    "project_note_append",
    {
      title: "Append to project note",
      description:
        "Append a Markdown paragraph to the end of a project note. Existing text is never replaced.",
      inputSchema: { noteId: z.string(), text: z.string() },
      outputSchema: { note: ProjectNoteSchema.optional(), ...NO_PROJECT },
    },
    ({ noteId, text }: { noteId: string; text: string }) =>
      withProject(async (project) =>
        result({ note: await deps.files.appendNote({ containerId: project.id, noteId, text }) }),
      ),
  );

  registerTool(
    "project_todos_list",
    {
      title: "List project todos",
      description:
        "List the todos of this workspace's Paseo project in the user's order. Done todos are omitted unless includeDone is true.",
      inputSchema: { includeDone: z.boolean().optional() },
      outputSchema: {
        project: ProjectRefSchema.optional(),
        todos: z.array(ProjectTodoSchema).optional(),
        ...NO_PROJECT,
      },
    },
    ({ includeDone }: { includeDone?: boolean }) =>
      withProject(async (project) => {
        const { todos } = await deps.files.get(project.id);
        const visible = includeDone ? todos : todos.filter((todo) => !todo.done);
        return result({ project: ref(project), todos: visible });
      }),
  );

  registerTool(
    "project_todo_add",
    {
      title: "Add project todo",
      description: "Add a todo to the end of this workspace's Paseo project checklist.",
      inputSchema: { text: z.string() },
      outputSchema: { todo: ProjectTodoSchema.optional(), ...NO_PROJECT },
    },
    ({ text }: { text: string }) =>
      withProject(async (project) =>
        result({ todo: await deps.files.createTodo({ containerId: project.id, text }) }),
      ),
  );

  registerTool(
    "project_todo_set_done",
    {
      title: "Complete project todo",
      description: "Mark a project todo done or not done.",
      inputSchema: { todoId: z.string(), done: z.boolean() },
      outputSchema: { todo: ProjectTodoSchema.optional(), ...NO_PROJECT },
    },
    ({ todoId, done }: { todoId: string; done: boolean }) =>
      withProject(async (project) =>
        result({ todo: await deps.files.updateTodo({ containerId: project.id, todoId, done }) }),
      ),
  );

  registerTool(
    "project_context_read",
    {
      title: "Read project context",
      description:
        "Read the agent context the user wrote for this workspace's Paseo project. It is also appended to your system prompt at launch; read it again for the current version.",
      inputSchema: {},
      outputSchema: {
        project: ProjectRefSchema.optional(),
        context: z.string().optional(),
        ...NO_PROJECT,
      },
    },
    () =>
      withProject(async (project) => {
        const { context } = await deps.files.get(project.id);
        return result({ project: ref(project), context });
      }),
  );
}
