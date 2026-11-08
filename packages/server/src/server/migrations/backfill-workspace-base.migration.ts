// COMPAT(workspaceBaseV3): one-time base backfill, delete after 2027-05-04
// once floor >= the release that always persists qualified bases with fork points.
//
// Workspaces written before the unified base resolver store six different base
// shapes in workspaces.json (raw sha, bare name, refs/heads/*, refs/remotes/*,
// null): none carries both branch identity and fork point. This migration
// qualifies each stored base to a full ref (refs/remotes/<remote>/<branch> for
// published bases, refs/heads/<branch> for local ones), records the fork point
// in worktree.json v3, and mirrors the qualified ref back to workspaces.json.
// Already-v3 worktrees keep their saved fork point. A stored sha keeps its
// commit as the fork point and takes the branch only from unambiguous ref
// evidence; a missing explicit ref migrates only to a verified local namesake.
// Anything else is left untouched with a diagnostic requiring set-base, never
// silently replaced with the repository default.
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

async function gitCommitExists(cwd: string, sha: string): Promise<boolean> {
  try {
    await runGitCommand(["rev-parse", "--verify", "--quiet", `${sha}^{commit}`], {
      cwd,
      timeout: 30_000,
    });
    return true;
  } catch {
    return false;
  }
}

// Branch refs pointing exactly at a commit, limited to branch namespaces so
// tags and other refs never contribute branch identity.
async function gitBranchRefsPointingAt(cwd: string, sha: string): Promise<string[]> {
  try {
    const { stdout } = await runGitCommand(
      ["for-each-ref", "--format=%(refname)", "--points-at", sha, "refs/heads", "refs/remotes"],
      { cwd, timeout: 30_000 },
    );
    return stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("refs/heads/") || line.startsWith("refs/remotes/"));
  } catch {
    return [];
  }
}

// Picks the single branch identity behind exact-pointing refs. A local branch
// and its remote-tracking counterparts share one name; published bases prefer
// the origin tracking ref. Distinct branch names are ambiguous and yield null.
function pickBranchRef(refs: string[]): string | null {
  if (refs.length === 0) return null;
  const names = new Set(refs.map(branchNameFromRef));
  if (names.size !== 1) return null;
  if (refs.length === 1) return refs[0];
  const name = [...names][0];
  const origin = `refs/remotes/origin/${name}`;
  if (refs.includes(origin)) return origin;
  const remote = refs.filter((ref) => ref.startsWith("refs/remotes/")).sort()[0];
  return remote ?? `refs/heads/${name}`;
}

// Infers the qualified base for a stored sha from unambiguous ref evidence,
// keeping the stored commit as the fork point. Returns null when the sha is
// not a commit, no branch points at it, or several branches do.
async function inferShaBase(
  cwd: string,
  sha: string,
): Promise<{ ref: string; forkSha: string } | null> {
  if (!(await gitCommitExists(cwd, sha))) return null;
  const ref = pickBranchRef(await gitBranchRefsPointingAt(cwd, sha));
  if (!ref) return null;
  return { ref, forkSha: sha };
}

function setBaseDiagnostic(workspaceId: string, stored: string): string {
  return (
    `Stored base '${stored}' for workspace ${workspaceId} cannot be migrated automatically; ` +
    `run 'paseo workspace set-base ${workspaceId} <ref>' with a qualified ref ` +
    `(refs/heads/<branch> or refs/remotes/<remote>/<branch>) to set an explicit base.`
  );
}

async function resolveMigrationTarget(cwd: string, stored: string): Promise<string | null> {
  const trimmed = stored.trim();
  if (!trimmed || isSha(trimmed)) return null;
  if (isQualifiedRef(trimmed)) {
    if (await gitRefExists(cwd, trimmed)) return trimmed;
    // A pruned remote-tracking base falls back to the verified local branch
    // of the same name; a deleted base with no local namesake is not migrated.
    if (trimmed.startsWith("refs/remotes/")) {
      const local = `refs/heads/${branchNameFromRef(trimmed)}`;
      if (await gitRefExists(cwd, local)) return local;
    }
    return null;
  }
  const name = branchNameFromRef(trimmed);
  const candidates = trimmed.startsWith("origin/")
    ? [`refs/remotes/${trimmed}`]
    : [`refs/remotes/origin/${name}`, `refs/heads/${name}`];
  for (const candidate of candidates) {
    if (await gitRefExists(cwd, candidate)) return candidate;
  }
  const local = `refs/heads/${name}`;
  if (
    (trimmed.startsWith("refs/remotes/") || trimmed.startsWith("origin/")) &&
    (await gitRefExists(cwd, local))
  ) {
    return local;
  }
  return null;
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
      if (isSha(stored)) {
        const inferred = await inferShaBase(workspace.cwd, stored);
        if (!inferred) {
          const diagnostic = setBaseDiagnostic(workspace.workspaceId, stored);
          result.errors.push({ workspaceId: workspace.workspaceId, error: diagnostic });
          options.logger.warn(
            { workspaceId: workspace.workspaceId, stored },
            "Leaving ambiguous SHA base unchanged; set an explicit base with set-base",
          );
          result.skipped += 1;
          continue;
        }
        const { setWorkspaceBaseWithForkSha } = await import("../../utils/checkout-git.js");
        const base = await setWorkspaceBaseWithForkSha(
          workspace.cwd,
          inferred.ref,
          inferred.forkSha,
        );
        await options.workspaceRegistry.update(workspace.workspaceId, (record) => ({
          ...record,
          baseBranch: base.ref,
          updatedAt: new Date().toISOString(),
        }));
        result.migrated += 1;
        continue;
      }
      const target = await resolveMigrationTarget(workspace.cwd, stored);
      if (!target) {
        const diagnostic = setBaseDiagnostic(workspace.workspaceId, stored);
        result.errors.push({ workspaceId: workspace.workspaceId, error: diagnostic });
        options.logger.warn(
          { workspaceId: workspace.workspaceId, stored },
          "Leaving unresolvable base unchanged; set an explicit base with set-base",
        );
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
