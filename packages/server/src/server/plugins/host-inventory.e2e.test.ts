import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { expect, test, vi } from "vitest";
import { HostInventoryPageSchema, HostWatermarkResultSchema } from "@getpaseo/plugin/server";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { createTestAgentClient } from "../test-utils/fake-agent-client.js";
import { DaemonClient } from "../test-utils/daemon-client.js";

const entry = `
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
export default function contribute(server) {
  for (const name of ["read", "watermark"]) server.handle(defineRpc({ name, input: z.unknown(), output: z.unknown() }),
    input => name === "read" ? server.inventory.read(input) : server.inventory.watermark());
  server.handle(defineRpc({ name: "bind", input: z.object({ agentId: z.string() }), output: z.unknown() }),
    input => server.agents.bindings.set(input.agentId, { managed: true }, { expectRevision: null }));
  server.handle(defineRpc({ name: "read-error", input: z.unknown(), output: z.unknown() }), async () => {
    try { await server.inventory.read(); return null; } catch (error) { return { code: error.code }; }
  });
  server.before("agent.session_open", () => {});
  return () => {};
}`;

test("native plugin inventory RPC observes durable bindings, provider opens and lifecycle revocation", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "host-inventory-native-"));
  vi.stubEnv("FLEET_TOWN_STATE_DIR", path.join(root, "town"));
  let pauseCreate = false;
  let releaseCreate!: () => void;
  let enteredCreate!: () => void;
  const createHeld = new Promise<void>((resolve) => {
    releaseCreate = resolve;
  });
  const createEntered = new Promise<void>((resolve) => {
    enteredCreate = resolve;
  });
  const provider = createTestAgentClient("claude", {
    beforeCreateSession: async () => {
      if (pauseCreate) {
        enteredCreate();
        await createHeld;
      }
    },
  });
  const daemon = await createTestPaseoDaemon({
    agentClients: { claude: provider },
  });
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  try {
    await writeFile(
      path.join(root, "paseo-plugin.json"),
      JSON.stringify({ id: "inventory", requirements: { paseo: ">=0.12.0" } }),
    );
    await writeFile(path.join(root, "index.server.ts"), entry);
    await client.connect();
    await client.patchDaemonConfig({ pluginsEnabled: true });
    await client.installDirectoryPlugin(root);
    const read = async () =>
      HostInventoryPageSchema.parse(await client.invokePluginRpc("inventory", "read", {}));
    const watermark = async () =>
      HostWatermarkResultSchema.parse(await client.invokePluginRpc("inventory", "watermark", {}));
    const agent = await client.createAgent({ provider: "claude", cwd: root });
    const baseline = await read();
    expect(baseline.complete).toBe(true);
    expect(baseline.agents).toEqual(
      expect.arrayContaining([expect.objectContaining({ agentId: agent.id, binding: null })]),
    );
    await client.invokePluginRpc("inventory", "bind", { agentId: agent.id });
    const bound = await read();
    expect(bound.watermark.sequence).toBeGreaterThan(baseline.watermark.sequence);
    expect(bound.agents.find((row) => row.agentId === agent.id)?.binding).toMatchObject({
      revision: 1,
    });
    pauseCreate = true;
    const creating = client.createAgent({ provider: "claude", cwd: root });
    await createEntered;
    try {
      expect(await client.invokePluginRpc("inventory", "read-error", {})).toEqual({
        code: "HOST_INVENTORY_BUSY",
      });
      expect((await watermark()).watermark.activeWriters).toBeGreaterThan(0);
    } finally {
      releaseCreate();
      pauseCreate = false;
      await creating;
    }
    const beforeRefresh = await watermark();
    await client.refreshAgent(agent.id);
    await expect
      .poll(async () => {
        try {
          return (await read()).admissions.filter(
            (row) =>
              row.agentId === agent.id && row.reason === "refresh" && row.status === "opened",
          ).length;
        } catch {
          return 0;
        }
      })
      .toBe(1);
    const afterRefresh = await watermark();
    expect(afterRefresh.watermark.sequence).toBeGreaterThan(beforeRefresh.watermark.sequence);
    expect(afterRefresh.watermark.productionFence).toBe(false);
    expect(afterRefresh.watermark.excluded).toContain("external-capability-revocation");
    const beforeReload = afterRefresh.watermark;
    await client.reloadPlugin("inventory");
    const afterReload = await watermark();
    expect(afterReload.watermark.sequence).toBeGreaterThan(beforeReload.sequence);
    expect(
      afterReload.watermark.changes.some((change) => change.domain === "plugin-lifecycle"),
    ).toBe(true);
    expect(afterReload.local?.path).toBe(
      path.join(daemon.paseoHome, "runtime-inventory", "watermark.json"),
    );
  } finally {
    releaseCreate();
    await client.close();
    await daemon.close();
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
