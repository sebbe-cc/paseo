import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { expect, test, vi } from "vitest";
import {
  HostFenceTokenSchema,
  HostInventoryPageSchema,
  HostWatermarkResultSchema,
} from "@getpaseo/plugin/server";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { createTestAgentClient } from "../test-utils/fake-agent-client.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createRequire } from "node:module";
import type { AgentSession, AgentStreamEvent } from "../agent/agent-sdk-types.js";

const entry = `
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
export default function contribute(server) {
  for (const name of ["read", "watermark", "fence"]) server.handle(defineRpc({ name, input: z.unknown(), output: z.unknown() }),
    input => name === "read" ? server.inventory.read(input) : server.inventory[name]());
  server.handle(defineRpc({ name: "bind", input: z.object({ agentId: z.string() }), output: z.unknown() }),
    input => server.agents.bindings.set(input.agentId, { managed: true }, { expectRevision: null }));
  server.handle(defineRpc({ name: "read-error", input: z.unknown(), output: z.unknown() }), async () => {
    try { await server.inventory.read(); return null; } catch (error) { return { code: error.code }; }
  });
  server.handle(defineRpc({ name: "bind-error", input: z.object({ agentId: z.string() }), output: z.unknown() }), async input => {
    try { await server.agents.bindings.set(input.agentId, { managed: true }, { expectRevision: 1 }); return null; }
    catch (error) { return { code: error.code }; }
  });
  server.before("agent.session_open", () => {});
  return () => {};
}`;

test.skipIf(process.platform !== "linux" && process.platform !== "darwin").each([false, true])(
  "daemon survives native EX contention; queue saturation=%s is isolated to its turn",
  async (saturate) => {
    const root = await mkdtemp(path.join(tmpdir(), "host-fence-stream-"));
    vi.stubEnv("PASEO_HOME", path.join(root, "home"));
    vi.stubEnv("FLEET_TOWN_STATE_DIR", path.join(root, "town"));
    const provider = createTestAgentClient("claude");
    const create = provider.createSession.bind(provider);
    const sessions: AgentSession[] = [];
    const emitters: Array<(event: AgentStreamEvent) => void> = [];
    provider.createSession = async (...args) => {
      const session = await create(...args);
      const subscribe = session.subscribe.bind(session);
      session.subscribe = (callback) => {
        emitters.push(callback);
        return subscribe(callback);
      };
      sessions.push(session);
      return session;
    };
    const daemon = await createTestPaseoDaemon({
      agentClients: { claude: provider },
      paseoHomeRoot: path.join(root, "home"),
    });
    const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
    let publisher: ReturnType<typeof spawn> | undefined;
    let exited: Promise<unknown> | undefined;
    try {
      await writeFile(
        path.join(root, "paseo-plugin.json"),
        JSON.stringify({ id: "inventory", requirements: { paseo: ">=0.12.0" } }),
      );
      await writeFile(path.join(root, "index.server.ts"), entry);
      await client.connect();
      await client.patchDaemonConfig({ pluginsEnabled: true });
      await client.installDirectoryPlugin(root);
      const first = await client.createAgent({ provider: "claude", cwd: root });
      const other = await client.createAgent({ provider: "claude", cwd: root });
      emitters[0]({ type: "turn_started", provider: "claude", turnId: "fence-turn" });
      await daemon.daemon.agentManager.flush();
      await daemon.daemon.agentStorage.flush();
      expect(daemon.daemon.agentManager.getAgent(first.id)?.lifecycle).toBe("running");
      const interrupt = vi.spyOn(sessions[0], "interrupt");
      const otherInterrupt = vi.spyOn(sessions[1], "interrupt");
      const fence = HostFenceTokenSchema.parse(
        await client.invokePluginRpc("inventory", "fence", {}),
      );
      publisher = spawn(
        process.execPath,
        [
          "-e",
          `
const { openSync, closeSync } = require("node:fs");
const { flockSync } = require(process.argv[2]);
const fd = openSync(process.argv[1], "r+");
flockSync(fd, "exnb");
process.stdout.write("locked\\n");
const timeout = setTimeout(() => process.exit(2), 10000);
process.stdin.resume();
process.stdin.on("end", () => { clearTimeout(timeout); closeSync(fd); });
`,
          fence.lock.path,
          createRequire(import.meta.url).resolve("fs-ext"),
        ],
        { stdio: ["pipe", "pipe", "pipe"] },
      );
      exited = once(publisher, "exit");
      await new Promise<void>((resolve, reject) => {
        publisher!.stdout!.once("data", () => resolve());
        publisher!.once("error", reject);
        publisher!.once("exit", () => reject(new Error("Publisher failed before lock")));
      });
      const emit = (index: number, text: string) =>
        emitters[index]({
          type: "timeline",
          provider: "claude",
          item: { type: "assistant_message", text, messageId: text.slice(0, 20) },
        });
      if (saturate) {
        for (let i = 0; i < 40; i++) emit(0, `${i}:` + "x".repeat(64_000));
        await vi.waitFor(() => expect(interrupt).toHaveBeenCalledTimes(1));
      } else {
        emit(0, "first");
        emit(0, "second");
        emit(0, "third");
      }
      emit(1, "other agent");
      // Both RPC traffic and the event loop keep responding while no host
      // mutation may cross the other process's publication fence.
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(daemon.daemon.agentManager.getTimeline(first.id)).toEqual([]);
      expect(daemon.daemon.agentManager.getTimeline(other.id)).toEqual([]);
      expect(await client.invokePluginRpc("inventory", "read-error", {})).toBeNull();
      expect(daemon.daemon.agentStorage.inventoryClock!.snapshot()).toEqual(fence.watermark);
      expect(otherInterrupt).not.toHaveBeenCalled();
      publisher.stdin!.end();
      await exited;
      await daemon.daemon.agentManager.flush();
      await vi.waitFor(() =>
        expect(daemon.daemon.agentManager.getTimeline(first.id).length).toBe(saturate ? 1 : 3),
      );
      const firstText = daemon.daemon.agentManager
        .getTimeline(first.id)
        .filter((item) => item.type === "assistant_message")
        .map((item) => item.text);
      if (saturate) {
        expect(firstText).toEqual([expect.stringContaining("HOST_FENCE_SATURATED")]);
      } else {
        expect(firstText).toEqual(["first", "second", "third"]);
        expect(interrupt).not.toHaveBeenCalled();
      }
      expect(daemon.daemon.agentManager.getTimeline(other.id)).toEqual([
        expect.objectContaining({ text: "other agent" }),
      ]);
      await daemon.daemon.agentStorage.flush();
      const census = HostInventoryPageSchema.parse(
        await client.invokePluginRpc("inventory", "read", {}),
      );
      expect(census.agents.map((agent) => agent.agentId).sort()).toEqual(
        [first.id, other.id].sort(),
      );
      expect(census.watermark.activeWriters).toBe(0);
      expect(census.watermark.sequence).toBeGreaterThan(fence.watermark.sequence);
      if (!saturate) {
        emitters[0]({ type: "turn_completed", provider: "claude", turnId: "fence-turn" });
        await daemon.daemon.agentManager.flush();
      }
      const resumed: AgentStreamEvent[] = [];
      for await (const event of daemon.daemon.agentManager.streamAgent(
        first.id,
        "resume after publication",
      ))
        resumed.push(event);
      expect(resumed.some((event) => event.type === "turn_completed")).toBe(true);
      expect(daemon.daemon.agentManager.getAgent(first.id)?.lifecycle).toBe("idle");
    } finally {
      publisher?.stdin?.end();
      if (exited) await exited;
      await client.close();
      await daemon.close();
      vi.unstubAllEnvs();
      await rm(root, { recursive: true, force: true });
    }
  },
  120_000,
);

test.skipIf(process.platform !== "linux" && process.platform !== "darwin")(
  "native plugin inventory RPC observes durable bindings, provider opens and lifecycle revocation",
  async () => {
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
      const fence = HostFenceTokenSchema.parse(
        await client.invokePluginRpc("inventory", "fence", {}),
      );
      const { openSync, closeSync } = await import("node:fs");
      const { flockSync } = await import("fs-ext");
      const publication = openSync(fence.lock.path, "r+");
      flockSync(publication, "exnb");
      const binding = client.invokePluginRpc("inventory", "bind-error", { agentId: agent.id });
      try {
        await new Promise((resolve) => setTimeout(resolve, 100));
      } finally {
        closeSync(publication);
      }
      expect(await binding).toBeNull();
      expect((await read()).watermark.sequence).toBeGreaterThan(fence.watermark.sequence);
      pauseCreate = true;
      const creating = client.createAgent({ provider: "claude", cwd: root });
      await createEntered;
      try {
        expect(await client.invokePluginRpc("inventory", "read-error", {})).toEqual({
          code: "HOST_INVENTORY_BUSY",
        });
        expect((await watermark()).watermark.activeWriters).toBeGreaterThan(0);
        const pendingPublication = openSync(fence.lock.path, "r+");
        try {
          expect(() => flockSync(pendingPublication, "exnb")).toThrow();
        } finally {
          closeSync(pendingPublication);
        }
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
      const token = HostFenceTokenSchema.parse(
        await client.invokePluginRpc("inventory", "fence", {}),
      );
      expect(token.watermark).toEqual(afterRefresh.watermark);
      const { stat } = await import("node:fs/promises");
      const lockStat = await stat(token.lock.path, { bigint: true });
      expect(token.lock.inode).toBe(String(lockStat.ino));
      expect(token.lock.device).toBe(String(lockStat.dev));
      expect(token.watermark.productionFence).toBe(false);
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
  },
  60_000,
);
