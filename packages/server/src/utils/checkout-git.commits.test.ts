import { execFileSync } from "child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
  getCheckoutDiff,
  getCheckoutStatus,
  getCheckoutShortstat,
  mergeFromBase,
  resolveWorkspaceBase,
  listCheckoutCommits,
} from "./checkout-git.js";
import {
  readPaseoWorktreeMetadata,
  writePaseoWorktreeRuntimeMetadata,
  writePaseoWorktreeFirstAgentBranchAutoNameMetadata,
  markPaseoWorktreeFirstAgentBranchAutoNameAttempted,
  writePaseoWorktreeMetadata,
} from "./worktree-metadata.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "checkout-commits-test-")));
  tempDirs.push(dir);
  return dir;
}

function git(args: string[], cwd?: string): void {
  execFileSync("git", args, cwd ? { cwd } : {});
}

function commit(repoDir: string, message: string): void {
  git(
    ["-c", "commit.gpgsign=false", "commit", "--author=Test User <test@test.com>", "-m", message],
    repoDir,
  );
}

function commitFile(repoDir: string, name: string, content: string, message: string): void {
  writeFileSync(join(repoDir, name), content);
  git(["add", "."], repoDir);
  commit(repoDir, message);
}

function importLinearHistory({
  repoDir,
  branch,
  file,
  subject,
  count,
}: {
  repoDir: string;
  branch: string;
  file: string;
  subject: string;
  count: number;
}): void {
  const startingSha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repoDir,
    encoding: "utf8",
  }).trim();
  const commands: string[] = [];
  let parent = startingSha;

  for (let index = 1; index <= count; index += 1) {
    const blobMark = index * 2 - 1;
    const commitMark = index * 2;
    const content = `${index}\n`;
    const message = `${subject} ${index}`;
    commands.push(
      `blob\nmark :${blobMark}\ndata ${Buffer.byteLength(content)}\n${content}`,
      `commit refs/heads/${branch}\nmark :${commitMark}\ncommitter Test User <test@test.com> ${1_700_000_000 + index} +0000\ndata ${Buffer.byteLength(message)}\n${message}\nfrom ${parent}\nM 100644 :${blobMark} ${file}\n\n`,
    );
    parent = `:${commitMark}`;
  }

  execFileSync("git", ["fast-import", "--quiet"], {
    cwd: repoDir,
    input: commands.join(""),
  });
  git(["reset", "--hard", branch], repoDir);
}

function initRepoOnMain(): { repoDir: string; tempDir: string } {
  const tempDir = makeTempDir();
  const repoDir = join(tempDir, "repo");
  mkdirSync(repoDir, { recursive: true });
  git(["init", "-b", "main"], repoDir);
  git(["config", "user.email", "test@test.com"], repoDir);
  git(["config", "user.name", "Test User"], repoDir);
  commitFile(repoDir, "README.md", "base\n", "initial");
  // These history fixtures choose a local base explicitly; implicit defaults require origin/HEAD.
  mkdirSync(join(repoDir, ".git", "paseo"));
  writeFileSync(
    join(repoDir, ".git", "paseo", "worktree.json"),
    JSON.stringify({
      version: 1,
      baseRefName: "main",
      baseRef: "refs/heads/main",
    }),
  );
  return { repoDir, tempDir };
}

function addBareRemote(repoDir: string, tempDir: string): string {
  const remoteDir = join(tempDir, "remote.git");
  git(["init", "--bare", "-b", "main", remoteDir]);
  git(["remote", "add", "origin", remoteDir], repoDir);
  return remoteDir;
}

describe("listCheckoutCommits", () => {
  it("keeps fixture authors independent of command-scoped Git configuration", async () => {
    const overrides = {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "user.name",
      GIT_CONFIG_VALUE_0: "Other User",
    };
    const previous = Object.fromEntries(
      Object.keys(overrides).map((key) => [key, process.env[key]]),
    );
    let repoDir: string;
    try {
      Object.assign(process.env, overrides);
      ({ repoDir } = initRepoOnMain());
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }

    const { commits } = await listCheckoutCommits({ cwd: repoDir });
    expect(commits[0]?.authorName).toBe("Test User");
  });

  it("lists recent commits newest-first with on-remote flags and file stats", async () => {
    const { repoDir, tempDir } = initRepoOnMain();
    git(["checkout", "-b", "feature"], repoDir);
    commitFile(repoDir, "foo.txt", "a\nb\nc\n", "Add foo");

    // Push feature (containing only commit A) to the remote, then add B locally.
    addBareRemote(repoDir, tempDir);
    git(["push", "-u", "origin", "feature"], repoDir);
    commitFile(repoDir, "bar.txt", "x\n", "Add bar");

    const { baseRef, commits } = await listCheckoutCommits({ cwd: repoDir });

    expect(baseRef).toBe("refs/heads/main");
    expect(commits).toHaveLength(3);
    expect(commits[0]?.subject).toBe("Add bar");
    expect(commits[1]?.subject).toBe("Add foo");
    expect(commits[2]?.subject).toBe("initial");

    expect(commits[0]?.isOnRemote).toBe(false);
    expect(commits[1]?.isOnRemote).toBe(true);
    expect(commits[2]?.isOnRemote).toBe(true);
    expect(commits[0]?.isOnBase).toBe(false);
    expect(commits[1]?.isOnBase).toBe(false);
    expect(commits[2]?.isOnBase).toBe(true);

    expect(commits[0]?.files).toEqual([
      { path: "bar.txt", additions: 1, deletions: 0, status: "added" },
    ]);
    expect(commits[1]?.files).toEqual([
      { path: "foo.txt", additions: 3, deletions: 0, status: "added" },
    ]);

    expect(commits[0]?.authorName).toBe("Test User");
    expect(commits[0]?.sha).toHaveLength(40);
    expect((commits[0]?.shortSha.length ?? 0) > 0).toBe(true);
    expect(Number.isNaN(new Date(commits[0]?.authorDate ?? "").getTime())).toBe(false);
  });

  it("shows recent history on the base branch", async () => {
    const { repoDir } = initRepoOnMain();
    const { baseRef, commits } = await listCheckoutCommits({ cwd: repoDir });
    expect(baseRef).toBe("refs/heads/main");
    expect(commits.map((entry) => entry.subject)).toEqual(["initial"]);
    expect(commits[0]?.isOnBase).toBe(true);
  });

  it("reports a missing legacy base without substituting the repo default", async () => {
    const { repoDir } = initRepoOnMain();
    await writePaseoWorktreeMetadata(repoDir, { baseRefName: "deleted-base" });
    await expect(listCheckoutCommits({ cwd: repoDir })).rejects.toThrow(
      "Base ref not found: deleted-base",
    );
  });

  it("marks all commits local-only when there is no remote", async () => {
    const { repoDir } = initRepoOnMain();
    git(["checkout", "-b", "feature"], repoDir);
    commitFile(repoDir, "foo.txt", "a\n", "Add foo");
    commitFile(repoDir, "bar.txt", "b\n", "Add bar");

    const { baseRef, commits } = await listCheckoutCommits({ cwd: repoDir });

    expect(baseRef).toBe("refs/heads/main");
    expect(commits).toHaveLength(3);
    expect(commits.every((c) => c.isOnRemote === false)).toBe(true);
  });

  it("recognizes base history on a remote before the feature branch is pushed", async () => {
    const { repoDir, tempDir } = initRepoOnMain();
    addBareRemote(repoDir, tempDir);
    git(["push", "-u", "origin", "main"], repoDir);
    git(["checkout", "-b", "feature"], repoDir);
    commitFile(repoDir, "feature.txt", "local\n", "Local feature");

    const { commits } = await listCheckoutCommits({ cwd: repoDir });

    expect(commits.map(({ subject, isOnRemote }) => ({ subject, isOnRemote }))).toEqual([
      { subject: "Local feature", isOnRemote: false },
      { subject: "initial", isOnRemote: true },
    ]);
  });

  it("keeps local base commits out of workspace history when the local base is ahead", async () => {
    const { repoDir, tempDir } = initRepoOnMain();
    addBareRemote(repoDir, tempDir);
    git(["push", "-u", "origin", "main"], repoDir);
    commitFile(repoDir, "local-base.txt", "base\n", "Local base work");
    git(["checkout", "-b", "feature"], repoDir);
    commitFile(repoDir, "feature.txt", "feature\n", "Feature work");

    const { commits } = await listCheckoutCommits({ cwd: repoDir });

    expect(commits.map(({ subject, isOnBase }) => ({ subject, isOnBase }))).toEqual([
      { subject: "Feature work", isOnBase: false },
      { subject: "Local base work", isOnBase: true },
      { subject: "initial", isOnBase: true },
    ]);
  });

  it("shows every workspace commit followed by at most 10 base commits", async () => {
    const { repoDir } = initRepoOnMain();
    importLinearHistory({
      repoDir,
      branch: "main",
      file: "base-history.txt",
      subject: "Base",
      count: 14,
    });
    git(["checkout", "-b", "feature"], repoDir);
    importLinearHistory({
      repoDir,
      branch: "feature",
      file: "workspace-history.txt",
      subject: "Workspace",
      count: 24,
    });

    const { commits } = await listCheckoutCommits({ cwd: repoDir });

    expect(commits).toHaveLength(34);
    expect(commits.every((entry) => entry.isOnRemote === false)).toBe(true);
    expect(commits.slice(0, 24).map((entry) => entry.subject)).toEqual(
      Array.from({ length: 24 }, (_, index) => `Workspace ${24 - index}`),
    );
    expect(commits.slice(0, 24).every((entry) => entry.isOnBase === false)).toBe(true);
    expect(commits.slice(24).map((entry) => entry.subject)).toEqual(
      Array.from({ length: 10 }, (_, index) => `Base ${14 - index}`),
    );
    expect(commits.slice(24).every((entry) => entry.isOnBase === true)).toBe(true);
  });

  it("starts base context at the fork point when the base branch has advanced", async () => {
    const { repoDir } = initRepoOnMain();
    commitFile(repoDir, "shared.txt", "shared\n", "Shared base");
    git(["checkout", "-b", "feature"], repoDir);
    commitFile(repoDir, "feature.txt", "feature\n", "Feature work");
    git(["checkout", "main"], repoDir);
    commitFile(repoDir, "newer-base.txt", "newer\n", "Newer base");
    git(["checkout", "feature"], repoDir);

    const { commits } = await listCheckoutCommits({ cwd: repoDir });

    expect(commits.map(({ subject, isOnBase }) => ({ subject, isOnBase }))).toEqual([
      { subject: "Feature work", isOnBase: false },
      { subject: "Shared base", isOnBase: true },
      { subject: "initial", isOnBase: true },
    ]);
  });

  it("limits base-branch history to 10 commits", async () => {
    const { repoDir } = initRepoOnMain();
    importLinearHistory({
      repoDir,
      branch: "main",
      file: "history.txt",
      subject: "Commit",
      count: 14,
    });

    const { commits } = await listCheckoutCommits({ cwd: repoDir });

    expect(commits.map((entry) => entry.subject)).toEqual(
      Array.from({ length: 10 }, (_, index) => `Commit ${14 - index}`),
    );
    expect(commits.every((entry) => entry.isOnBase === true)).toBe(true);
  });

  it("shows merged branch commits and compares the merge against its first parent", async () => {
    const { repoDir } = initRepoOnMain();
    git(["checkout", "-b", "feature"], repoDir);
    commitFile(repoDir, "feature.txt", "feature\n", "Add feature");
    git(["checkout", "main"], repoDir);
    commitFile(repoDir, "main.txt", "main\n", "Advance main");
    git(["merge", "--no-ff", "feature", "-m", "Merge feature"], repoDir);

    const { commits } = await listCheckoutCommits({ cwd: repoDir });

    expect(commits.map((entry) => entry.subject)).toEqual([
      "Merge feature",
      "Advance main",
      "Add feature",
      "initial",
    ]);
    expect(commits[0]?.files).toEqual([
      { path: "feature.txt", additions: 1, deletions: 0, status: "added" },
    ]);
  });

  it("classifies renamed files with status renamed and correct destination path", async () => {
    const { repoDir } = initRepoOnMain();
    git(["checkout", "-b", "feature"], repoDir);
    commitFile(repoDir, "original.txt", "content\n", "Add original");
    git(["mv", "original.txt", "renamed.txt"], repoDir);
    commit(repoDir, "Rename file");

    const { commits } = await listCheckoutCommits({ cwd: repoDir });

    expect(commits[0]?.files).toEqual([
      { path: "renamed.txt", additions: 0, deletions: 0, status: "renamed" },
    ]);
  });

  it("derives status for modified and deleted files", async () => {
    const { repoDir } = initRepoOnMain();
    git(["checkout", "-b", "feature"], repoDir);
    commitFile(repoDir, "README.md", "base\nmore\n", "Edit readme");
    git(["rm", "README.md"], repoDir);
    commit(repoDir, "Delete readme");

    const { commits } = await listCheckoutCommits({ cwd: repoDir });

    expect(commits[0]?.files).toEqual([
      { path: "README.md", additions: 0, deletions: 2, status: "deleted" },
    ]);
    expect(commits[1]?.files).toEqual([
      { path: "README.md", additions: 1, deletions: 0, status: "modified" },
    ]);
  });
});

describe("one workspace comparison base", () => {
  function sha(cwd: string, ref = "HEAD"): string {
    return execFileSync("git", ["rev-parse", ref], { cwd, encoding: "utf8" }).trim();
  }

  it("uses origin/HEAD rather than a stale local default in every reader and merge-from-base", async () => {
    const { repoDir } = initRepoOnMain();
    const forkSha = sha(repoDir);
    rmSync(join(repoDir, ".git", "paseo", "worktree.json"));
    git(["checkout", "-b", "remote-main"], repoDir);
    commitFile(repoDir, "remote.txt", "remote\n", "Remote base advance");
    const remoteTip = sha(repoDir);
    git(["update-ref", "refs/remotes/origin/main", remoteTip], repoDir);
    git(["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"], repoDir);
    git(["checkout", "-b", "feature", forkSha], repoDir);
    commitFile(repoDir, "feature.txt", "feature\n", "Feature work");
    expect(await resolveWorkspaceBase(repoDir)).toEqual({
      ref: "refs/remotes/origin/main",
      forkSha,
      source: "default",
      missing: false,
    });
    expect(await getCheckoutStatus(repoDir)).toMatchObject({
      baseRef: "refs/remotes/origin/main",
      aheadBehind: { ahead: 1, behind: 1 },
    });
    expect((await getCheckoutDiff(repoDir, { mode: "all" })).diff).toContain("feature.txt");
    expect((await getCheckoutDiff(repoDir, { mode: "all" })).diff).not.toContain("remote.txt");
    expect(await getCheckoutShortstat(repoDir)).toEqual({ additions: 1, deletions: 0 });
    expect(
      (await listCheckoutCommits({ cwd: repoDir })).commits.map((c) => [c.subject, c.isOnBase]),
    ).toEqual([
      ["Feature work", false],
      ["initial", true],
    ]);
    await mergeFromBase(repoDir);
    expect(
      execFileSync("git", ["merge-base", "--is-ancestor", remoteTip, "HEAD"], { cwd: repoDir })
        .length,
    ).toBe(0);
    expect(sha(repoDir, "refs/heads/main")).toBe(forkSha);
  });

  it.each(["refs/heads/epic/sprint", "refs/remotes/upstream/release/stable"])(
    "preserves exact base %s across all comparisons",
    async (ref) => {
      const { repoDir } = initRepoOnMain();
      const forkSha = sha(repoDir);
      git(["update-ref", ref, forkSha], repoDir);
      git(["checkout", "-b", "feature"], repoDir);
      await writePaseoWorktreeMetadata(repoDir, { baseRefName: ref, baseRef: ref, forkSha });
      commitFile(repoDir, "feature.txt", "feature\n", "Feature work");
      // A competing origin ref must never replace the explicitly chosen stream.
      git(["update-ref", "refs/remotes/origin/epic/sprint", "HEAD"], repoDir);
      expect(await resolveWorkspaceBase(repoDir)).toEqual({
        ref,
        forkSha,
        source: "stored",
        missing: false,
      });
      expect(await getCheckoutStatus(repoDir)).toMatchObject({
        baseRef: ref,
        aheadBehind: { ahead: 1, behind: 0 },
      });
      expect((await getCheckoutDiff(repoDir, { mode: "all" })).diff).toContain("feature.txt");
      expect(await getCheckoutShortstat(repoDir)).toEqual({ additions: 1, deletions: 0 });
      expect((await listCheckoutCommits({ cwd: repoDir })).baseRef).toBe(ref);
      await mergeFromBase(repoDir);
      expect(sha(repoDir, ref)).toBe(forkSha);
    },
  );

  it("uses the persisted fork point when a qualified base disappears", async () => {
    const { repoDir } = initRepoOnMain();
    const forkSha = sha(repoDir);
    const ref = "refs/remotes/upstream/epic";
    git(["update-ref", ref, forkSha], repoDir);
    git(["checkout", "-b", "feature"], repoDir);
    await writePaseoWorktreeMetadata(repoDir, { baseRefName: ref, baseRef: ref, forkSha });
    await writePaseoWorktreeRuntimeMetadata(repoDir, { worktreePort: 12345 });
    await writePaseoWorktreeFirstAgentBranchAutoNameMetadata(repoDir, {
      placeholderBranchName: "feature",
    });
    await markPaseoWorktreeFirstAgentBranchAutoNameAttempted(repoDir, {
      attemptedAt: "2026-11-04T00:00:00.000Z",
    });
    expect(await readPaseoWorktreeMetadata(repoDir)).toMatchObject({
      version: 3,
      baseRef: ref,
      forkSha,
      runtime: { worktreePort: 12345 },
      firstAgentBranchAutoName: { status: "attempted" },
    });
    commitFile(repoDir, "feature.txt", "feature\n", "Feature work");
    git(["update-ref", "-d", ref], repoDir);
    expect(await resolveWorkspaceBase(repoDir)).toEqual({
      ref,
      forkSha,
      source: "stored",
      missing: true,
    });
    expect(await getCheckoutStatus(repoDir)).toMatchObject({
      baseRef: ref,
      base: { missing: true },
      aheadBehind: { ahead: 1, behind: 0 },
    });
    expect((await getCheckoutDiff(repoDir, { mode: "all" })).diff).toContain("feature.txt");
    expect(await getCheckoutShortstat(repoDir)).toEqual({ additions: 1, deletions: 0 });
    expect(
      (await listCheckoutCommits({ cwd: repoDir })).commits.map((c) => [c.subject, c.isOnBase]),
    ).toEqual([
      ["Feature work", false],
      ["initial", true],
    ]);
    await mergeFromBase(repoDir);
  });

  it("reports an unavailable implicit base instead of an empty diff", async () => {
    const { repoDir } = initRepoOnMain();
    rmSync(join(repoDir, ".git", "paseo", "worktree.json"));
    expect(await resolveWorkspaceBase(repoDir)).toBeNull();
    await expect(getCheckoutDiff(repoDir, { mode: "all" })).rejects.toThrow(
      "Unable to determine workspace base",
    );
    await expect(listCheckoutCommits({ cwd: repoDir })).rejects.toThrow(
      "Unable to determine workspace base",
    );
  });
});
