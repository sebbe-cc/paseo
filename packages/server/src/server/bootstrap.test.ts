import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import pino from "pino";
import { expect, test, onTestFinished, vi } from "vitest";
import { MutableDaemonConfigSchema } from "@getpaseo/protocol/messages";
import { DaemonConfigStore } from "./daemon-config-store.js";
import { loadPersistedConfig } from "./persisted-config.js";
import {
  createIdleRuntimeCleanup,
  type RuntimeCleanupCandidate,
} from "./agent/idle-runtime-cleanup/index.js";
import { createTestLogger } from "../test-utils/test-logger.js";

import {
  connectIdleRuntimeCleanupConfig,
  createPaseoDaemon,
  fanOutReconciledWorkspaceUpdates,
} from "./bootstrap.js";
import { PluginService } from "./plugins/index.js";
import { ScheduleService } from "./schedule/service.js";
import { createTestAgentClients } from "./test-utils/fake-agent-client.js";

test("scheduled agent recovery waits for plugin lifecycle hooks before starting", async () => {
  const home = await mkdtemp(join(tmpdir(), "paseo-schedule-startup-"));
  const town = await mkdtemp(join(home, "fleet-town-"));
  vi.stubEnv("PASEO_HOME", home);
  vi.stubEnv("FLEET_TOWN_STATE_DIR", town);
  const entered = Promise.withResolvers<void>();
  const ready = Promise.withResolvers<void>();
  const pluginStart = vi.spyOn(PluginService.prototype, "start").mockImplementation(async () => {
    entered.resolve();
    await ready.promise;
  });
  const scheduleStart = vi.spyOn(ScheduleService.prototype, "start");
  const daemon = await createPaseoDaemon(
    {
      listen: "127.0.0.1:0",
      paseoHome: home,
      corsAllowedOrigins: [],
      hostnames: true,
      mcpEnabled: false,
      staticDir: home,
      mcpDebug: false,
      agentClients: createTestAgentClients(),
      agentStoragePath: join(home, "agents"),
      relayEnabled: false,
      appBaseUrl: "https://app.paseo.sh",
    },
    pino({ level: "silent" }),
  );
  let starting: Promise<void> | undefined;
  try {
    expect(scheduleStart).not.toHaveBeenCalled();
    starting = daemon.start();
    await entered.promise;
    expect(scheduleStart).not.toHaveBeenCalled();
    ready.resolve();
    await starting;
    expect(pluginStart).toHaveBeenCalledOnce();
    expect(scheduleStart).toHaveBeenCalledOnce();
  } finally {
    ready.resolve();
    await starting?.catch(() => undefined);
    await daemon.stop();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true });
  }
});

test("reconciliation emits workspace updates when observer sync fails", async () => {
  const emittedWorkspaceIds: string[][] = [];
  const syncFailure = new Error("workspace observer unavailable");

  await fanOutReconciledWorkspaceUpdates({
    sessions: [
      {
        syncWorkspaceGitObserversForExternalWorkspaceIds: async () => {
          throw syncFailure;
        },
        emitWorkspaceUpdatesForExternalWorkspaceIds: async (workspaceIds) => {
          emittedWorkspaceIds.push(Array.from(workspaceIds));
        },
      },
    ],
    workspaceIds: ["ws-reclassified"],
    logger: { warn: () => {} },
  });

  expect(emittedWorkspaceIds).toEqual([["ws-reclassified"]]);
});

test("reconciliation isolates workspace update failures between sessions", async () => {
  const emittedWorkspaceIds: string[][] = [];
  const warnings: unknown[] = [];

  await fanOutReconciledWorkspaceUpdates({
    sessions: [
      {
        syncWorkspaceGitObserversForExternalWorkspaceIds: async () => {},
        emitWorkspaceUpdatesForExternalWorkspaceIds: async () => {
          throw new Error("session closed");
        },
      },
      {
        syncWorkspaceGitObserversForExternalWorkspaceIds: async () => {},
        emitWorkspaceUpdatesForExternalWorkspaceIds: async (workspaceIds) => {
          emittedWorkspaceIds.push(Array.from(workspaceIds));
        },
      },
    ],
    workspaceIds: ["ws-reclassified"],
    logger: {
      warn: (context) => {
        warnings.push(context);
      },
    },
  });

  expect(emittedWorkspaceIds).toEqual([["ws-reclassified"]]);
  expect(warnings).toHaveLength(1);
});

// Exercise bootstrap's actual live-config binding with the real collector and store.

function liveCleanupHost() {
  const home = mkdtempSync(path.join(tmpdir(), "paseo-live-cleanup-"));
  writeFileSync(path.join(home, "config.json"), JSON.stringify({ version: 1 }));
  const store = new DaemonConfigStore(
    home,
    MutableDaemonConfigSchema.parse({
      relay: { enabled: true },
      mcp: { injectIntoAgents: false },
      idleRuntimeCleanup: true,
    }),
    undefined,
    {
      reloadSource: {
        resolve: (persisted) => ({
          mutable: MutableDaemonConfigSchema.parse({
            relay: { enabled: true },
            mcp: { injectIntoAgents: false },
            idleRuntimeCleanup: persisted.agents?.idleRuntimeCleanup ?? true,
          }),
          overrideControlledPaths: [],
        }),
      },
    },
  );
  let minutes = 61;
  let closed = false;
  let protectedCaller = false;
  const runtime: RuntimeCleanupCandidate = {
    identity: {},
    agentId: "agent",
    provider: "test",
    sessionId: "session",
    parentAgentId: undefined,
    lastActivityAt: 0,
    isEligible: () => !closed,
    closeIfEligible: async (eligible) => {
      if (!eligible()) return false;
      closed = true;
      return true;
    },
  };
  const cleanup = createIdleRuntimeCleanup({
    enabled: true,
    now: () => minutes * 60_000,
    runtimes: () => [runtime],
    isProtected: () => protectedCaller,
    logger: createTestLogger(),
    schedule: () => () => {},
  });
  const unsubscribe = connectIdleRuntimeCleanupConfig(store, cleanup);
  onTestFinished(async () => {
    unsubscribe();
    await cleanup.close();
    rmSync(home, { recursive: true, force: true });
  });
  return {
    home,
    store,
    cleanup,
    unsubscribe,
    protect: (value: boolean) => {
      protectedCaller = value;
    },
    sweep: (at = minutes) => {
      minutes = at;
      return cleanup.sweep();
    },
  };
}

test("bootstrap's host toggle prevents collection live, persists, and leaves other hosts enabled", async () => {
  const host = liveCleanupHost();
  const other = liveCleanupHost();
  await host.store.patch({ idleRuntimeCleanup: false });
  expect(loadPersistedConfig(host.home).agents?.idleRuntimeCleanup).toBe(false);
  expect((await host.sweep()).collected).toEqual([]);
  expect((await other.sweep()).collected).toHaveLength(1);
  await host.store.patch({ idleRuntimeCleanup: true });
  host.protect(true);
  expect((await host.sweep()).collected).toEqual([]);
  host.protect(false);
  expect((await host.sweep(62)).collected).toEqual([]);
  expect((await host.sweep(122)).collected).toHaveLength(1);
});

test("bootstrap's config-file reload binding disables and enables eligible collection live", async () => {
  const host = liveCleanupHost();
  for (const enabled of [false, true]) {
    writeFileSync(
      path.join(host.home, "config.json"),
      JSON.stringify({ version: 1, agents: { idleRuntimeCleanup: enabled } }),
    );
    expect(await host.store.reload()).toEqual({
      appliedPaths: ["agents.idleRuntimeCleanup"],
      restartRequiredPaths: [],
      overrideControlledPaths: [],
    });
    expect((await host.sweep()).collected).toHaveLength(enabled ? 1 : 0);
  }
});

test.each([false, true])(
  "failed config apply restores prior idle cleanup behavior (previous: %s)",
  async (previous) => {
    const host = liveCleanupHost();
    await host.store.patch({ idleRuntimeCleanup: previous });
    const persistedBefore = loadPersistedConfig(host.home);
    const refuse = host.store.onApply(() => {
      throw new Error("Another live owner refused");
    });
    await expect(host.store.patch({ idleRuntimeCleanup: !previous })).rejects.toThrow(
      "Another live owner refused",
    );
    expect(host.store.get().idleRuntimeCleanup).toBe(previous);
    expect(loadPersistedConfig(host.home)).toEqual(persistedBefore);
    expect((await host.sweep()).collected).toHaveLength(previous ? 1 : 0);
    refuse();
  },
);

test("disposing bootstrap's binding stops configuration delivery", async () => {
  const host = liveCleanupHost();
  host.unsubscribe();
  await host.store.patch({ idleRuntimeCleanup: false });
  expect((await host.sweep()).collected).toHaveLength(1);
});
