import type { ProjectContainerCatalog } from "@getpaseo/protocol/project-containers";
import type { SessionInboundMessage, SessionOutboundMessage } from "./messages.js";
import { ProjectContainerError, type ProjectContainerService } from "./project-containers/index.js";
import type { SessionDelivery } from "./session/owned-subscriptions/index.js";

type Inbound<T extends SessionInboundMessage["type"]> = Extract<SessionInboundMessage, { type: T }>;

export interface ProjectContainerSessionContext {
  service: ProjectContainerService | undefined;
  delivery: SessionDelivery;
  emit: (message: SessionOutboundMessage) => void;
}

/** Fork-only RPC family; kept out of session.ts so upstream rebases touch one dispatch line. */
export function dispatchProjectContainerMessage(
  context: ProjectContainerSessionContext,
  msg: SessionInboundMessage,
): Promise<void> | undefined {
  switch (msg.type) {
    case "project.container.list.request":
      return handleList(context, msg);
    case "project.container.create.request":
      return run(context, msg, async (service) => ({
        type: "project.container.create.response",
        payload: { requestId: msg.requestId, container: await service.create(msg) },
      }));
    case "project.container.rename.request":
      return run(context, msg, async (service) => ({
        type: "project.container.rename.response",
        payload: { requestId: msg.requestId, container: await service.rename(msg) },
      }));
    case "project.container.delete.request":
      return run(context, msg, async (service) => ({
        type: "project.container.delete.response",
        payload: { requestId: msg.requestId, ...(await service.delete(msg.containerId)) },
      }));
    case "project.container.reorder.request":
      return run(context, msg, async (service) => ({
        type: "project.container.reorder.response",
        payload: {
          requestId: msg.requestId,
          containerIds: await service.reorder(msg.containerIds),
        },
      }));
    case "project.container.assign.request":
      return run(context, msg, async (service) => ({
        type: "project.container.assign.response",
        payload: { requestId: msg.requestId, ...(await service.assign(msg)) },
      }));
    default:
      return undefined;
  }
}

function requireService(context: ProjectContainerSessionContext): ProjectContainerService {
  if (!context.service) {
    throw new ProjectContainerError(
      "project_containers_unavailable",
      "Projects are unavailable on this host",
    );
  }
  return context.service;
}

function emitError(
  context: ProjectContainerSessionContext,
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
  context: ProjectContainerSessionContext,
  request: { requestId: string; type: string },
  operation: (service: ProjectContainerService) => Promise<SessionOutboundMessage>,
): Promise<void> {
  try {
    context.emit(await operation(requireService(context)));
  } catch (error) {
    emitError(context, request, error);
  }
}

async function handleList(
  context: ProjectContainerSessionContext,
  request: Inbound<"project.container.list.request">,
): Promise<void> {
  let service: ProjectContainerService;
  try {
    service = requireService(context);
    if (!request.subscribe) {
      context.emit({
        type: "project.container.list.response",
        payload: { requestId: request.requestId, ...(await service.list()) },
      });
      return;
    }
  } catch (error) {
    emitError(context, request, error);
    return;
  }
  let unsubscribe: (() => void) | undefined;
  const owner = context.delivery.begin("projectContainers", request.subscribe.subscriptionId, () =>
    unsubscribe?.(),
  );
  try {
    let latest: ProjectContainerCatalog | null = null;
    let ready = false;
    const push = (catalog: ProjectContainerCatalog): void =>
      owner.emit({ type: "project.container.update", payload: catalog });
    const subscription = await service.subscribe((catalog) => {
      if (owner.signal.aborted) return;
      if (ready) push(catalog);
      else latest = catalog;
    });
    unsubscribe = subscription.unsubscribe;
    if (owner.signal.aborted) {
      unsubscribe();
      return;
    }
    context.emit({
      type: "project.container.list.response",
      payload: {
        requestId: request.requestId,
        subscriptionId: owner.responseId,
        ...subscription.snapshot,
      },
    });
    ready = true;
    const buffered = latest as ProjectContainerCatalog | null;
    if (buffered && buffered.revision > subscription.snapshot.revision) push(buffered);
  } catch (error) {
    await owner.release();
    emitError(context, request, error);
  }
}
