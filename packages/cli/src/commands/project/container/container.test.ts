import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectContainer } from "@getpaseo/protocol/project-containers";
import { createProjectCommand } from "../index.js";
import { runLsCommand } from "../ls.js";
import {
  runContainerAdd,
  runContainerCreate,
  runContainerDelete,
  runContainerLs,
  runContainerOrder,
  runContainerRemove,
} from "./index.js";

const T = "2026-09-25T00:00:00.000Z";
const repositories = [
  {
    projectId: "prj_a",
    projectDisplayName: "platform",
    projectRootPath: "/r/a",
    projectKind: "git",
  },
  { projectId: "prj_b", projectDisplayName: "fleet", projectRootPath: "/r/b", projectKind: "git" },
];
let containers: ProjectContainer[];
let features: Record<string, boolean>;
const client = {
  getLastServerInfoMessage: () => ({ features }),
  listProjects: vi.fn(async () => ({ projects: repositories })),
  listProjectContainers: vi.fn(async () => ({ containers, revision: 1 })),
  createProjectContainer: vi.fn(async ({ name }: { name: string }) => {
    const container = { id: "pcnt_new", name, projectIds: [], createdAt: T, updatedAt: T };
    containers = [...containers, container];
    return { container };
  }),
  deleteProjectContainer: vi.fn(async () => ({})),
  reorderProjectContainers: vi.fn(async () => ({})),
  assignProjectContainer: vi.fn(
    async ({ projectIds, containerId }: { projectIds: string[]; containerId: string | null }) => {
      for (const c of containers) {
        c.projectIds =
          c.id === containerId
            ? [...c.projectIds, ...projectIds]
            : c.projectIds.filter((id) => !projectIds.includes(id));
      }
      return {};
    },
  ),
  close: vi.fn(async () => undefined),
};

vi.mock("../../../utils/client.js", () => ({
  buildDaemonConnectionCommandError: vi.fn(({ error }: { error: unknown }) => error),
  connectToDaemon: vi.fn(async () => client),
}));

const options = { daemonTarget: { kind: "instance", home: "/tmp/container-test" } } as never;

beforeEach(() => {
  vi.clearAllMocks();
  features = { projectContainers: true };
  containers = [
    { id: "pcnt_heads", name: "Heads", projectIds: ["prj_a"], createdAt: T, updatedAt: T },
    { id: "pcnt_ops", name: "Ops", projectIds: [], createdAt: T, updatedAt: T },
  ];
});

describe("project container commands", () => {
  it("registers under paseo project container", () => {
    const container = createProjectCommand().commands.find((c) => c.name() === "container");
    expect(container?.commands.map((c) => c.name())).toEqual([
      "ls",
      "create",
      "rename",
      "delete",
      "add",
      "remove",
      "order",
      "note",
      "todo",
      "context",
    ]);
  });

  it("lists projects with repository names", async () => {
    const result = await runContainerLs(options);
    expect(result.data).toEqual([
      { containerId: "pcnt_heads", name: "Heads", repositories: ["platform"] },
      { containerId: "pcnt_ops", name: "Ops", repositories: [] },
    ]);
    expect(client.close).toHaveBeenCalled();
  });

  it("resolves projects and repositories by name", async () => {
    const result = await runContainerAdd("ops", ["fleet", "prj_a"], options);
    expect(client.assignProjectContainer).toHaveBeenCalledWith({
      projectIds: ["prj_b", "prj_a"],
      containerId: "pcnt_ops",
    });
    expect(result.data.repositories).toEqual(["fleet", "platform"]);
    await runContainerRemove(["platform"], options);
    expect(client.assignProjectContainer).toHaveBeenLastCalledWith({
      projectIds: ["prj_a"],
      containerId: null,
    });
  });

  it("creates, deletes, and orders", async () => {
    expect((await runContainerCreate("New", options)).data.name).toBe("New");
    await runContainerDelete("Heads", options);
    expect(client.deleteProjectContainer).toHaveBeenCalledWith({ containerId: "pcnt_heads" });
    await runContainerOrder(["New"], options);
    expect(client.reorderProjectContainers).toHaveBeenCalledWith({
      containerIds: ["pcnt_new", "pcnt_heads", "pcnt_ops"],
    });
  });

  it("fails clearly on unknown names and stock hosts", async () => {
    await expect(runContainerDelete("nope", options)).rejects.toMatchObject({
      code: "PROJECT_NOT_FOUND",
    });
    features = {};
    await expect(runContainerLs(options)).rejects.toMatchObject({ code: "PROJECTS_UNSUPPORTED" });
  });

  it("adds a PROJECT column to paseo project ls", async () => {
    const result = await runLsCommand(options, {} as never);
    expect(result.data.map((row) => [row.name, row.project])).toEqual([
      ["platform", "Heads"],
      ["fleet", undefined],
    ]);
  });
});
