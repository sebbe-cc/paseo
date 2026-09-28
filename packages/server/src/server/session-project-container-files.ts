import type { ProjectContainerFiles } from "@getpaseo/protocol/project-container-files";
import type { SessionInboundMessage, SessionOutboundMessage } from "./messages.js";
import {
  ProjectContainerError,
  type ProjectContainerFilesService,
} from "./project-containers/index.js";
import type { SessionDelivery } from "./session/owned-subscriptions/index.js";

type Inbound<T extends SessionInboundMessage["type"]> = Extract<SessionInboundMessage, { type: T }>;
type Service = ProjectContainerFilesService;

export interface ProjectContainerFilesSessionContext {
  service: Service | undefined;
  delivery: SessionDelivery;
  emit: (message: SessionOutboundMessage) => void;
}

/** Fork-only notes, todos and context RPCs of a project; see session-project-containers.ts. */
export function dispatchProjectContainerFilesMessage(
  context: ProjectContainerFilesSessionContext,
  msg: SessionInboundMessage,
): Promise<void> | undefined {
  switch (msg.type) {
    case "project.container.files.get.request":
      return handleGet(context, msg);
    case "project.container.note.create.request":
      return run(context, msg, async (service) => ({
        type: "project.container.note.create.response",
        payload: { requestId: msg.requestId, note: await service.createNote(msg) },
      }));
    case "project.container.note.update.request":
      return run(context, msg, async (service) => ({
        type: "project.container.note.update.response",
        payload: { requestId: msg.requestId, note: await service.updateNote(msg) },
      }));
    case "project.container.note.append.request":
      return run(context, msg, async (service) => ({
        type: "project.container.note.append.response",
        payload: { requestId: msg.requestId, note: await service.appendNote(msg) },
      }));
    case "project.container.note.delete.request":
      return run(context, msg, async (service) => ({
        type: "project.container.note.delete.response",
        payload: { requestId: msg.requestId, noteId: await service.deleteNote(msg) },
      }));
    case "project.container.note.reorder.request":
      return run(context, msg, async (service) => ({
        type: "project.container.note.reorder.response",
        payload: { requestId: msg.requestId, noteIds: await service.reorderNotes(msg) },
      }));
    case "project.container.todo.create.request":
      return run(context, msg, async (service) => ({
        type: "project.container.todo.create.response",
        payload: { requestId: msg.requestId, todo: await service.createTodo(msg) },
      }));
    case "project.container.todo.update.request":
      return run(context, msg, async (service) => ({
        type: "project.container.todo.update.response",
        payload: { requestId: msg.requestId, todo: await service.updateTodo(msg) },
      }));
    case "project.container.todo.delete.request":
      return run(context, msg, async (service) => ({
        type: "project.container.todo.delete.response",
        payload: { requestId: msg.requestId, todoId: await service.deleteTodo(msg) },
      }));
    case "project.container.todo.reorder.request":
      return run(context, msg, async (service) => ({
        type: "project.container.todo.reorder.response",
        payload: { requestId: msg.requestId, todoIds: await service.reorderTodos(msg) },
      }));
    case "project.container.context.write.request":
      return run(context, msg, async (service) => ({
        type: "project.container.context.write.response",
        payload: { requestId: msg.requestId, contextUpdatedAt: await service.writeContext(msg) },
      }));
    default:
      return undefined;
  }
}

function requireService(context: ProjectContainerFilesSessionContext): Service {
  if (!context.service) {
    throw new ProjectContainerError(
      "project_containers_unavailable",
      "Project notes are unavailable on this host",
    );
  }
  return context.service;
}

function emitError(
  context: ProjectContainerFilesSessionContext,
  request: { requestId: string; type: string },
  error: unknown,
): void {
  context.emit({
    type: "rpc_error",
    payload: {
      requestId: request.requestId,
      requestType: request.type,
      code: error instanceof ProjectContainerError ? error.code : "project_container_failed",
      error: error instanceof Error ? error.message : "Project operation failed",
    },
  });
}

async function run(
  context: ProjectContainerFilesSessionContext,
  request: { requestId: string; type: string },
  operation: (service: Service) => Promise<SessionOutboundMessage>,
): Promise<void> {
  try {
    context.emit(await operation(requireService(context)));
  } catch (error) {
    emitError(context, request, error);
  }
}

async function handleGet(
  context: ProjectContainerFilesSessionContext,
  request: Inbound<"project.container.files.get.request">,
): Promise<void> {
  const { requestId, containerId } = request;
  let service: Service;
  try {
    service = requireService(context);
    if (!request.subscribe) {
      const files = await service.get(containerId);
      context.emit({
        type: "project.container.files.get.response",
        payload: { requestId, ...files },
      });
      return;
    }
  } catch (error) {
    emitError(context, request, error);
    return;
  }
  let unsubscribe: (() => void) | undefined;
  const owner = context.delivery.begin(
    "projectContainerFiles",
    request.subscribe.subscriptionId,
    () => unsubscribe?.(),
    `projectContainerFiles:${containerId}`,
  );
  try {
    let latest: ProjectContainerFiles | null = null;
    let ready = false;
    const push = (files: ProjectContainerFiles): void =>
      owner.emit({ type: "project.container.files.update", payload: files });
    const subscription = await service.subscribe(containerId, (files) => {
      if (owner.signal.aborted) return;
      if (ready) push(files);
      else latest = files;
    });
    unsubscribe = subscription.unsubscribe;
    if (owner.signal.aborted) {
      unsubscribe();
      return;
    }
    context.emit({
      type: "project.container.files.get.response",
      payload: { requestId, subscriptionId: owner.responseId, ...subscription.snapshot },
    });
    ready = true;
    const buffered = latest as ProjectContainerFiles | null;
    if (buffered && buffered.revision > subscription.snapshot.revision) push(buffered);
  } catch (error) {
    await owner.release();
    emitError(context, request, error);
  }
}
