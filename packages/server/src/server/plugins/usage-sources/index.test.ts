import { expect, test } from "vitest";
import { UsageSourceRegistry } from "./index.js";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discoverSession as discoverCursorSession,
  fetchUsage as fetchCursorUsage,
} from "../../../../../../plugins/cursor-usage-source/server/usage.js";
import { inputSchema as cursorInputSchema } from "../../../../../../plugins/cursor-usage-source/shared/input.js";

test("#7142: host usage retains distinct Cursor accounts after their individual details are read", async () => {
  const root = await mkdtemp(join(tmpdir(), "cursor-accounts-"));
  try {
    const sessions = new Map<
      string,
      { provider: string; sessionKey: string; env: Record<string, string> }
    >();
    const spends = new Map<string, number>();
    for (const [agentId, account, spend] of [
      ["a", "user-a", 100],
      ["b", "user-b", 200],
      ["a-copy", "user-a", 100],
    ] as const) {
      const configHome = join(root, agentId);
      const token = `e30.${Buffer.from(JSON.stringify({ sub: account, nonce: agentId })).toString("base64url")}.signature`;
      await mkdir(join(configHome, "cursor"), { recursive: true });
      await writeFile(
        join(configHome, "cursor", "auth.json"),
        JSON.stringify({ accessToken: token }),
      );
      spends.set(`Bearer ${token}`, spend);
      sessions.set(agentId, {
        provider: "cursor",
        sessionKey: agentId,
        env: { XDG_CONFIG_HOME: configHome },
      });
    }
    const registry = new UsageSourceRegistry(Date.now, 300_000, undefined, {
      hasAgent: (id) => sessions.has(id),
      usageSession: (id) => sessions.get(id) ?? null,
    });
    const fetchApi: typeof fetch = async (_url, init) => {
      const authorization = new Headers(init?.headers).get("Authorization") ?? "";
      const spend = spends.get(authorization);
      if (spend === undefined) throw new Error("Unexpected fixture login");
      return new Response(JSON.stringify({ planUsage: { totalSpend: spend, limit: 1000 } }));
    };
    registry.register({
      id: "cursor",
      label: "Cursor",
      discover: (scope) =>
        scope.kind === "session" ? discoverCursorSession(scope, "linux") : Promise.resolve([]),
      fetch: (input) => fetchCursorUsage(cursorInputSchema.parse(input), fetchApi),
    });
    const spent = (reports: Awaited<ReturnType<typeof registry.listReports>>) =>
      reports.map((entry) => {
        if (entry.report.status !== "available")
          throw new Error("Expected available fixture usage");
        return entry.report.balances?.[0]?.used;
      });
    expect(spent(await registry.listReports({ agentId: "a" }))).toEqual([1]);
    expect(spent(await registry.listReports({ agentId: "b" }))).toEqual([2]);
    expect(spent(await registry.listReports({ agentId: "a-copy" }))).toEqual([1]);
    expect(spent(await registry.listReports())).toEqual([1, 2]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function source(input: {
  id: string;
  discover?: () => Promise<Array<{ key: string; label?: string; input: unknown }>>;
  fetch?: (value: unknown) => Promise<unknown>;
}) {
  return {
    id: input.id,
    label: input.id,
    discover: input.discover ?? (async () => []),
    fetch: input.fetch ?? (async () => ({ status: "available", windows: [] })),
  };
}

test("discovery preserves account IDs and updates input after token rotation", async () => {
  const registry = new UsageSourceRegistry();
  let token = "old";
  registry.register(
    source({
      id: "codex",
      discover: async () => [{ key: "work", input: { token } }],
      fetch: async (input) => ({
        status: "available",
        windows: [{ id: "token", label: (input as { token: string }).token }],
      }),
    }),
  );
  const first = await registry.listReports();
  expect(first.map((entry) => entry.id)).toEqual(["codex:work"]);
  expect(first[0]?.report.windows[0]?.label).toBe("old");
  token = "new";
  const refreshed = await registry.listReports({ forceRefresh: true });
  expect(refreshed.map((entry) => entry.id)).toEqual(["codex:work"]);
  expect(refreshed[0]?.report.windows[0]?.label).toBe("new");
});

test("coalesces per account, caches errors, and refreshes only requested IDs", async () => {
  let now = 0;
  const counts = new Map<string, number>();
  const registry = new UsageSourceRegistry(() => now);
  registry.register(
    source({
      id: "source",
      discover: async () => ["a", "b"].map((account) => ({ key: account, input: { account } })),
      fetch: async (input) => {
        const account = (input as { account: string }).account;
        counts.set(account, (counts.get(account) ?? 0) + 1);
        if (account === "b") throw new Error("failed");
        return { status: "available", windows: [] };
      },
    }),
  );
  const first = await registry.listReports();
  expect(first.map((entry) => entry.id)).toEqual(["source:a", "source:b"]);
  expect(first[1]?.report.status).toBe("error");
  expect(await registry.listReports()).toEqual(first);
  expect(counts.get("a")).toBe(1);
  expect(counts.get("b")).toBe(1);
  now = 1000;
  const refreshed = await registry.listReports({
    reportIds: ["source:a", "missing:id"],
    forceRefresh: true,
  });
  expect(refreshed.map((entry) => entry.id)).toEqual(["source:a"]);
  expect(refreshed[0]?.fetchedAt).not.toBe(first[0]?.fetchedAt);
  expect(counts.get("a")).toBe(2);
  expect(counts.get("b")).toBe(1);
  now = 301_001;
  await registry.listReports({ reportIds: ["source:a"] });
  expect(counts.get("a")).toBe(3);
});

test("legacy listing uses oldest fetchedAt", async () => {
  let now = 1000;
  const registry = new UsageSourceRegistry(() => now);
  registry.register(
    source({
      id: "source",
      discover: async () => ["a", "b"].map((account) => ({ key: account, input: { account } })),
    }),
  );
  await registry.listReports();
  now = 2000;
  await registry.listReports({ reportIds: ["source:b"], forceRefresh: true });
  expect((await registry.listLegacyUsage()).fetchedAt).toBe(new Date(1000).toISOString());
});

test("concurrent requests for the same ID share one vendor fetch", async () => {
  let finish!: (report: unknown) => void;
  const response = new Promise<unknown>((resolve) => {
    finish = resolve;
  });
  let fetches = 0;
  const registry = new UsageSourceRegistry();
  registry.register(
    source({
      id: "coalesced",
      discover: async () => [{ key: "one", input: {} }],
      fetch: async () => {
        fetches++;
        return response;
      },
    }),
  );
  const first = registry.listReports();
  const second = registry.listReports();
  finish({ status: "available", windows: [] });
  const [one, two] = await Promise.all([first, second]);
  expect(one[0]).toBe(two[0]);
  expect(fetches).toBe(1);
});

test("rediscovery removes an old account from targeted refreshes", async () => {
  let now = 0;
  const registry = new UsageSourceRegistry(() => now, 100);
  let account = "old";
  registry.register(source({ id: "source", discover: async () => [{ key: account, input: {} }] }));
  await registry.listReports();
  await registry.listReports({ reportIds: ["source:old"] });
  now = 101;
  account = "new";
  await registry.listReports();
  await registry.listReports({ reportIds: ["source:new"] });
  expect(await registry.listReports({ reportIds: ["source:old"] })).toEqual([]);
});

test("discovery failures log once while other sources still report", async () => {
  const warnings: unknown[][] = [];
  const registry = new UsageSourceRegistry(Date.now, 300_000, {
    warn: (...args: unknown[]) => {
      warnings.push(args);
    },
  });
  const err = new Error("subprocess stopped");
  registry.register(
    source({
      id: "kimi",
      discover: async () => {
        throw err;
      },
    }),
  );
  registry.register(source({ id: "healthy", discover: async () => [{ key: "one", input: {} }] }));
  const updates: string[] = [];
  const reports = await registry.listReports({ onReport: (report) => updates.push(report.id) });
  expect(reports.map((report) => report.id)).toEqual(["healthy:one"]);
  expect(updates).toEqual(["healthy:one"]);
  expect(warnings).toEqual([[{ sourceId: "kimi", err }, "Usage source discovery failed"]]);
});

test("a failed fetch is logged as well as reported", async () => {
  const warnings: unknown[][] = [];
  const registry = new UsageSourceRegistry(Date.now, 300_000, {
    warn: (...args: unknown[]) => {
      warnings.push(args);
    },
  });
  const err = new Error("Rate limited by Claude. Try again in 38m.");
  registry.register(
    source({
      id: "claude",
      discover: async () => [{ key: "work", input: {} }],
      fetch: async () => {
        throw err;
      },
    }),
  );
  const [report] = await registry.listReports();
  expect(report?.report).toEqual({ status: "error", error: err.message });
  expect(warnings).toEqual([[{ sourceId: "claude", err }, "Usage fetch failed"]]);
});

test("legacy listing distinguishes labeled accounts and preserves unlabeled names", async () => {
  const registry = new UsageSourceRegistry(() => 1000);
  registry.register(
    source({
      id: "claude",
      discover: async () =>
        ["work", "personal", "default"].map((key) => ({
          key,
          label: key === "default" ? undefined : key,
          input: {},
        })),
    }),
  );
  expect(
    (await registry.listLegacyUsage()).providers.map((provider) => provider.displayName),
  ).toEqual(["claude (work)", "claude (personal)", "claude"]);
});

test("duplicate logins prefer discovery order across unavailable, error and thrown fetches", async () => {
  for (const failure of ["unavailable", "error", "throw"]) {
    const registry = new UsageSourceRegistry();
    const calls: number[] = [];
    registry.register(
      source({
        id: "codex",
        discover: async () => [0, 1, 2].map((input) => ({ key: "same", input })),
        fetch: async (input) => {
          calls.push(Number(input));
          if (input === 0) {
            if (failure === "throw") throw new Error("revoked");
            return failure === "unavailable"
              ? { status: failure, problem: { kind: "rejected", status: 401 } }
              : { status: failure, error: "revoked" };
          }
          return {
            status: "available",
            windows: [{ id: "session", label: "Session", usedPct: 42 }],
          };
        },
      }),
    );
    const reports = await registry.listReports();
    expect(reports).toHaveLength(1);
    expect(reports[0]?.report.status).toBe("available");
    expect(calls).toEqual([0, 1, 2]);
  }
});

test("targeted refresh re-reads the login without discovering again", async () => {
  let discoveries = 0;
  let value = "old";
  const registry = new UsageSourceRegistry();
  registry.register(
    source({
      id: "source",
      discover: async () => {
        discoveries++;
        return [{ key: "original", input: {} }];
      },
      fetch: async () => ({ status: "available", windows: [{ id: "session", label: value }] }),
    }),
  );
  await registry.listReports();
  value = "new";
  const reports = await registry.listReports({
    reportIds: ["source:original"],
    forceRefresh: true,
  });
  expect(reports[0]?.report).toEqual({
    status: "available",
    windows: [{ id: "session", label: "new" }],
  });
  expect(discoveries).toBe(1);
});

test("a thrown fetch is an error card", async () => {
  const registry = new UsageSourceRegistry();
  registry.register(
    source({
      id: "source",
      discover: async () => [{ key: "one", input: {} }],
      fetch: async () => {
        throw new Error("Store deleted");
      },
    }),
  );
  expect((await registry.listReports())[0]?.report).toEqual({
    status: "error",
    error: "Store deleted",
  });
});

test("an unavailable login falls back to the next available login", async () => {
  const calls: unknown[] = [];
  const registry = new UsageSourceRegistry();
  registry.register(
    source({
      id: "source",
      discover: async () => [1, 2].map((input) => ({ key: "same", input })),
      fetch: async (input) => {
        calls.push(input);
        return input === 1
          ? {
              status: "unavailable",
              problem: { kind: "expired", expiresAt: "1970-01-01T00:00:00.000Z" },
            }
          : { status: "available", windows: [] };
      },
    }),
  );
  expect(
    (await registry.listReports()).map((entry) => ({ id: entry.id, report: entry.report })),
  ).toEqual([{ id: "source:same", report: { status: "available", windows: [] } }]);
  expect(calls).toEqual([1, 2]);
});

test("failed fallbacks preserve the final problem", async () => {
  const registry = new UsageSourceRegistry();
  registry.register(
    source({
      id: "source",
      discover: async () => [1, 2].map((input) => ({ key: "same", input })),
      fetch: async (input) => ({
        status: "unavailable",
        problem: { kind: "rejected", status: input === 1 ? 401 : 403 },
      }),
    }),
  );
  expect((await registry.listReports())[0]?.report).toEqual({
    status: "unavailable",
    problem: { kind: "rejected", status: 403 },
  });
});

test("session discovery reuses accounts, separates launches, and retains live agent reports globally", async () => {
  const sessions = new Map([
    ["one", { provider: "claude", env: { HOME: "/one" }, sessionKey: "launch-1" }],
    ["two", { provider: "claude", env: { HOME: "/two" }, sessionKey: "launch-2" }],
  ]);
  const existing = new Set(["one", "two", "closed"]);
  const discoveries: string[] = [];
  let fetches = 0;
  const registry = new UsageSourceRegistry(Date.now, 300_000, undefined, {
    hasAgent: (id) => existing.has(id),
    usageSession: (id) => sessions.get(id) ?? null,
  });
  registry.register({
    id: "claude",
    label: "Claude",
    discover: async (scope) => {
      discoveries.push(scope.kind === "global" ? "global" : scope.env.HOME);
      if (scope.kind === "global") return [{ key: "default", input: "default" }];
      return [{ key: scope.env.HOME === "/new" ? "new" : "same", input: scope.env.HOME }];
    },
    fetch: async () => {
      fetches++;
      return { status: "available", windows: [] };
    },
  });
  expect(await registry.listReports({ agentId: "closed" })).toEqual([]);
  expect((await registry.listReports({ agentId: "one" })).map((r) => r.id)).toEqual([
    "claude:same",
  ]);
  await registry.listReports({ agentId: "one" });
  await registry.listReports({ agentId: "two" });
  expect(discoveries).toEqual(["/one", "/two"]);
  expect(fetches).toBe(2);
  expect((await registry.listReports()).map((r) => r.id)).toEqual([
    "claude:default",
    "claude:same",
  ]);
  sessions.set("one", { provider: "claude", env: { HOME: "/new" }, sessionKey: "launch-3" });
  expect((await registry.listReports({ agentId: "one" })).map((r) => r.id)).toEqual(["claude:new"]);
  existing.delete("two");
  sessions.delete("two");
  expect((await registry.listReports()).map((r) => r.id)).toEqual(["claude:default", "claude:new"]);
  await expect(registry.listReports({ agentId: "missing" })).rejects.toThrow("Unknown agent");
  await expect(registry.listReports({ agentId: "one", reportIds: [] })).rejects.toThrow("agentId");
});

test("reports arrive independently and a hung fetch settles as an error before completion", async () => {
  const registry = new UsageSourceRegistry(Date.now, 300_000, undefined, undefined, 25);
  let finishSlow!: (value: unknown) => void;
  const slow = new Promise<unknown>((resolve) => {
    finishSlow = resolve;
  });
  const reports: string[] = [];
  let firstReport!: () => void;
  const first = new Promise<void>((resolve) => {
    firstReport = resolve;
  });
  for (const id of ["slow", "fast", "also-fast"]) {
    registry.register(
      source({
        id,
        discover: async () => [{ key: "account", input: {} }],
        fetch: async () => (id === "slow" ? slow : { status: "available", windows: [] }),
      }),
    );
  }
  let complete = false;
  const request = registry
    .listReports({
      onReport: (entry) => {
        reports.push(entry.id);
        firstReport();
      },
    })
    .then((entries) => {
      complete = true;
      return entries;
    });
  await first;
  expect(reports).toEqual(["fast:account", "also-fast:account"]);
  expect(complete).toBe(false);
  const entries = await request;
  expect(reports).toEqual(["fast:account", "also-fast:account", "slow:account"]);
  expect(entries[0]?.report).toEqual({ status: "error", error: "Usage fetch timed out" });
  finishSlow({ status: "available", windows: [] });
  expect((await registry.listReports({ reportIds: ["slow:account"] }))[0]?.report).toEqual(
    entries[0]?.report,
  );
});

test("#6155: agent reports use only their session login despite host and sibling discoveries", async () => {
  const sessions = new Map([
    ["codex-agent", { provider: "codex", env: {}, sessionKey: "codex-launch" }],
    ["opencode-agent", { provider: "opencode", env: {}, sessionKey: "opencode-launch" }],
  ]);
  const registry = new UsageSourceRegistry(Date.now, 300_000, undefined, {
    hasAgent: (id) => sessions.has(id),
    usageSession: (id) => sessions.get(id) ?? null,
  });
  const codexError = { status: "error", error: "Codex usage API returned 500" };
  const expired = {
    status: "unavailable",
    problem: { kind: "expired", expiresAt: "2026-07-07T00:00:00.000Z", refreshedBy: "opencode" },
  };
  registry.register({
    id: "codex",
    label: "Codex",
    discover: async (scope) =>
      (scope.kind === "global" ? ["codex", "opencode"] : [scope.provider]).map((harness) => ({
        key: "same",
        harness,
        input: { harness },
      })),
    fetch: async (input) =>
      (input as { harness: string }).harness === "codex" ? codexError : expired,
  });
  await registry.listReports();
  await registry.listReports({ agentId: "opencode-agent" });
  expect((await registry.listReports({ agentId: "codex-agent" }))[0]?.report).toEqual(codexError);
});

test("all failed host logins retain each source-supplied harness and remedy", async () => {
  const registry = new UsageSourceRegistry();
  const failures = [
    { status: "error", error: "Codex usage API returned 500" },
    {
      status: "unavailable",
      problem: { kind: "expired", expiresAt: "2026-07-07T00:00:00.000Z", refreshedBy: "opencode" },
    },
    { status: "unavailable", problem: { kind: "rejected", status: 401, refreshedBy: "pi" } },
    { status: "unavailable", problem: { kind: "rejected", status: 403, refreshedBy: "omp" } },
  ];
  const harnesses = ["Codex", "OpenCode", "Pi", "OMP"];
  registry.register(
    source({
      id: "codex",
      discover: async () => harnesses.map((harness, input) => ({ key: "same", harness, input })),
      fetch: async (input) => failures[Number(input)],
    }),
  );
  const [entry] = await registry.listReports();
  expect(entry?.loginErrors).toEqual(
    harnesses.map((harness, index) => ({ harness, report: failures[index] })),
  );
});

test("a working agent login never uses another harness's failure or host fallback cache", async () => {
  const sessions = new Map([
    ["working", { provider: "codex", env: {}, sessionKey: "one" }],
    ["broken", { provider: "opencode", env: {}, sessionKey: "two" }],
  ]);
  const registry = new UsageSourceRegistry(Date.now, 300_000, undefined, {
    hasAgent: (id) => sessions.has(id),
    usageSession: (id) => sessions.get(id) ?? null,
  });
  const available = {
    status: "available",
    windows: [{ id: "weekly", label: "Weekly", usedPct: 31 }],
  };
  const error = { status: "error", error: "OpenCode login rejected. Run opencode to refresh it." };
  registry.register({
    id: "codex",
    label: "Codex",
    discover: async (scope) =>
      (scope.kind === "global" ? ["opencode", "codex"] : [scope.provider]).map((harness) => ({
        key: "same",
        harness,
        input: harness,
      })),
    fetch: async (input) => (input === "codex" ? available : error),
  });
  const [host] = await registry.listReports();
  expect(host?.report).toEqual(available);
  expect(host?.loginErrors).toBeUndefined();
  expect((await registry.listReports({ agentId: "working" }))[0]?.report).toEqual(available);
  expect((await registry.listReports({ agentId: "broken" }))[0]?.report).toEqual(error);
  expect(
    (await registry.listReports({ agentId: "broken", forceRefresh: true }))[0]?.report,
  ).toEqual(error);
  expect(
    (await registry.listReports({ reportIds: ["codex:same"], forceRefresh: true }))[0]?.report,
  ).toEqual(available);
});

test("concurrent host and agent requests never share a different login's pending fetch", async () => {
  let finish!: (report: unknown) => void;
  const slow = new Promise<unknown>((resolve) => {
    finish = resolve;
  });
  const registry = new UsageSourceRegistry(Date.now, 300_000, undefined, {
    hasAgent: () => true,
    usageSession: () => ({ provider: "codex", env: {}, sessionKey: "launch" }),
  });
  registry.register({
    id: "codex",
    label: "Codex",
    discover: async (scope) => [{ key: "same", harness: "Codex", input: scope.kind }],
    fetch: async (input) =>
      input === "global" ? slow : { status: "error", error: "Session login failed" },
  });
  const host = registry.listReports();
  const [agent] = await registry.listReports({ agentId: "agent" });
  expect(agent?.report).toEqual({ status: "error", error: "Session login failed" });
  finish({ status: "available", windows: [] });
  expect((await host)[0]?.report.status).toBe("available");
});

test("duplicate logins across scopes appear only once in the host's errors", async () => {
  const registry = new UsageSourceRegistry(Date.now, 300_000, undefined, {
    hasAgent: () => true,
    usageSession: () => ({ provider: "codex", env: {}, sessionKey: "launch" }),
  });
  registry.register({
    id: "codex",
    label: "Codex",
    discover: async (scope) => [
      {
        key: "same",
        harness: "Codex",
        input:
          scope.kind === "global"
            ? { path: "/auth", kind: "file" }
            : { kind: "file", path: "/auth" },
      },
    ],
    fetch: async () => ({ status: "error", error: "Login failed" }),
  });
  await registry.listReports({ agentId: "agent" });
  expect((await registry.listReports())[0]?.loginErrors).toEqual([
    { harness: "Codex", report: { status: "error", error: "Login failed" } },
  ]);
});

test("a hung login records its own timeout and still tries the next login", async () => {
  const registry = new UsageSourceRegistry(Date.now, 300_000, undefined, undefined, 25);
  registry.register({
    id: "codex",
    label: "Codex",
    discover: async () => [
      { key: "same", harness: "Codex", input: 0 },
      { key: "same", harness: "OpenCode", input: 1 },
    ],
    fetch: async (input) =>
      input === 0 ? new Promise(() => {}) : { status: "error", error: "Login rejected" },
  });
  expect((await registry.listReports())[0]?.loginErrors).toEqual([
    { harness: "Codex", report: { status: "error", error: "Usage fetch timed out" } },
    { harness: "OpenCode", report: { status: "error", error: "Login rejected" } },
  ]);
});

test("retains the last successful poll across failures, cache expiry, and recovery", async () => {
  let now = 0;
  let report: unknown = {
    status: "available",
    windows: [{ id: "week", label: "Weekly", usedPct: 42 }],
  };
  const registry = new UsageSourceRegistry(() => now);
  registry.register(
    source({
      id: "quota",
      discover: async () => [{ key: "account", input: {} }],
      fetch: async () => report,
    }),
  );
  registry.register(source({ id: "other", discover: async () => [{ key: "account", input: {} }] }));
  const [success] = await registry.listReports();
  now = 360_000;
  // An unrelated write evicts the expired fetch result, but must not discard its snapshot.
  await registry.listReports({ reportIds: ["other:account"], forceRefresh: true });
  report = { status: "error", error: "Rate limited" };
  const [failure] = await registry.listReports({ reportIds: ["quota:account"] });
  expect(failure).toMatchObject({
    fetchedAt: new Date(now).toISOString(),
    report,
    lastSuccessful: { fetchedAt: success!.fetchedAt, report: success!.report },
  });
  now += 360_000;
  const [repeated] = await registry.listReports({ reportIds: ["quota:account"] });
  expect(repeated?.lastSuccessful).toEqual(failure?.lastSuccessful);
  report = { status: "unavailable", problem: { kind: "no_quota", detail: "No quota" } };
  const [unavailable] = await registry.listReports({
    reportIds: ["quota:account"],
    forceRefresh: true,
  });
  expect(unavailable?.lastSuccessful).toEqual(failure?.lastSuccessful);
  now += 1000;
  report = { status: "available", windows: [{ id: "week", label: "Weekly", usedPct: 43 }] };
  const [recovered] = await registry.listReports({
    reportIds: ["quota:account"],
    forceRefresh: true,
  });
  expect(recovered?.report).toEqual(report);
  expect(recovered?.lastSuccessful).toBeUndefined();
  expect(recovered?.fetchedAt).toBe(new Date(now).toISOString());
});

test("successful history is isolated by login set and pruned when identities retire", async () => {
  let login = "old";
  let present = true;
  let available = true;
  const registry = new UsageSourceRegistry();
  const fixture = source({
    id: "source",
    discover: async () => (present ? [{ key: "same", input: login }] : []),
    fetch: async () =>
      available ? { status: "available", windows: [] } : { status: "error", error: "failed" },
  });
  registry.register(fixture);
  await registry.listReports();
  available = false;
  login = "new";
  expect((await registry.listReports({ forceRefresh: true }))[0]?.lastSuccessful).toBeUndefined();
  login = "old";
  expect((await registry.listReports({ forceRefresh: true }))[0]?.lastSuccessful).toBeUndefined();
  available = true;
  await registry.listReports({ forceRefresh: true });
  present = false;
  expect(await registry.listReports()).toEqual([]);
  present = true;
  available = false;
  expect((await registry.listReports())[0]?.lastSuccessful).toBeUndefined();
  available = true;
  await registry.listReports({ forceRefresh: true });
  registry.unregister("source");
  registry.register(fixture);
  available = false;
  expect((await registry.listReports())[0]?.lastSuccessful).toBeUndefined();
});

test("host fallback history never supplies an agent's failed login, and removed agents lose history", async () => {
  const sessions = new Map([["agent", { provider: "codex", env: {}, sessionKey: "one" }]]);
  let available = true;
  const registry = new UsageSourceRegistry(Date.now, 300_000, undefined, {
    hasAgent: (id) => sessions.has(id),
    usageSession: (id) => sessions.get(id) ?? null,
  });
  registry.register({
    id: "source",
    label: "Source",
    discover: async (scope) =>
      (scope.kind === "global" ? ["host", "agent"] : ["agent"]).map((input) => ({
        key: "same",
        input,
      })),
    fetch: async () =>
      available ? { status: "available", windows: [] } : { status: "error", error: "failed" },
  });
  await registry.listReports();
  available = false;
  expect((await registry.listReports({ agentId: "agent" }))[0]?.lastSuccessful).toBeUndefined();
  available = true;
  const [success] = await registry.listReports({ agentId: "agent", forceRefresh: true });
  available = false;
  expect(
    (await registry.listReports({ agentId: "agent", forceRefresh: true }))[0]?.lastSuccessful
      ?.report,
  ).toEqual(success?.report);
  sessions.delete("agent");
  await registry.listReports();
  sessions.set("agent", { provider: "codex", env: {}, sessionKey: "two" });
  expect((await registry.listReports({ agentId: "agent" }))[0]?.lastSuccessful).toBeUndefined();
});

test("a timed out poll retains successful values and late completion cannot replace the failure", async () => {
  let now = 1000;
  let finish!: (value: unknown) => void;
  let slow = false;
  const registry = new UsageSourceRegistry(() => now, 300_000, undefined, undefined, 10);
  registry.register(
    source({
      id: "source",
      discover: async () => [{ key: "same", input: {} }],
      fetch: async () =>
        slow
          ? new Promise((resolve) => {
              finish = resolve;
            })
          : { status: "available", windows: [] },
    }),
  );
  const [success] = await registry.listReports();
  now = 2000;
  slow = true;
  const [failure] = await registry.listReports({ forceRefresh: true });
  expect(failure?.report).toEqual({ status: "error", error: "Usage fetch timed out" });
  expect(failure?.lastSuccessful).toEqual({
    fetchedAt: success?.fetchedAt,
    report: success?.report,
  });
  finish({ status: "available", windows: [{ id: "late", label: "Late" }] });
  expect((await registry.listReports())[0]).toEqual(failure);
});

test("attempt ordering keeps its timestamp while retained freshness records successful completion", async () => {
  let now = 1000;
  let available = true;
  const registry = new UsageSourceRegistry(() => now);
  registry.register(
    source({
      id: "source",
      discover: async () => [{ key: "same", input: {} }],
      fetch: async () => {
        if (available) now = 2000;
        return available
          ? { status: "available", windows: [] }
          : { status: "error", error: "failed" };
      },
    }),
  );
  const [success] = await registry.listReports();
  expect(success?.fetchedAt).toBe(new Date(1000).toISOString());
  expect(success?.successfulAt).toBe(new Date(2000).toISOString());
  available = false;
  now = 3000;
  const [failure] = await registry.listReports({ forceRefresh: true });
  expect(failure?.fetchedAt).toBe(new Date(3000).toISOString());
  expect(failure?.lastSuccessful?.fetchedAt).toBe(success?.successfulAt);
});

test("failed discovery preserves history until discovery confirms account removal", async () => {
  let discoveryFails = false;
  let present = true;
  let available = true;
  const registry = new UsageSourceRegistry(() => 1000, 300_000, { warn: () => {} });
  registry.register(
    source({
      id: "source",
      discover: async () => {
        if (discoveryFails) throw new Error("Login store temporarily unavailable");
        return present ? [{ key: "account", input: {} }] : [];
      },
      fetch: async () =>
        available
          ? { status: "available", windows: [{ id: "weekly", label: "Weekly", usedPct: 42 }] }
          : { status: "error", error: "Rate limited" },
    }),
  );
  const [success] = await registry.listReports();
  available = false;
  discoveryFails = true;
  const [duringDiscoveryFailure] = await registry.listReports({ forceRefresh: true });
  expect(duringDiscoveryFailure?.lastSuccessful).toEqual({
    fetchedAt: success?.successfulAt,
    report: success?.report,
  });
  discoveryFails = false;
  const [afterDiscoveryRecovery] = await registry.listReports({ forceRefresh: true });
  expect(afterDiscoveryRecovery?.lastSuccessful).toEqual(duringDiscoveryFailure?.lastSuccessful);
  expect(afterDiscoveryRecovery?.report).toEqual({ status: "error", error: "Rate limited" });
  present = false;
  expect(await registry.listReports()).toEqual([]);
  present = true;
  expect((await registry.listReports())[0]?.lastSuccessful).toBeUndefined();
});

function nativeSource(input: {
  id: string;
  label: string;
  discover?: () => Promise<
    Array<{ key: string; label?: string; identity?: string; input: unknown }>
  >;
  fetch?: (value: unknown) => Promise<unknown>;
  replaces?: string[];
  skipNativeFallback?: boolean;
}) {
  return {
    id: input.id,
    label: input.label,
    replaces: input.replaces,
    skipNativeFallback: input.skipNativeFallback,
    discover: input.discover ?? (async () => []),
    fetch: input.fetch ?? (async () => ({ status: "available", windows: [] })),
  };
}

test("a takeover publishes plugin windows on the native card", async () => {
  const registry = new UsageSourceRegistry();
  registry.register(
    nativeSource({
      id: "codex",
      label: "Codex",
      discover: async () => [{ key: "shared", input: { origin: "builtin" } }],
      fetch: async () => ({
        status: "available",
        windows: [{ id: "builtin", label: "Builtin", usedPct: 11 }],
      }),
    }),
  );
  registry.register(
    nativeSource({
      id: "cliproxy",
      label: "CLIProxy",
      replaces: ["codex"],
      discover: async () => [{ key: "shared", input: { origin: "override" } }],
      fetch: async () => ({
        status: "available",
        windows: [{ id: "session", label: "Override", usedPct: 42 }],
      }),
    }),
  );
  expect([...registry.overrides()]).toEqual([["codex", "cliproxy"]]);
  const reports = await registry.listReports();
  // The override never publishes under its own id; the native card keeps its identity.
  expect(reports.map((entry) => entry.id)).toEqual(["codex:shared"]);
  expect(reports[0]).toMatchObject({ sourceId: "codex", sourceLabel: "Codex" });
  if (reports[0]?.report.status !== "available") throw new Error("Expected override usage");
  expect(reports[0].report.windows).toEqual([
    { id: "session", label: "Override", usedPct: 42 },
  ]);
});

test("a failing takeover falls back to the built-in source with its errors kept", async () => {
  const registry = new UsageSourceRegistry();
  registry.register(
    nativeSource({
      id: "codex",
      label: "Codex",
      discover: async () => [
        { key: "shared", identity: "test:shared", input: { origin: "builtin" } },
      ],
      fetch: async () => ({
        status: "available",
        accountIdentity: "test:shared",
        windows: [{ id: "builtin", label: "Builtin", usedPct: 11 }],
      }),
    }),
  );
  registry.register(
    nativeSource({
      id: "cliproxy",
      label: "CLIProxy",
      replaces: ["codex"],
      discover: async () => [
        { key: "shared", identity: "test:shared", input: { origin: "override" } },
      ],
      fetch: async () => {
        throw new Error("proxy down");
      },
    }),
  );
  const [entry] = await registry.listReports();
  expect(entry?.id).toBe("codex:shared");
  expect(entry?.sourceId).toBe("codex");
  if (entry?.report.status !== "available") throw new Error("Expected built-in fallback usage");
  expect(entry.report.windows).toEqual([{ id: "builtin", label: "Builtin", usedPct: 11 }]);
  expect(entry.loginErrors).toHaveLength(1);
  expect(entry.loginErrors?.[0]).toMatchObject({ harness: "CLIProxy" });
  expect(entry.loginErrors?.[0]?.report).toEqual({ status: "error", error: "proxy down" });
});

test("takeover conflicts resolve deterministically and log once", async () => {
  const warnings: unknown[][] = [];
  const registry = new UsageSourceRegistry(Date.now, 300_000, {
    warn: (...args: unknown[]) => {
      warnings.push(args);
    },
  });
  registry.register(
    nativeSource({
      id: "codex",
      label: "Codex",
      discover: async () => [{ key: "shared", input: {} }],
    }),
  );
  for (const id of ["zzz-override", "aaa-override"]) {
    registry.register(
      nativeSource({
        id,
        label: id,
        replaces: ["codex"],
        discover: async () => [{ key: "shared", input: {} }],
        fetch: async () => ({
          status: "available",
          windows: [{ id: "session", label: id, usedPct: 1 }],
        }),
      }),
    );
  }
  expect([...registry.overrides()]).toEqual([["codex", "aaa-override"]]);
  const conflicts = warnings.filter(([meta]) => (meta as { target?: string }).target === "codex");
  expect(conflicts).toHaveLength(1);
  expect(conflicts[0]?.[0]).toEqual({
    target: "codex",
    winner: "aaa-override",
    ignored: ["zzz-override"],
  });
  const reports = await registry.listReports();
  // The losing claimant keeps its own cards; only the winner takes the native card.
  expect(reports.map((entry) => entry.id).sort()).toEqual(["codex:shared", "zzz-override:shared"]);
  const entry = reports.find((report) => report.id === "codex:shared");
  if (entry?.report.status !== "available") throw new Error("Expected winner usage");
  expect(entry.report.windows).toEqual([{ id: "session", label: "aaa-override", usedPct: 1 }]);
});

test("disabling hides a built-in source without replacing it", async () => {
  const registry = new UsageSourceRegistry();
  registry.register(
    nativeSource({
      id: "codex",
      label: "Codex",
      discover: async () => [{ key: "shared", input: {} }],
    }),
  );
  expect((await registry.listReports()).map((entry) => entry.id)).toEqual(["codex:shared"]);
  registry.disable("codex");
  expect(await registry.listReports()).toEqual([]);
  registry.enable("codex");
  expect((await registry.listReports()).map((entry) => entry.id)).toEqual(["codex:shared"]);
});

test("a takeover whose discovery fails keeps the built-in card", async () => {
  const warnings: unknown[][] = [];
  const registry = new UsageSourceRegistry(Date.now, 300_000, {
    warn: (...args: unknown[]) => {
      warnings.push(args);
    },
  });
  registry.register(
    nativeSource({
      id: "codex",
      label: "Codex",
      discover: async () => [{ key: "shared", input: {} }],
      fetch: async () => ({
        status: "available",
        windows: [{ id: "builtin", label: "Builtin", usedPct: 11 }],
      }),
    }),
  );
  registry.register(
    nativeSource({
      id: "cliproxy",
      label: "CLIProxy",
      replaces: ["codex"],
      discover: async () => {
        throw new Error("proxy store unreadable");
      },
    }),
  );
  const [entry] = await registry.listReports();
  expect(entry?.id).toBe("codex:shared");
  if (entry?.report.status !== "available") throw new Error("Expected built-in usage");
  expect(entry.report.windows).toEqual([{ id: "builtin", label: "Builtin", usedPct: 11 }]);
  expect(
    warnings.some(
      ([meta, message]) =>
        (meta as { target?: string }).target === "codex" &&
        message === "Usage source takeover failed; falling back to built-in source",
    ),
  ).toBe(true);
});

function countedNative(
  id: string,
  accounts: Array<{ key: string; usedPct: number; identity?: string }>,
  calls: { discover: number; fetch: unknown[] },
) {
  return nativeSource({
    id,
    label: id,
    discover: async () => {
      calls.discover++;
      return accounts.map(({ key, identity }) => ({
        key,
        ...(identity !== undefined ? { identity } : {}),
        input: { account: key },
      }));
    },
    fetch: async (input) => {
      calls.fetch.push(input);
      const account = accounts.find(({ key }) => key === (input as { account: string }).account);
      return {
        status: "available",
        ...(account?.identity !== undefined ? { accountIdentity: account.identity } : {}),
        windows: [{ id: "native", label: "Native", usedPct: account?.usedPct ?? -1 }],
      };
    },
  });
}

test("a mismatched override failure never shows another account's quota", async () => {
  const calls = { discover: 0, fetch: [] as unknown[] };
  const registry = new UsageSourceRegistry();
  registry.register(countedNative("local", [{ key: "c", usedPct: 7, identity: "test:c" }], calls));
  registry.register(
    nativeSource({
      id: "cpa",
      label: "CPA",
      replaces: ["local"],
      discover: async () => [
        { key: "a", input: { account: "a" } },
        { key: "b", input: { account: "b" } },
      ],
      fetch: async (input) => {
        if ((input as { account: string }).account === "a") throw new Error("A store down");
        return {
          status: "available",
          windows: [{ id: "override", label: "Override", usedPct: 42 }],
        };
      },
    }),
  );
  const reports = await registry.listReports();
  // Both override accounts publish under the taken-over id; the local C
  // account never becomes a card while the takeover is active.
  expect(reports.map((entry) => entry.id).sort()).toEqual(["local:a", "local:b"]);
  const failed = reports.find((entry) => entry.id === "local:a")!;
  expect(failed.sourceId).toBe("local");
  expect(failed.report).toEqual({ status: "error", error: "A store down" });
  // Only the override's own login was tried: no native fetch ran for A.
  expect(failed.loginErrors).toHaveLength(1);
  expect(failed.loginErrors?.[0]).toMatchObject({ harness: "CPA" });
  expect(JSON.stringify(failed)).not.toContain("Native");
  const healthy = reports.find((entry) => entry.id === "local:b")!;
  if (healthy?.report.status !== "available") throw new Error("Expected override usage");
  expect(healthy.report.windows).toEqual([{ id: "override", label: "Override", usedPct: 42 }]);
  expect(calls.fetch).toEqual([]);
});

test("a matched fallback serves the same account and keeps the override error", async () => {
  const calls = { discover: 0, fetch: [] as unknown[] };
  const registry = new UsageSourceRegistry();
  registry.register(
    countedNative("local", [{ key: "shared", usedPct: 11, identity: "test:shared" }], calls),
  );
  registry.register(
    nativeSource({
      id: "cpa",
      label: "CPA",
      replaces: ["local"],
      discover: async () => [
        { key: "shared", identity: "test:shared", input: { account: "shared" } },
        { key: "other", input: { account: "other" } },
      ],
      fetch: async (input) => {
        throw new Error(`proxy down for ${(input as { account: string }).account}`);
      },
    }),
  );
  const reports = await registry.listReports();
  const matched = reports.find((entry) => entry.id === "local:shared")!;
  if (matched?.report.status !== "available") throw new Error("Expected matched fallback usage");
  expect(matched.report.windows).toEqual([{ id: "native", label: "Native", usedPct: 11 }]);
  expect(matched.loginErrors).toHaveLength(1);
  expect(matched.loginErrors?.[0]).toMatchObject({
    harness: "CPA",
    report: { status: "error", error: "proxy down for shared" },
  });
  // The unknown sibling keeps its own error; the shared native values never leak into it.
  const unknown = reports.find((entry) => entry.id === "local:other")!;
  expect(unknown?.report).toEqual({ status: "error", error: "proxy down for other" });
  expect(JSON.stringify(unknown)).not.toContain("Native");
  expect(calls.fetch).toEqual([{ account: "shared" }]);
});

test("a rejected native login cannot rescue a mismatched override", async () => {
  const registry = new UsageSourceRegistry();
  registry.register(
    nativeSource({
      id: "local",
      label: "Local",
      discover: async () => [{ key: "c", input: { account: "c" } }],
      fetch: async () => ({
        status: "unavailable",
        problem: { kind: "rejected", status: 401 },
      }),
    }),
  );
  registry.register(
    nativeSource({
      id: "cpa",
      label: "CPA",
      replaces: ["local"],
      discover: async () => [{ key: "a", input: { account: "a" } }],
      fetch: async () => {
        throw new Error("A store down");
      },
    }),
  );
  const [entry] = await registry.listReports();
  expect(entry?.id).toBe("local:a");
  expect(entry?.report).toEqual({ status: "error", error: "A store down" });
});

test("an unknown identity keeps its own error and last successful snapshot", async () => {
  let now = 1000;
  let available = true;
  const registry = new UsageSourceRegistry(() => now);
  registry.register(
    nativeSource({
      id: "local",
      label: "Local",
      discover: async () => [{ key: "c", input: { account: "c" } }],
      fetch: async () => ({
        status: "available",
        windows: [{ id: "native", label: "Native", usedPct: 7 }],
      }),
    }),
  );
  registry.register(
    nativeSource({
      id: "cpa",
      label: "CPA",
      replaces: ["local"],
      discover: async () => [{ key: "a", input: { account: "a" } }],
      fetch: async () =>
        available
          ? { status: "available", windows: [{ id: "override", label: "Override", usedPct: 42 }] }
          : { status: "error", error: "A store down" },
    }),
  );
  const [success] = await registry.listReports();
  if (success?.report.status !== "available") throw new Error("Expected override usage");
  now = 2000;
  available = false;
  const [failure] = await registry.listReports({ forceRefresh: true });
  expect(failure?.report).toEqual({ status: "error", error: "A store down" });
  expect(failure?.lastSuccessful).toEqual({
    fetchedAt: success?.successfulAt,
    report: success?.report,
  });
});

test("an opted-out takeover makes zero native calls while a model session is active", async () => {
  const calls = { discover: 0, fetch: [] as unknown[] };
  const sessions = new Map([["muse-agent", { provider: "muse", env: {}, sessionKey: "one" }]]);
  const registry = new UsageSourceRegistry(Date.now, 300_000, undefined, {
    hasAgent: (id) => sessions.has(id),
    usageSession: (id) => sessions.get(id) ?? null,
  });
  registry.register(countedNative("muse", [{ key: "local-user", usedPct: 7 }], calls));
  registry.register(
    nativeSource({
      id: "cpa",
      label: "CPA",
      replaces: ["muse"],
      skipNativeFallback: true,
      discover: async () => [{ key: "cpa-a", input: { account: "cpa-a" } }],
      fetch: async () => ({
        status: "available",
        windows: [{ id: "override", label: "Override", usedPct: 42 }],
      }),
    }),
  );
  const global = await registry.listReports();
  expect(global.map((entry) => entry.id)).toEqual(["muse:cpa-a"]);
  expect(global[0]).toMatchObject({ sourceId: "muse", sourceLabel: "muse" });
  const agent = await registry.listReports({ agentId: "muse-agent" });
  expect(agent.map((entry) => entry.id)).toEqual(["muse:cpa-a"]);
  // Global and session discovery never touched the native source, so no
  // native fetch could start a host either.
  expect(calls).toEqual({ discover: 0, fetch: [] });
});

test("an opted-out takeover failure reports its own error, never native values", async () => {
  const warnings: unknown[][] = [];
  const calls = { discover: 0, fetch: [] as unknown[] };
  const registry = new UsageSourceRegistry(Date.now, 300_000, {
    warn: (...args: unknown[]) => {
      warnings.push(args);
    },
  });
  registry.register(countedNative("muse", [{ key: "local-user", usedPct: 7 }], calls));
  registry.register(
    nativeSource({
      id: "cpa",
      label: "CPA",
      replaces: ["muse"],
      skipNativeFallback: true,
      discover: async () => [{ key: "cpa-a", input: { account: "cpa-a" } }],
      fetch: async () => {
        throw new Error("proxy down");
      },
    }),
  );
  const [entry] = await registry.listReports();
  expect(entry?.id).toBe("muse:cpa-a");
  expect(entry?.report).toEqual({ status: "error", error: "proxy down" });
  expect(entry?.loginErrors).toHaveLength(1);
  expect(calls).toEqual({ discover: 0, fetch: [] });
  expect(
    warnings.some(
      ([meta, message]) =>
        (meta as { target?: string }).target === "muse" &&
        message === "Usage source takeover failed; native fallback disabled",
    ),
  ).toBe(false);
});

test("an opted-out discovery failure keeps previous winner cards, never native cards", async () => {
  const warnings: unknown[][] = [];
  const calls = { discover: 0, fetch: [] as unknown[] };
  let discoveryFails = false;
  let fetchFails = false;
  const registry = new UsageSourceRegistry(Date.now, 300_000, {
    warn: (...args: unknown[]) => {
      warnings.push(args);
    },
  });
  registry.register(countedNative("muse", [{ key: "local-user", usedPct: 7 }], calls));
  registry.register(
    nativeSource({
      id: "cpa",
      label: "CPA",
      replaces: ["muse"],
      skipNativeFallback: true,
      discover: async () => {
        if (discoveryFails) throw new Error("proxy store unreadable");
        return [{ key: "cpa-a", input: { account: "cpa-a" } }];
      },
      fetch: async () => {
        if (fetchFails) throw new Error("proxy down");
        return {
          status: "available",
          windows: [{ id: "override", label: "Override", usedPct: 42 }],
        };
      },
    }),
  );
  const [success] = await registry.listReports();
  if (success?.report.status !== "available") throw new Error("Expected override usage");
  discoveryFails = true;
  fetchFails = true;
  const [stale] = await registry.listReports({ forceRefresh: true });
  // The winner's own previous card stays (with its last success and age);
  // no native card returns for the owned provider.
  expect(stale?.id).toBe("muse:cpa-a");
  expect(stale?.report).toEqual({ status: "error", error: "proxy down" });
  expect(stale?.lastSuccessful?.report).toEqual(success?.report);
  expect(calls).toEqual({ discover: 0, fetch: [] });
  expect(
    warnings.some(
      ([meta, message]) =>
        (meta as { target?: string }).target === "muse" &&
        message === "Usage source takeover failed; native fallback disabled",
    ),
  ).toBe(true);
});

test("unregistering the winner restores native cards without leftovers", async () => {
  const registry = new UsageSourceRegistry();
  const override = () =>
    nativeSource({
      id: "cliproxy",
      label: "CLIProxy",
      replaces: ["codex"],
      discover: async () => [{ key: "shared", input: { origin: "override" } }],
      fetch: async () => ({
        status: "available",
        windows: [{ id: "session", label: "Override", usedPct: 42 }],
      }),
    });
  registry.register(
    nativeSource({
      id: "codex",
      label: "Codex",
      discover: async () => [{ key: "shared", input: { origin: "builtin" } }],
      fetch: async () => ({
        status: "available",
        windows: [{ id: "builtin", label: "Builtin", usedPct: 11 }],
      }),
    }),
  );
  registry.register(override());
  expect((await registry.listReports()).map((entry) => entry.id)).toEqual(["codex:shared"]);
  registry.unregister("cliproxy");
  const native = await registry.listReports();
  expect(native.map((entry) => entry.id)).toEqual(["codex:shared"]);
  if (native[0]?.report.status !== "available") throw new Error("Expected built-in usage");
  expect(native[0]?.report.windows).toEqual([{ id: "builtin", label: "Builtin", usedPct: 11 }]);
  expect(native[0]?.lastSuccessful).toBeUndefined();
  registry.register(override());
  const taken = await registry.listReports();
  expect(taken.map((entry) => entry.id)).toEqual(["codex:shared"]);
  if (taken[0]?.report.status !== "available") throw new Error("Expected override usage");
  expect(taken[0]?.report.windows).toEqual([{ id: "session", label: "Override", usedPct: 42 }]);
  registry.disable("cliproxy");
  const disabled = await registry.listReports();
  expect(disabled.map((entry) => entry.id)).toEqual(["codex:shared"]);
  expect(disabled[0]?.report.windows).toEqual([{ id: "builtin", label: "Builtin", usedPct: 11 }]);
  registry.enable("cliproxy");
  const reenabled = await registry.listReports();
  expect(reenabled.map((entry) => entry.id)).toEqual(["codex:shared"]);
  expect(reenabled[0]?.report.windows).toEqual([
    { id: "session", label: "Override", usedPct: 42 },
  ]);
});

test("equal keys without a verified identity on either side never fall back", async () => {
  for (const [winnerIdentity, nativeIdentity] of [
    [undefined, "test:a"],
    ["test:a", undefined],
    [undefined, undefined],
  ] as Array<[string | undefined, string | undefined]>) {
    const calls = { discover: 0, fetch: [] as unknown[] };
    const registry = new UsageSourceRegistry();
    registry.register(
      countedNative(
        "local",
        [{ key: "a", usedPct: 7, ...(nativeIdentity ? { identity: nativeIdentity } : {}) }],
        calls,
      ),
    );
    registry.register(
      nativeSource({
        id: "cpa",
        label: "CPA",
        replaces: ["local"],
        discover: async () => [
          {
            key: "a",
            ...(winnerIdentity ? { identity: winnerIdentity } : {}),
            input: { account: "a" },
          },
        ],
        fetch: async () => {
          throw new Error("A store down");
        },
      }),
    );
    const [entry] = await registry.listReports();
    expect(entry?.id).toBe("local:a");
    expect(entry?.report).toEqual({ status: "error", error: "A store down" });
    expect(JSON.stringify(entry)).not.toContain("Native");
    // No verified match, so the native login is never even tried.
    expect(calls.fetch).toEqual([]);
  }
});

test("equal keys with different verified identities never fall back", async () => {
  const calls = { discover: 0, fetch: [] as unknown[] };
  const registry = new UsageSourceRegistry();
  registry.register(
    countedNative("local", [{ key: "shared", usedPct: 7, identity: "test:b" }], calls),
  );
  registry.register(
    nativeSource({
      id: "cpa",
      label: "CPA",
      replaces: ["local"],
      discover: async () => [
        { key: "shared", identity: "test:a", input: { account: "a" } },
      ],
      fetch: async () => {
        throw new Error("A store down");
      },
    }),
  );
  const [entry] = await registry.listReports();
  expect(entry?.id).toBe("local:shared");
  expect(entry?.report).toEqual({ status: "error", error: "A store down" });
  // A locator hash would look identical here; only the verified identity decides.
  expect(JSON.stringify(entry)).not.toContain("Native");
  expect(calls.fetch).toEqual([]);
});

test("a rotated native login cannot rescue the override, even on targeted refresh", async () => {
  const calls = { discover: 0, fetch: [] as unknown[] };
  const backing = { identity: "test:a", usedPct: 11 };
  const registry = new UsageSourceRegistry();
  registry.register(
    nativeSource({
      id: "local",
      label: "Local",
      discover: async () => {
        calls.discover++;
        return [{ key: "shared", identity: backing.identity, input: { slot: "n" } }];
      },
      fetch: async (input) => {
        calls.fetch.push(input);
        // Reads the login store afresh, like the real sources do: a rotation
        // between discovery and fetch changes what is attested.
        return {
          status: "available",
          accountIdentity: backing.identity,
          windows: [{ id: "native", label: "Native", usedPct: backing.usedPct }],
        };
      },
    }),
  );
  registry.register(
    nativeSource({
      id: "cpa",
      label: "CPA",
      replaces: ["local"],
      discover: async () => [
        { key: "shared", identity: "test:a", input: { account: "a" } },
      ],
      fetch: async () => {
        throw new Error("proxy down");
      },
    }),
  );
  const [matched] = await registry.listReports();
  if (matched?.report.status !== "available") throw new Error("Expected matched fallback usage");
  expect(matched.report.windows).toEqual([{ id: "native", label: "Native", usedPct: 11 }]);
  // The login file now belongs to C under the same locator. A targeted
  // refresh skips discovery, so only the fetch-time attestation can stop it.
  backing.identity = "test:c";
  backing.usedPct = 99;
  const [rotated] = await registry.listReports({
    reportIds: ["local:shared"],
    forceRefresh: true,
  });
  expect(rotated?.report).toEqual({ status: "error", error: "proxy down" });
  // C's quota value never appears; its identity only shows up inside the
  // provenance error explaining why the read was discarded.
  expect(JSON.stringify(rotated)).not.toContain("99");
  expect(
    rotated?.loginErrors?.some(
      (login) =>
        login.harness === "Local" &&
        login.report.status === "error" &&
        login.report.error.includes("does not match"),
    ),
  ).toBe(true);
  // A fresh discovery sees the same locator with C's identity and no longer
  // matches the override either: still A's own error, never C's values.
  const [rediscovered] = await registry.listReports();
  expect(rediscovered?.report).toEqual({ status: "error", error: "proxy down" });
  expect(JSON.stringify(rediscovered)).not.toContain("99");
  expect(calls.fetch).toHaveLength(2);
});

test("a pending primary cannot start native fallback or publish after reload and opt-out", async () => {
  const calls = { discover: 0, fetch: [] as unknown[] };
  let primaryStarted = false;
  let releasePrimary!: (error: Error) => void;
  const registry = new UsageSourceRegistry();
  registry.register(
    countedNative("local", [{ key: "shared", usedPct: 11, identity: "test:a" }], calls),
  );
  const failingWinner = () =>
    nativeSource({
      id: "cpa",
      label: "CPA",
      replaces: ["local"],
      discover: async () => [
        { key: "shared", identity: "test:a", input: { account: "a" } },
      ],
      fetch: async () => {
        primaryStarted = true;
        return new Promise<never>((_, reject) => {
          releasePrimary = reject;
        });
      },
    });
  registry.register(failingWinner());
  const pending = registry.listReports();
  // Fixture discovery and the primary fetch invocation are microtask-only,
  // so flushing macrotasks guarantees the primary is in flight below.
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  expect(primaryStarted).toBe(true);
  // Reload while the primary is in flight: unregister, then re-register the
  // same id with a native opt-out, then disable and re-enable it.
  registry.unregister("cpa");
  registry.register(
    nativeSource({
      id: "cpa",
      label: "CPA",
      replaces: ["local"],
      skipNativeFallback: true,
      discover: async () => [{ key: "b", identity: "test:b", input: { account: "b" } }],
      fetch: async () => ({
        status: "available",
        windows: [{ id: "override", label: "Override", usedPct: 42 }],
      }),
    }),
  );
  registry.disable("cpa");
  registry.enable("cpa");
  releasePrimary(new Error("old primary down"));
  const [stale] = await pending;
  // The retired request resolves with the old primary's own error: no native
  // fetch ran (which could have started a native host), and there is no
  // provenance from another account.
  expect(stale?.id).toBe("local:shared");
  expect(stale?.report).toEqual({ status: "error", error: "old primary down" });
  expect(calls.fetch).toEqual([]);
  // Nothing was published: the next discovery shows only the new winner's
  // card, and the retired card is gone entirely.
  const after = await registry.listReports();
  expect(after.map((entry) => entry.id)).toEqual(["local:b"]);
  if (after[0]?.report.status !== "available") throw new Error("Expected new winner usage");
  expect(after[0].report.windows).toEqual([{ id: "override", label: "Override", usedPct: 42 }]);
  expect(await registry.listReports({ reportIds: ["local:shared"] })).toEqual([]);
});

test("a successful pending primary publishes nothing after disable", async () => {
  const registry = new UsageSourceRegistry();
  let calls = 0;
  let releasePrimary!: (value: unknown) => void;
  const primaryGate = new Promise<unknown>((resolve) => {
    releasePrimary = resolve;
  });
  registry.register(
    source({
      id: "muse",
      discover: async () => [{ key: "a", input: { account: "a" } }],
      fetch: async () => {
        calls++;
        // Only the second read stalls: the warm-up and the post-enable
        // re-read resolve at once.
        if (calls === 2) await primaryGate;
        return { status: "available", windows: [{ id: "w", label: "retired-success" }] };
      },
    }),
  );
  // Warm the card so the retired shape is a success, not a first discovery.
  expect((await registry.listReports())[0]?.report).toMatchObject({
    windows: [{ label: "retired-success" }],
  });
  const reported: string[] = [];
  const pending = registry.listReports({
    reportIds: ["muse:a"],
    forceRefresh: true,
    onReport: (entry) => reported.push(entry.id),
  });
  await Promise.resolve();
  // Disable while the successful primary is still in flight.
  registry.disable("muse");
  releasePrimary(undefined);
  // Sequence A: the success resolves, but the retired card reaches neither
  // the callback, the returned list, the cache, nor last-success.
  expect(await pending).toEqual([]);
  expect(reported).toEqual([]);
  registry.enable("muse");
  // A global re-read rediscovers the card and serves it fresh; the retired
  // success lodged neither cache nor last-success on its way out.
  const after = await registry.listReports();
  expect(after.map((entry) => entry.id)).toEqual(["muse:a"]);
  expect(after[0]?.report).toMatchObject({ windows: [{ label: "retired-success" }] });
  expect(after[0]?.lastSuccessful).toBeUndefined();
});

test("an already-started fallback publishes nothing after retirement", async () => {
  const nativeCalls: unknown[] = [];
  let releaseFallback!: () => void;
  const fallbackGate = new Promise<void>((resolve) => {
    releaseFallback = resolve;
  });
  let nativeFails = false;
  const registry = new UsageSourceRegistry();
  registry.register(
    nativeSource({
      id: "local",
      label: "local",
      discover: async () => [{ key: "shared", identity: "test:a", input: { account: "shared" } }],
      fetch: async (input) => {
        nativeCalls.push(input);
        await fallbackGate;
        if (nativeFails) throw new Error("native down");
        return {
          status: "available",
          accountIdentity: "test:a",
          windows: [{ id: "native", label: "Native", usedPct: 11 }],
        };
      },
    }),
  );
  registry.register(
    nativeSource({
      id: "cpa",
      label: "CPA",
      replaces: ["local"],
      discover: async () => [{ key: "shared", identity: "test:a", input: { account: "a" } }],
      // The primary fails while live, so native fallback starts at once.
      fetch: async () => ({ status: "error", error: "proxy down" }),
    }),
  );
  const reported: string[] = [];
  const pending = registry.listReports({ onReport: (entry) => reported.push(entry.id) });
  // Flush macrotasks so the primary has failed and the native fallback is
  // genuinely in flight before retirement.
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  expect(nativeCalls).toHaveLength(1);
  // Sequence B: retire while the attested fallback is in flight, then let it
  // succeed. The success reaches neither callback nor return, and retirement
  // starts no further native fetch.
  registry.disable("cpa");
  const callsAtRetire = nativeCalls.length;
  releaseFallback();
  expect(await pending).toEqual([]);
  expect(reported).toEqual([]);
  expect(nativeCalls).toHaveLength(callsAtRetire);
  // Nothing lodged: with everything failing after re-enable, the error
  // carries no last-success from the retired fetch.
  registry.enable("cpa");
  nativeFails = true;
  const [failed] = await registry.listReports({ forceRefresh: true });
  expect(failed?.report).toMatchObject({ status: "error" });
  expect(failed?.lastSuccessful).toBeUndefined();
});

test("a fetch retired by an event publishes nothing; the push's re-read serves new data", async () => {
  let now = 0;
  const registry = new UsageSourceRegistry(() => now);
  let calls = 0;
  let releaseOld!: () => void;
  const oldGate = new Promise<void>((resolve) => {
    releaseOld = resolve;
  });
  const invalidated: Array<{ sourceId: string; reportIds: string[] }> = [];
  const unsubscribe = registry.onInvalidated((event) => invalidated.push(event));
  try {
    registry.register(
      source({
        id: "muse",
        discover: async () => [{ key: "a", input: { account: "a" } }],
        fetch: async () => {
          calls++;
          if (calls === 2) {
            // F1 starts with the older quota and stalls.
            await oldGate;
            return { status: "available", windows: [{ id: "w", label: "old" }] };
          }
          return {
            status: "available",
            windows: [{ id: "w", label: calls === 1 ? "old" : "new" }],
          };
        },
      }),
    );
    const first = await registry.listReports();
    expect(first[0]?.report).toMatchObject({ windows: [{ label: "old" }] });
    // F1 hangs on its next read; the event retires it, F2 reads the new
    // quota, and F1 resolves last with the older values.
    const reported: string[] = [];
    const slow = registry.listReports({
      reportIds: ["muse:a"],
      forceRefresh: true,
      onReport: (entry) => reported.push(entry.id),
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(registry.invalidateSource("muse")).toEqual(["muse:a"]);
    expect(invalidated).toEqual([{ sourceId: "muse", reportIds: ["muse:a"] }]);
    const fresh = await registry.listReports({ reportIds: ["muse:a"] });
    expect(fresh[0]?.report).toMatchObject({ windows: [{ label: "new" }] });
    releaseOld();
    // The retired fetch reaches neither the callback nor the returned list,
    // so its older quota can never overwrite the event's newer data.
    expect(await slow).toEqual([]);
    expect(reported).toEqual([]);
    expect(calls).toBe(3);
    // The cache holds the new quota; no further fetch is needed.
    await registry.listReports({ reportIds: ["muse:a"] });
    expect(calls).toBe(3);
  } finally {
    unsubscribe();
  }
});

test("a freshness invalidation keeps every account's last-good snapshot for later errors", async () => {
  let now = 0;
  const registry = new UsageSourceRegistry(() => now);
  let failB = false;
  registry.register(
    source({
      id: "muse",
      discover: async () => [
        { key: "a", input: { account: "a" } },
        { key: "b", input: { account: "b" } },
      ],
      fetch: async (input) => {
        const account = (input as { account: string }).account;
        if (account === "b" && failB) throw new Error("quota backend down");
        return { status: "available", windows: [{ id: "w", label: `ok-${account}` }] };
      },
    }),
  );
  const initial = await registry.listReports();
  expect(initial.map((entry) => entry.id)).toEqual(["muse:a", "muse:b"]);
  // An event for the source drops freshness but preserves valid history.
  expect(registry.invalidateSource("muse")).toEqual(["muse:a", "muse:b"]);
  failB = true;
  const after = await registry.listReports({ forceRefresh: true });
  const entryB = after.find((entry) => entry.id === "muse:b")!;
  expect(entryB.report).toMatchObject({ status: "error" });
  // B's proven observation survives the invalidation and the later error.
  expect(entryB.lastSuccessful?.report).toMatchObject({ windows: [{ label: "ok-b" }] });
  const entryA = after.find((entry) => entry.id === "muse:a")!;
  expect(entryA.report).toMatchObject({ windows: [{ label: "ok-a" }] });
});

test("a first event after an empty discovery still pushes an inventory invalidation", async () => {
  const registry = new UsageSourceRegistry();
  registry.register(source({ id: "muse" }));
  const invalidated: Array<{ sourceId: string; reportIds: string[] }> = [];
  const unsubscribe = registry.onInvalidated((event) => invalidated.push(event));
  try {
    // Nothing discovered yet: no card ids, but the registered source's
    // inventory may have changed, so listeners still fire for rediscovery.
    expect(registry.invalidateSource("muse")).toEqual([]);
    expect(invalidated).toEqual([{ sourceId: "muse", reportIds: [] }]);
  } finally {
    unsubscribe();
  }
});

test("replacing a source keeps invalidation routed to the new owner's cards", async () => {
  let now = 0;
  const registry = new UsageSourceRegistry(() => now);
  const windows = (label: string) => ({ status: "available", windows: [{ id: "w", label }] });
  registry.register(
    source({
      id: "muse",
      discover: async () => [{ key: "a", input: { account: "a" } }],
      fetch: async () => windows("v1"),
    }),
  );
  expect((await registry.listReports()).map((entry) => entry.id)).toEqual(["muse:a"]);
  registry.unregister("muse");
  registry.register(
    source({
      id: "muse",
      discover: async () => [{ key: "a", input: { account: "a" } }],
      fetch: async () => windows("v2"),
    }),
  );
  const replaced = await registry.listReports();
  expect(replaced[0]?.report).toMatchObject({ windows: [{ label: "v2" }] });
  expect(registry.invalidateSource("muse")).toEqual(["muse:a"]);
  const refetched = await registry.listReports({ reportIds: ["muse:a"] });
  expect(refetched[0]?.report).toMatchObject({ windows: [{ label: "v2" }] });
});

test("source-owned observation age owns freshness through the registry", async () => {
  let now = 1_000_000;
  const registry = new UsageSourceRegistry(() => now);
  const observedAt = new Date(now - 60_000).toISOString();
  let mode: "ok" | "fail" = "ok";
  registry.register(
    source({
      id: "claude",
      discover: async () => [{ key: "a", input: {} }],
      fetch: async () =>
        mode === "ok"
          ? {
              status: "available",
              observedAt,
              windows: [{ id: "five_hour", label: "5-hour", usedPct: 10 }],
            }
          : { status: "error", error: "proxy down" },
    }),
  );
  // Poll time never becomes the observation: successfulAt is the source's
  // observedAt even though the fetch completed later.
  now += 5_000;
  const first = await registry.listReports();
  expect(first[0]?.report.status).toBe("available");
  expect(first[0]?.successfulAt).toBe(observedAt);
  // A failure inside the ceiling keeps the error visible and carries the
  // true observation in history — no new observation is stamped.
  mode = "fail";
  now += 120_000;
  const failed = await registry.listReports({ forceRefresh: true });
  expect(failed[0]?.report.status).toBe("error");
  expect(failed[0]?.lastSuccessful?.report).toMatchObject({ status: "available", observedAt });
  expect(failed[0]?.successfulAt).toBeUndefined();
  // Repeated failures past the ceiling drop history: stale quota is never
  // reintroduced, however fresh the poll itself is.
  now += 2_000_000;
  const stale = await registry.listReports({ forceRefresh: true });
  expect(stale[0]?.report.status).toBe("error");
  expect(stale[0]?.lastSuccessful).toBeUndefined();
});

test("available quota older than the ceiling never publishes, even cold", async () => {
  const now = 5_000_000;
  const registry = new UsageSourceRegistry(() => now);
  registry.register(
    source({
      id: "codex",
      discover: async () => [{ key: "a", input: {} }],
      fetch: async () => ({
        status: "available",
        observedAt: new Date(now - 45 * 60_000).toISOString(),
        windows: [{ id: "primary", label: "Primary", usedPct: 61 }],
      }),
    }),
  );
  const reports = await registry.listReports();
  expect(reports).toHaveLength(1);
  expect(reports[0]?.report.status).toBe("error");
  expect(reports[0]?.lastSuccessful).toBeUndefined();
});
