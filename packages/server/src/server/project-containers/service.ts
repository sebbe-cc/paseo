import { randomBytes } from "node:crypto";
import {
  isValidProjectContainerName,
  normalizeProjectContainerName,
  projectContainerNameKey,
  PROJECT_CONTAINER_ID_PREFIX,
  type ProjectContainer,
  type ProjectContainerCatalog,
  type ProjectContainerErrorCode,
} from "@getpaseo/protocol/project-containers";
import type { ProjectRegistry } from "../workspace-registry.js";
import type { ProjectContainerStore } from "./store.js";

export class ProjectContainerError extends Error {
  constructor(
    readonly code: ProjectContainerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ProjectContainerError";
  }
}

type Listener = (catalog: ProjectContainerCatalog) => void;

export function generateProjectContainerId(): string {
  return `${PROJECT_CONTAINER_ID_PREFIX}${randomBytes(8).toString("hex")}`;
}

/** Daemon-owned projects above repositories. Mutations are serialised; every commit is pushed. */
export class ProjectContainerService {
  private operations: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<Listener>();
  private unsubscribeRegistry: (() => void) | null = null;

  constructor(
    private readonly store: ProjectContainerStore,
    private readonly projects: Pick<ProjectRegistry, "list" | "subscribeToMutations">,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly generateId: () => string = generateProjectContainerId,
  ) {}

  async initialize(): Promise<void> {
    await this.exclusive(async () => {
      const state = await this.store.load();
      const active = await this.activeProjectIds();
      // An empty registry means it failed to load or is new; pruning then would empty every project.
      if (active.size === 0) return;
      const pruned = state.containers.map((container) => ({
        ...container,
        projectIds: container.projectIds.filter((id) => active.has(id)),
      }));
      if (
        pruned.some(
          (container, i) => container.projectIds.length !== state.containers[i]!.projectIds.length,
        )
      ) {
        await this.commit(pruned);
      }
    });
    this.unsubscribeRegistry =
      this.projects.subscribeToMutations?.((mutation) => {
        if (mutation.kind === "upsert") return;
        return this.detachProject(mutation.projectId).catch(() => undefined);
      }) ?? null;
  }

  dispose(): void {
    this.unsubscribeRegistry?.();
    this.unsubscribeRegistry = null;
    this.listeners.clear();
  }

  async list(): Promise<ProjectContainerCatalog> {
    return this.exclusive(async () => toCatalog(await this.store.load()));
  }

  /** Returns the snapshot and registers the listener inside one critical section, so no push is lost. */
  async subscribe(
    listener: Listener,
  ): Promise<{ snapshot: ProjectContainerCatalog; unsubscribe: () => void }> {
    return this.exclusive(async () => {
      const snapshot = toCatalog(await this.store.load());
      this.listeners.add(listener);
      return { snapshot, unsubscribe: () => this.listeners.delete(listener) };
    });
  }

  async create(input: { name: string; projectIds?: string[] }): Promise<ProjectContainer> {
    return this.exclusive(async () => {
      const { containers } = await this.store.load();
      const name = requireName(input.name, containers);
      const projectIds = input.projectIds ? await this.requireProjects(input.projectIds) : [];
      const timestamp = this.now();
      const container: ProjectContainer = {
        id: this.generateId(),
        name,
        projectIds,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      const next = [...detach(containers, projectIds, timestamp), container];
      await this.commit(next);
      return container;
    });
  }

  async rename(input: { containerId: string; name: string }): Promise<ProjectContainer> {
    return this.exclusive(async () => {
      const { containers } = await this.store.load();
      const existing = requireContainer(containers, input.containerId);
      const name = requireName(input.name, containers, existing.id);
      if (name === existing.name) return existing;
      const renamed = { ...existing, name, updatedAt: this.now() };
      await this.commit(
        containers.map((container) => (container.id === existing.id ? renamed : container)),
      );
      return renamed;
    });
  }

  async delete(
    containerId: string,
  ): Promise<{ containerId: string; detachedProjectIds: string[] }> {
    return this.exclusive(async () => {
      const { containers } = await this.store.load();
      const existing = requireContainer(containers, containerId);
      await this.commit(containers.filter((container) => container.id !== containerId));
      return { containerId, detachedProjectIds: existing.projectIds };
    });
  }

  async reorder(containerIds: string[]): Promise<string[]> {
    return this.exclusive(async () => {
      const { containers } = await this.store.load();
      const byId = new Map(containers.map((container) => [container.id, container]));
      if (
        containerIds.length !== containers.length ||
        new Set(containerIds).size !== containerIds.length ||
        containerIds.some((id) => !byId.has(id))
      ) {
        throw new ProjectContainerError(
          "project_container_order_invalid",
          "Order must list every project exactly once",
        );
      }
      if (containerIds.every((id, index) => containers[index]!.id === id)) return containerIds;
      await this.commit(containerIds.map((id) => byId.get(id)!));
      return containerIds;
    });
  }

  async assign(input: {
    projectIds: string[];
    containerId: string | null;
    index?: number;
  }): Promise<{ projectIds: string[]; containerId: string | null }> {
    return this.exclusive(async () => {
      const { containers } = await this.store.load();
      if (input.containerId !== null) requireContainer(containers, input.containerId);
      const projectIds = await this.requireProjects(input.projectIds);
      const timestamp = this.now();
      const next = detach(containers, projectIds, timestamp).map((container) => {
        if (container.id !== input.containerId) return container;
        const at = Math.min(
          input.index ?? container.projectIds.length,
          container.projectIds.length,
        );
        const members = [
          ...container.projectIds.slice(0, at),
          ...projectIds,
          ...container.projectIds.slice(at),
        ];
        return { ...container, projectIds: members, updatedAt: timestamp };
      });
      if (!sameMembership(containers, next)) await this.commit(next);
      return { projectIds, containerId: input.containerId };
    });
  }

  /** Called when a repository is removed or archived so it never lingers in a project. */
  async detachProject(projectId: string): Promise<void> {
    await this.exclusive(async () => {
      const { containers } = await this.store.load();
      if (!containers.some((container) => container.projectIds.includes(projectId))) return;
      await this.commit(detach(containers, [projectId], this.now()));
    });
  }

  private async commit(containers: ProjectContainer[]): Promise<void> {
    const catalog = toCatalog(await this.store.save(containers));
    for (const listener of this.listeners) listener(catalog);
  }

  private async activeProjectIds(): Promise<Set<string>> {
    const projects = await this.projects.list();
    return new Set(
      projects.filter((project) => !project.archivedAt).map((project) => project.projectId),
    );
  }

  private async requireProjects(projectIds: readonly string[]): Promise<string[]> {
    const active = await this.activeProjectIds();
    const unique = [...new Set(projectIds)];
    const missing = unique.find((id) => !active.has(id));
    if (missing)
      throw new ProjectContainerError("project_not_found", `Repository ${missing} not found`);
    return unique;
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

function toCatalog(state: {
  revision: number;
  containers: ProjectContainer[];
}): ProjectContainerCatalog {
  return { revision: state.revision, containers: state.containers };
}

function requireContainer(
  containers: readonly ProjectContainer[],
  containerId: string,
): ProjectContainer {
  const container = containers.find((candidate) => candidate.id === containerId);
  if (!container)
    throw new ProjectContainerError("project_container_not_found", "Project not found");
  return container;
}

function requireName(
  raw: string,
  containers: readonly ProjectContainer[],
  selfId?: string,
): string {
  if (!isValidProjectContainerName(raw)) {
    throw new ProjectContainerError(
      "project_container_name_invalid",
      "Project name must be 1-64 characters",
    );
  }
  const name = normalizeProjectContainerName(raw);
  const key = projectContainerNameKey(name);
  if (
    containers.some(
      (container) => container.id !== selfId && projectContainerNameKey(container.name) === key,
    )
  ) {
    throw new ProjectContainerError(
      "project_container_name_taken",
      `A project named "${name}" already exists`,
    );
  }
  return name;
}

function detach(
  containers: readonly ProjectContainer[],
  projectIds: readonly string[],
  timestamp: string,
): ProjectContainer[] {
  const moving = new Set(projectIds);
  return containers.map((container) => {
    if (!container.projectIds.some((id) => moving.has(id))) return container;
    return {
      ...container,
      projectIds: container.projectIds.filter((id) => !moving.has(id)),
      updatedAt: timestamp,
    };
  });
}

function sameMembership(
  left: readonly ProjectContainer[],
  right: readonly ProjectContainer[],
): boolean {
  return left.every(
    (container, i) => container.projectIds.join("\0") === right[i]!.projectIds.join("\0"),
  );
}
