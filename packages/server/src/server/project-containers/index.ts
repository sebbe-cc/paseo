import { join } from "node:path";
import type { ProjectRegistry } from "../workspace-registry.js";
import { ProjectContainerFilesService, type ContainerCatalogSource } from "./files-service.js";
import { ProjectContainerFilesStore } from "./files-store.js";
import { ProjectContainerService } from "./service.js";
import { ProjectContainerStore, type WriteContainersFile } from "./store.js";

export { ProjectContainerError, ProjectContainerService } from "./service.js";
export { ProjectContainerFilesService } from "./files-service.js";

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

export function createProjectContainerFilesService(input: {
  paseoHome: string;
  containers: ContainerCatalogSource;
  now?: () => string;
  generateId?: (prefix: string) => string;
}): ProjectContainerFilesService {
  return new ProjectContainerFilesService(
    new ProjectContainerFilesStore(join(input.paseoHome, "projects", "containers")),
    input.containers,
    input.now,
    input.generateId,
  );
}
