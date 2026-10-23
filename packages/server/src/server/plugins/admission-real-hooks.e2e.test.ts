import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { createTestAgentClient } from "../test-utils/fake-agent-client.js";
import { DaemonClient } from "../test-utils/daemon-client.js";

// Fleet integration: use the installed hook implementations, including the real
// gascity agents.ref().refresh() RPC. Only provider I/O and credentials are fake.
const bifrost = process.env.PASEO_TEST_BIFROST_PLUGIN;
const gascity = process.env.PASEO_TEST_GASCITY_PLUGIN;
test.skipIf(!bifrost || !gascity)(
  "history and GC resume survive the installed Bifrost/resume-env hook chain",
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "admission-real-hooks-"));
    const gcRoot = path.join(root, "gc-data");
    vi.stubEnv("FLEET_TOWN_STATE_DIR", path.join(root, "town"));
    vi.stubEnv("PASEO_HOME", path.join(root, ".paseo"));
    vi.stubEnv("BIFROST_VK", "isolated-test-key");
    const plugin = path.join(root, "gascity");
    await mkdir(path.join(plugin, "server"), { recursive: true });
    await copyFile(
      path.join(gascity!, "server/resume-env.ts"),
      path.join(plugin, "server/resume-env.ts"),
    );
    await writeFile(
      path.join(plugin, "paseo-plugin.json"),
      JSON.stringify({
        id: "gascity",
        requirements: { paseo: ">=0.12.0" },
      }),
    );
    await writeFile(
      path.join(plugin, "index.server.ts"),
      `
import { registerResumeEnv } from "./server/resume-env.ts";
export default function contribute(server) {
  const dispose = registerResumeEnv(server, {root:${JSON.stringify(gcRoot)}});
  // Force ordinary outcome acknowledgement during the real hook chain. This
  // advances the native clock without changing the pending operation/binding.
  const stop = server.before("agent.session_open", async ({request}) => {
    if (request.reason !== "resume") return;
    const prior = await server.admissions.query({agentId:request.agentId, status:["opened"]});
    if (prior.length) await server.admissions.ack(prior[0].id);
  });
  return () => {dispose(); stop();};
}`,
    );
    const provider = createTestAgentClient("codex", { supportsMcpServers: true });
    const resumes = vi.spyOn(provider, "resumeSession");
    const options = {
      paseoHomeRoot: root,
      cleanup: false,
      agentClients: { codex: provider },
      pluginsEnabled: true,
      plugins: {
        gascity: { source: "directory" as const, path: plugin, enabled: true },
        "zz-bifrost": { source: "directory" as const, path: bifrost!, enabled: true },
      },
    };
    let daemon = await createTestPaseoDaemon(options);
    let client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
    try {
      await client.connect();
      const agent = await client.createAgent({
        provider: "codex",
        cwd: root,
        labels: { "gc-city": "isolated", "gc-session": "worker" },
      });
      const session = path.join(gcRoot, "isolated/sessions/worker");
      await mkdir(session, { recursive: true });
      await writeFile(path.join(session, "agent"), agent.id);
      await writeFile(
        path.join(session, "env"),
        "BEADS_ACTOR='isolated-worker'\nGC_SESSION_NAME='worker'\n",
      );
      const stored = (await daemon.daemon.agentStorage.get(agent.id))!;
      await daemon.daemon.agentManager.closeAgent(agent.id);
      await daemon.daemon.agentManager.flush();
      await daemon.daemon.agentStorage.upsert({
        ...stored,
        archivedAt: new Date().toISOString(),
        lastStatus: "closed",
      });
      await client.close();
      await daemon.close();
      daemon = await createTestPaseoDaemon(options);
      client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
      await client.connect();
      for (const id of ["gascity", "zz-bifrost"])
        expect(
          (await client.getPluginLogs(id)).some((log) => log.message.includes("Plugin ready")),
        ).toBe(true);
      await client.fetchAgentTimeline(agent.id, { limit: 1 });
      expect(
        resumes.mock.calls.some((call) => call[2]?.env?.BEADS_ACTOR === "isolated-worker"),
      ).toBe(true);
      await daemon.daemon.agentManager.closeAgent(agent.id);
      await daemon.daemon.agentManager.flush();
      expect(resumes.mock.calls.at(-1)?.[2]?.env?.OPENAI_BASE_URL).toBeUndefined();
      await daemon.daemon.agentStorage.upsert({
        ...stored,
        archivedAt: null,
        lastStatus: "closed",
      });
      const before = resumes.mock.calls.length;
      await client.sendAgentMessage(agent.id, "Return a short acknowledgement");
      expect(resumes.mock.calls.length).toBe(before + 1);
      const env = resumes.mock.calls.at(-1)?.[2]?.env;
      expect(env).toMatchObject({
        BEADS_ACTOR: "isolated-worker",
        GC_SESSION_NAME: "worker",
        BIFROST_MCP_KEY: "isolated-test-key",
      });
      expect((await daemon.daemon.agentStorage.get(agent.id))!.persistence?.sessionId).toBe(
        stored.persistence!.sessionId,
      );
    } finally {
      await client.close();
      await daemon.close();
      vi.unstubAllEnvs();
      await rm(root, { recursive: true, force: true });
    }
  },
  60000,
);
