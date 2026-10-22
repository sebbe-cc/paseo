import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type {
  ProjectContainerFiles,
  ProjectNote,
  ProjectTodo,
} from "@getpaseo/protocol/project-container-files";
import type { ProjectContainer } from "@getpaseo/protocol/project-containers";
import type { CommandError, CommandOptions } from "../../../output/index.js";
import { resolveContainer, withContainerClient } from "./shared.js";

export interface ProjectFilesScope {
  client: DaemonClient;
  container: ProjectContainer;
  files: ProjectContainerFiles;
}

/** Resolves `ref` on a host with project notes and hands over its current files. */
export function withProjectFiles<T>(
  options: CommandOptions,
  ref: string,
  operation: (scope: ProjectFilesScope) => Promise<T>,
): Promise<T> {
  return withContainerClient(options, async (client) => {
    if (!client.getLastServerInfoMessage()?.features?.projectContainerFiles) {
      throw {
        code: "PROJECT_FILES_UNSUPPORTED",
        message: "This host does not support project notes; update it to the fork build",
      } satisfies CommandError;
    }
    const { containers } = await client.listProjectContainers();
    const container = resolveContainer({ containers, repositories: [] }, ref);
    const files = await client.getProjectContainerFiles({ containerId: container.id });
    return operation({ client, container, files });
  });
}

/** Accepts an id, a 1-based position as `ls` prints it, or (for notes) an exact title. */
function resolveEntity<T extends { id: string }>(input: {
  items: T[];
  ref: string;
  kind: "note" | "todo";
  label?: (item: T) => string;
}): T {
  const { items, ref, kind, label } = input;
  const position = /^\d+$/.test(ref) ? items[Number(ref) - 1] : undefined;
  const match =
    items.find((item) => item.id === ref) ??
    position ??
    items.find((item) => label?.(item).toLowerCase() === ref.toLowerCase());
  if (!match) {
    throw {
      code: kind === "note" ? "NOTE_NOT_FOUND" : "TODO_NOT_FOUND",
      message: `No ${kind} matches "${ref}"`,
    } satisfies CommandError;
  }
  return match;
}

export function resolveNote(files: ProjectContainerFiles, ref: string): ProjectNote {
  return resolveEntity({ items: files.notes, ref, kind: "note", label: (note) => note.title });
}

export function resolveTodo(files: ProjectContainerFiles, ref: string): ProjectTodo {
  return resolveEntity({ items: files.todos, ref, kind: "todo" });
}

/** Reads Markdown from `path`, or from stdin when `path` is `-`. */
export async function readTextInput(path: string): Promise<string> {
  if (path === "-") {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks).toString("utf8");
  }
  try {
    return await readFile(resolve(path), "utf8");
  } catch (error) {
    throw {
      code: "FILE_READ_ERROR",
      message: `Failed to read ${path}`,
      details: error instanceof Error ? error.message : String(error),
    } satisfies CommandError;
  }
}

/** `--body` wins over `--body-file`; neither leaves the body unchanged (undefined). */
export async function readBodyOption(options: {
  body?: string;
  bodyFile?: string;
}): Promise<string | undefined> {
  if (options.body !== undefined) return options.body;
  if (options.bodyFile !== undefined) return readTextInput(options.bodyFile);
  return undefined;
}
