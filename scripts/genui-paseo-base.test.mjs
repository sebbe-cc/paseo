// pa-9av7.5: genui Changes()/Commits()/PullRequest() measure against the
// workspace base Paseo reports and nothing else. The branch diff carries
// uncommitted tracked changes and untracked files. A stored base that no
// longer resolves falls back to the recorded fork point and says so; a
// ref:null base compares with its fork SHA. When Paseo reports no base, or
// the lookup fails, the reader returns unavailable instead of guessing
// another branch (no pa-kw2m-style fetch/default-branch resolver).
//
// Applies the repo's genui patch to the pinned paseo-plugin-genui@0.1.7
// tarball in a temp dir and runs the server's project reader against real
// git repositories: a bare origin, Seb's clone whose local main is far
// behind, and worktrees with their own commits.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const VERSION = "0.1.7";
const SHASUM = "cac6a928119583d0550372128b3416d46267242e";
const scratch = (name) => mkdtempSync(join(tmpdir(), `genui-base-${name}-`));

const buildPatchedCopy = () => {
  const dir = scratch("plugin");
  const pack = JSON.parse(
    execFileSync(
      "npm",
      ["pack", `paseo-plugin-genui@${VERSION}`, "--json", "--pack-destination", dir],
      { encoding: "utf8" },
    ),
  )[0];
  assert.equal(pack.shasum, SHASUM, "genui base must be the pinned tarball");
  const src = join(dir, "src");
  execFileSync("mkdir", ["-p", src]);
  execFileSync("tar", ["xzf", join(dir, pack.filename), "-C", src, "--strip-components=1"]);
  const packagePath = join(src, "package.json");
  const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
  packageJson.type = "module";
  writeFileSync(packagePath, JSON.stringify(packageJson, null, 2));
  execFileSync("git", ["apply", join(root, "patches/genui-paseo.patch")], { cwd: src });
  return src;
};

// Resolve the plugin's extensionless and directory TS imports like its bundler.
const hook = join(scratch("resolve"), "resolve.mjs");
writeFileSync(
  hook,
  `export async function resolve(specifier, context, nextResolve) {
		try {
			return await nextResolve(specifier, context);
		} catch (error) {
			const codes = ["ERR_MODULE_NOT_FOUND", "ERR_UNSUPPORTED_DIR_IMPORT"];
			if (!codes.includes(error?.code) || !specifier.startsWith(".")) throw error;
			for (const ext of [".ts", ".tsx", "/index.ts"]) {
				try {
					return await nextResolve(specifier + ext, context);
				} catch {}
			}
			throw error;
		}
	}
`,
);
register(pathToFileURL(hook));

let patchedSrc = null;
// A fresh module graph per test: the reader caches the workspace list and
// fetched bases per process, and fixtures must not see each other.
let loadSeq = 0;
const loadModules = async () => {
  patchedSrc ??= await buildPatchedCopy();
  const tag = `?t=${++loadSeq}`;
  const reader = await import(pathToFileURL(join(patchedSrc, "server", "project.ts")).href + tag);
  const shared = await import(
    pathToFileURL(join(patchedSrc, "shared", "core", "project.ts")).href + tag
  );
  return { ...reader, scopeLabel: shared.scopeLabel };
};

const env = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};
const git = (cwd, ...args) => execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();
const commit = (cwd, file, message) => {
  writeFileSync(join(cwd, file), `${message}\n`);
  git(cwd, "add", file);
  git(cwd, "commit", "-q", "-m", message);
};

/**
 * origin has 40 commits on main; Seb's clone saw only the first; the
 * worktree branches from the fetched origin/main and adds three.
 */
const setup = () => {
  const dir = scratch("repos");
  const origin = join(dir, "origin.git");
  git(dir, "init", "-q", "--bare", "-b", "main", origin);
  const upstream = join(dir, "upstream");
  git(dir, "clone", "-q", origin, upstream);
  commit(upstream, "a.txt", "upstream 0");
  git(upstream, "push", "-q", "origin", "main");
  const checkout = join(dir, "checkout");
  git(dir, "clone", "-q", origin, checkout);
  for (let i = 1; i < 40; i++) commit(upstream, "a.txt", `upstream ${i}`);
  git(upstream, "push", "-q", "origin", "main");
  git(checkout, "fetch", "-q", "origin");
  const forkPoint = git(checkout, "rev-parse", "origin/main");
  const worktree = join(dir, "wt");
  git(checkout, "worktree", "add", "-q", "-b", "wf/feature", worktree, "origin/main");
  for (let i = 1; i <= 3; i++) commit(worktree, `own-${i}.txt`, `own ${i}`);
  return { dir, origin, upstream, checkout, worktree, forkPoint };
};

const wsEntry = (id, workspaceDirectory, base) => ({
  id,
  title: id,
  workspaceKind: "worktree",
  projectKind: "git",
  projectId: "p1",
  workspaceDirectory,
  archivingAt: null,
  ...(base === undefined ? {} : { base }),
});

// resolveAgentWorkspace reads the agent once; a fresh id per checkout.
let agentSeq = 0;
const paseoAt = (cwd, entries = [], opts = {}) => ({
  agents: {
    ref: () => ({
      current: () => ({ cwd, workspaceId: opts.workspaceId ?? null }),
      refresh: async () => null,
    }),
    list: async () => ({ entries: [] }),
  },
  workspaces: {
    ...(opts.get ? { get: opts.get } : {}),
    list: opts.list ?? (async () => ({ entries })),
  },
});
const agent = () => `agent-base-${++agentSeq}`;

const getById = (entries) => async (id) => entries.find((e) => e.id === id) ?? null;

// A two-page listing; records every call so tests can assert the
// background-inclusive filter and cursor paging the reader must use.
const twoPages =
  (first, second, seen = []) =>
  async (options = {}) => {
    seen.push(options);
    const cursor = options.page?.cursor;
    if (cursor === undefined) {
      return {
        entries: first,
        pageInfo: { nextCursor: "page-2", prevCursor: null, hasMore: true },
      };
    }
    if (cursor === "page-2") {
      return {
        entries: second,
        pageInfo: { nextCursor: null, prevCursor: "page-1", hasMore: false },
      };
    }
    throw new Error(`unexpected cursor ${cursor}`);
  };

// A small local repo without remotes or upstream history.
const localRepo = () => {
  const dir = scratch("local");
  git(dir, "init", "-q", "-b", "main");
  commit(dir, "a.txt", "base");
  return dir;
};

// The daemon's base shape (pa-9av7 on 0.16): { ref, forkSha, missing }.
const storedBase = (ref, forkSha, missing = false) => ({ ref, forkSha, missing });

test("Commits() prefers the stored Paseo base over a stale local main", async () => {
  const { readProjectCommits } = await loadModules();
  const { checkout, worktree, forkPoint } = setup();
  assert.equal(
    git(checkout, "rev-list", "--count", "main..wf/feature"),
    "42",
    "local main is stale",
  );

  const result = await readProjectCommits(
    paseoAt(worktree, [
      wsEntry("ws1", worktree, storedBase("refs/remotes/origin/main", forkPoint)),
    ]),
    agent(),
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.base, "origin/main", "the header names the stored base");
  assert.equal(result.onBase, false);
  assert.equal(result.ahead, 3);
  assert.equal(result.behind, 0);
  assert.deepEqual(
    result.commits.map((c) => c.subject),
    ["own 3", "own 2", "own 1"],
  );
});

test("Commits() reads the stored base under gitRuntime.base too", async () => {
  const { readProjectCommits } = await loadModules();
  const { worktree, forkPoint } = setup();
  // Production daemons report the base under gitRuntime.base (where the
  // client's workspaceBaseOf reads it); a top-level base wins when both exist.
  const entry = {
    ...wsEntry("ws1b", worktree),
    gitRuntime: { base: storedBase("refs/remotes/origin/main", forkPoint) },
  };
  const result = await readProjectCommits(paseoAt(worktree, [entry]), agent());
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.base, "origin/main", "the nested stored base is honored");
  assert.equal(result.onBase, false);
  assert.equal(result.ahead, 3);
  assert.deepEqual(
    result.commits.map((c) => c.subject),
    ["own 3", "own 2", "own 1"],
  );
});

test("Commits() counts a local epic base as-is, never origin", async () => {
  const { readProjectCommits } = await loadModules();
  const { checkout } = setup();
  git(checkout, "switch", "-q", "-c", "epic-x");
  commit(checkout, "epic.txt", "epic work");
  const epicTip = git(checkout, "rev-parse", "epic-x");
  const item = join(checkout, "..", "item");
  git(checkout, "worktree", "add", "-q", "-b", "wf/item", item, "epic-x");
  commit(item, "item-1.txt", "item 1");
  commit(item, "item-2.txt", "item 2");

  const result = await readProjectCommits(
    paseoAt(item, [wsEntry("ws2", item, storedBase("refs/heads/epic-x", epicTip))]),
    agent(),
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.base, "epic-x", "the local epic base is used verbatim");
  assert.equal(result.onBase, false);
  assert.equal(result.ahead, 2, "origin/main history is not counted");
  assert.deepEqual(
    result.commits.map((c) => c.subject),
    ["item 2", "item 1"],
  );
});

test("a stored base that no longer resolves falls back to the fork point and says so", async () => {
  const { readProjectCommits, readProjectChanges } = await loadModules();
  const { checkout, origin } = setup();
  git(checkout, "switch", "-q", "-c", "gone-branch");
  commit(checkout, "gone.txt", "gone work");
  git(checkout, "push", "-q", "origin", "gone-branch");
  const forkSha = git(checkout, "rev-parse", "gone-branch");
  const wt = join(checkout, "..", "wt-gone");
  git(checkout, "worktree", "add", "-q", "-b", "wf/gone", wt, "origin/gone-branch");
  commit(wt, "own-gone.txt", "own on gone");
  execFileSync("git", ["--git-dir", origin, "branch", "-D", "gone-branch"], { env });
  git(wt, "fetch", "-q", "--prune", "origin");
  assert.throws(() => git(wt, "rev-parse", "--verify", "refs/remotes/origin/gone-branch"));

  const entries = [
    wsEntry("ws3", wt, storedBase("refs/remotes/origin/gone-branch", forkSha, true)),
  ];
  const commits = await readProjectCommits(paseoAt(wt, entries), agent());
  assert.equal(commits.ok, true, JSON.stringify(commits));
  assert.equal(commits.baseMissing, true, "the fallback is marked");
  assert.equal(commits.base, forkSha.slice(0, 7), "the header names the fork point");
  assert.deepEqual(
    commits.commits.map((c) => c.subject),
    ["own on gone"],
  );

  const changes = await readProjectChanges(paseoAt(wt, entries), agent(), null, null);
  assert.equal(changes.ok, true, JSON.stringify(changes));
  assert.equal(changes.scope.kind, "branch");
  assert.equal(changes.scope.baseMissing, true);
  assert.ok(
    (changes.scope.wantedBase ?? "").includes("gone-branch"),
    `the scope keeps the lost base: ${JSON.stringify(changes.scope)}`,
  );
  const { scopeLabel: labelOf } = await loadModules();
  const missingLabel = labelOf(changes.scope);
  assert.ok(
    missingLabel.includes("gone-branch") && missingLabel.includes("fork point"),
    `the label explains the fallback: ${missingLabel}`,
  );
  assert.deepEqual(
    changes.files.map((f) => f.path).sort(),
    ["own-gone.txt"],
    "only work since the fork point shows; the lost branch's own files are the base",
  );
});

test("Changes() carries uncommitted tracked changes and untracked files", async () => {
  const { readProjectChanges, scopeLabel: labelOf } = await loadModules();
  const { worktree, forkPoint } = setup();
  writeFileSync(join(worktree, "own-1.txt"), "changed\n");
  writeFileSync(join(worktree, "scratch-note.txt"), "note\n");

  const result = await readProjectChanges(
    paseoAt(worktree, [
      wsEntry("ws4", worktree, storedBase("refs/remotes/origin/main", forkPoint)),
    ]),
    agent(),
    null,
    null,
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.scope.kind, "branch");
  assert.equal(result.scope.base, "origin/main");
  assert.equal(
    labelOf(result.scope),
    "wf/feature vs origin/main, incl. uncommitted",
    "the label stays truthful now that the diff carries the worktree",
  );
  const byPath = new Map(result.files.map((f) => [f.path, f]));
  assert.deepEqual([...byPath.keys()].sort(), [
    "own-1.txt",
    "own-2.txt",
    "own-3.txt",
    "scratch-note.txt",
  ]);
  assert.equal(byPath.get("scratch-note.txt").untracked, true, "the new file is marked untracked");
  assert.equal(byPath.get("own-1.txt").untracked, false);
  const patch = result.patches.find((p) => p.path === "scratch-note.txt");
  assert.ok(patch && patch.patch.includes("+note"), "the untracked file has a patch");
});

test("a workspace without a reported base is unavailable, not another branch", async () => {
  const { readProjectCommits } = await loadModules();
  const { worktree } = setup();

  const result = await readProjectCommits(paseoAt(worktree, [wsEntry("ws5", worktree)]), agent());
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.reason, "unavailable");
  assert.match(result.message, /no base/i, "the message names the missing base");
});

test("a failed workspace lookup is unavailable, not another branch", async () => {
  const { readProjectCommits } = await loadModules();
  const { worktree, forkPoint } = setup();
  const entries = [wsEntry("ws5b", worktree, storedBase("refs/remotes/origin/main", forkPoint))];
  const list = async () => {
    throw new Error("daemon unreachable");
  };

  const result = await readProjectCommits(paseoAt(worktree, entries, { list }), agent());
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.reason, "unavailable");
});

test("a daemon-reported default base marks its own checkout on-base", async () => {
  const { readProjectCommits } = await loadModules();
  const { checkout } = setup();
  const base = {
    ...storedBase("refs/remotes/origin/main", git(checkout, "rev-parse", "origin/main")),
  };
  const result = await readProjectCommits(
    paseoAt(checkout, [wsEntry("ws6", checkout, base)]),
    agent(),
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.base, "origin/main");
  assert.equal(result.onBase, true);
});

test("a stored local base needs no remote", async () => {
  const { readProjectCommits } = await loadModules();
  const dir = localRepo();
  git(dir, "switch", "-q", "-c", "topic");
  commit(dir, "b.txt", "topic 1");
  const forkSha = git(dir, "rev-parse", "main");

  const result = await readProjectCommits(
    paseoAt(dir, [wsEntry("ws7", dir, storedBase("refs/heads/main", forkSha))]),
    agent(),
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.base, "main");
  assert.equal(result.ahead, 1);
});

test("an existing base without a known fork point still compares against the ref", async () => {
  const { readProjectCommits } = await loadModules();
  const dir = localRepo();
  git(dir, "switch", "-q", "-c", "topic");
  commit(dir, "b.txt", "topic 1");

  const result = await readProjectCommits(
    paseoAt(dir, [wsEntry("ws7b", dir, storedBase("refs/heads/main", null))]),
    agent(),
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.base, "main");
  assert.equal(result.ahead, 1);
});

test("a missing base without a known fork point is unavailable", async () => {
  const { readProjectCommits } = await loadModules();
  const dir = localRepo();
  git(dir, "switch", "-q", "-c", "topic");
  commit(dir, "b.txt", "topic 1");

  const result = await readProjectCommits(
    paseoAt(dir, [wsEntry("ws7c", dir, storedBase("refs/heads/gone", null, true))]),
    agent(),
  );
  assert.equal(result.ok, false, JSON.stringify(result));
});

test("the owning workspace resolves by id through get", async () => {
  const { readProjectCommits } = await loadModules();
  const { worktree, forkPoint } = setup();
  const entries = [wsEntry("ws-get", worktree, storedBase("refs/remotes/origin/main", forkPoint))];
  // The listing is empty on purpose: the base must come from get(ws-get).
  const get = getById(entries);
  const list = async () => ({ entries: [] });

  const result = await readProjectCommits(
    paseoAt(worktree, entries, { workspaceId: "ws-get", get, list }),
    agent(),
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.base, "origin/main");
  assert.equal(result.ahead, 3);
  assert.deepEqual(
    result.commits.map((c) => c.subject),
    ["own 3", "own 2", "own 1"],
  );
});

test("the owning workspace resolves beyond the first list page", async () => {
  const { readProjectCommits } = await loadModules();
  const dir = localRepo();
  git(dir, "switch", "-q", "-c", "epic-x");
  commit(dir, "epic.txt", "epic work");
  const epicTip = git(dir, "rev-parse", "epic-x");
  const item = join(dir, "item");
  git(dir, "worktree", "add", "-q", "-b", "wf/item", item, "epic-x");
  commit(item, "item-1.txt", "item 1");
  const owning = wsEntry("ws-page2", item, storedBase("refs/heads/epic-x", epicTip));
  const seen = [];
  const list = twoPages([wsEntry("ws-other", join(dir, "elsewhere"))], [owning], seen);

  const result = await readProjectCommits(paseoAt(item, [], { list }), agent());
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.base, "epic-x", "the page-two local base wins over origin");
  assert.equal(result.ahead, 1);
  assert.deepEqual(
    result.commits.map((c) => c.subject),
    ["item 1"],
  );
  assert.equal(seen.length, 2, "both pages are read");
  assert.equal(seen[0].filter?.includeBackground, true, "the listing is background-inclusive");
});

test("a host rejecting the background filter still resolves plainly", async () => {
  const { readProjectCommits } = await loadModules();
  const { worktree, forkPoint } = setup();
  const entries = [
    wsEntry("ws-plain", worktree, storedBase("refs/remotes/origin/main", forkPoint)),
  ];
  const list = async (options = {}) => {
    if (options.filter !== undefined) throw new Error("unknown filter");
    return { entries };
  };

  const result = await readProjectCommits(paseoAt(worktree, entries, { list }), agent());
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.base, "origin/main");
  assert.equal(result.ahead, 3);
});

test("a slash-containing local base keeps its namespace", async () => {
  const { readProjectCommits } = await loadModules();
  const dir = localRepo();
  git(dir, "switch", "-q", "-c", "feature/epic");
  commit(dir, "epic.txt", "epic work");
  const epicTip = git(dir, "rev-parse", "feature/epic");
  const item = join(dir, "item");
  git(dir, "worktree", "add", "-q", "-b", "wf/item", item, "feature/epic");
  commit(item, "item-1.txt", "item 1");
  commit(item, "item-2.txt", "item 2");

  const result = await readProjectCommits(
    paseoAt(item, [wsEntry("ws-slash", item, storedBase("refs/heads/feature/epic", epicTip))]),
    agent(),
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.base, "feature/epic", "no namespace component is dropped");
  assert.equal(result.onBase, false);
  assert.equal(result.ahead, 2);
  assert.deepEqual(
    result.commits.map((c) => c.subject),
    ["item 2", "item 1"],
  );
});

test("a branch matching only the base suffix is not on-base", async () => {
  const { readProjectChanges, readProjectCommits } = await loadModules();
  const dir = localRepo();
  git(dir, "switch", "-q", "-c", "feature/epic");
  commit(dir, "epic.txt", "epic work");
  const epicTip = git(dir, "rev-parse", "feature/epic");
  git(dir, "switch", "-q", "-c", "epic", "main");
  commit(dir, "own-a.txt", "own a");
  commit(dir, "own-b.txt", "own b");
  const entries = [wsEntry("ws-suffix", dir, storedBase("refs/heads/feature/epic", epicTip))];

  const commits = await readProjectCommits(paseoAt(dir, entries), agent());
  assert.equal(commits.ok, true, JSON.stringify(commits));
  assert.equal(commits.base, "feature/epic");
  assert.equal(commits.onBase, false, "epic is not feature/epic");
  assert.deepEqual(
    commits.commits.map((c) => c.subject),
    ["own b", "own a"],
  );

  const changes = await readProjectChanges(paseoAt(dir, entries), agent(), null, null);
  assert.equal(changes.ok, true, JSON.stringify(changes));
  assert.equal(changes.scope.kind, "branch");
  assert.equal(changes.scope.onBase, false, "committed work stays visible");
  assert.deepEqual(
    changes.files.map((f) => f.path).sort(),
    // epic.txt lives on the sibling base branch, never in this worktree.
    ["own-a.txt", "own-b.txt"],
  );
});

test("a checkout on a slash-containing local base is on-base", async () => {
  const { readProjectCommits } = await loadModules();
  const dir = localRepo();
  git(dir, "switch", "-q", "-c", "feature/epic");
  commit(dir, "epic.txt", "epic work");
  const epicTip = git(dir, "rev-parse", "feature/epic");

  const result = await readProjectCommits(
    paseoAt(dir, [wsEntry("ws-slash-on", dir, storedBase("refs/heads/feature/epic", epicTip))]),
    agent(),
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.base, "feature/epic");
  assert.equal(result.onBase, true);
});

test("a ref:null base compares with its fork SHA", async () => {
  const { readProjectChanges, readProjectCommits } = await loadModules();
  const { worktree } = setup();
  const forkSha = git(worktree, "rev-parse", "HEAD~1");
  const entry = {
    ...wsEntry("ws-raw", worktree),
    gitRuntime: { base: { ref: null, forkSha, missing: false } },
  };

  const commits = await readProjectCommits(paseoAt(worktree, [entry]), agent());
  assert.equal(commits.ok, true, JSON.stringify(commits));
  assert.equal(commits.base, forkSha.slice(0, 7), "the header names the fork point");
  assert.deepEqual(
    commits.commits.map((c) => c.subject),
    ["own 3"],
  );

  const changes = await readProjectChanges(paseoAt(worktree, [entry]), agent(), null, null);
  assert.equal(changes.ok, true, JSON.stringify(changes));
  assert.deepEqual(changes.files.map((f) => f.path).sort(), ["own-3.txt"]);
});

test("an untracked symlink renders its target path, not target contents", async () => {
  const { readProjectChanges } = await loadModules();
  const { dir, worktree, forkPoint } = setup();
  const secret = join(dir, "secret-outside.txt");
  writeFileSync(secret, "private outside contents\n");
  const link = join(worktree, "leak-link");
  symlinkSync(secret, link);

  const result = await readProjectChanges(
    paseoAt(worktree, [
      wsEntry("ws-link", worktree, storedBase("refs/remotes/origin/main", forkPoint)),
    ]),
    agent(),
    null,
    null,
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  const byPath = new Map(result.files.map((f) => [f.path, f]));
  assert.equal(byPath.get("leak-link")?.untracked, true, "the link itself is listed");
  const patch = result.patches.find((p) => p.path === "leak-link");
  assert.ok(patch, "the link has a patch");
  assert.ok(
    !patch.patch.includes("private outside contents"),
    "target contents never leak into the patch",
  );
  assert.ok(patch.patch.includes(secret), "the patch records the link target path");
});

test("a missing base matching the branch name still measures from forkSha", async () => {
  const { readProjectChanges, readProjectCommits } = await loadModules();
  const dir = localRepo();
  const forkSha = git(dir, "rev-parse", "main");
  commit(dir, "own-1.txt", "own 1");
  commit(dir, "own-2.txt", "own 2");
  // refs/remotes/origin/main does not exist here, so the stored base is
  // missing while the checkout sits on main, its short name.
  const entries = [
    wsEntry("ws-missing-main", dir, storedBase("refs/remotes/origin/main", forkSha, true)),
  ];

  const commits = await readProjectCommits(paseoAt(dir, entries), agent());
  assert.equal(commits.ok, true, JSON.stringify(commits));
  assert.equal(commits.baseMissing, true);
  assert.equal(commits.onBase, false, "a missing ref is never on-base");
  assert.deepEqual(
    commits.commits.map((c) => c.subject),
    ["own 2", "own 1"],
  );

  const changes = await readProjectChanges(paseoAt(dir, entries), agent(), null, null);
  assert.equal(changes.ok, true, JSON.stringify(changes));
  assert.equal(changes.scope.onBase, false);
  assert.deepEqual(changes.files.map((f) => f.path).sort(), ["own-1.txt", "own-2.txt"]);
});

test("an untracked filename keeps its surrounding whitespace", async () => {
  const { readProjectChanges } = await loadModules();
  const { worktree, forkPoint } = setup();
  const name = " note.txt ";
  writeFileSync(join(worktree, name), "spaced out\n");

  const result = await readProjectChanges(
    paseoAt(worktree, [
      wsEntry("ws-space", worktree, storedBase("refs/remotes/origin/main", forkPoint)),
    ]),
    agent(),
    null,
    null,
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  const byPath = new Map(result.files.map((f) => [f.path, f]));
  assert.equal(byPath.get(name)?.untracked, true, "the exact filename is listed");
  const patch = result.patches.find((p) => p.path === name);
  assert.ok(patch && patch.patch.includes("+spaced out"), "its contents are shown");
});
