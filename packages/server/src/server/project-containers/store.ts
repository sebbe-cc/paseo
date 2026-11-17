import { promises as fs } from "node:fs";
import { z } from "zod";
import {
  ProjectContainerSchema,
  type ProjectContainer,
} from "@getpaseo/protocol/project-containers";
import { writeJsonFileAtomic } from "../atomic-file.js";

const ContainersFileSchema = z.object({
  version: z.literal(1),
  revision: z.number().int().nonnegative(),
  containers: z.array(ProjectContainerSchema),
});

export interface ProjectContainerState {
  revision: number;
  containers: ProjectContainer[];
}

export type WriteContainersFile = (filePath: string, value: unknown) => Promise<void>;

/** Owns `containers.json`. The array order is the display order; there is no separate index. */
export class ProjectContainerStore {
  private state: ProjectContainerState | null = null;

  constructor(
    private readonly filePath: string,
    private readonly write: WriteContainersFile = writeJsonFileAtomic,
  ) {}

  async load(): Promise<ProjectContainerState> {
    if (this.state) return this.state;
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.state = { revision: 0, containers: [] };
      return this.state;
    }
    const parsed = ContainersFileSchema.parse(JSON.parse(raw));
    this.state = { revision: parsed.revision, containers: parsed.containers };
    return this.state;
  }

  /** Writes first, then swaps the cache, so a failed write leaves memory matching disk. */
  async save(containers: ProjectContainer[]): Promise<ProjectContainerState> {
    const current = await this.load();
    const next = { revision: current.revision + 1, containers };
    await this.write(this.filePath, { version: 1, ...next });
    this.state = next;
    return next;
  }
}
