import { join } from "node:path";
import type { ProjectRegistry } from "../workspace-registry.js";
import { ProjectContainerService } from "./service.js";
import { ProjectContainerStore, type WriteContainersFile } from "./store.js";

export { ProjectContainerError, ProjectContainerService } from "./service.js";

export function createProjectContainerService(input: {
  paseoHome: string;
  projectRegistry: Pick<ProjectRegistry, "list" | "subscribeToMutations">;
  write?: WriteContainersFile;
  now?: () => string;
  generateId?: () => string;
}): ProjectContainerService {
  return new ProjectContainerService(
    new ProjectContainerStore(join(input.paseoHome, "projects", "containers.json"), input.write),
    input.projectRegistry,
    input.now,
    input.generateId,
  );
}
