import { Command } from "commander";
import type { ProjectNote } from "@getpaseo/protocol/project-container-files";
import type {
  CommandError,
  CommandOptions,
  ListResult,
  OutputSchema,
  SingleResult,
} from "../../../output/index.js";
import { withOutput } from "../../../output/index.js";
import { addJsonAndDaemonHostOptions } from "../../../utils/command-options.js";
import { readBodyOption, readTextInput, resolveNote, withProjectFiles } from "./files-shared.js";

interface NoteOptions extends CommandOptions {
  title?: string;
  body?: string;
  bodyFile?: string;
  file?: string;
}

interface ContextRow {
  containerId: string;
  context: string;
  contextUpdatedAt: string | null;
}

function noteListSchema(notes: ProjectNote[]): OutputSchema<ProjectNote> {
  return {
    idField: "id",
    columns: [
      { header: "#", field: (note) => notes.indexOf(note) + 1, width: 4 },
      { header: "ID", field: "id", width: 18 },
      { header: "TITLE", field: "title", width: 48 },
      { header: "UPDATED", field: "updatedAt", width: 24 },
    ],
  };
}

const noteSchema: OutputSchema<ProjectNote> = {
  idField: "id",
  columns: [],
  renderHuman: (result) => {
    const note = result.data as ProjectNote;
    return note.body ? `# ${note.title}\n\n${note.body}` : `# ${note.title}`;
  },
};

const contextSchema: OutputSchema<ContextRow> = {
  idField: "containerId",
  columns: [],
  renderHuman: (result) => (result.data as ContextRow).context,
};

function single(note: ProjectNote): SingleResult<ProjectNote> {
  return { type: "single", data: note, schema: noteSchema };
}

export function runNoteLs(
  ref: string,
  options: CommandOptions,
  _command?: Command,
): Promise<ListResult<ProjectNote>> {
  return withProjectFiles(options, ref, async ({ files }) => ({
    type: "list",
    data: files.notes,
    schema: noteListSchema(files.notes),
  }));
}

export function runNoteShow(
  ref: string,
  note: string,
  options: CommandOptions,
  _command?: Command,
) {
  return withProjectFiles(options, ref, async ({ files }) => single(resolveNote(files, note)));
}

export function runNoteCreate(ref: string, options: NoteOptions, _command?: Command) {
  return withProjectFiles(options, ref, async ({ client, container }) => {
    if (!options.title) {
      throw { code: "MISSING_TITLE", message: "--title is required" } satisfies CommandError;
    }
    const body = (await readBodyOption(options)) ?? "";
    const { note } = await client.createProjectNote({
      containerId: container.id,
      title: options.title,
      body,
    });
    return single(note);
  });
}

export function runNoteAppend(
  ref: string,
  noteRef: string,
  text: string | undefined,
  options: NoteOptions,
  _command?: Command,
) {
  return withProjectFiles(options, ref, async ({ client, container, files }) => {
    const paragraph = options.file !== undefined ? await readTextInput(options.file) : text;
    if (!paragraph?.trim()) {
      throw { code: "MISSING_TEXT", message: "Give the text or --file" } satisfies CommandError;
    }
    const { note } = await client.appendProjectNote({
      containerId: container.id,
      noteId: resolveNote(files, noteRef).id,
      text: paragraph,
    });
    return single(note);
  });
}

export function runNoteUpdate(
  ref: string,
  noteRef: string,
  options: NoteOptions,
  _command?: Command,
) {
  return withProjectFiles(options, ref, async ({ client, container, files }) => {
    const current = resolveNote(files, noteRef);
    const body = await readBodyOption(options);
    if (options.title === undefined && body === undefined) {
      throw {
        code: "NOTHING_TO_UPDATE",
        message: "Give --title, --body or --body-file",
      } satisfies CommandError;
    }
    const { note } = await client.updateProjectNote({
      containerId: container.id,
      noteId: current.id,
      ...(options.title === undefined ? {} : { title: options.title }),
      ...(body === undefined ? {} : { body }),
      expectedUpdatedAt: current.updatedAt,
    });
    return single(note);
  });
}

export function runNoteDelete(
  ref: string,
  noteRef: string,
  options: CommandOptions,
  _command?: Command,
) {
  return withProjectFiles(options, ref, async ({ client, container, files }) => {
    const note = resolveNote(files, noteRef);
    await client.deleteProjectNote({ containerId: container.id, noteId: note.id });
    return single(note);
  });
}

export function runContextShow(ref: string, options: CommandOptions, _command?: Command) {
  return withProjectFiles(
    options,
    ref,
    async ({ container, files }): Promise<SingleResult<ContextRow>> => ({
      type: "single",
      data: {
        containerId: container.id,
        context: files.context,
        contextUpdatedAt: files.contextUpdatedAt,
      },
      schema: contextSchema,
    }),
  );
}

export function runContextSet(
  ref: string,
  text: string | undefined,
  options: NoteOptions,
  _command?: Command,
) {
  return withProjectFiles(options, ref, async ({ client, container }) => {
    const content = options.file !== undefined ? await readTextInput(options.file) : text;
    if (content === undefined) {
      throw { code: "MISSING_TEXT", message: "Give the context or --file" } satisfies CommandError;
    }
    const { contextUpdatedAt } = await client.writeProjectContext({
      containerId: container.id,
      content,
    });
    return {
      type: "single" as const,
      data: { containerId: container.id, context: content, contextUpdatedAt },
      schema: { ...contextSchema, renderHuman: () => `Saved context of ${container.name}` },
    };
  });
}

const PROJECT_ARG = ["<project>", "Project id or name"] as const;
const NOTE_ARG = ["<note>", "Note id, position from `note ls`, or exact title"] as const;

export function createProjectNoteCommand(): Command {
  const note = new Command("note").description("Read and write a project's shared notes");
  const add = addJsonAndDaemonHostOptions;
  add(
    note
      .command("ls")
      .description("List notes in order")
      .argument(...PROJECT_ARG),
  ).action(withOutput(runNoteLs));
  add(
    note
      .command("show")
      .description("Print a note")
      .argument(...PROJECT_ARG)
      .argument(...NOTE_ARG),
  ).action(withOutput(runNoteShow));
  add(
    note
      .command("create")
      .description("Create a note")
      .argument(...PROJECT_ARG)
      .requiredOption("--title <title>", "Note title")
      .option("--body <markdown>", "Note body")
      .option("--body-file <path>", "Read the body from a file, or - for stdin"),
  ).action(withOutput(runNoteCreate));
  add(
    note
      .command("append")
      .description("Append a paragraph to a note")
      .argument(...PROJECT_ARG)
      .argument(...NOTE_ARG)
      .argument("[text]", "Markdown paragraph")
      .option("--file <path>", "Read the paragraph from a file, or - for stdin"),
  ).action(withOutput(runNoteAppend));
  add(
    note
      .command("update")
      .description("Replace a note's title or body")
      .argument(...PROJECT_ARG)
      .argument(...NOTE_ARG)
      .option("--title <title>", "New title")
      .option("--body <markdown>", "New body")
      .option("--body-file <path>", "Read the new body from a file, or - for stdin"),
  ).action(withOutput(runNoteUpdate));
  add(
    note
      .command("delete")
      .description("Delete a note")
      .argument(...PROJECT_ARG)
      .argument(...NOTE_ARG),
  ).action(withOutput(runNoteDelete));
  return note;
}

export function createProjectContextCommand(): Command {
  const context = new Command("context").description(
    "Read and write the context appended to every agent's system prompt in a project",
  );
  const add = addJsonAndDaemonHostOptions;
  add(
    context
      .command("show")
      .description("Print the context")
      .argument(...PROJECT_ARG),
  ).action(withOutput(runContextShow));
  add(
    context
      .command("set")
      .description("Replace the context")
      .argument(...PROJECT_ARG)
      .argument("[markdown]", "New context")
      .option("--file <path>", "Read the context from a file, or - for stdin"),
  ).action(withOutput(runContextSet));
  return context;
}
