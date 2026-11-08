// COMPAT(workspaceBaseV3): one-time base backfill, delete after 2027-05-04
// once floor >= the release that always persists qualified bases with fork points.
//
// Workspaces written before the unified base resolver store six different base
// shapes in workspaces.json (raw sha, bare name, refs/heads/*, refs/remotes/*,
// null): none carries both branch identity and fork point. This migration
// qualifies each stored base to a full ref (refs/remotes/<remote>/<branch> for
// published bases, refs/heads/<branch> for local ones), records the fork point
// in worktree.json v3, and mirrors the qualified ref back to workspaces.json.
// Already-v3 worktrees keep their saved fork point; missing refs fall back to
// the local namesake, then to the repo default, so no view silently swaps in
// the local default branch.
import type { Logger } from "pino";

import { runGitCommand } from "../../utils/run-git-command.js";
import { branchNameFromRef, readPaseoWorktreeMetadata } from "../../utils/worktree-metadata.js";
import type { WorkspaceRegistry } from "../workspace-registry.js";

export interface MigrateWorkspaceBasesResult {
  migrated: number;
  skipped: number;
  errors: { workspaceId: string; error: string }[];
}

function isSha(value: string): boolean {
  return /^[0-9a-f]{40,64}$/i.test(value.trim());
}

function isQualifiedRef(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.startsWith("refs/heads/") || trimmed.startsWith("refs/remotes/");
}

async function gitRefExists(cwd: string, ref: string): Promise<boolean> {
  try {
    await runGitCommand(["show-ref", "--verify", "--quiet", ref], { cwd, timeout: 30_000 });
    return true;
  } catch {
    return false;
  }
}

async function gitDefaultBranch(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await runGitCommand(
      ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"],
      { cwd, timeout: 30_000 },
    );
    const ref = stdout.trim();
    return ref.startsWith("refs/remotes/origin/") ? ref : null;
  } catch {
    return null;
  }
}

async function resolveMigrationTarget(cwd: string, stored: string): Promise<string | null> {
  const trimmed = stored.trim();
  if (!trimmed) return null;
  if (isSha(trimmed)) {
    return gitDefaultBranch(cwd);
  }
  if (isQualifiedRef(trimmed)) {
    if (await gitRefExists(cwd, trimmed)) return trimmed;
    if (trimmed.startsWith("refs/remotes/")) {
      const local = `refs/heads/${branchNameFromRef(trimmed)}`;
      if (await gitRefExists(cwd, local)) return local;
    }
    return gitDefaultBranch(cwd);
  }
  const name = branchNameFromRef(trimmed);
  const candidates = trimmed.startsWith("origin/")
    ? [`refs/remotes/${trimmed}`]
    : [`refs/remotes/origin/${name}`, `refs/heads/${name}`];
  for (const candidate of candidates) {
    if (await gitRefExists(cwd, candidate)) return candidate;
  }
  if (trimmed.startsWith("refs/remotes/") || trimmed.startsWith("origin/")) {
    const local = `refs/heads/${name}`;
    if (await gitRefExists(cwd, local)) return local;
  }
  return gitDefaultBranch(cwd);
}

export async function migrateWorkspaceBases(options: {
  workspaceRegistry: WorkspaceRegistry;
  logger: Logger;
}): Promise<MigrateWorkspaceBasesResult> {
  const result: MigrateWorkspaceBasesResult = { migrated: 0, skipped: 0, errors: [] };
  const workspaces = await options.workspaceRegistry.list();

  for (const workspace of workspaces) {
    if (workspace.kind === "directory") {
      result.skipped += 1;
      continue;
    }
    const stored = workspace.baseBranch?.trim() ?? "";
    if (!stored) {
      result.skipped += 1;
      continue;
    }
    try {
      const metadata = await readPaseoWorktreeMetadata(workspace.cwd).catch(() => null);
      if (metadata?.version === 3) {
        if (workspace.baseBranch !== metadata.baseRef) {
          await options.workspaceRegistry.update(workspace.workspaceId, (record) => ({
            ...record,
            baseBranch: metadata.baseRef,
            updatedAt: new Date().toISOString(),
          }));
          result.migrated += 1;
        } else {
          result.skipped += 1;
        }
        continue;
      }
      const target = await resolveMigrationTarget(workspace.cwd, stored);
      if (!target) {
        result.skipped += 1;
        continue;
      }
      const { setWorkspaceBase } = await import("../../utils/checkout-git.js");
      const base = await setWorkspaceBase(workspace.cwd, target);
      await options.workspaceRegistry.update(workspace.workspaceId, (record) => ({
        ...record,
        baseBranch: base.ref,
        updatedAt: new Date().toISOString(),
      }));
      result.migrated += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("Not a git repository")) {
        result.skipped += 1;
        continue;
      }
      result.errors.push({ workspaceId: workspace.workspaceId, error: message });
      options.logger.warn(
        { err: error, workspaceId: workspace.workspaceId },
        "Failed to migrate workspace base; leaving stored base unchanged",
      );
    }
  }

  if (result.migrated > 0) {
    options.logger.info(
      { migrated: result.migrated, errors: result.errors.length },
      "Migrated workspace bases to qualified refs with fork points",
    );
  }
  return result;
}
