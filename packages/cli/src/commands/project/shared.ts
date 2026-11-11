import type { WorkspaceProjectDescriptorPayload } from "@getpaseo/protocol/messages";
import {
  findProjectContainerForProject,
  type ProjectContainer,
} from "@getpaseo/protocol/project-containers";
import type { OutputSchema } from "../../output/index.js";

export interface ProjectRow {
  projectId: string;
  name: string;
  kind: "git" | "non_git" | "directory";
  path: string;
  project?: string;
}

export const projectSchema: OutputSchema<ProjectRow> = {
  idField: "projectId",
  columns: [
    { header: "PROJECT ID", field: "projectId", width: 20 },
    { header: "NAME", field: "name", width: 24 },
    { header: "KIND", field: "kind", width: 10 },
    { header: "PROJECT", field: (row) => row.project ?? "", width: 16 },
    { header: "PATH", field: "path", width: 42 },
  ],
};

export function toProjectRow(
  project: WorkspaceProjectDescriptorPayload,
  containers: readonly ProjectContainer[] = [],
): ProjectRow {
  const container = findProjectContainerForProject(containers, project.projectId);
  return {
    projectId: project.projectId,
    name: project.projectDisplayName,
    kind: project.projectKind,
    path: project.projectRootPath,
    ...(container ? { project: container.name } : {}),
  };
}
