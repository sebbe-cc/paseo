import { createPaseoDaemon } from "../bootstrap.js";
import { BuiltinPluginLoader } from "./builtin/index.js";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { AdmissionJournal } from "./admission-journal.js";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "vitest";
import { z } from "zod";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { createTestAgentClient } from "../test-utils/fake-agent-client.js";

const entry = `
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { writeFile } from "node:fs/promises";
export default function contribute(server) {
  server.before("agent.session_open", () => {});
  server.handle(defineRpc({ name: "bind", input: z.object({ agentId: z.string() }), output: z.unknown() }),
    ({ agentId }) => server.agents.bindings.set(agentId, { fenced: true }, { expectRevision: null }));
  return async () => { CLEANUP };
}`;

test("bound openings fail during reload and failed start while ordinary agents and existing turns survive", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-fence-"));
  const stopped = path.join(directory, "stopping");
  let finishTurn!: () => void;
  const turnHeld = new Promise<void>((resolve) => {
    finishTurn = resolve;
  });
  const provider = createTestAgentClient("claude", { beforeTurnComplete: () => turnHeld });
  const daemon = await createTestPaseoDaemon({ agentClients: { claude: provider } });
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  try {
    await writeFile(
      path.join(directory, "paseo-plugin.json"),
      JSON.stringify({
        id: "fence",
        requirements: { paseo: ">=0.12.0" },
        admission: { fence: "bound-agents", fenceWaitMs: 75, durableEvents: true },
      }),
    );
    await writeFile(
      path.join(directory, "index.server.ts"),
      entry.replace(
        "CLEANUP",
        `await writeFile(${JSON.stringify(stopped)}, "stopping"); await new Promise(r => setTimeout(r, 600));`,
      ),
    );
    await client.connect();
    await client.patchDaemonConfig({ pluginsEnabled: true });
    await client.installDirectoryPlugin(directory);
    const bound = await client.createAgent({ provider: "claude", cwd: directory });
    const ordinary = await client.createAgent({ provider: "claude", cwd: directory });
    const running = await client.createAgent({ provider: "claude", cwd: directory });
    await client.invokePluginRpc("fence", "bind", { agentId: bound.id });
    await client.invokePluginRpc("fence", "bind", { agentId: running.id });
    await client.sendMessage(running.id, "Hold this turn");
    const manager = daemon.daemon.agentManager;
    await expect.poll(() => manager.getAgent(running.id)?.lifecycle).toBe("running");
    const before = manager.getAgent(running.id)!;
    const reload = client.reloadPlugin("fence");
    await expect.poll(() => readFile(stopped, "utf8").catch(() => "")).toBe("stopping");
    await expect(client.refreshAgent(bound.id)).rejects.toMatchObject({
      code: "PLUGIN_ADMISSION_UNAVAILABLE",
    });
    await client.refreshAgent(ordinary.id);
    await reload;
    const after = manager.getAgent(running.id)!;
    expect(after.lifecycle).toBe("running");
    expect(after.session).toBe(before.session);
    expect(after.persistence).toEqual(before.persistence);
    expect(after.activeForegroundTurnId).toBe(before.activeForegroundTurnId);
    finishTurn();
    await expect.poll(() => manager.getAgent(running.id)?.lifecycle).toBe("idle");

    await writeFile(
      path.join(directory, "index.server.ts"),
      'export default function contribute() { throw new Error("startup broken"); }',
    );
    await expect(client.reloadPlugin("fence")).rejects.toThrow("startup broken");
    await expect(client.refreshAgent(bound.id)).rejects.toMatchObject({
      code: "PLUGIN_ADMISSION_UNAVAILABLE",
    });
    await client.refreshAgent(ordinary.id);
    await client.disablePlugin("fence");
    await client.refreshAgent(bound.id);
    const records = (
      await readFile(
        path.join(daemon.paseoHome, "admissions", new Date().toISOString().slice(0, 10) + ".jsonl"),
        "utf8",
      )
    )
      .trim()
      .split("\n")
      .map((line) =>
        z
          .object({ agentId: z.string(), status: z.string(), error: z.unknown() })
          .parse(JSON.parse(line)),
      );
    expect(
      records.filter((record) => record.agentId === bound.id && record.status === "failed"),
    ).toHaveLength(2);
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          error: expect.objectContaining({ code: "PLUGIN_ADMISSION_UNAVAILABLE", stage: "fence" }),
        }),
      ]),
    );
  } finally {
    finishTurn();
    await client.close();
    await daemon.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);

test("restart recovers pending outcomes and fences stored agents before plugins start", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-fence-restart-"));
  let providerCreates = 0;
  const provider = createTestAgentClient("claude", {
    beforeCreateSession: async () => {
      providerCreates++;
    },
  });
  await writeFile(
    path.join(directory, "paseo-plugin.json"),
    JSON.stringify({
      id: "fence",
      requirements: { paseo: ">=0.12.0" },
      admission: { fence: "bound-agents", fenceWaitMs: 30, durableEvents: true },
    }),
  );
  const source = entry.replace("CLEANUP", "").replace("  const events = [];", "");
  await writeFile(
    path.join(directory, "index.server.ts"),
    source.replace(
      "  server.before(",
      '  server.on("agent.session_open_failed", (event) => console.log(JSON.stringify({ failure: event })));\n  server.before(',
    ),
  );
  const first = await createTestPaseoDaemon({
    paseoHomeRoot: directory,
    cleanup: false,
    agentClients: { claude: provider },
    pluginsEnabled: true,
    plugins: { fence: { source: "directory", path: directory, enabled: true } },
  });
  const client = new DaemonClient({ url: `ws://127.0.0.1:${first.port}/ws` });
  let restarted: Awaited<ReturnType<typeof createPaseoDaemon>> | undefined;
  let reconnected: DaemonClient | undefined;
  try {
    await client.connect();
    const bound = await client.createAgent({ provider: "claude", cwd: directory });
    await client.invokePluginRpc("fence", "bind", { agentId: bound.id });
    const stored = (await first.daemon.agentStorage.get(bound.id))!;
    await client.close();
    await first.close();
    const journal = new AdmissionJournal(path.join(first.paseoHome, "admissions"));
    const pending = await journal.begin({
      agent: {
        id: bound.id,
        provider: "claude",
        cwd: directory,
        workspaceId: stored.workspaceId ?? null,
        parentAgentId: null,
        title: null,
      },
      reason: "resume",
      origin: { kind: "daemon", source: "restore" },
      previousEpoch: null,
      recipients: ["fence"],
    });
    restarted = await createPaseoDaemon(first.config, createTestLogger(), {
      builtinPlugins: new BuiltinPluginLoader(undefined, []),
    });
    await expect(
      restarted.agentManager.createAgent({ provider: "claude", cwd: directory }, bound.id, {
        workspaceId: stored.workspaceId,
        origin: { kind: "daemon", source: "schedule" },
      }),
    ).rejects.toMatchObject({ code: "PLUGIN_ADMISSION_UNAVAILABLE" });
    expect(providerCreates).toBe(1);
    await expect(
      restarted.agentManager.resumeAgentFromPersistence(
        stored.persistence!,
        { provider: "claude", cwd: directory },
        bound.id,
      ),
    ).rejects.toMatchObject({ code: "PLUGIN_ADMISSION_UNAVAILABLE" });
    await restarted.agentManager.createAgent({ provider: "claude", cwd: directory }, undefined, {
      workspaceId: stored.workspaceId,
    });
    expect(providerCreates).toBe(2);
    await restarted.start();
    const listen = restarted.getListenTarget();
    if (listen?.type !== "tcp") throw new Error("Expected TCP listener");
    reconnected = new DaemonClient({ url: `ws://127.0.0.1:${listen.port}/ws` });
    await reconnected.connect();
    const connected = reconnected;
    await expect
      .poll(async () =>
        (await connected.getPluginLogs("fence"))
          .filter((log) => log.message.startsWith('{"failure":'))
          .map((log) => JSON.parse(log.message)),
      )
      .toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            failure: expect.objectContaining({
              operation: expect.objectContaining({ id: pending.id }),
              stage: "interrupted",
            }),
          }),
        ]),
      );
    await restarted.agentManager.resumeAgentFromPersistence(
      stored.persistence!,
      { provider: "claude", cwd: directory },
      bound.id,
    );
  } finally {
    await reconnected?.close();
    await restarted?.stop();
    await client.close();
    await first.close();
    await rm(directory, { recursive: true, force: true });
    await rm(first.staticDir, { recursive: true, force: true });
  }
}, 60_000);
