import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { expect, test, vi } from "vitest";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { createTestAgentClient } from "../test-utils/fake-agent-client.js";
import { DaemonClient } from "../test-utils/daemon-client.js";

const exec = promisify(execFile);
test.skipIf(process.platform !== "linux" && process.platform !== "darwin")(
  "session hook publishes under process EX; concurrent native CAS aborts before provider effect",
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "admission-boundary-live-"));
    vi.stubEnv("FLEET_TOWN_STATE_DIR", path.join(root, "town"));
    let effects = 0;
    const provider = createTestAgentClient("claude", {
      beforeCreateSession: async () => {
        effects++;
      },
    });
    const resumes = vi.spyOn(provider, "resumeSession");
    const daemon = await createTestPaseoDaemon({ agentClients: { claude: provider } });
    const url = `ws://127.0.0.1:${daemon.port}/ws`;
    const client = new DaemonClient({ url });
    const hold = path.join(root, "hold"),
      entered = path.join(root, "entered"),
      release = path.join(root, "release");
    try {
      await writeFile(
        path.join(root, "paseo-plugin.json"),
        JSON.stringify({
          id: "boundary",
          requirements: { paseo: ">=0.12.0" },
        }),
      );
      await writeFile(
        path.join(root, "index.server.ts"),
        `
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, writeFileSync } from "node:fs";
export default function contribute(server) {
  server.handle(defineRpc({name:"bind", input:z.object({id:z.string()}), output:z.unknown()}),
    ({id}) => server.agents.bindings.set(id, {race:true}, {expectRevision:null}));
  server.handle(defineRpc({name:"observe", input:z.object({id:z.string()}), output:z.unknown()}),
    ({id}) => server.agents.bindings.observe(id));
  server.handle(defineRpc({name:"cas", input:z.object({id:z.string(), options:z.unknown()}), output:z.unknown()}),
    ({id, options}) => server.agents.bindings.setWithProof(id, {original:true}, options));
  server.before("agent.session_open", async () => {
    const token = await server.inventory.fence();
    await promisify(execFile)("python3", ["-c",
      "import fcntl,sys; f=open(sys.argv[1], 'r+'); fcntl.flock(f, fcntl.LOCK_EX|fcntl.LOCK_NB)", token.lock.path]);
    if (existsSync(${JSON.stringify(hold)})) {
      writeFileSync(${JSON.stringify(entered)}, "ready");
      const deadline = Date.now()+10000;
      while (!existsSync(${JSON.stringify(release)})) {
        if (Date.now()>deadline) throw new Error("barrier timeout");
        await new Promise(r=>setTimeout(r,10));
      }
    }
  });
  return () => {};
}`,
      );
      await client.connect();
      await client.patchDaemonConfig({ pluginsEnabled: true });
      await client.installDirectoryPlugin(root);
      const first = await client.createAgent({ provider: "claude", cwd: root });
      expect(effects).toBe(1);
      await daemon.daemon.agentManager.closeAgent(first.id);
      await daemon.daemon.agentManager.flush();
      await writeFile(hold, "hold");
      const opening = client.fetchAgentTimeline(first.id);
      const rejected = expect(opening).rejects.toThrow(/Host state changed/);
      await expect.poll(() => readFile(entered, "utf8").catch(() => "")).toBe("ready");
      // Separate process -> authenticated host IPC -> real native record writer.
      const source = `import {DaemonClient} from ${JSON.stringify(fileURLToPath(new URL("../test-utils/daemon-client.ts", import.meta.url)))};
        const client = new DaemonClient({url:${JSON.stringify(url)}, clientId:"boundary-writer"});
        await client.connect();
        try { await client.invokePluginRpc("boundary", "bind", {id:${JSON.stringify(first.id)}}); }
        finally { await client.close(); }`;
      await exec(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], {
        timeout: 10000,
        env: {
          ...process.env,
          PASEO_HOME: daemon.paseoHome,
          FLEET_TOWN_STATE_DIR: path.join(root, "town"),
        },
      });
      await writeFile(release, "release");
      await rejected;
      expect(effects).toBe(1);
      expect(resumes).not.toHaveBeenCalled();
      await rm(release);
      await rm(entered);
      const retrying = client.fetchAgentTimeline(first.id);
      void retrying.catch(() => {});
      await expect.poll(() => readFile(entered, "utf8").catch(() => "")).toBe("ready");
      // Metadata for this same agent is not its admission authority.
      await daemon.daemon.agentStorage.setTitle(first.id, "Refreshed metadata");
      await writeFile(release, "release");
      await retrying;
      expect(resumes).toHaveBeenCalledTimes(1);
      await rm(hold);
      const retried = await client.createAgent({ provider: "claude", cwd: root });
      expect(effects).toBe(2);
      const observed = (await client.invokePluginRpc("boundary", "observe", {
        id: retried.id,
      })) as { state: unknown };
      const request = {
        id: retried.id,
        options: { expectRevision: null, expected: observed.state, operationKey: "c".repeat(64) },
      };
      const proof = await client.invokePluginRpc("boundary", "cas", request);
      expect(await client.invokePluginRpc("boundary", "cas", request)).toEqual(proof);
    } finally {
      await writeFile(release, "release");
      await client.close();
      await daemon.close();
      vi.unstubAllEnvs();
      await rm(root, { recursive: true, force: true });
    }
  },
  60000,
);
