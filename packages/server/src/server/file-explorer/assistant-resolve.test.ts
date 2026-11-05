import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runGitCommand } from "../../utils/run-git-command.js";
import { collectAssistantSearchRoots, resolveAssistantFilePaths } from "./assistant-resolve.js";

async function makeTempRoot(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function gitInit(root: string): Promise<void> {
  await runGitCommand(["init", "--quiet"], { cwd: root });
  await runGitCommand(["config", "user.email", "test@example.com"], { cwd: root });
  await runGitCommand(["config", "user.name", "Paseo Test"], { cwd: root });
}

async function gitCommitAll(root: string, message: string): Promise<void> {
  await runGitCommand(["add", "-A"], { cwd: root });
  await runGitCommand(["commit", "--quiet", "-m", message], { cwd: root });
}

async function removeDir(root: string): Promise<void> {
  try {
    await fs.rm(root, { recursive: true, force: true });
  } catch {
    // Best effort cleanup for temp dirs.
  }
}

describe("assistant file resolve", () => {
  let roots: string[] = [];

  beforeEach(() => {
    roots = [];
  });

  afterEach(async () => {
    await Promise.all(roots.map(removeDir));
    roots = [];
  });

  async function track(dir: Promise<string>): Promise<string> {
    const resolved = await dir;
    roots.push(resolved);
    return resolved;
  }

  it("finds an absolute path that exists", async () => {
    const dir = await track(makeTempRoot("paseo-assistant-resolve-abs-"));
    const file = path.join(dir, "notes.md");
    await fs.writeFile(file, "hello", "utf8");

    const [result] = await resolveAssistantFilePaths({ cwd: dir, candidates: [file] });

    expect(result?.status).toBe("found");
    expect(result?.absolutePath).toBe(await fs.realpath(file));
    expect(result?.modifiedAt).toBeTruthy();
  });

  it("resolves relative to the agent cwd before the workspace root", async () => {
    const cwd = await track(makeTempRoot("paseo-assistant-resolve-cwd-"));
    const workspace = await track(makeTempRoot("paseo-assistant-resolve-ws-"));
    await fs.writeFile(path.join(cwd, "plan.md"), "from cwd", "utf8");
    await fs.writeFile(path.join(workspace, "plan.md"), "from workspace", "utf8");

    const [result] = await resolveAssistantFilePaths({
      cwd,
      workspaceRoot: workspace,
      candidates: ["plan.md"],
    });

    expect(result?.status).toBe("found");
    expect(result?.absolutePath).toBe(await fs.realpath(path.join(cwd, "plan.md")));
  });

  it("falls back to the workspace and git roots", async () => {
    const repo = await track(makeTempRoot("paseo-assistant-resolve-repo-"));
    await gitInit(repo);
    const sub = path.join(repo, "sub");
    await fs.mkdir(sub, { recursive: true });
    await fs.writeFile(path.join(repo, "top.md"), "top", "utf8");
    await gitCommitAll(repo, "init");

    const outside = await track(makeTempRoot("paseo-assistant-resolve-out-"));
    const [result] = await resolveAssistantFilePaths({
      cwd: sub,
      workspaceRoot: outside,
      candidates: ["top.md"],
    });

    expect(result?.status).toBe("found");
    expect(result?.absolutePath).toBe(await fs.realpath(path.join(repo, "top.md")));
    expect(result?.searchedRoots.length).toBeGreaterThan(0);
  });

  it("finds files in a sibling worktree of the same repo", async () => {
    const repo = await track(makeTempRoot("paseo-assistant-resolve-main-"));
    await gitInit(repo);
    await fs.writeFile(path.join(repo, "main.md"), "main", "utf8");
    await gitCommitAll(repo, "init");

    const sibling = path.join(os.tmpdir(), `paseo-assistant-resolve-sib-${process.pid}`);
    await runGitCommand(["worktree", "add", "--detach", sibling], { cwd: repo });
    roots.push(sibling);
    const summaryName = "task-pa-9-summary.md";
    await fs.writeFile(path.join(sibling, summaryName), "worker summary", "utf8");

    const searchRoots = await collectAssistantSearchRoots({ cwd: repo });
    expect(searchRoots).toContain(sibling);

    const [result] = await resolveAssistantFilePaths({ cwd: repo, candidates: [summaryName] });

    expect(result?.status).toBe("found");
    expect(result?.absolutePath).toBe(await fs.realpath(path.join(sibling, summaryName)));

    await runGitCommand(["worktree", "remove", "--force", sibling], { cwd: repo });
    roots = roots.filter((root) => root !== sibling);
  });

  it("finds a nested file by unique basename", async () => {
    const repo = await track(makeTempRoot("paseo-assistant-resolve-deep-"));
    await gitInit(repo);
    const nested = path.join(repo, ".gc", "artifacts");
    await fs.mkdir(nested, { recursive: true });
    await fs.writeFile(path.join(nested, "worker-summary.md"), "deep", "utf8");

    const [result] = await resolveAssistantFilePaths({
      cwd: repo,
      candidates: ["worker-summary.md"],
    });

    expect(result?.status).toBe("found");
    expect(result?.absolutePath).toBe(await fs.realpath(path.join(nested, "worker-summary.md")));
  });

  it("prefers the newest file when several roots hold the same name", async () => {
    const first = await track(makeTempRoot("paseo-assistant-resolve-old-"));
    const second = await track(makeTempRoot("paseo-assistant-resolve-new-"));
    const name = "dupe.md";
    await fs.mkdir(path.join(first, "sub"), { recursive: true });
    await fs.mkdir(path.join(second, "sub"), { recursive: true });
    await fs.writeFile(path.join(first, "sub", name), "old", "utf8");
    const oldTime = new Date("2020-01-01T00:00:00.000Z");
    await fs.utimes(path.join(first, "sub", name), oldTime, oldTime);
    await fs.writeFile(path.join(second, "sub", name), "new", "utf8");

    const [result] = await resolveAssistantFilePaths({
      cwd: first,
      workspaceRoot: second,
      candidates: [name],
    });

    expect(result?.status).toBe("found");
    expect(result?.absolutePath).toBe(await fs.realpath(path.join(second, "sub", name)));
  });

  it("reports missing files with the searched roots", async () => {
    const cwd = await track(makeTempRoot("paseo-assistant-resolve-miss-"));

    const [result] = await resolveAssistantFilePaths({
      cwd,
      candidates: ["no-such-file.md"],
    });

    expect(result?.status).toBe("missing");
    expect(result?.absolutePath).toBeNull();
    expect(result?.searchedRoots).toContain(cwd);
  });

  it("refuses absolute paths outside the home and tmp allowlist", async () => {
    const cwd = await track(makeTempRoot("paseo-assistant-resolve-conf-"));
    const systemFile = "/bin/sh";
    if (!existsSync(systemFile)) return;

    const [result] = await resolveAssistantFilePaths({ cwd, candidates: [systemFile] });

    expect(result?.status).toBe("missing");
  });

  it("finds files under the tmp allowlist by absolute path", async () => {
    const cwd = await track(makeTempRoot("paseo-assistant-resolve-tmp-"));
    const file = path.join(os.tmpdir(), `paseo-assistant-resolve-loose-${process.pid}.md`);
    await fs.writeFile(file, "loose", "utf8");
    try {
      const [result] = await resolveAssistantFilePaths({ cwd, candidates: [file] });
      expect(result?.status).toBe("found");
    } finally {
      await fs.rm(file, { force: true });
    }
  });
});
