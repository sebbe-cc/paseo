import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { BuiltinPluginLoader } from "./builtin/index.js";

/**
 * Real-boundary proof for the CPA usage plugin (pa-vtgw9) against the
 * observed_at/expiry/capability core delta in this worktree:
 *
 * - the REAL plugin directory (copied from the pa-vtgw9 worktree) runs in a
 *   REAL plugin subprocess spawned by the REAL daemon;
 * - its `ready` payload flows through the REAL PluginService into the REAL
 *   UsageSourceRegistry and out through the REAL `listUsageReports` RPC;
 * - quota assertions run against contract-correct fakes (quota-v1 account
 *   ids, opaque window ids, real percents incl. overdraw).
 *
 * No stub context, no mirrored registry, no preview page. What the client
 * receives here is what the native card receives.
 */

const PLUGIN_SRC = "/home/seb/.paseo/worktrees/32ilzdap/pa-vtgw9/plugins/paseo-cpa-usage";
const API_KEY = "e2e-management-key";

function quotaV1(provider: "claude" | "codex", ...parts: string[]): string {
  const payload = JSON.stringify(["quota-v1", provider, ...parts]);
  return `quota-v1-${createHash("sha256").update(payload, "utf8").digest("hex")}`;
}

const CLAUDE_A = quotaV1("claude", "acc-aaaaaaaa-0001", "org-11111111-0001");
const CLAUDE_B = quotaV1("claude", "acc-bbbbbbbb-0002", "org-22222222-0002");
const CODEX_A = quotaV1("codex", "chatgpt-acct-aaa");
const CODEX_B = quotaV1("codex", "chatgpt-acct-bbb");
const CODEX_C = quotaV1("codex", "chatgpt-acct-ccc");

type ApiMode = "fresh" | "aged" | "forbidden";

function accountsPayload(now: number, mode: ApiMode) {
  const observedAt =
    mode === "aged"
      ? new Date(now - 45 * 60_000).toISOString()
      : new Date(now - 60_000).toISOString();
  const checkedAt = new Date(now).toISOString();
  return {
    schema_version: 1,
    generated_at: checkedAt,
    accounts: [
      {
        account_id: CLAUDE_A,
        provider: "claude",
        plan: "Max",
        status: "ok",
        detail: "ok",
        observed_at: observedAt,
        checked_at: checkedAt,
        retry_at: null,
        windows: [
          {
            id: "five_hour",
            used_percent: 34,
            window_seconds: 18_000,
            resets_at: new Date(now + 3_600_000).toISOString(),
            scope: null,
          },
          {
            id: "weekly_scoped:opus:",
            used_percent: 150.75,
            window_seconds: 604_800,
            resets_at: null,
            scope: { model: "opus", surface: null },
          },
        ],
      },
      {
        account_id: CLAUDE_B,
        provider: "claude",
        plan: null,
        status: "stale",
        detail: "transient-fetch-error",
        observed_at: observedAt,
        checked_at: checkedAt,
        retry_at: null,
        windows: [
          {
            id: "seven_day",
            used_percent: 12.5,
            window_seconds: 604_800,
            resets_at: null,
            scope: null,
          },
        ],
      },
      {
        account_id: CODEX_A,
        provider: "codex",
        plan: "Plus",
        status: "ok",
        detail: "ok",
        observed_at: observedAt,
        checked_at: checkedAt,
        retry_at: null,
        windows: [
          {
            id: "primary",
            used_percent: 61,
            window_seconds: 18_000,
            resets_at: new Date(now + 1_800_000).toISOString(),
            scope: null,
          },
        ],
      },
      {
        account_id: CODEX_B,
        provider: "codex",
        plan: null,
        status: "expired",
        detail: "token-expired",
        observed_at: observedAt,
        checked_at: checkedAt,
        retry_at: null,
        windows: [],
      },
      {
        // R1: a failing account whose backend still holds the last
        // validated quota. The plugin forwards it as history alongside the
        // visible error; the registry bridges it to lastSuccessful so the
        // native card shows error + retained quota after a cold restart.
        account_id: CODEX_C,
        provider: "codex",
        plan: "Plus",
        status: "rate_limited",
        detail: "http-429",
        observed_at: observedAt,
        checked_at: checkedAt,
        retry_at: checkedAt,
        windows: [
          {
            id: "primary",
            used_percent: 61,
            window_seconds: 18_000,
            resets_at: new Date(now + 1_800_000).toISOString(),
            scope: null,
          },
        ],
      },
    ],
  };
}

async function startFakeApi(mode: {
  current: ApiMode;
}): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    if (req.url !== "/v0/management/subscription-quotas") {
      res.writeHead(404).end();
      return;
    }
    if (req.headers.authorization !== `Bearer ${API_KEY}`) {
      res
        .writeHead(403, { "content-type": "application/json" })
        .end(JSON.stringify({ schema_version: 1, error: { code: "forbidden" } }));
      return;
    }
    if (mode.current === "forbidden") {
      res
        .writeHead(403, { "content-type": "application/json" })
        .end(JSON.stringify({ schema_version: 1, error: { code: "forbidden" } }));
      return;
    }
    const now = Date.now();
    res
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify(accountsPayload(now, mode.current)));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/v0/management/subscription-quotas`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error?: Error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      }),
  };
}

async function stagePlugin(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "cpa-plugin-"));
  const dir = path.join(root, "paseo-cpa-usage");
  await mkdir(dir, { recursive: true });
  // Only the runtime files: the daemon compiles the plugin itself.
  await cp(path.join(PLUGIN_SRC, "paseo-plugin.json"), path.join(dir, "paseo-plugin.json"));
  await cp(path.join(PLUGIN_SRC, "index.server.ts"), path.join(dir, "index.server.ts"));
  await cp(path.join(PLUGIN_SRC, "server"), path.join(dir, "server"), { recursive: true });
  await cp(path.join(PLUGIN_SRC, "shared"), path.join(dir, "shared"), { recursive: true });
  return { dir, cleanup: () => rm(root, { recursive: true, force: true }) };
}

function builtinSource(
  id: "claude" | "codex",
  label: string,
  markers: { discovered: string; fetched: string },
): string {
  return `import { appendFileSync } from 'node:fs';
import { z } from 'zod';
const discovered = ${JSON.stringify(markers.discovered)};
const fetched = ${JSON.stringify(markers.fetched)};
export default function contribute(server) {
  server.registerUsageSource({ id: '${id}', label: '${label}', input: z.object({}),
    discover: async () => {
      appendFileSync(discovered, 'x');
      return [{ key: 'native-login', input: {} }];
    },
    fetch: async () => {
      appendFileSync(fetched, 'x');
      return { status: 'available', windows: [{ id: 'builtin', label: 'Builtin', usedPct: 99 }] };
    },
  });
  return () => {};
}`;
}

async function stageBuiltins(): Promise<{
  pluginsDir: string;
  markers: { discovered: string; fetched: string };
  cleanup: () => Promise<void>;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "cpa-builtins-"));
  const pluginsDir = path.join(root, "plugins");
  const markers = {
    discovered: path.join(root, "native-discovered"),
    fetched: path.join(root, "native-fetched"),
  };
  for (const [id, label] of [
    ["claude", "Claude"],
    ["codex", "Codex"],
  ] as const) {
    const dir = path.join(pluginsDir, `${id}-usage-source`);
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, "paseo-plugin.json"),
      JSON.stringify({ id: `${id}-usage-source`, requirements: { paseo: ">=0.9.2" } }),
    );
    await writeFile(path.join(dir, "index.server.ts"), builtinSource(id, label, markers));
  }
  return { pluginsDir, markers, cleanup: () => rm(root, { recursive: true, force: true }) };
}

async function withCpaEnv<T>(url: string, run: () => Promise<T>): Promise<T> {
  const savedUrl = process.env.PASEO_CPA_QUOTAS_URL;
  const savedKey = process.env.PASEO_CPA_MANAGEMENT_KEY;
  const savedKeyFile = process.env.PASEO_CPA_MANAGEMENT_KEY_FILE;
  process.env.PASEO_CPA_QUOTAS_URL = url;
  process.env.PASEO_CPA_MANAGEMENT_KEY = API_KEY;
  delete process.env.PASEO_CPA_MANAGEMENT_KEY_FILE;
  try {
    return await run();
  } finally {
    if (savedUrl === undefined) delete process.env.PASEO_CPA_QUOTAS_URL;
    else process.env.PASEO_CPA_QUOTAS_URL = savedUrl;
    if (savedKey === undefined) delete process.env.PASEO_CPA_MANAGEMENT_KEY;
    else process.env.PASEO_CPA_MANAGEMENT_KEY = savedKey;
    if (savedKeyFile !== undefined) process.env.PASEO_CPA_MANAGEMENT_KEY_FILE = savedKeyFile;
  }
}

test("real daemon subprocess serves CPA quotas as native cards with observed_at provenance", async () => {
  const mode: { current: ApiMode } = { current: "fresh" };
  const api = await startFakeApi(mode);
  const plugin = await stagePlugin();
  const builtins = await stageBuiltins();
  try {
    await withCpaEnv(api.url, async () => {
      const daemon = await createTestPaseoDaemon({
        daemonVersion: "0.14.0",
        pluginsEnabled: true,
        builtinPlugins: new BuiltinPluginLoader(builtins.pluginsDir, [
          "claude-usage-source",
          "codex-usage-source",
        ]),
      });
      const client = new DaemonClient({
        url: `ws://127.0.0.1:${daemon.port}/ws`,
        appVersion: "0.14.0",
      });
      try {
        await client.connect();
        await client.installDirectoryPlugin(plugin.dir, "paseo-cpa-usage");
        const first = await client.listUsageReports({ forceRefresh: true });

        // Native placement: CPA accounts publish under the taken-over
        // claude/codex cards, never under cpa-* ids.
        const ids = first.reports.map((entry) => entry.id).sort();
        expect(ids).toEqual(
          [
            `claude:${CLAUDE_A}`,
            `claude:${CLAUDE_B}`,
            `codex:${CODEX_A}`,
            `codex:${CODEX_B}`,
            `codex:${CODEX_C}`,
          ].sort(),
        );
        for (const entry of first.reports) {
          expect(entry.id.startsWith("cpa-")).toBe(false);
          expect(["claude", "codex"]).toContain(entry.sourceId);
        }

        // skipNativeFallback honored by the real registry: the built-in
        // sources were never discovered nor fetched.
        const { existsSync } = await import("node:fs");
        expect(existsSync(builtins.markers.discovered)).toBe(false);
        expect(existsSync(builtins.markers.fetched)).toBe(false);

        const claudeA = first.reports.find((entry) => entry.id === `claude:${CLAUDE_A}`);
        expect(claudeA?.report.status).toBe("available");
        if (claudeA?.report.status !== "available") throw new Error("expected available");
        // Real percents incl. vendor overdraw, never clamped or dropped.
        expect(
          claudeA.report.windows
            .map((window) => window.usedPct)
            .sort((a, b) => (a ?? 0) - (b ?? 0)),
        ).toEqual([34, 150.75]);
        // Source-owned provenance survives to the native entry: the
        // registry stamps successfulAt from observedAt, never poll time.
        expect(claudeA.report.observedAt).toMatch(/^\d{4}-/);
        expect(claudeA.successfulAt).toBe(claudeA.report.observedAt);
        const ageMs = Date.now() - Date.parse(claudeA.report.observedAt!);
        expect(ageMs).toBeGreaterThanOrEqual(0);
        expect(ageMs).toBeLessThan(300_000);

        // The stale account renders its history as available with a marker.
        const claudeB = first.reports.find((entry) => entry.id === `claude:${CLAUDE_B}`);
        expect(claudeB?.report.status).toBe("available");

        // The expired account stays a visible expiry, never quota.
        const codexB = first.reports.find((entry) => entry.id === `codex:${CODEX_B}`);
        expect(codexB?.report).toMatchObject({
          status: "unavailable",
          problem: { kind: "expired", expiresAt: expect.any(String) },
        });

        // R1 over the real RPC: the rate-limited account keeps its visible
        // error, while its fresh backend quota is bridged to lastSuccessful
        // — the native card shows error + retained quota on a cold daemon.
        const codexC = first.reports.find((entry) => entry.id === `codex:${CODEX_C}`);
        expect(codexC?.report.status).toBe("error");
        expect(codexC?.lastSuccessful?.report).toMatchObject({
          status: "available",
          windows: [{ usedPct: 61 }],
        });
        expect(codexC?.lastSuccessful?.report.observedAt).toMatch(/^\d{4}-/);
      } finally {
        await client.close();
        await daemon.close();
      }
    });
  } finally {
    await builtins.cleanup();
    await plugin.cleanup();
    await api.close();
  }
}, 120_000);

test("real registry never serves quota older than the ceiling, including after a restart", async () => {
  const mode: { current: ApiMode } = { current: "aged" };
  const api = await startFakeApi(mode);
  const plugin = await stagePlugin();
  const builtins = await stageBuiltins();
  try {
    await withCpaEnv(api.url, async () => {
      const daemon = await createTestPaseoDaemon({
        daemonVersion: "0.14.0",
        pluginsEnabled: true,
        builtinPlugins: new BuiltinPluginLoader(builtins.pluginsDir, [
          "claude-usage-source",
          "codex-usage-source",
        ]),
      });
      const client = new DaemonClient({
        url: `ws://127.0.0.1:${daemon.port}/ws`,
        appVersion: "0.14.0",
      });
      try {
        await client.connect();
        await client.installDirectoryPlugin(plugin.dir, "paseo-cpa-usage");
        // Cold start, aged backend observation (45 min > 1800 s ceiling):
        // the real registry downgrades to error and serves no windows, and
        // repeated polls can never stamp a new observation.
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const reports = (await client.listUsageReports({ forceRefresh: true })).reports;
          const claudeA = reports.find((entry) => entry.id === `claude:${CLAUDE_A}`);
          expect(claudeA?.report.status).toBe("error");
          expect(JSON.stringify(claudeA?.report)).toContain("stale");
          expect(claudeA).not.toHaveProperty("lastSuccessful");
          // R1: the rate-limited account's backend history is 45 minutes
          // old here, so nothing is bridged — error without quota.
          const codexC = reports.find((entry) => entry.id === `codex:${CODEX_C}`);
          expect(codexC?.report.status).toBe("error");
          expect(codexC).not.toHaveProperty("lastSuccessful");
          const withWindows = reports.filter(
            (entry) =>
              entry.report.status === "available" && (entry.report.windows?.length ?? 0) > 0,
          );
          expect(withWindows).toEqual([]);
        }
      } finally {
        await client.close();
        await daemon.close();
      }
    });
  } finally {
    await builtins.cleanup();
    await plugin.cleanup();
    await api.close();
  }
}, 120_000);
