import type { ProjectContainer } from "@getpaseo/protocol/project-containers";
import { resolveWorkspaceIdForPath } from "../resolve-workspace-id-for-path.js";
import type { WorkspaceRegistry } from "../workspace-registry.js";
import type { ProjectContainerFilesService } from "./files-service.js";
import type { ProjectContainerService } from "./service.js";

export interface ProjectContainerCwdLookup {
  /** The project whose repository owns the workspace at `cwd`, or null when ungrouped. */
  findForCwd(cwd: string): Promise<ProjectContainer | null>;
  /** The `# Project: <name>` block agents get appended to the daemon system prompt. */
  contextPromptForCwd(cwd: string): Promise<string | null>;
}

export function createProjectContainerCwdLookup(deps: {
  workspaceRegistry: Pick<WorkspaceRegistry, "list">;
  containers: Pick<ProjectContainerService, "list">;
  files: Pick<ProjectContainerFilesService, "get">;
}): ProjectContainerCwdLookup {
  async function findForCwd(cwd: string): Promise<ProjectContainer | null> {
    const workspaces = await deps.workspaceRegistry.list();
    const workspaceId = resolveWorkspaceIdForPath(cwd, workspaces);
    const workspace = workspaces.find((candidate) => candidate.workspaceId === workspaceId);
    if (!workspace) return null;
    const { containers } = await deps.containers.list();
    return (
      containers.find((container) => container.projectIds.includes(workspace.projectId)) ?? null
    );
  }
  return {
    findForCwd,
    async contextPromptForCwd(cwd) {
      const container = await findForCwd(cwd);
      if (!container) return null;
      const { context } = await deps.files.get(container.id);
      return formatProjectContextPrompt(container.name, context);
    },
  };
}

export function formatProjectContextPrompt(name: string, context: string): string | null {
  const body = context.trim();
  return body ? `# Project: ${name}\n${body}` : null;
}
