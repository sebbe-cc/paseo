import { describe, expect, it, vi } from "vitest";
import type { AssistantFileResolveResult } from "@getpaseo/client/internal/daemon-client";
import { createAssistantFileBatcher } from "./queries";

function found(path: string, absolutePath: string): AssistantFileResolveResult {
  return { path, status: "found", absolutePath, searchedRoots: ["/ws"], modifiedAt: null };
}

function missing(path: string): AssistantFileResolveResult {
  return { path, status: "missing", absolutePath: null, searchedRoots: ["/ws"], modifiedAt: null };
}

function makeResultsRpc(byPath: Map<string, AssistantFileResolveResult>) {
  const seen: string[][] = [];
  const rpc = vi.fn(async (input: { candidates: string[] }) => {
    seen.push(input.candidates);
    return {
      results: input.candidates.map((path) => byPath.get(path) ?? missing(path)),
      error: null,
      requestId: "r1",
    };
  });
  return { rpc, seen };
}

describe("createAssistantFileBatcher", () => {
  it("coalesces concurrent checks into one daemon batch", async () => {
    const { rpc } = makeResultsRpc(
      new Map([
        ["a.md", found("a.md", "/ws/a.md")],
        ["b.md", found("b.md", "/ws/b.md")],
      ]),
    );
    const resolve = createAssistantFileBatcher(rpc, { cwd: "/ws", windowMs: 5 });

    const [first, second] = await Promise.all([resolve("a.md"), resolve("b.md")]);

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith({
      cwd: "/ws",
      workspaceRoot: undefined,
      candidates: ["a.md", "b.md"],
    });
    expect(first?.absolutePath).toBe("/ws/a.md");
    expect(second?.absolutePath).toBe("/ws/b.md");
  });

  it("resolves each path with its own result and falls back to missing", async () => {
    const { rpc } = makeResultsRpc(new Map([["a.md", found("a.md", "/other/a.md")]]));
    const resolve = createAssistantFileBatcher(rpc, { cwd: "/ws", windowMs: 5 });

    const [first, second] = await Promise.all([resolve("a.md"), resolve("gone.md")]);

    expect(first?.status).toBe("found");
    expect(second).toMatchObject({ path: "gone.md", status: "missing" });
  });

  it("rejects every pending check when the batch fails", async () => {
    const rpc = vi.fn(async () => {
      throw new Error("daemon down");
    });
    const resolve = createAssistantFileBatcher(rpc, { cwd: "/ws", windowMs: 5 });

    await expect(Promise.all([resolve("a.md"), resolve("b.md")])).rejects.toThrow("daemon down");
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("fans overflow beyond maxBatch out to a second flush", async () => {
    const { rpc, seen } = makeResultsRpc(new Map());
    const resolve = createAssistantFileBatcher(rpc, { cwd: "/ws", windowMs: 5, maxBatch: 2 });

    const results = await Promise.all([resolve("a.md"), resolve("b.md"), resolve("c.md")]);

    expect(rpc).toHaveBeenCalledTimes(2);
    expect(seen[0]).toEqual(["a.md", "b.md"]);
    expect(seen[1]).toEqual(["c.md"]);
    expect(results).toHaveLength(3);
  });
});
