import { describe, expect, it, vi } from "vitest";
import type { Command } from "commander";
import { createWorkspaceCommand } from "./index.js";
import {
  resolveWorkspaceLabelColor,
  resolveWorkspaceLabelName,
  runLabelSetCommand,
} from "./labels.js";

const daemonTarget = { kind: "endpoint" as const, host: "example.test:12345" };

const setWorkspaceLabel = vi.fn(async (input: { label: { name: string; color: string } }) => ({
  label: { ...input.label },
}));
const close = vi.fn(async () => undefined);

vi.mock("../../utils/client.js", () => ({
  connectToDaemon: vi.fn(async () => ({ setWorkspaceLabel, close })),
  getDaemonHost: vi.fn(() => "ws://127.0.0.1:6767"),
}));

function stubCommand(localOptions: Record<string, unknown>): Command {
  return { opts: () => localOptions } as unknown as Command;
}

function catchError(run: () => unknown): unknown {
  try {
    run();
    return null;
  } catch (error) {
    return error;
  }
}

describe("workspace label name", () => {
  it("trims the requested label name", () => {
    expect(resolveWorkspaceLabelName("  Blocked  ")).toBe("Blocked");
  });

  it("requires a non-empty label name", () => {
    expect(catchError(() => resolveWorkspaceLabelName(undefined))).toMatchObject({
      code: "MISSING_LABEL",
    });
    expect(catchError(() => resolveWorkspaceLabelName("   "))).toMatchObject({
      code: "MISSING_LABEL",
    });
  });
});

describe("workspace label color", () => {
  it("defaults to violet when no color is given", () => {
    expect(resolveWorkspaceLabelColor(undefined)).toBe("violet");
  });

  it("accepts a catalog color", () => {
    expect(resolveWorkspaceLabelColor("red")).toBe("red");
  });

  it("rejects colors outside the catalog", () => {
    expect(catchError(() => resolveWorkspaceLabelColor("chartreuse"))).toMatchObject({
      code: "INVALID_COLOR",
    });
  });
});

describe("runLabelSetCommand color source", () => {
  it("prefers the subcommand-local --color over the merged global default", async () => {
    // withGlobalOptions() merges program globals (global --no-color defaults
    // to color: true) over subcommand options.
    const result = await runLabelSetCommand(
      "ws-1",
      "Blocked",
      { daemonTarget, color: true as unknown as string },
      stubCommand({ color: "teal" }),
    );

    expect(setWorkspaceLabel).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      label: { name: "Blocked", color: "teal" },
      assigned: true,
    });
    expect(result.data).toMatchObject({ name: "Blocked", color: "teal" });
  });

  it("defaults to violet when no --color is passed anywhere", async () => {
    const result = await runLabelSetCommand(
      "ws-1",
      "Blocked",
      { daemonTarget, color: true as unknown as string },
      stubCommand({}),
    );

    expect(setWorkspaceLabel).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      label: { name: "Blocked", color: "violet" },
      assigned: true,
    });
    expect(result.data).toMatchObject({ color: "violet" });
  });

  it("honors a string color from merged options for programmatic callers", async () => {
    const result = await runLabelSetCommand(
      "ws-1",
      "Blocked",
      { daemonTarget, color: "red" },
      {} as unknown as Command,
    );

    expect(setWorkspaceLabel).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      label: { name: "Blocked", color: "red" },
      assigned: true,
    });
    expect(result.data).toMatchObject({ color: "red" });
  });
});

describe("workspace label arguments", () => {
  function parseLabels(argv: string[]): unknown {
    const workspace = createWorkspaceCommand()
      .exitOverride()
      .configureOutput({ writeErr: () => undefined });
    for (const name of ["labels", "label-set", "label-remove"]) {
      workspace.commands.find((command) => command.name() === name)?.exitOverride();
    }
    return catchError(() => workspace.parse(argv, { from: "user" }));
  }

  it("registers get, set, and remove label commands", () => {
    const workspace = createWorkspaceCommand();
    expect(workspace.commands.map((command) => command.name())).toEqual(
      expect.arrayContaining(["labels", "label-set", "label-remove"]),
    );
  });

  it("rejects an unquoted multi-word label instead of dropping words", () => {
    expect(parseLabels(["label-set", "ws-1", "Needs", "review"])).toMatchObject({
      code: "commander.excessArguments",
    });
    expect(parseLabels(["label-remove", "ws-1", "Needs", "review"])).toMatchObject({
      code: "commander.excessArguments",
    });
  });
});
