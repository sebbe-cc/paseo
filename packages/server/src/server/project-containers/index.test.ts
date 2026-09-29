import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { ProjectContainerCatalog } from "@getpaseo/protocol/project-containers";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { createPersistedProjectRecord, FileBackedProjectRegistry } from "../workspace-registry.js";
import {
  createProjectContainerService,
  ProjectContainerError,
  type ProjectContainerService,
} from "./index.js";

const T = "2026-09-25T00:00:00.000Z";

describe("project containers", () => {
  let paseoHome: string;
  let registry: FileBackedProjectRegistry;
  let service: ProjectContainerService;
  let ids: number;

  function create(overrides: { write?: (path: string, value: unknown) => Promise<void> } = {}) {
    return createProjectContainerService({
      paseoHome,
      projectRegistry: registry,
      now: () => T,
      generateId: () => `pcnt_${String(++ids).padStart(16, "0")}`,
      ...overrides,
    });
  }

  async function addRepository(projectId: string): Promise<void> {
    await registry.upsert(
      createPersistedProjectRecord({
        projectId,
        rootPath: `/repos/${projectId}`,
        kind: "git",
        displayName: projectId,
        createdAt: T,
        updatedAt: T,
      }),
    );
  }

  async function readFileState(): Promise<unknown> {
    return JSON.parse(await readFile(join(paseoHome, "projects", "containers.json"), "utf8"));
  }

  beforeEach(async () => {
    ids = 0;
    paseoHome = await mkdtemp(join(tmpdir(), "paseo-containers-"));
    registry = new FileBackedProjectRegistry(
      join(paseoHome, "projects", "projects.json"),
      createTestLogger(),
    );
    for (const id of ["prj_a", "prj_b", "prj_c"]) await addRepository(id);
    service = create();
    await service.initialize();
  });

  afterEach(async () => {
    service.dispose();
    await rm(paseoHome, { recursive: true, force: true });
  });

  test("starts empty without writing a file", async () => {
    expect(await service.list()).toEqual({ revision: 0, containers: [] });
    await expect(readFile(join(paseoHome, "projects", "containers.json"))).rejects.toThrow();
  });

  test("creates with normalized names and rejects case-insensitive duplicates", async () => {
    const heads = await service.create({ name: "  heads  work ", projectIds: ["prj_a"] });
    expect(heads).toMatchObject({
      id: "pcnt_0000000000000001",
      name: "heads work",
      projectIds: ["prj_a"],
    });
    await expect(service.create({ name: "HEADS   WORK" })).rejects.toMatchObject({
      code: "project_container_name_taken",
    });
    await expect(service.create({ name: "   " })).rejects.toMatchObject({
      code: "project_container_name_invalid",
    });
    await expect(service.create({ name: "x", projectIds: ["prj_missing"] })).rejects.toMatchObject({
      code: "project_not_found",
    });
    expect(await readFileState()).toMatchObject({
      version: 1,
      revision: 1,
      containers: [{ name: "heads work" }],
    });
  });

  test("assign moves repositories between projects and places them at an index", async () => {
    const heads = await service.create({ name: "heads", projectIds: ["prj_a", "prj_b"] });
    const fleet = await service.create({ name: "fleet" });
    await service.assign({ projectIds: ["prj_c"], containerId: heads.id, index: 1 });
    await service.assign({ projectIds: ["prj_a"], containerId: fleet.id });
    const { containers } = await service.list();
    expect(containers.map((c) => [c.name, c.projectIds])).toEqual([
      ["heads", ["prj_c", "prj_b"]],
      ["fleet", ["prj_a"]],
    ]);
    await service.assign({ projectIds: ["prj_a"], containerId: null });
    expect((await service.list()).containers[1]!.projectIds).toEqual([]);
  });

  test("reorders within a project by re-assigning to the same project", async () => {
    const heads = await service.create({ name: "heads", projectIds: ["prj_a", "prj_b", "prj_c"] });
    await service.assign({ projectIds: ["prj_c"], containerId: heads.id, index: 0 });
    expect((await service.list()).containers[0]!.projectIds).toEqual(["prj_c", "prj_a", "prj_b"]);
  });

  test("rename, reorder, and delete", async () => {
    const heads = await service.create({ name: "heads", projectIds: ["prj_a"] });
    const fleet = await service.create({ name: "fleet" });
    await expect(service.rename({ containerId: heads.id, name: "Fleet" })).rejects.toBeInstanceOf(
      ProjectContainerError,
    );
    expect((await service.rename({ containerId: heads.id, name: "Heads" })).name).toBe("Heads");
    await expect(service.reorder([fleet.id])).rejects.toMatchObject({
      code: "project_container_order_invalid",
    });
    await service.reorder([fleet.id, heads.id]);
    expect((await service.list()).containers.map((c) => c.name)).toEqual(["fleet", "Heads"]);
    expect(await service.delete(heads.id)).toEqual({
      containerId: heads.id,
      detachedProjectIds: ["prj_a"],
    });
    await expect(service.delete(heads.id)).rejects.toMatchObject({
      code: "project_container_not_found",
    });
  });

  test("pushes once per committed change and never for a no-op", async () => {
    const pushes: ProjectContainerCatalog[] = [];
    const { snapshot } = await service.subscribe((catalog) => pushes.push(catalog));
    expect(snapshot.revision).toBe(0);
    const heads = await service.create({ name: "heads", projectIds: ["prj_a"] });
    await service.assign({ projectIds: ["prj_a"], containerId: heads.id, index: 0 });
    await service.rename({ containerId: heads.id, name: "heads" });
    await service.reorder([heads.id]);
    expect(pushes.map((p) => p.revision)).toEqual([1]);
  });

  test("detaches a repository when it is removed from the registry", async () => {
    await service.create({ name: "heads", projectIds: ["prj_a", "prj_b"] });
    await registry.remove("prj_a");
    expect((await service.list()).containers[0]!.projectIds).toEqual(["prj_b"]);
  });

  test("prunes unknown repositories on load but not when the registry is empty", async () => {
    await mkdir(join(paseoHome, "projects"), { recursive: true });
    const stale = {
      id: "pcnt_x",
      name: "old",
      projectIds: ["prj_a", "prj_gone"],
      createdAt: T,
      updatedAt: T,
    };
    await writeFile(
      join(paseoHome, "projects", "containers.json"),
      JSON.stringify({ version: 1, revision: 4, containers: [stale] }),
    );
    const reloaded = create();
    await reloaded.initialize();
    expect(await reloaded.list()).toMatchObject({
      revision: 5,
      containers: [{ projectIds: ["prj_a"] }],
    });
    reloaded.dispose();

    const emptyRegistry = new FileBackedProjectRegistry(
      join(paseoHome, "empty.json"),
      createTestLogger(),
    );
    const guarded = createProjectContainerService({ paseoHome, projectRegistry: emptyRegistry });
    await guarded.initialize();
    expect((await guarded.list()).containers[0]!.projectIds).toEqual(["prj_a"]);
  });

  test("a failed write leaves memory and disk unchanged", async () => {
    await service.create({ name: "heads" });
    const failing = create({ write: async () => Promise.reject(new Error("disk full")) });
    await failing.initialize();
    await expect(failing.create({ name: "fleet" })).rejects.toThrow("disk full");
    expect((await failing.list()).containers.map((c) => c.name)).toEqual(["heads"]);
    expect(await readFileState()).toMatchObject({ revision: 1 });
  });
});
