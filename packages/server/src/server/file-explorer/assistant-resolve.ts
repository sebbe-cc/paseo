import { promises as fs } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { expandUserPath, resolvePathFromBase } from "../path-utils.js";
import { runGitCommand } from "../../utils/run-git-command.js";

export interface AssistantResolveInput {
  cwd: string;
  workspaceRoot?: string;
  candidates: string[];
}

export interface AssistantResolveResult {
  path: string;
  status: "found" | "missing";
  absolutePath: string | null;
  searchedRoots: string[];
  modifiedAt: string | null;
}

const MAX_WALK_ENTRIES = 30_000;
const MAX_WALK_DEPTH = 15;
const MAX_SUFFIX_HITS = 50;
const GIT_TIMEOUT_MS = 10_000;

const IGNORED_DIR_NAMES = new Set([
  ".git",
  ".hg",
  ".svn",
  "__pycache__",
  ".next",
  ".expo",
  "node_modules",
  "dist",
  "build",
  "target",
  "Library",
  ".cache",
]);

function normalizeDir(value: string): string {
  return value.replace(/[/\\]+$/, "") || "/";
}

function isAbsoluteLike(value: string): boolean {
  const trimmed = value.trim();
  return (
    trimmed === "~" ||
    trimmed.startsWith("~/") ||
    path.posix.isAbsolute(trimmed) ||
    path.win32.isAbsolute(trimmed)
  );
}

function isWithin(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function existingDir(value: string): Promise<string | null> {
  try {
    const expanded = expandUserPath(value);
    const stats = await fs.stat(expanded);
    if (!stats.isDirectory()) return null;
    return expanded;
  } catch {
    return null;
  }
}

async function gitOutput(args: string[], cwd: string): Promise<string | null> {
  try {
    const result = await runGitCommand(args, {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      acceptExitCodes: [0, 128],
    });
    if (result.exitCode !== 0) return null;
    return result.stdout;
  } catch {
    return null;
  }
}

async function gitTopLevel(cwd: string): Promise<string | null> {
  const stdout = await gitOutput(["rev-parse", "--show-toplevel"], cwd);
  const top = stdout?.trim();
  if (!top) return null;
  return existingDir(top);
}

async function gitWorktrees(cwd: string): Promise<string[]> {
  const stdout = await gitOutput(["worktree", "list", "--porcelain"], cwd);
  if (!stdout) return [];
  const found: string[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.startsWith("worktree ")) continue;
    const dir = await existingDir(line.slice("worktree ".length).trim());
    if (dir) found.push(dir);
  }
  return found;
}

async function gitTrackedFiles(repoCwd: string): Promise<string[] | null> {
  const tracked = await gitOutput(["ls-files", "-z"], repoCwd);
  if (tracked === null) return null;
  const others = await gitOutput(["ls-files", "--others", "--exclude-standard", "-z"], repoCwd);
  const names = tracked.split("\0");
  if (others) names.push(...others.split("\0"));
  return names.filter((name) => name.length > 0);
}

async function walkFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  let visited = 0;
  const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || visited >= MAX_WALK_ENTRIES) break;
    let entries;
    try {
      entries = await fs.readdir(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      visited += 1;
      if (visited > MAX_WALK_ENTRIES) break;
      const full = path.join(current.dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.isSymbolicLink()) continue;
        if (IGNORED_DIR_NAMES.has(entry.name)) continue;
        if (current.depth + 1 <= MAX_WALK_DEPTH)
          stack.push({ dir: full, depth: current.depth + 1 });
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        files.push(full);
      }
    }
  }
  return files;
}

interface RootFileIndex {
  // Lazily built per RPC: absolute file paths under the root.
  promise: Promise<string[]> | null;
}

async function listRootFiles(root: string, cache: Map<string, RootFileIndex>): Promise<string[]> {
  let entry = cache.get(root);
  if (!entry) {
    entry = { promise: null };
    cache.set(root, entry);
  }
  if (!entry.promise) {
    entry.promise = (async () => {
      const tracked = await gitTrackedFiles(root);
      if (tracked !== null) {
        return tracked.map((name) => path.join(root, name));
      }
      return walkFiles(root);
    })();
  }
  return entry.promise;
}

async function outsideRootAllowlist(): Promise<string[]> {
  const raw = [homedir(), tmpdir(), "/tmp", "/private/tmp"];
  const resolved: string[] = [];
  for (const candidate of raw) {
    try {
      resolved.push(await fs.realpath(candidate));
    } catch {
      resolved.push(candidate);
    }
  }
  return [...new Set(resolved.map(normalizeDir))];
}

async function statFile(candidate: string): Promise<{ realPath: string; mtimeMs: number } | null> {
  try {
    const stats = await fs.stat(candidate);
    if (!stats.isFile() && !stats.isDirectory()) return null;
    const realPath = await fs.realpath(candidate);
    return { realPath, mtimeMs: stats.mtimeMs };
  } catch {
    return null;
  }
}

export async function collectAssistantSearchRoots(input: {
  cwd: string;
  workspaceRoot?: string;
}): Promise<string[]> {
  const ordered: string[] = [];
  const seen = new Set<string>();
  const push = (dir: string | null | undefined) => {
    if (!dir) return;
    const key = normalizeDir(dir);
    if (seen.has(key)) return;
    seen.add(key);
    ordered.push(dir);
  };

  push(await existingDir(input.cwd));
  if (input.workspaceRoot) push(await existingDir(input.workspaceRoot));
  push(await gitTopLevel(input.cwd));
  for (const worktree of await gitWorktrees(input.cwd)) push(worktree);
  return ordered;
}

export async function resolveAssistantFilePaths(
  input: AssistantResolveInput,
): Promise<AssistantResolveResult[]> {
  const cwd = input.cwd?.trim() ?? "";
  if (!cwd) {
    return input.candidates.map((candidate) => ({
      path: candidate,
      status: "missing",
      absolutePath: null,
      searchedRoots: [],
      modifiedAt: null,
    }));
  }

  const roots = await collectAssistantSearchRoots({ cwd, workspaceRoot: input.workspaceRoot });
  const allowlist = await outsideRootAllowlist();
  const fileListCache = new Map<string, RootFileIndex>();

  const isAllowed = (realPath: string): boolean => {
    if (roots.some((root) => isWithin(realPath, root))) return true;
    return allowlist.some((allowed) => realPath === allowed || isWithin(realPath, allowed));
  };

  const results: AssistantResolveResult[] = [];
  for (const candidate of input.candidates) {
    results.push(await resolveOneCandidate(candidate, roots, fileListCache, isAllowed));
  }
  return results;
}

async function resolveOneCandidate(
  candidate: string,
  roots: string[],
  fileListCache: Map<string, RootFileIndex>,
  isAllowed: (realPath: string) => boolean,
): Promise<AssistantResolveResult> {
  const missing = (): AssistantResolveResult => ({
    path: candidate,
    status: "missing",
    absolutePath: null,
    searchedRoots: roots,
    modifiedAt: null,
  });
  const found = (realPath: string, mtimeMs: number): AssistantResolveResult => ({
    path: candidate,
    status: "found",
    absolutePath: realPath,
    searchedRoots: roots,
    modifiedAt: new Date(mtimeMs).toISOString(),
  });

  if (isAbsoluteLike(candidate)) {
    const direct = await statFile(expandUserPath(candidate.trim()));
    if (direct && isAllowed(direct.realPath)) return found(direct.realPath, direct.mtimeMs);
    return missing();
  }

  const relative = candidate.trim().replace(/\\/g, "/");
  if (!relative || relative === "." || relative === "..") return missing();

  for (const root of roots) {
    const joined = resolvePathFromBase(root, relative);
    const hit = await statFile(joined);
    if (hit && isAllowed(hit.realPath)) return found(hit.realPath, hit.mtimeMs);
  }

  const suffixHits = await findSuffixHits(relative, roots, fileListCache, isAllowed);
  if (suffixHits.length > 0) {
    suffixHits.sort((left, right) => right.mtimeMs - left.mtimeMs);
    const newest = suffixHits[0];
    if (newest) return found(newest.realPath, newest.mtimeMs);
  }
  return missing();
}

async function findSuffixHits(
  relative: string,
  roots: string[],
  fileListCache: Map<string, RootFileIndex>,
  isAllowed: (realPath: string) => boolean,
): Promise<Array<{ realPath: string; mtimeMs: number }>> {
  const normalized = relative.replace(/^\.\//, "");
  const suffixes = [normalized];
  const slash = normalized.lastIndexOf("/");
  if (slash >= 0) suffixes.push(normalized.slice(slash + 1));

  const hits: Array<{ realPath: string; mtimeMs: number }> = [];
  const seen = new Set<string>();
  for (const root of roots) {
    const files = await listRootFiles(root, fileListCache);
    for (const file of files) {
      const rel = path.relative(root, file).split(path.sep).join("/");
      const matches = suffixes.some((suffix) => rel === suffix || rel.endsWith(`/${suffix}`));
      if (!matches) continue;
      if (seen.has(file)) continue;
      seen.add(file);
      const hit = await statFile(file);
      if (hit && isAllowed(hit.realPath)) {
        hits.push(hit);
        if (hits.length >= MAX_SUFFIX_HITS) return hits;
      }
    }
    if (hits.length >= MAX_SUFFIX_HITS) break;
  }
  return hits;
}
