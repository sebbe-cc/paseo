import { describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, writeFile, rm, chmod, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  diffWorkspaceGitRefs,
  diffWorkspaceGitRemoteRefs,
  fetchWorkspaceGitRemote,
  parseWorkspaceGitRefs,
  readStoredRemoteBaseRefs,
} from "./workspace-git-fetch.js";
import { runGitCommand, type RunGitCommand } from "../utils/run-git-command.js";

describe("workspace Git remote refs", () => {
  test("runs the complete fetch through the supplied Git runner", async () => {
    const commands: string[][] = [];
    let refRead = 0;
    const run: RunGitCommand = async (args, options) => {
      commands.push(args);
      if (args[0] === "fetch") {
        expect(options.envOverlay).toEqual({
          GIT_TERMINAL_PROMPT: "0",
          GIT_ASKPASS: "",
          GCM_INTERACTIVE: "0",
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: "remote.origin.followRemoteHEAD",
          GIT_CONFIG_VALUE_0: "always",
        });
      }
      const stdout =
        args[0] === "for-each-ref"
          ? `refs/remotes/origin/main\0${refRead++ === 0 ? "aaaaaaaa" : "bbbbbbbb"}`
          : "";
      return { stdout, stderr: "", truncated: false, exitCode: 0, signal: null };
    };

    await expect(
      fetchWorkspaceGitRemote("/repo", { onRefSnapshot() {} }, run),
    ).resolves.toMatchObject({
      changes: [
        {
          kind: "moved",
          ref: "origin/main",
          beforeOid: "aaaaaaaa",
          afterOid: "bbbbbbbb",
        },
      ],
    });
    expect(commands).toEqual([
      ["for-each-ref", "--format=%(refname)%00%(objectname)"],
      ["fetch", "origin", "--prune"],
      ["for-each-ref", "--format=%(refname)%00%(objectname)"],
    ]);
  });

  test("parses refs for semantic before/after comparison", () => {
    expect(
      parseWorkspaceGitRefs(
        [
          "refs/remotes/origin/main\0aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          "refs/remotes/upstream/topic\0bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          "refs/heads/main\0cccccccccccccccccccccccccccccccccccccccc",
        ].join("\n"),
      ),
    ).toEqual(
      new Map([
        ["refs/remotes/origin/main", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
        ["refs/remotes/upstream/topic", "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"],
        ["refs/heads/main", "cccccccccccccccccccccccccccccccccccccccc"],
      ]),
    );
  });

  test("distinguishes remote changes from concurrent local ref changes", () => {
    expect(
      diffWorkspaceGitRefs(
        new Map([
          ["refs/remotes/origin/main", "aaaaaaaa"],
          ["refs/heads/topic", "bbbbbbbb"],
        ]),
        new Map([
          ["refs/remotes/origin/main", "cccccccc"],
          ["refs/heads/topic", "dddddddd"],
        ]),
      ),
    ).toEqual({
      remoteChanges: [
        {
          kind: "moved",
          ref: "origin/main",
          beforeOid: "aaaaaaaa",
          afterOid: "cccccccc",
        },
      ],
      nonRemoteRefsChanged: true,
    });
  });

  test("reports added, changed, and deleted remote refs", () => {
    expect(
      diffWorkspaceGitRemoteRefs(
        new Map([
          ["origin/main", "aaaaaaaa"],
          ["origin/deleted", "bbbbbbbb"],
          ["origin/unchanged", "cccccccc"],
        ]),
        new Map([
          ["origin/main", "dddddddd"],
          ["origin/added", "eeeeeeee"],
          ["origin/unchanged", "cccccccc"],
        ]),
      ),
    ).toEqual([
      {
        kind: "moved",
        ref: "origin/main",
        beforeOid: "aaaaaaaa",
        afterOid: "dddddddd",
      },
      { kind: "added", ref: "origin/added", afterOid: "eeeeeeee" },
      { kind: "deleted", ref: "origin/deleted", beforeOid: "bbbbbbbb" },
    ]);
  });
});

// Serve a real bare repository over Git's dumb HTTP transport, behind Basic authentication.
// Both the authentication challenge and successful fetch exercise Git itself.
async function withAuthenticatedRemote(
  verify: (fixture: {
    cwd: string;
    run: RunGitCommand;
    root: string;
    origin: string;
    expectedOid: string;
  }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "paseo-fetch-auth-"));
  const cwd = join(root, "checkout");
  const remote = join(root, "remote.git");
  const emptyConfig = join(root, "gitconfig");
  const askpass = join(root, "askpass.sh");
  const marker = join(root, "prompts");
  await writeFile(emptyConfig, "");
  await writeFile(
    askpass,
    `#!/bin/sh\nprintf 'prompt\\n' >> '${marker.replaceAll("'", "'\\''")}'\nexit 1\n`,
  );
  await chmod(askpass, 0o755);
  const askpassCommand = askpass;
  const run: RunGitCommand = (args, options) =>
    runGitCommand(args, {
      ...options,
      env: {
        ...options.env,
        GIT_CONFIG_GLOBAL: emptyConfig,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_ASKPASS: askpassCommand,
        SSH_ASKPASS: askpassCommand,
      },
    });
  const server = createServer(async (request, response) => {
    if (
      request.headers.authorization !== `Basic ${Buffer.from("fixture:secret").toString("base64")}`
    ) {
      response.writeHead(401, { "WWW-Authenticate": 'Basic realm="git-test"' });
      response.end();
      return;
    }
    const pathname = new URL(request.url!, "http://localhost").pathname;
    try {
      const contents = await readFile(join(root, pathname));
      response.writeHead(200, { "Content-Type": "application/octet-stream" });
      response.end(contents);
    } catch {
      response.writeHead(404);
      response.end();
    }
  });
  try {
    await run(["init", "--initial-branch=main", cwd], { cwd: root });
    await run(
      [
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "--allow-empty",
        "-m",
        "initial",
      ],
      { cwd },
    );
    await run(["clone", "--bare", cwd, remote], { cwd: root });
    await run(["update-server-info"], { cwd: remote });
    await run(["config", "credential.helper", ""], { cwd });
    await run(["config", "core.askPass", askpassCommand], { cwd });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP server");
    const origin = `http://127.0.0.1:${address.port}/remote.git`;
    await run(["remote", "add", "origin", origin], { cwd });
    const expectedOid = (await run(["rev-parse", "HEAD"], { cwd })).stdout.trim();
    await verify({ cwd, run, root, origin, expectedOid });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

test.skipIf(process.platform === "win32")(
  "background fetches never invoke askpass when credentials are missing",
  async () => {
    await withAuthenticatedRemote(async ({ cwd, run, root }) => {
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = await fetchWorkspaceGitRemote(cwd, { onRefSnapshot() {} }, run);
        expect(String(result.error)).toContain("terminal prompts disabled");
      }
      await expect(readFile(join(root, "prompts"), "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
    });
  },
);

test.skipIf(process.platform === "win32")(
  "background fetches still use stored credentials",
  async () => {
    await withAuthenticatedRemote(async ({ cwd, run, root, origin, expectedOid }) => {
      const credentials = join(root, "credentials");
      await writeFile(credentials, origin.replace("http://", "http://fixture:secret@") + "\n");
      await run(["config", "credential.helper", `store --file="${credentials}"`], { cwd });

      const result = await fetchWorkspaceGitRemote(cwd, { onRefSnapshot() {} }, run);

      expect(result.error).toBeNull();
      expect(result.changes).toContainEqual({
        kind: "added",
        ref: "origin/main",
        afterOid: expectedOid,
      });
      expect((await run(["rev-parse", "refs/remotes/origin/main"], { cwd })).stdout.trim()).toBe(
        expectedOid,
      );
      await expect(readFile(join(root, "prompts"), "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
    });
  },
);

interface LocalRemoteFixture {
  root: string;
  remote: string;
  clone: string;
  git: (cwd: string, ...args: string[]) => string;
}

// A clone of a real local repository. The remote has main, keep and gone; the clone has a linked
// worktree whose paseo/worktree.json says it was cut from refs/remotes/origin/keep.
async function withLocalRemote(verify: (fixture: LocalRemoteFixture) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "paseo-fetch-prune-"));
  const remote = join(root, "remote");
  const clone = join(root, "clone");
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: join(root, "gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  };
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();
  try {
    await writeFile(join(root, "gitconfig"), "");
    await mkdir(remote);
    git(remote, "init", "--initial-branch=main");
    git(remote, "commit", "--allow-empty", "-m", "initial");
    git(remote, "branch", "keep");
    git(remote, "branch", "gone");
    git(root, "clone", "-q", remote, clone);
    git(
      clone,
      "worktree",
      "add",
      "-q",
      "-b",
      "topic",
      join(root, "topic"),
      "refs/remotes/origin/keep",
    );
    const adminDir = join(clone, ".git", "worktrees", "topic", "paseo");
    await mkdir(adminDir);
    await writeFile(
      join(adminDir, "worktree.json"),
      JSON.stringify({ version: 1, baseRefName: "keep", baseRef: "refs/remotes/origin/keep" }),
    );
    await verify({ root, remote, clone, git });
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

const gitRunner: RunGitCommand = (args, options) =>
  runGitCommand(args, {
    ...options,
    envOverlay: {
      ...options.envOverlay,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    },
  });

describe("background fetch of a repository with Paseo worktrees", () => {
  test("reads stored remote bases from every worktree of the repository", async () => {
    await withLocalRemote(async ({ clone }) => {
      const mainAdmin = join(clone, ".git", "paseo");
      await mkdir(mainAdmin);
      await writeFile(
        join(mainAdmin, "worktree.json"),
        JSON.stringify({ version: 1, baseRefName: "legacy" }),
      );
      expect(await readStoredRemoteBaseRefs(join(clone, ".git"))).toEqual(
        new Set(["refs/remotes/origin/keep", "refs/remotes/origin/legacy"]),
      );
    });
  });

  test("keeps a pruned remote ref that a worktree stores as its base", async () => {
    await withLocalRemote(async ({ root, remote, clone, git }) => {
      const keptOid = git(clone, "rev-parse", "refs/remotes/origin/keep");
      git(remote, "commit", "--allow-empty", "-m", "second");
      git(remote, "branch", "-D", "keep", "gone");

      const result = await fetchWorkspaceGitRemote(
        join(root, "topic"),
        { onRefSnapshot() {} },
        gitRunner,
      );

      expect(result.error).toBeNull();
      expect(git(clone, "rev-parse", "refs/remotes/origin/keep")).toBe(keptOid);
      expect(git(clone, "for-each-ref", "--format=%(refname)", "refs/remotes/origin/gone")).toBe(
        "",
      );
      expect(result.changes).toContainEqual({
        kind: "deleted",
        ref: "origin/gone",
        beforeOid: keptOid,
      });
      expect(result.changes).not.toContainEqual(expect.objectContaining({ ref: "origin/keep" }));
      expect(git(clone, "rev-parse", "refs/remotes/origin/main")).toBe(
        git(remote, "rev-parse", "main"),
      );
    });
  });

  test("still moves a stored base while the remote has it", async () => {
    await withLocalRemote(async ({ root, remote, clone, git }) => {
      git(remote, "checkout", "-q", "keep");
      git(remote, "commit", "--allow-empty", "-m", "moved");
      git(remote, "checkout", "-q", "main");

      await fetchWorkspaceGitRemote(join(root, "topic"), { onRefSnapshot() {} }, gitRunner);

      expect(git(clone, "rev-parse", "refs/remotes/origin/keep")).toBe(
        git(remote, "rev-parse", "keep"),
      );
    });
  });

  test("never moves local branches", async () => {
    await withLocalRemote(async ({ remote, clone, git }) => {
      const localMain = git(clone, "rev-parse", "refs/heads/main");
      git(remote, "commit", "--allow-empty", "-m", "ahead");

      await fetchWorkspaceGitRemote(clone, { onRefSnapshot() {} }, gitRunner);

      expect(git(clone, "rev-parse", "refs/heads/main")).toBe(localMain);
      expect(git(clone, "rev-parse", "refs/remotes/origin/main")).toBe(
        git(remote, "rev-parse", "main"),
      );
    });
  });

  test("removes a packed-refs.new left by a killed git so the prune succeeds", async () => {
    await withLocalRemote(async ({ remote, clone, git }) => {
      git(clone, "pack-refs", "--all");
      const leftover = join(clone, ".git", "packed-refs.new");
      await writeFile(leftover, "");
      const anHourAgo = new Date(Date.now() - 60 * 60 * 1000);
      await utimes(leftover, anHourAgo, anHourAgo);
      git(remote, "branch", "-D", "gone");

      const result = await fetchWorkspaceGitRemote(clone, { onRefSnapshot() {} }, gitRunner);

      expect(result.error).toBeNull();
      expect(git(clone, "for-each-ref", "--format=%(refname)", "refs/remotes/origin/gone")).toBe(
        "",
      );
    });
  });

  test("leaves a fresh packed-refs.lock alone", async () => {
    await withLocalRemote(async ({ clone }) => {
      const lock = join(clone, ".git", "packed-refs.lock");
      await writeFile(lock, "");

      await fetchWorkspaceGitRemote(clone, { onRefSnapshot() {} }, gitRunner);

      await expect(stat(lock)).resolves.toBeTruthy();
    });
  });

  test("serializes fetches started from different worktrees of one repository", async () => {
    await withLocalRemote(async ({ root, clone }) => {
      let running = 0;
      let maxRunning = 0;
      const run: RunGitCommand = async (args, options) => {
        const isFetch = args.includes("fetch");
        if (isFetch) {
          running += 1;
          maxRunning = Math.max(maxRunning, running);
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
        }
        try {
          return await gitRunner(args, options);
        } finally {
          if (isFetch) running -= 1;
        }
      };

      await Promise.all([
        fetchWorkspaceGitRemote(clone, { onRefSnapshot() {} }, run),
        fetchWorkspaceGitRemote(join(root, "topic"), { onRefSnapshot() {} }, run),
        fetchWorkspaceGitRemote(clone, { onRefSnapshot() {} }, run),
      ]);

      expect(maxRunning).toBe(1);
    });
  });

  test("updates origin/HEAD when the remote changes its default branch", async () => {
    await withLocalRemote(async ({ remote, clone, git }) => {
      git(remote, "symbolic-ref", "HEAD", "refs/heads/keep");

      await fetchWorkspaceGitRemote(clone, { onRefSnapshot() {} }, gitRunner);

      expect(git(clone, "symbolic-ref", "refs/remotes/origin/HEAD")).toBe(
        "refs/remotes/origin/keep",
      );
    });
  });
});
