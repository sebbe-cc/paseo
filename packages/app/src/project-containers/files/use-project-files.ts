import { useEffect, useState } from "react";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { ProjectContainerFiles } from "@getpaseo/protocol/project-container-files";
import { i18n } from "@/i18n/i18next";

export type ProjectFilesState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; files: ProjectContainerFiles };

/** Drops the transport fields (`requestId`, `subscriptionId`) a snapshot or push carries. */
function toFiles(payload: ProjectContainerFiles): ProjectContainerFiles {
  const { containerId, notes, todos, context, contextUpdatedAt, revision } = payload;
  return { containerId, notes, todos, context, contextUpdatedAt, revision };
}

/** A snapshot always wins; a push only when it is newer than what is on screen. */
export function acceptProjectFiles(
  current: ProjectFilesState,
  next: ProjectContainerFiles,
  snapshot: boolean,
): ProjectFilesState {
  if (!snapshot && current.status === "ready" && next.revision <= current.files.revision) {
    return current;
  }
  return { status: "ready", files: toFiles(next) };
}

function loadError(error: unknown): string {
  return error instanceof Error ? error.message : i18n.t("projectContainers.errors.load");
}

// Live files of one project on one host. The subscription re-snapshots on reconnect and is
// released when the screen goes away or the host client changes.
export function useProjectFiles(
  client: DaemonClient | null,
  containerId: string,
): ProjectFilesState {
  const [state, setState] = useState<ProjectFilesState>({ status: "loading" });
  useEffect(() => {
    if (!client) return undefined;
    setState({ status: "loading" });
    const subscription = client.observeProjectContainerFiles({ containerId });
    const accept = (payload: ProjectContainerFiles, snapshot: boolean) => {
      if (payload.containerId !== containerId) return;
      setState((current) => acceptProjectFiles(current, payload, snapshot));
    };
    const unsubscribe = subscription.subscribe({
      snapshot: (payload) => accept(payload, true),
      update: (message) => {
        if (message.type === "project.container.files.update") accept(message.payload, false);
      },
      error: (error) => setState({ status: "error", message: loadError(error) }),
    });
    return () => {
      unsubscribe();
      void subscription.release().catch(() => undefined);
    };
  }, [client, containerId]);
  return state;
}
