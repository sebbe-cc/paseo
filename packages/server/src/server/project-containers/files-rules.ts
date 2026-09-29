import { randomBytes } from "node:crypto";
import {
  PROJECT_CONTEXT_MAX_LENGTH,
  PROJECT_NOTE_BODY_MAX_LENGTH,
  PROJECT_NOTE_TITLE_MAX_LENGTH,
  PROJECT_TODO_TEXT_MAX_LENGTH,
} from "@getpaseo/protocol/project-container-files";
import { ProjectContainerError } from "./service.js";

export function generateEntityId(prefix: string): string {
  return `${prefix}${randomBytes(6).toString("hex")}`;
}

function invalid(message: string): ProjectContainerError {
  return new ProjectContainerError("project_container_entity_invalid", message);
}

export function requireTitle(raw: string): string {
  const title = raw.trim();
  if (!title || title.length > PROJECT_NOTE_TITLE_MAX_LENGTH) {
    throw invalid(`Note title must be 1-${PROJECT_NOTE_TITLE_MAX_LENGTH} characters`);
  }
  return title;
}

export function requireBody(body: string): string {
  if (body.length > PROJECT_NOTE_BODY_MAX_LENGTH) {
    throw invalid(`Note body must be at most ${PROJECT_NOTE_BODY_MAX_LENGTH} characters`);
  }
  return body;
}

export function requireTodoText(raw: string): string {
  const text = raw.trim();
  if (!text || text.length > PROJECT_TODO_TEXT_MAX_LENGTH) {
    throw invalid(`Todo text must be 1-${PROJECT_TODO_TEXT_MAX_LENGTH} characters`);
  }
  return text;
}

export function requireContext(content: string): string {
  if (content.length > PROJECT_CONTEXT_MAX_LENGTH) {
    throw invalid(`Context must be at most ${PROJECT_CONTEXT_MAX_LENGTH} characters`);
  }
  return content;
}

/** `expected` undefined skips the check; anything else must match the stored token exactly. */
export function requireToken(actual: string | null, expected: string | null | undefined): void {
  if (expected !== undefined && actual !== expected) {
    throw new ProjectContainerError(
      "project_container_conflict",
      "Changed elsewhere since you opened it; reload and try again",
    );
  }
}

export function requireEntity<T extends { id: string }>(
  items: readonly T[],
  id: string,
  code: "project_note_not_found" | "project_todo_not_found",
): T {
  const found = items.find((item) => item.id === id);
  if (!found) throw new ProjectContainerError(code, `${id} not found`);
  return found;
}

export function insertAt<T>(items: readonly T[], item: T, index: number | undefined): T[] {
  const at = Math.min(index ?? items.length, items.length);
  return [...items.slice(0, at), item, ...items.slice(at)];
}

export function replaceById<T extends { id: string }>(items: readonly T[], next: T): T[] {
  return items.map((item) => (item.id === next.id ? next : item));
}

export function reorderById<T extends { id: string }>(
  items: readonly T[],
  ids: readonly string[],
): T[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  if (
    ids.length !== items.length ||
    new Set(ids).size !== ids.length ||
    ids.some((id) => !byId.has(id))
  ) {
    throw invalid("Order must list every item exactly once");
  }
  return ids.map((id) => byId.get(id)!);
}
