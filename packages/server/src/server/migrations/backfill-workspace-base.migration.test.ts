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

function commitEmpty(dir: string, message: string): void {
  git(
    dir,
    "-c",
    "user.email=test@example.com",
    "-c",
    "user.name=Test",
    "commit",
    "--allow-empty",
    "-m",
    message,
  );
}

function initRepo(dir: string, defaultBranch: string): void {
  git(dir, "init", "-b", defaultBranch);
  commitEmpty(dir, "init");
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

  test("recovers a fork sha to its local branch and keeps the stored commit", async () => {
    const repo = mkdtempSync(path.join(tmpdir(), "paseo-base-sha-"));
    try {
      initRepo(repo, "main");
      const mainSha = git(repo, "rev-parse", "HEAD");
      git(repo, "update-ref", "refs/remotes/origin/main", mainSha);
      git(repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
      // A local fork/epic branch on its own history, distinct from origin/main.
      git(repo, "checkout", "-b", "epic-work");
      commitEmpty(repo, "epic commit");
      const epicSha = git(repo, "rev-parse", "HEAD");
      expect(epicSha).not.toBe(mainSha);
      await writePaseoWorktreeMetadata(repo, { baseRefName: epicSha, baseRef: epicSha });
      await addWorkspace("wks_sha", repo, epicSha);

      const result = await migrateWorkspaceBases({
        workspaceRegistry: registry,
        logger: createTestLogger(),
      });
      expect(result.errors).toEqual([]);
      expect(result.migrated).toBe(1);

      const record = await registry.get("wks_sha");
      expect(record?.baseBranch).toBe("refs/heads/epic-work");
      const metadata = await readPaseoWorktreeMetadata(repo);
      expect(metadata?.version).toBe(3);
      expect(metadata?.baseRef).toBe("refs/heads/epic-work");
      // The stored commit is retained as the fork point, not recomputed.
      expect(metadata && "forkSha" in metadata ? metadata.forkSha : null).toBe(epicSha);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("leaves an ambiguous sha unchanged with a set-base diagnostic", async () => {
    const repo = mkdtempSync(path.join(tmpdir(), "paseo-base-ambiguous-"));
    try {
      initRepo(repo, "main");
      const sha = git(repo, "rev-parse", "HEAD");
      git(repo, "branch", "epic-a");
      git(repo, "branch", "epic-b");
      await writePaseoWorktreeMetadata(repo, { baseRefName: sha, baseRef: sha });
      await addWorkspace("wks_ambiguous", repo, sha);

      const result = await migrateWorkspaceBases({
        workspaceRegistry: registry,
        logger: createTestLogger(),
      });
      expect(result.migrated).toBe(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]?.workspaceId).toBe("wks_ambiguous");
      expect(result.errors[0]?.error).toMatch(/set-base/);

      // Explicit identity is preserved, not replaced with the repo default.
      const record = await registry.get("wks_ambiguous");
      expect(record?.baseBranch).toBe(sha);
      const metadata = await readPaseoWorktreeMetadata(repo);
      expect(metadata?.version).toBe(1);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("leaves a deleted non-default base unchanged while origin/HEAD exists", async () => {
    const repo = mkdtempSync(path.join(tmpdir(), "paseo-base-deleted-"));
    try {
      initRepo(repo, "main");
      git(repo, "update-ref", "refs/remotes/origin/main", "HEAD");
      git(repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
      const stored = "refs/remotes/origin/feature/epic";
      await writePaseoWorktreeMetadata(repo, { baseRefName: "epic", baseRef: stored });
      await addWorkspace("wks_deleted", repo, stored);

      const result = await migrateWorkspaceBases({
        workspaceRegistry: registry,
        logger: createTestLogger(),
      });
      expect(result.migrated).toBe(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]?.workspaceId).toBe("wks_deleted");

      const record = await registry.get("wks_deleted");
      expect(record?.baseBranch).toBe(stored);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("skips null and directory workspaces", async () => {
    const repo = mkdtempSync(path.join(tmpdir(), "paseo-base-skip-"));
    try {
      initRepo(repo, "main");
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
      expect(result.migrated).toBe(0);

      expect((await registry.get("wks_null"))?.baseBranch).toBeNull();
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
