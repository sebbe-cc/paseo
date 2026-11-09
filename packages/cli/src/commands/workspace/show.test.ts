import { describe, expect, it } from "vitest";
import type { WorkspaceDescriptorPayload } from "@getpaseo/protocol/messages";
import { createWorkspaceCommand } from "./index.js";
import { formatWorkspaceBase, toWorkspaceDetail, workspaceDetailSchema } from "./show.js";

function catchError(run: () => unknown): unknown {
  try {
    run();
    return null;
  } catch (error) {
    return error;
  }
}

function entry(input: Partial<WorkspaceDescriptorPayload> = {}): WorkspaceDescriptorPayload {
  return {
    id: "ws_show",
    projectId: "project_show",
    projectDisplayName: "Show",
    projectRootPath: "/repo/show",
    workspaceDirectory: "/repo/show",
    projectKind: "git",
    workspaceKind: "worktree",
    name: "show",
    archivingAt: null,
    status: "done",
    statusEnteredAt: null,
    activityAt: "2026-05-16T00:00:00.000Z",
    scripts: [],
    gitRuntime: null,
    githubRuntime: null,
    ...input,
  } as WorkspaceDescriptorPayload;
}

describe("workspace show base", () => {
  it("formats the daemon-resolved base ref", () => {
    expect(
      formatWorkspaceBase({
        ref: "refs/remotes/origin/main",
        forkSha: "abc1234",
        source: "stored",
        missing: false,
      }),
    ).toBe("refs/remotes/origin/main");
  });

  it("marks a pruned ref instead of falling back silently", () => {
    expect(
      formatWorkspaceBase({
        ref: "refs/remotes/origin/feature/heads-6460-hid-pos-scanner-26.2.2",
        forkSha: "abc1234",
        source: "stored",
        missing: true,
      }),
    ).toBe("refs/remotes/origin/feature/heads-6460-hid-pos-scanner-26.2.2 (missing)");
  });

  it("falls back to the fork commit for a workspace cut from a raw sha", () => {
    expect(
      formatWorkspaceBase({ ref: null, forkSha: "abc1234", source: "stored", missing: false }),
    ).toBe("abc1234");
  });

  it("reports nothing when the daemon omits the base", () => {
    expect(formatWorkspaceBase(null)).toBe("");
  });
});

describe("workspace show detail", () => {
  it("maps the entry including its resolved base", () => {
    const detail = toWorkspaceDetail(
      entry({
        gitRuntime: {
          currentBranch: "feature/work",
          remoteUrl: null,
          isPaseoOwnedWorktree: true,
          base: {
            ref: "refs/remotes/origin/main",
            forkSha: "abc1234",
            source: "stored",
            missing: false,
          },
        } as WorkspaceDescriptorPayload["gitRuntime"],
      }),
    );
    expect(detail).toMatchObject({
      workspaceId: "ws_show",
      project: "Show",
      name: "show",
      isolation: "worktree",
      cwd: "/repo/show",
      background: false,
      branch: "feature/work",
      base: "refs/remotes/origin/main",
      baseSource: "stored",
      baseMissing: false,
    });
  });

  it("keeps the fork commit when the stored ref is missing", () => {
    const detail = toWorkspaceDetail(
      entry({
        gitRuntime: {
          currentBranch: "feature/heads-6460",
          base: {
            ref: "refs/remotes/origin/feature/heads-6460-hid-pos-scanner-26.2.2",
            forkSha: "abc1234",
            source: "stored",
            missing: true,
          },
        } as WorkspaceDescriptorPayload["gitRuntime"],
      }),
    );
    expect(detail.base).toBe(
      "refs/remotes/origin/feature/heads-6460-hid-pos-scanner-26.2.2 (missing)",
    );
    expect(detail.baseMissing).toBe(true);
    expect(detail.forkSha).toBe("abc1234");
  });

  it("leaves the base empty for daemons that do not report one", () => {
    const detail = toWorkspaceDetail(entry());
    expect(detail.base).toBe("");
    expect(detail.baseSource).toBe("");
    expect(detail.baseMissing).toBe(false);
  });
});

describe("workspace show output", () => {
  it("renders the base lines for humans", () => {
    const human = workspaceDetailSchema.renderHuman?.(
      {
        type: "single",
        data: toWorkspaceDetail(
          entry({
            gitRuntime: {
              currentBranch: "feature/work",
              base: {
                ref: "refs/remotes/origin/main",
                forkSha: "abc1234",
                source: "stored",
                missing: false,
              },
            } as WorkspaceDescriptorPayload["gitRuntime"],
          }),
        ),
        schema: workspaceDetailSchema,
      },
      { format: "table", quiet: false, noHeaders: false, noColor: true },
    );
    expect(human).toContain("base: refs/remotes/origin/main");
    expect(human).toContain("base source: stored");
  });

  it("says the base is not reported on older daemons", () => {
    const human = workspaceDetailSchema.renderHuman?.(
      { type: "single", data: toWorkspaceDetail(entry()), schema: workspaceDetailSchema },
      { format: "table", quiet: false, noHeaders: false, noColor: true },
    );
    expect(human).toContain("base: not reported");
  });
});

describe("workspace show arguments", () => {
  function parseShow(argv: string[]): unknown {
    const workspace = createWorkspaceCommand()
      .exitOverride()
      .configureOutput({ writeErr: () => undefined });
    workspace.commands.find((command) => command.name() === "show")?.exitOverride();
    return catchError(() => workspace.parse(argv, { from: "user" }));
  }

  it("registers show alongside the other workspace commands", () => {
    const workspace = createWorkspaceCommand();
    expect(workspace.commands.map((command) => command.name())).toContain("show");
  });

  it("requires a workspace id", () => {
    expect(parseShow(["show"])).toMatchObject({ code: "commander.missingArgument" });
  });
});
