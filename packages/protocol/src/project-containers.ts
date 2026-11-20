import { z } from "zod";

export const PROJECT_CONTAINER_NAME_MAX_LENGTH = 64;
export const PROJECT_CONTAINER_ID_PREFIX = "pcnt_";

export const PROJECT_CONTAINER_ERROR_CODES = [
  "project_containers_unavailable",
  "project_container_not_found",
  "project_container_name_taken",
  "project_container_name_invalid",
  "project_container_order_invalid",
  "project_not_found",
  "project_container_failed",
] as const;

export type ProjectContainerErrorCode = (typeof PROJECT_CONTAINER_ERROR_CODES)[number];

/** A daemon-owned project above repositories. `projectIds` is the member order in the sidebar. */
export const ProjectContainerSchema = z.object({
  id: z.string(),
  name: z.string(),
  projectIds: z.array(z.string()),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type ProjectContainer = z.infer<typeof ProjectContainerSchema>;

/** `containers` is in display order; `revision` grows with every committed change. */
export interface ProjectContainerCatalog {
  containers: ProjectContainer[];
  revision: number;
}

const CatalogFields = {
  containers: z.array(ProjectContainerSchema),
  revision: z.number().int().nonnegative(),
};

export const ProjectContainerListRequestSchema = z.object({
  type: z.literal("project.container.list.request"),
  requestId: z.string(),
  subscribe: z.object({ subscriptionId: z.string().optional() }).optional(),
});
export const ProjectContainerCreateRequestSchema = z.object({
  type: z.literal("project.container.create.request"),
  requestId: z.string(),
  name: z.string(),
  projectIds: z.array(z.string()).optional(),
});
export const ProjectContainerRenameRequestSchema = z.object({
  type: z.literal("project.container.rename.request"),
  requestId: z.string(),
  containerId: z.string(),
  name: z.string(),
});
export const ProjectContainerDeleteRequestSchema = z.object({
  type: z.literal("project.container.delete.request"),
  requestId: z.string(),
  containerId: z.string(),
});
/** `containerIds` is the complete top-to-bottom order; it must name every container once. */
export const ProjectContainerReorderRequestSchema = z.object({
  type: z.literal("project.container.reorder.request"),
  requestId: z.string(),
  containerIds: z.array(z.string()),
});
/** A null `containerId` ungroups; `index` places the repositories inside the target container. */
export const ProjectContainerAssignRequestSchema = z.object({
  type: z.literal("project.container.assign.request"),
  requestId: z.string(),
  projectIds: z.array(z.string()).min(1),
  containerId: z.string().nullable(),
  index: z.number().int().nonnegative().optional(),
});

export const ProjectContainerListResponseSchema = z.object({
  type: z.literal("project.container.list.response"),
  payload: z.object({
    requestId: z.string(),
    subscriptionId: z.string().optional(),
    ...CatalogFields,
  }),
});
/** Whole-catalog push to `project.container.list` subscribers after every committed change. */
export const ProjectContainerUpdateSchema = z.object({
  type: z.literal("project.container.update"),
  payload: z.object({
    subscriptionId: z.string().optional(),
    ...CatalogFields,
  }),
});
export const ProjectContainerCreateResponseSchema = z.object({
  type: z.literal("project.container.create.response"),
  payload: z.object({ requestId: z.string(), container: ProjectContainerSchema }),
});
export const ProjectContainerRenameResponseSchema = z.object({
  type: z.literal("project.container.rename.response"),
  payload: z.object({ requestId: z.string(), container: ProjectContainerSchema }),
});
export const ProjectContainerDeleteResponseSchema = z.object({
  type: z.literal("project.container.delete.response"),
  payload: z.object({
    requestId: z.string(),
    containerId: z.string(),
    detachedProjectIds: z.array(z.string()),
  }),
});
export const ProjectContainerReorderResponseSchema = z.object({
  type: z.literal("project.container.reorder.response"),
  payload: z.object({ requestId: z.string(), containerIds: z.array(z.string()) }),
});
export const ProjectContainerAssignResponseSchema = z.object({
  type: z.literal("project.container.assign.response"),
  payload: z.object({
    requestId: z.string(),
    projectIds: z.array(z.string()),
    containerId: z.string().nullable(),
  }),
});

export function normalizeProjectContainerName(name: string): string {
  return name.replace(/\s+/g, " ").trim();
}

/** Case-insensitive identity for a name: used for uniqueness and for merging across hosts. */
export function projectContainerNameKey(name: string): string {
  return normalizeProjectContainerName(name).toLowerCase();
}

export function isValidProjectContainerName(name: string): boolean {
  const normalized = normalizeProjectContainerName(name);
  return normalized.length > 0 && normalized.length <= PROJECT_CONTAINER_NAME_MAX_LENGTH;
}

export function findProjectContainerForProject(
  containers: readonly ProjectContainer[],
  projectId: string,
): ProjectContainer | null {
  return containers.find((container) => container.projectIds.includes(projectId)) ?? null;
}
