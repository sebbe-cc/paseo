import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type {
  ProjectContainer,
  ProjectContainerCatalog,
} from "@getpaseo/protocol/project-containers";
import { useMemo } from "react";
import { create } from "zustand";
import { i18n } from "@/i18n/i18next";
import { mergeProjectContainerCatalogs, type MergedProjectContainer } from "./internal/merge";

export {
  mergeProjectContainerCatalogs,
  placementForHost,
  type MergedProjectContainer,
  type ProjectContainerPlacement,
} from "./internal/merge";

export interface ProjectContainerHostSnapshot {
  serverId: string;
  containers: ProjectContainer[];
  revision: number;
  status: "offline" | "online" | "unsupported";
  error: string | null;
}

interface ProjectContainerState {
  hosts: Record<string, ProjectContainerHostSnapshot>;
  setHost: (host: ProjectContainerHostSnapshot) => void;
}

export const useProjectContainers = create<ProjectContainerState>((set) => ({
  hosts: {},
  setHost: (host) => set((state) => ({ hosts: { ...state.hosts, [host.serverId]: host } })),
}));

/** Offline hosts keep their last catalog so folders do not flicker away during a reconnect. */
export function projectProjectContainers(
  hostsById: Readonly<Record<string, ProjectContainerHostSnapshot>>,
  targetServerId?: string,
): MergedProjectContainer[] {
  const catalogs = Object.values(hostsById)
    .filter((host) => host.status !== "unsupported")
    .map((host) => ({ serverId: host.serverId, containers: host.containers }));
  return mergeProjectContainerCatalogs({ catalogs, targetServerId });
}

export function useMergedProjectContainers(targetServerId?: string): MergedProjectContainer[] {
  const hosts = useProjectContainers((state) => state.hosts);
  return useMemo(() => projectProjectContainers(hosts, targetServerId), [hosts, targetServerId]);
}

export function useProjectContainerHost(
  serverId: string | null | undefined,
): ProjectContainerHostSnapshot | undefined {
  return useProjectContainers((state) => (serverId ? state.hosts[serverId] : undefined));
}

/** Strips the transport suffixes `DaemonRpcError` appends, leaving the daemon's sentence. */
export function projectContainerErrorMessage(cause: unknown): string {
  if (!(cause instanceof Error)) return i18n.t("projectContainers.errors.update");
  const message = cause.message
    .replace(/ requestType=\S+/, "")
    .replace(/ code=\S+/, "")
    .trim();
  return message || i18n.t("projectContainers.errors.update");
}

interface HostConnection {
  client: DaemonClient;
  unsubscribe: () => void;
}

class ProjectContainersController {
  private readonly catalogs = new Map<string, ProjectContainerCatalog>();
  private readonly connections = new Map<string, HostConnection>();

  async connect(input: {
    serverId: string;
    client: DaemonClient;
    supportsProjectContainers: boolean;
  }): Promise<void> {
    const existing = this.connections.get(input.serverId);
    if (existing?.client === input.client && input.supportsProjectContainers) {
      await this.refresh(input.serverId);
      return;
    }
    this.disconnect(input.serverId);
    if (!input.supportsProjectContainers) {
      this.catalogs.delete(input.serverId);
      this.publish(input.serverId, "unsupported", null);
      return;
    }

    const subscription = input.client.observeProjectContainers();
    const connection: HostConnection = {
      client: input.client,
      unsubscribe: () => {
        void subscription.release().catch(() => undefined);
      },
    };
    this.connections.set(input.serverId, connection);
    subscription.subscribe({
      snapshot: (payload) => {
        this.accept(input.serverId, payload, true);
        this.publish(input.serverId, "online", null);
      },
      update: (message) => {
        if (message.type !== "project.container.update") return;
        if (this.accept(input.serverId, message.payload, false)) {
          this.publish(input.serverId, "online", null);
        }
      },
      error: (error) => {
        this.publish(input.serverId, "online", loadErrorMessage(error));
      },
    });
    await subscription.ready;
  }

  disconnect(serverId: string): void {
    this.connections.get(serverId)?.unsubscribe();
    const hadConnection = this.connections.delete(serverId);
    if (hadConnection || this.catalogs.has(serverId)) this.publish(serverId, "offline", null);
  }

  create(input: { serverId: string; name: string; projectIds?: string[] }) {
    return this.mutate(input.serverId, (client) =>
      client.createProjectContainer({ name: input.name, projectIds: input.projectIds }),
    );
  }

  rename(input: { serverId: string; containerId: string; name: string }) {
    return this.mutate(input.serverId, (client) =>
      client.renameProjectContainer({ containerId: input.containerId, name: input.name }),
    );
  }

  delete(input: { serverId: string; containerId: string }) {
    return this.mutate(input.serverId, (client) =>
      client.deleteProjectContainer({ containerId: input.containerId }),
    );
  }

  reorder(input: { serverId: string; containerIds: string[] }) {
    return this.mutate(input.serverId, (client) =>
      client.reorderProjectContainers({ containerIds: input.containerIds }),
    );
  }

  assign(input: {
    serverId: string;
    projectIds: string[];
    containerId: string | null;
    index?: number;
  }) {
    return this.mutate(input.serverId, (client) =>
      client.assignProjectContainer({
        projectIds: input.projectIds,
        containerId: input.containerId,
        index: input.index,
      }),
    );
  }

  /** A snapshot always wins; a push only when it is newer than what the host already showed. */
  private accept(serverId: string, catalog: ProjectContainerCatalog, snapshot: boolean): boolean {
    const current = this.catalogs.get(serverId);
    if (!snapshot && current && catalog.revision <= current.revision) return false;
    this.catalogs.set(serverId, { containers: catalog.containers, revision: catalog.revision });
    return true;
  }

  private async refresh(serverId: string): Promise<void> {
    const connection = this.connections.get(serverId);
    if (!connection) return;
    try {
      const catalog = await connection.client.listProjectContainers();
      if (this.connections.get(serverId) !== connection) return;
      this.accept(serverId, catalog, true);
      this.publish(serverId, "online", null);
    } catch (error) {
      if (this.connections.get(serverId) !== connection) throw error;
      this.publish(serverId, "online", loadErrorMessage(error));
      throw error;
    }
  }

  private async mutate<T>(serverId: string, operation: (client: DaemonClient) => Promise<T>) {
    const connection = this.connections.get(serverId);
    if (!connection) throw new Error(i18n.t("projectContainers.offline"));
    try {
      return await operation(connection.client);
    } catch (error) {
      await this.refresh(serverId).catch(() => undefined);
      throw error;
    }
  }

  private publish(
    serverId: string,
    status: ProjectContainerHostSnapshot["status"],
    error: string | null,
  ): void {
    const catalog = this.catalogs.get(serverId);
    useProjectContainers.getState().setHost({
      serverId,
      containers: catalog?.containers ?? [],
      revision: catalog?.revision ?? 0,
      status,
      error,
    });
  }
}

function loadErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : i18n.t("projectContainers.errors.load");
}

export const projectContainers = new ProjectContainersController();
