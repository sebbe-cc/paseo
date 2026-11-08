import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import {
  createPersistedWorkspaceRecord,
  FileBackedWorkspaceRegistry,
} from "../workspace-registry.js";
import {
  readPaseoWorktreeMetadata,
  writePaseoWorktreeMetadata,
} from "../../utils/worktree-metadata.js";
import { migrateWorkspaceBases } from "./backfill-workspace-base.migration.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function initRepo(dir: string, defaultBranch: string): void {
  git(dir, "init", "-b", defaultBranch);
  git(
    dir,
    "-c",
    "user.email=test@example.com",
    "-c",
    "user.name=Test",
    "commit",
    "--allow-empty",
    "-m",
    "init",
  );
}

describe("migrateWorkspaceBases", () => {
  let home: string;
  let registry: FileBackedWorkspaceRegistry;

  beforeEach(async () => {
    home = mkdtempSync(path.join(tmpdir(), "paseo-base-migrate-"));
    registry = new FileBackedWorkspaceRegistry(
      path.join(home, "workspaces.json"),
      createTestLogger(),
    );
    await registry.initialize();
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  async function addWorkspace(workspaceId: string, cwd: string, baseBranch: string | null) {
    await registry.upsert(
      createPersistedWorkspaceRecord({
        workspaceId,
        projectId: workspaceId,
        cwd,
        kind: "local_checkout",
        displayName: path.basename(cwd),
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-01T00:00:00.000Z",
        ...(baseBranch === null ? {} : { baseBranch }),
      }),
    );
  }

  test("qualifies a bare branch name to the remote ref and records the fork point", async () => {
    const repo = mkdtempSync(path.join(tmpdir(), "paseo-base-repo-"));
    try {
      initRepo(repo, "main");
      git(repo, "update-ref", "refs/remotes/origin/main", "HEAD");
      await writePaseoWorktreeMetadata(repo, { baseRefName: "main" });
      await addWorkspace("wks_bare", repo, "main");

      const result = await migrateWorkspaceBases({
        workspaceRegistry: registry,
        logger: createTestLogger(),
      });
      expect(result.errors).toEqual([]);
      expect(result.migrated).toBe(1);

      const metadata = await readPaseoWorktreeMetadata(repo);
      expect(metadata?.version).toBe(3);
      expect(metadata?.baseRef).toBe("refs/remotes/origin/main");
      expect(metadata && "forkSha" in metadata ? metadata.forkSha : null).toMatch(
        /^[0-9a-f]{40}$/i,
      );

      const record = await registry.get("wks_bare");
      expect(record?.baseBranch).toBe("refs/remotes/origin/main");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("maps a stored sha to the repo default and skips null and directory workspaces", async () => {
    const repo = mkdtempSync(path.join(tmpdir(), "paseo-base-sha-"));
    try {
      initRepo(repo, "main");
      git(repo, "update-ref", "refs/remotes/origin/main", "HEAD");
      git(repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
      const sha = git(repo, "rev-parse", "HEAD");
      await writePaseoWorktreeMetadata(repo, { baseRefName: sha, baseRef: sha });
      await addWorkspace("wks_sha", repo, sha);
      await addWorkspace("wks_null", repo, null);
      await registry.upsert(
        createPersistedWorkspaceRecord({
          workspaceId: "wks_dir",
          projectId: "wks_dir",
          cwd: repo,
          kind: "directory",
          displayName: "dir",
          createdAt: "2026-03-01T00:00:00.000Z",
          updatedAt: "2026-03-01T00:00:00.000Z",
        }),
      );

      const result = await migrateWorkspaceBases({
        workspaceRegistry: registry,
        logger: createTestLogger(),
      });
      expect(result.errors).toEqual([]);

      const record = await registry.get("wks_sha");
      expect(record?.baseBranch).toBe("refs/remotes/origin/main");
      const metadata = await readPaseoWorktreeMetadata(repo);
      expect(metadata?.version).toBe(3);
      expect(metadata?.baseRef).toBe("refs/remotes/origin/main");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("falls back from a pruned remote ref to the local namesake", async () => {
    const repo = mkdtempSync(path.join(tmpdir(), "paseo-base-pruned-"));
    try {
      initRepo(repo, "main");
      git(repo, "branch", "feature-keep");
      git(repo, "update-ref", "refs/remotes/origin/feature-gone", "HEAD");
      // Simulate the prune: the remote ref is gone, the local branch remains.
      git(repo, "update-ref", "-d", "refs/remotes/origin/feature-gone");
      await writePaseoWorktreeMetadata(repo, {
        baseRefName: "feature-gone",
        baseRef: "refs/remotes/origin/feature-gone",
      });
      await addWorkspace("wks_pruned", repo, "refs/remotes/origin/feature-gone");
      // Point the local namesake at an existing commit so it resolves.
      git(repo, "update-ref", "refs/heads/feature-gone", "HEAD");

      const result = await migrateWorkspaceBases({
        workspaceRegistry: registry,
        logger: createTestLogger(),
      });
      expect(result.errors).toEqual([]);

      const record = await registry.get("wks_pruned");
      expect(record?.baseBranch).toBe("refs/heads/feature-gone");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("leaves an already-v3 base alone except for mirroring the registry", async () => {
    const repo = mkdtempSync(path.join(tmpdir(), "paseo-base-v3-"));
    try {
      initRepo(repo, "main");
      git(repo, "update-ref", "refs/remotes/origin/main", "HEAD");
      const forkSha = git(repo, "rev-parse", "HEAD");
      const { setPaseoWorktreeBase } = await import("../../utils/worktree-metadata.js");
      await setPaseoWorktreeBase(repo, { baseRef: "refs/remotes/origin/main", forkSha });
      // Registry still holds the bare name; migration mirrors the qualified ref.
      await addWorkspace("wks_v3", repo, "main");

      const result = await migrateWorkspaceBases({
        workspaceRegistry: registry,
        logger: createTestLogger(),
      });
      expect(result.errors).toEqual([]);
      expect(result.migrated).toBe(1);

      const record = await registry.get("wks_v3");
      expect(record?.baseBranch).toBe("refs/remotes/origin/main");
      const metadata = await readPaseoWorktreeMetadata(repo);
      expect(metadata?.version).toBe(3);
      expect(metadata && "forkSha" in metadata ? metadata.forkSha : null).toBe(forkSha);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
