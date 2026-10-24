import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
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
    const provider = createTestAgentClient("codex", {
      supportsMcpServers: true,
    });
    const claude = createTestAgentClient("claude", {
      supportsMcpServers: true,
    });
    const resumes = vi.spyOn(provider, "resumeSession");
    const snapshotTargets: string[] = [];
    const snapshotRoot = process.env.PASEO_TEST_AGENT_SNAPSHOT;
    if (snapshotRoot) {
      // Read-only production snapshot, sanitized before entering the isolated
      // daemon: never copy env, prompts, credentials, native handles or tools.
      // IDs/provider thread IDs survive; cwd and GC lookup point to this fixture.
      const files = (await readdir(snapshotRoot, { recursive: true })).filter((name) =>
        name.endsWith(".json"),
      );
      expect(files.length).toBeLessThanOrEqual(20000);
      const destination = path.join(root, ".paseo/agents/snapshot");
      await mkdir(destination, { recursive: true, mode: 0o700 });
      for (const file of files) {
        const row = JSON.parse(await readFile(path.join(snapshotRoot, file), "utf8"));
        if (!row.id || !row.provider || !row.persistence?.sessionId) continue;
        const selected = ["4c3fe5c", "d5a82a57", "0834d4d0"].some((prefix) =>
          row.id.startsWith(prefix),
        );
        const labels = selected
          ? { "gc-city": "isolated", "gc-session": `snapshot-${row.id}` }
          : {};
        const copy = {
          id: row.id,
          provider: row.provider,
          cwd: root,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
          lastStatus: "closed",
          archivedAt: row.archivedAt ?? null,
          labels,
          persistence: {
            provider: row.provider,
            sessionId: row.persistence.sessionId,
          },
        };
        await writeFile(path.join(destination, `${row.id}.json`), JSON.stringify(copy), {
          mode: 0o600,
        });
        if (selected) {
          snapshotTargets.push(row.id);
          const session = path.join(gcRoot, "isolated/sessions", `snapshot-${row.id}`);
          await mkdir(session, { recursive: true });
          await writeFile(path.join(session, "agent"), row.id);
          await writeFile(
            path.join(session, "env"),
            "BEADS_ACTOR='isolated-snapshot'\nGC_SESSION_NAME='snapshot'\n",
          );
        }
      }
      expect(snapshotTargets).toHaveLength(3);
    }
    const options = {
      paseoHomeRoot: root,
      cleanup: false,
      agentClients: { codex: provider, claude },
      pluginsEnabled: true,
      plugins: {
        gascity: { source: "directory" as const, path: plugin, enabled: true },
        "zz-bifrost": {
          source: "directory" as const,
          path: bifrost!,
          enabled: true,
        },
      },
    };
    let daemon = await createTestPaseoDaemon(options);
    let client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
    try {
      await client.connect();
      // Reconnecting clients request several old timelines concurrently. These
      // admissions must not reject one another's journal/metadata writes.
      await Promise.all(
        snapshotTargets.map(async (id) => {
          const before = await daemon.daemon.agentStorage.get(id);
          await client.fetchAgentTimeline(id, { limit: 1 });
          // Resume may enrich provider metadata (for example cwd); the durable
          // provider/thread identity must survive the real history hook chain.
          expect((await daemon.daemon.agentStorage.get(id))!.persistence).toMatchObject({
            provider: before!.persistence!.provider,
            sessionId: before!.persistence!.sessionId,
          });
          await daemon.daemon.agentManager.closeAgent(id);
        }),
      );
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
      const publication = vi.spyOn(daemon.daemon.agentStorage, "applySnapshot");
      const admissionCheck = vi.spyOn(daemon.daemon.agentStorage.inventoryClock!, "admission");
      await client.fetchAgentTimeline(agent.id, { limit: 1 });
      // Even purpose=history opens publish native state: registration persists
      // the restored agent and withAdmission commits its durable outcome. They
      // cannot bypass the publication boundary merely because provider I/O is
      // read-only. A warm timeline fetch, in contrast, does neither.
      expect(resumes.mock.calls.at(-1)?.[3]).toMatchObject({ purpose: "history" });
      expect(publication.mock.calls.some(([published]) => published.id === agent.id)).toBe(true);
      expect(admissionCheck).toHaveBeenCalled();
      await daemon.daemon.agentManager.flush();
      publication.mockClear();
      admissionCheck.mockClear();
      const journalFile = path.join(
        daemon.paseoHome,
        "admissions",
        new Date().toISOString().slice(0, 10) + ".jsonl",
      );
      const journalBefore = await readFile(journalFile, "utf8");
      expect(
        journalBefore
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line))
          .some(
            (row) => row.agentId === agent.id && row.reason === "resume" && row.status === "opened",
          ),
      ).toBe(true);
      const resumesBefore = resumes.mock.calls.length;
      await client.fetchAgentTimeline(agent.id, { limit: 1 });
      await daemon.daemon.agentManager.flush();
      expect(resumes).toHaveBeenCalledTimes(resumesBefore);
      expect(publication).not.toHaveBeenCalled();
      expect(admissionCheck).not.toHaveBeenCalled();
      expect(await readFile(journalFile, "utf8")).toBe(journalBefore);
      publication.mockRestore();
      admissionCheck.mockRestore();
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
  120000,
);
