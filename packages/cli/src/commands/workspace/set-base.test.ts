import { describe, expect, it } from "vitest";
import { createWorkspaceCommand } from "./index.js";
import { resolveWorkspaceBaseRef } from "./set-base.js";

function catchError(run: () => unknown): unknown {
  try {
    run();
    return null;
  } catch (error) {
    return error;
  }
}

describe("workspace set-base ref", () => {
  it("trims the requested ref", () => {
    expect(resolveWorkspaceBaseRef({ baseRef: "  refs/remotes/origin/main  " })).toBe(
      "refs/remotes/origin/main",
    );
  });

  it("requires a non-empty ref", () => {
    expect(catchError(() => resolveWorkspaceBaseRef({}))).toMatchObject({ code: "MISSING_BASE" });
    expect(catchError(() => resolveWorkspaceBaseRef({ baseRef: "   " }))).toMatchObject({
      code: "MISSING_BASE",
    });
  });
});

describe("workspace set-base arguments", () => {
  function parseSetBase(argv: string[]): unknown {
    const workspace = createWorkspaceCommand()
      .exitOverride()
      .configureOutput({ writeErr: () => undefined });
    workspace.commands.find((command) => command.name() === "set-base")?.exitOverride();
    return catchError(() => workspace.parse(argv, { from: "user" }));
  }

  it("requires a workspace id and a ref", () => {
    expect(parseSetBase(["set-base", "ws-1"])).toMatchObject({ code: "commander.missingArgument" });
  });
});
