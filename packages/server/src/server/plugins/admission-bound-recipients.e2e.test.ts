import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AdmissionJournalRecord } from "./admission-journal.js";
import { test, expect, vi } from "vitest";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { createTestAgentClient } from "../test-utils/fake-agent-client.js";
import { DaemonClient } from "../test-utils/daemon-client.js";

const source = `
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { writeFile } from "node:fs/promises";
export default function contribute(server) {
  const events = [];
  server.before("agent.session_open", () => {});
  server.before("agent.create", ({ request }) => {
    if (request.origin.kind === "plugin" && request.origin.pluginId === "scoped") return { ...request, bindingIntent: { scoped: true } };
  });
  server.handle(defineRpc({ name: "create", input: z.object({ path: z.string() }), output: z.unknown() }), async (input, { paseo }) => {
    const workspace = await paseo.workspaces.create({ source: { kind: "directory", path: input.path } });
    const agent = await workspace.agents.create({ config: { provider: "claude/haiku" } });
    return { agentId: agent.id };
  });
  server.on("agent.session_opened", event => { events.push(event); });
  server.handle(defineRpc({ name: "events", input: z.object({}), output: z.unknown() }), () => events);
  server.handle(defineRpc({ name: "census", input: z.object({}), output: z.unknown() }), () => server.inventory.read());
  server.handle(defineRpc({ name: "bind", input: z.object({ agentId: z.string() }), output: z.unknown() }),
    ({ agentId }) => server.agents.bindings.set(agentId, { scoped: true }, { expectRevision: null }));
  return async () => { CLEANUP };
}`;

test("subject delivery replays the original outcome without provider effects and releases only own recipients", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "bound-replay-"));
  vi.stubEnv("PASEO_HOME", path.join(root, "home"));
  vi.stubEnv("FLEET_TOWN_STATE_DIR", path.join(root, "fleet-state"));
  const directory = path.join(root, "plugin");
  await mkdir(directory);
  const stopping = path.join(root, "stopping");
  await writeFile(
    path.join(directory, "paseo-plugin.json"),
    JSON.stringify({
      id: "scoped",
      requirements: { paseo: ">=0.12.0" },
      admission: {
        recipients: "bound-agents",
        durableEvents: true,
        fence: "bound-agents",
        fenceWaitMs: 40,
      },
    }),
  );
  await writeFile(
    path.join(directory, "index.server.ts"),
    source.replace(
      "CLEANUP",
      `await writeFile(${JSON.stringify(stopping)}, "stopping"); await new Promise(r => setTimeout(r, 400));`,
    ),
  );
  let effects = 0;
  const provider = createTestAgentClient("claude", {
    beforeCreateSession: async () => {
      effects++;
    },
  });
  const resumeSpy = vi.spyOn(provider, "resumeSession");
  const options = {
    paseoHomeRoot: path.join(root, "daemon"),
    cleanup: false,
    agentClients: { claude: provider },
    pluginsEnabled: true,
    plugins: {
      scoped: { source: "directory" as const, path: directory, enabled: true },
    },
  };
  let daemon = await createTestPaseoDaemon(options);
  let client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  try {
    await client.connect();
    const own = await client.createAgent({ provider: "claude", cwd: root });
    const foreign = await client.createAgent({ provider: "claude", cwd: root });
    await client.invokePluginRpc("scoped", "bind", { agentId: own.id });
    await client.refreshAgent(own.id);
    const records = await journalRecords(daemon.paseoHome);
    expect(
      records
        .filter((record) => record.agentId === foreign.id)
        .every((record) => !record.undeliveredTo.includes("scoped")),
    ).toBe(true);
    const original = records.find(
      (record) => record.agentId === own.id && record.reason === "refresh",
    )!;
    expect(original.undeliveredTo).toEqual(["scoped"]);
    expect(original.boundRecipients?.scoped?.revision).toBe(1);
    const census = (await client.invokePluginRpc("scoped", "census", {})) as {
      complete: boolean;
      admissions: AdmissionJournalRecord[];
    };
    expect(census.complete).toBe(true);
    expect(
      census.admissions.filter((record) => record.undeliveredTo.includes("scoped")),
    ).toHaveLength(1);
    const born = (await client.invokePluginRpc("scoped", "create", {
      path: root,
    })) as { agentId: string };
    expect(
      (await journalRecords(daemon.paseoHome)).find((record) => record.agentId === born.agentId),
    ).toMatchObject({
      reason: "create",
      status: "opened",
      undeliveredTo: ["scoped"],
      boundRecipients: { scoped: { revision: 1 } },
    });
    await client.close();
    await daemon.close();
    const beforeRestart = effects;
    const resumesBeforeRestart = resumeSpy.mock.calls.length;
    daemon = await createTestPaseoDaemon(options);
    client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
    await client.connect();
    await expect
      .poll(async () => client.invokePluginRpc("scoped", "events", {}))
      .toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            operation: expect.objectContaining({ id: original.id }),
            persistence: original.effect!.persistence,
          }),
        ]),
      );
    expect(effects).toBe(beforeRestart);
    expect(resumeSpy).toHaveBeenCalledTimes(resumesBeforeRestart);
    await client.refreshAgent(own.id);
    await rm(stopping, { force: true });
    const reload = client.reloadPlugin("scoped");
    await expect.poll(() => readFile(stopping, "utf8").catch(() => "")).toBe("stopping");
    const beforeBlocked = effects;
    const resumesBeforeBlocked = resumeSpy.mock.calls.length;
    await expect(client.refreshAgent(own.id)).rejects.toMatchObject({
      code: "PLUGIN_ADMISSION_UNAVAILABLE",
    });
    expect(effects).toBe(beforeBlocked);
    expect(resumeSpy).toHaveBeenCalledTimes(resumesBeforeBlocked);
    await reload;
    await client.disablePlugin("scoped");
    await expect(client.refreshAgent(own.id)).rejects.toMatchObject({
      code: "PLUGIN_ADMISSION_UNAVAILABLE",
    });
    await client.refreshAgent(foreign.id);
    const pending = (await journalRecords(daemon.paseoHome)).filter((record) =>
      record.undeliveredTo.includes("scoped"),
    );
    expect(pending.length).toBeGreaterThan(0);
    expect(
      pending.every((record) => record.agentId === own.id || record.agentId === born.agentId),
    ).toBe(true);
    await client.removePlugin("scoped", "probe completed");
    expect(
      (await journalRecords(daemon.paseoHome)).filter((record) =>
        record.undeliveredTo.includes("scoped"),
      ),
    ).toEqual([]);
    expect(
      (await journalRecords(daemon.paseoHome)).find((record) => record.id === original.id),
    ).toMatchObject({
      effect: original.effect,
      recipientReleases: [
        {
          pluginId: "scoped",
          reason: "probe completed",
          origin: { kind: "client" },
        },
      ],
    });
    await expect(client.refreshAgent(own.id)).rejects.toMatchObject({
      code: "PLUGIN_ADMISSION_UNAVAILABLE",
    });
  } finally {
    await client.close();
    await daemon.close();
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
}, 90_000);

async function journalRecords(home: string): Promise<AdmissionJournalRecord[]> {
  const content = await readFile(
    path.join(home, "admissions", new Date().toISOString().slice(0, 10) + ".jsonl"),
    "utf8",
  );
  const records = new Map<string, AdmissionJournalRecord>();
  for (const line of content.trim().split("\n")) {
    const record = JSON.parse(line) as AdmissionJournalRecord;
    records.set(record.id, record);
  }
  return [...records.values()];
}
