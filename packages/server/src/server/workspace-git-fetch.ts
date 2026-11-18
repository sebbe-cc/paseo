import { readdir, readFile, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { withRepoFetchLock } from "../utils/repo-fetch-lock.js";
import { runGitCommand, type RunGitCommand } from "../utils/run-git-command.js";
import { readPaseoWorktreeMetadataFromGitDir } from "../utils/worktree-metadata.js";

const FETCH_TIMEOUT_MS = 120_000;
// Git holds packed-refs.lock / packed-refs.new for the length of one ref transaction. A file
// older than any fetch this process allows was left by a git that was killed (the fetch
// timeout kills with SIGKILL), and it makes every later prune and pack-refs fail with
// "File exists" until someone deletes it.
const STALE_REF_LOCK_AGE_MS = 2 * FETCH_TIMEOUT_MS;
const STALE_REF_LOCK_FILES = ["packed-refs.lock", "packed-refs.new"];
const ZERO_OID = "0000000000000000000000000000000000000000";

export interface WorkspaceGitFetchResult {
  changes: WorkspaceGitRemoteRefChange[] | null;
  nonRemoteRefsChanged?: boolean;
  remoteRefs?: ReadonlySet<string>;
  error: unknown | null;
}

export interface WorkspaceGitFetchObserver {
  onRefSnapshot(phase: "before" | "after"): void;
}

export type WorkspaceGitRemoteRefChange =
  | { kind: "moved"; ref: string; beforeOid: string; afterOid: string }
  | { kind: "added"; ref: string; afterOid: string }
  | { kind: "deleted"; ref: string; beforeOid: string };

export interface FetchWorkspaceGitRemoteOptions {
  now?: () => number;
}

/**
 * Fetches origin for the repository that owns cwd. Fetches of one repository are serialized
 * (see withRepoFetchLock), origin/HEAD follows the remote's default branch, and a remote ref
 * that a Paseo worktree of the repository stores as its base survives the prune at the oid it
 * had: deleting it would leave that worktree with no base to diff against. refs/heads/* are
 * never written; local branches belong to whoever owns the checkout.
 */
export async function fetchWorkspaceGitRemote(
  cwd: string,
  observer: WorkspaceGitFetchObserver,
  run: RunGitCommand = runGitCommand,
  options: FetchWorkspaceGitRemoteOptions = {},
): Promise<WorkspaceGitFetchResult> {
  const gitCommonDir = await findGitCommonDir(cwd);
  if (!gitCommonDir) {
    return fetchWorkspaceGitRemoteUnlocked({ cwd, gitCommonDir, observer, run, options });
  }
  return withRepoFetchLock(gitCommonDir, () =>
    fetchWorkspaceGitRemoteUnlocked({ cwd, gitCommonDir, observer, run, options }),
  );
}

interface UnlockedFetchInput {
  cwd: string;
  gitCommonDir: string | null;
  observer: WorkspaceGitFetchObserver;
  run: RunGitCommand;
  options: FetchWorkspaceGitRemoteOptions;
}

async function fetchWorkspaceGitRemoteUnlocked(
  input: UnlockedFetchInput,
): Promise<WorkspaceGitFetchResult> {
  const { cwd, gitCommonDir, observer, run } = input;
  if (gitCommonDir) {
    await removeStaleRefLockFiles(gitCommonDir, input.options.now ?? Date.now);
  }
  let before: Map<string, string> | null = null;
  let after: Map<string, string> | null = null;
  let error: unknown | null = null;
  try {
    before = await readWorkspaceGitRefs(cwd, run);
    observer.onRefSnapshot("before");
  } catch (caught) {
    error = caught;
  }
  try {
    await run(["fetch", "origin", "--prune"], {
      cwd,
      envOverlay: {
        // Terminal prompting and graphical credential prompting have separate controls.
        // Keep cached credentials available, but never start a login from a passive fetch.
        GIT_TERMINAL_PROMPT: "0",
        GIT_ASKPASS: "",
        GCM_INTERACTIVE: "0",
        // followRemoteHEAD=always moves origin/HEAD when the remote changes its default branch;
        // git's default only creates it when missing. Git before 2.48 ignores the setting.
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "remote.origin.followRemoteHEAD",
        GIT_CONFIG_VALUE_0: "always",
      },
      timeout: FETCH_TIMEOUT_MS,
    });
  } catch (caught) {
    error ??= caught;
  }
  try {
    after = await readWorkspaceGitRefs(cwd, run);
  } catch (caught) {
    error ??= caught;
  }
  if (before && after && gitCommonDir) {
    try {
      await restorePrunedBaseRefs({ cwd, gitCommonDir, before, after, run });
    } catch (caught) {
      error ??= caught;
    }
  }
  if (!before || !after) {
    return { changes: null, error };
  }
  const diff = diffWorkspaceGitRefs(before, after);
  const result = {
    changes: diff.remoteChanges,
    nonRemoteRefsChanged: diff.nonRemoteRefsChanged,
    remoteRefs: collectWorkspaceGitRemoteRefs(after),
    error,
  } satisfies WorkspaceGitFetchResult;
  observer.onRefSnapshot("after");
  return result;
}

// Filesystem only, so a fetch costs no extra git process: the nearest .git at or above cwd is
// either the repository's git dir or a gitdir file pointing at a linked worktree's admin dir,
// whose commondir file points back at the shared one.
async function findGitCommonDir(cwd: string): Promise<string | null> {
  let current = resolve(cwd);
  for (;;) {
    const dotGit = join(current, ".git");
    const info = await stat(dotGit).catch(() => null);
    if (info?.isDirectory()) return dotGit;
    if (info?.isFile()) return resolveLinkedGitCommonDir(current, dotGit);
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

async function resolveLinkedGitCommonDir(
  worktreeRoot: string,
  dotGitFile: string,
): Promise<string | null> {
  try {
    const match = (await readFile(dotGitFile, "utf8")).match(/^gitdir:\s*(.+)$/m);
    if (!match?.[1]) return null;
    const raw = match[1].trim();
    const gitDir = isAbsolute(raw) ? raw : resolve(worktreeRoot, raw);
    const commonDir = (await readFile(join(gitDir, "commondir"), "utf8").catch(() => "")).trim();
    return commonDir ? resolve(gitDir, commonDir) : gitDir;
  } catch {
    return null;
  }
}

async function removeStaleRefLockFiles(gitCommonDir: string, now: () => number): Promise<void> {
  for (const name of STALE_REF_LOCK_FILES) {
    const path = join(gitCommonDir, name);
    try {
      const info = await stat(path);
      if (info.isFile() && now() - info.mtimeMs > STALE_REF_LOCK_AGE_MS) {
        await rm(path, { force: true });
      }
    } catch {
      // Missing is the normal case.
    }
  }
}

/**
 * The remote-tracking refs Paseo worktrees of this repository were cut from, read from each
 * worktree's paseo/worktree.json. A metadata file with only a base name protects
 * refs/remotes/origin/<name>, the ref that name resolves to first.
 */
export async function readStoredRemoteBaseRefs(gitCommonDir: string): Promise<Set<string>> {
  const gitDirs = [gitCommonDir];
  try {
    const entries = await readdir(join(gitCommonDir, "worktrees"), { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) gitDirs.push(join(gitCommonDir, "worktrees", entry.name));
    }
  } catch {
    // A repository without linked worktrees has no worktrees directory.
  }
  const refs = new Set<string>();
  for (const gitDir of gitDirs) {
    let metadata;
    try {
      metadata = await readPaseoWorktreeMetadataFromGitDir(gitDir);
    } catch {
      continue;
    }
    if (!metadata) continue;
    const ref = metadata.baseRef?.trim();
    if (ref) {
      if (ref.startsWith("refs/remotes/")) refs.add(ref);
      continue;
    }
    refs.add(`refs/remotes/origin/${metadata.baseRefName}`);
  }
  return refs;
}

async function restorePrunedBaseRefs(input: {
  cwd: string;
  gitCommonDir: string;
  before: ReadonlyMap<string, string>;
  /** Updated in place with every ref put back, so the fetch result never reports it deleted. */
  after: Map<string, string>;
  run: RunGitCommand;
}): Promise<void> {
  const pruned = [...input.before.keys()].filter(
    (ref) => ref.startsWith("refs/remotes/") && !input.after.has(ref),
  );
  if (pruned.length === 0) return;
  const stored = await readStoredRemoteBaseRefs(input.gitCommonDir);
  for (const ref of pruned) {
    const oid = input.before.get(ref);
    if (!oid || !stored.has(ref)) continue;
    // Create-only: if anything wrote the ref in the meantime, that value wins.
    const result = await input.run(
      ["update-ref", "-m", "paseo: keep pruned workspace base", ref, oid, ZERO_OID],
      { cwd: input.cwd, acceptExitCodes: [0, 1, 128] },
    );
    if (result.exitCode === 0) {
      input.after.set(ref, oid);
    }
  }
}

function collectWorkspaceGitRemoteRefs(refs: ReadonlyMap<string, string>): Set<string> {
  const remotePrefix = "refs/remotes/";
  return new Set(
    [...refs.keys()]
      .filter((ref) => ref.startsWith(remotePrefix))
      .map((ref) => ref.slice(remotePrefix.length)),
  );
}

async function readWorkspaceGitRefs(cwd: string, run: RunGitCommand): Promise<Map<string, string>> {
  const { stdout } = await run(["for-each-ref", "--format=%(refname)%00%(objectname)"], {
    cwd,
  });
  return parseWorkspaceGitRefs(stdout);
}

export function parseWorkspaceGitRefs(stdout: string): Map<string, string> {
  const refs = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    const [ref, objectId] = line.split("\0");
    if (ref?.startsWith("refs/") && objectId) {
      refs.set(ref, objectId);
    }
  }
  return refs;
}

export interface WorkspaceGitRefDiff {
  remoteChanges: WorkspaceGitRemoteRefChange[];
  nonRemoteRefsChanged: boolean;
}

export function diffWorkspaceGitRefs(
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>,
): WorkspaceGitRefDiff {
  const remotePrefix = "refs/remotes/";
  const beforeRemote = new Map<string, string>();
  const afterRemote = new Map<string, string>();
  let nonRemoteRefsChanged = false;
  for (const [ref, objectId] of before) {
    if (ref.startsWith(remotePrefix)) {
      beforeRemote.set(ref.slice(remotePrefix.length), objectId);
    } else if (after.get(ref) !== objectId) {
      nonRemoteRefsChanged = true;
    }
  }
  for (const [ref, objectId] of after) {
    if (ref.startsWith(remotePrefix)) {
      afterRemote.set(ref.slice(remotePrefix.length), objectId);
    } else if (!before.has(ref)) {
      nonRemoteRefsChanged = true;
    }
  }
  return {
    remoteChanges: diffWorkspaceGitRemoteRefs(beforeRemote, afterRemote),
    nonRemoteRefsChanged,
  };
}

export function diffWorkspaceGitRemoteRefs(
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>,
): WorkspaceGitRemoteRefChange[] {
  const changes: WorkspaceGitRemoteRefChange[] = [];
  for (const [ref, objectId] of after) {
    const beforeOid = before.get(ref);
    if (beforeOid === undefined) {
      changes.push({ kind: "added", ref, afterOid: objectId });
    } else if (beforeOid !== objectId) {
      changes.push({ kind: "moved", ref, beforeOid, afterOid: objectId });
    }
  }
  for (const [ref, beforeOid] of before) {
    if (!after.has(ref)) {
      changes.push({ kind: "deleted", ref, beforeOid });
    }
  }
  return changes;
}
