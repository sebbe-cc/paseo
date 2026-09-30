import { describe, expect, it } from "vitest";
import { createWorkspaceCommand } from "./index.js";
import { resolveWorkspaceLabelColor, resolveWorkspaceLabelName } from "./labels.js";

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
