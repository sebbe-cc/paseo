import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { expect, test, vi } from "vitest";

import { createPaseoDaemon, fanOutReconciledWorkspaceUpdates } from "./bootstrap.js";
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
