import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import pino from "pino";
import { expect, test, vi } from "vitest";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { createTestAgentClient } from "../test-utils/fake-agent-client.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { fetchAgentTimelineOnce } from "../../../../app/src/timeline/fetch-agent-timeline-once.js";
import {
  planTimelineTailFetch,
  planTimelineCatchUpAfter,
} from "../../../../app/src/timeline/timeline-sync-plan.js";

const duration = Number(process.env.PASEO_ADMISSION_SOAK_MS ?? 0);
const bifrost = process.env.PASEO_TEST_BIFROST_PLUGIN;
const gascity = process.env.PASEO_TEST_GASCITY_PLUGIN;
const snapshot = process.env.PASEO_TEST_AGENT_SNAPSHOT;

function parseJournalRows(raw: string) {
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

// Opt-in release gate. Uses the app's actual deduplication and projected
// tail/catch-up planners over WebSocket. The live incident showed a peak of
// 12 failing timeline requests/second; this drives 20/second, including cold
// history opens every fifth round, with two active turns and create/resume/ACK.
test.skipIf(!duration || !bifrost || !gascity || !snapshot)(
  "concurrent app timeline polling coexists with active turns and admission publication",
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "admission-concurrency-"));
    console.log(JSON.stringify({ stage: "fixture", root, duration }));
    vi.stubEnv("PASEO_HOME", path.join(root, ".paseo"));
    vi.stubEnv("FLEET_TOWN_STATE_DIR", path.join(root, "town"));
    vi.stubEnv("BIFROST_VK", "isolated-test-key");
    const plugin = path.join(root, "gascity");
    const gcRoot = path.join(root, "gc-data");
    const destination = path.join(root, ".paseo/agents/snapshot");
    await mkdir(destination, { recursive: true, mode: 0o700 });
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
        admission: { durableEvents: true },
      }),
    );
    await writeFile(
      path.join(plugin, "index.server.ts"),
      `
import { registerResumeEnv } from "./server/resume-env.ts";
import { appendFile } from "node:fs/promises";
export default function contribute(server) {
  const dispose = registerResumeEnv(server, {root:${JSON.stringify(gcRoot)}});
  const stop = server.on("agent.session_opened", async ({operation}) => {
    await server.admissions.ack(operation.id);
    await appendFile(${JSON.stringify(path.join(root, "acks.log"))}, operation.id+"\\n");
  });
  return () => {dispose(); stop();};
}`,
    );
    const candidates = [];
    for (const file of await readdir(snapshot!, { recursive: true })) {
      if (!file.endsWith(".json")) continue;
      const row = JSON.parse(await readFile(path.join(snapshot!, file), "utf8"));
      if (row.id && ["codex", "claude"].includes(row.provider) && row.persistence?.sessionId)
        candidates.push(row);
    }
    const named = ["4c3fe5c", "d5a82a57", "0834d4d0"];
    candidates.sort(
      (a, b) =>
        Number(named.some((p) => b.id.startsWith(p))) -
        Number(named.some((p) => a.id.startsWith(p))),
    );
    const selected = candidates.slice(0, 20);
    expect(selected).toHaveLength(20);
    for (const row of selected) {
      const session = `snapshot-${row.id}`;
      // Only native identity, timestamps and archive state enter the fixture.
      // Provider credentials, tools, native handles, prompts and env never do.
      await writeFile(
        path.join(destination, `${row.id}.json`),
        JSON.stringify({
          id: row.id,
          provider: row.provider,
          cwd: root,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
          lastStatus: "closed",
          archivedAt: row.archivedAt ?? null,
          labels: { "gc-city": "isolated", "gc-session": session },
          persistence: { provider: row.provider, sessionId: row.persistence.sessionId },
        }),
        { mode: 0o600 },
      );
      const folder = path.join(gcRoot, "isolated/sessions", session);
      await mkdir(folder, { recursive: true });
      await writeFile(path.join(folder, "agent"), row.id);
      await writeFile(
        path.join(folder, "env"),
        "BEADS_ACTOR='isolated-soak'\nGC_SESSION_NAME='soak'\n",
      );
    }
    let finishTurns!: () => void;
    const turnsHeld = new Promise<void>((resolve) => {
      finishTurns = resolve;
    });
    const providerOptions = { supportsMcpServers: true, beforeTurnComplete: () => turnsHeld };
    const errors: unknown[] = [];
    const logger = pino(
      { level: "error" },
      {
        write(line: string) {
          errors.push(JSON.parse(line));
        },
      },
    );
    const daemon = await createTestPaseoDaemon({
      paseoHomeRoot: root,
      cleanup: false,
      logger,
      agentClients: {
        codex: createTestAgentClient("codex", providerOptions),
        claude: createTestAgentClient("claude", providerOptions),
      },
      pluginsEnabled: true,
      plugins: {
        gascity: { source: "directory", path: plugin, enabled: true },
        "zz-bifrost": { source: "directory", path: bifrost!, enabled: true },
      },
    });
    const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
    const stats = {
      polls: 0,
      rounds: 0,
      cold_opens: 0,
      creates: 0,
      resumes: 0,
      active_turns_min: 2,
      elapsed_ms: 0,
      acks: 0,
    };
    let success = false;
    try {
      await client.connect();
      const active = [];
      for (let i = 0; i < 2; i++) {
        active.push(await client.createAgent({ provider: "codex", cwd: root }));
        await daemon.daemon.agentManager.flush();
        await delay(50); // The initial fixture itself is not the measured burst.
      }
      await Promise.all(
        active.map((agent) => client.sendAgentMessage(agent.id, "Hold this isolated turn")),
      );
      await expect
        .poll(
          () =>
            active.filter((a) => daemon.daemon.agentManager.getAgent(a.id)?.lifecycle === "running")
              .length,
        )
        .toBe(2);
      const start = Date.now();
      const cursors = new Map<string, { epoch: string; seq: number }>();
      while (Date.now() - start < duration) {
        const roundStart = Date.now();
        const cold = stats.rounds % 5 === 0;
        if (cold) {
          await Promise.all(selected.map((row) => daemon.daemon.agentManager.closeAgent(row.id)));
          cursors.clear();
        }
        const running = active.filter(
          (a) => daemon.daemon.agentManager.getAgent(a.id)?.lifecycle === "running",
        ).length;
        stats.active_turns_min = Math.min(stats.active_turns_min, running);
        expect(running).toBe(2);
        const polling = Promise.allSettled(
          selected.map(async (row) => {
            const cursor = cursors.get(row.id);
            const page = await fetchAgentTimelineOnce(
              client,
              row.id,
              cursor ? planTimelineCatchUpAfter(cursor) : planTimelineTailFetch(),
            );
            cursors.set(row.id, page.endCursor ?? { epoch: page.epoch, seq: 0 });
            stats.polls++;
            if (cold) stats.cold_opens++;
          }),
        );
        const lifecycle = cold
          ? (async () => {
              const fresh = await client.createAgent({ provider: "codex", cwd: root });
              stats.creates++;
              await daemon.daemon.agentManager.closeAgent(fresh.id);
              await fetchAgentTimelineOnce(client, fresh.id, planTimelineTailFetch());
              stats.resumes++;
              await daemon.daemon.agentManager.closeAgent(fresh.id);
            })()
          : Promise.resolve();
        const settled = await Promise.allSettled([polling, lifecycle]);
        const polls = settled[0];
        if (polls.status === "rejected") throw polls.reason;
        for (const result of polls.value!) if (result.status === "rejected") throw result.reason;
        if (settled[1].status === "rejected") throw settled[1].reason;
        stats.rounds++;
        expect(errors).toEqual([]);
        if (stats.rounds % 30 === 0)
          console.log(JSON.stringify({ stage: "soak", ...stats, elapsed_ms: Date.now() - start }));
        await delay(Math.max(0, 1000 - (Date.now() - roundStart)));
      }
      stats.elapsed_ms = Date.now() - start;
      // The native journal is the ACK receipt. An RPC reply or the callback's
      // subsequent diagnostic append can be lost after a durable ACK; neither
      // can establish whether the journal mutation actually committed.
      await expect
        .poll(
          async () => {
            const rows = (
              await Promise.all(
                (
                  await readdir(path.join(daemon.paseoHome, "admissions"))
                )
                  .filter((name) => name.endsWith(".jsonl"))
                  .map((name) => readFile(path.join(daemon.paseoHome, "admissions", name), "utf8")),
              )
            ).flatMap(parseJournalRows);
            const latest = new Map(rows.map((row) => [row.id, row]));
            const expected = rows.filter((row) => row.status === "pending");
            expect(expected.every((row) => row.undeliveredTo.includes("gascity"))).toBe(true);
            stats.acks = expected.filter((row) => {
              const receipt = latest.get(row.id)!;
              return receipt.status === "opened" && !receipt.undeliveredTo.includes("gascity");
            }).length;
            return expected.length - stats.acks;
          },
          { timeout: 10000 },
        )
        .toBe(0);
      expect(stats.elapsed_ms).toBeGreaterThanOrEqual(duration);
      expect(stats.polls).toBeGreaterThanOrEqual(Math.max(20, (duration / 1000) * 12));
      expect(stats.acks).toBe(stats.cold_opens + stats.creates + stats.resumes + 2);
      expect(errors).toEqual([]);
      success = true;
    } finally {
      finishTurns();
      await client.close();
      await daemon.close();
      vi.unstubAllEnvs();
      await writeFile(
        path.join(root, "proof.json"),
        JSON.stringify(
          {
            success,
            ...stats,
            errors,
            fixture_only: true,
            native_snapshot_agents: selected.length,
            production_changed: false,
          },
          null,
          2,
        ),
      );
      console.log(
        JSON.stringify({ stage: "finished", root, success, ...stats, errors: errors.length }),
      );
      // Retain private fixture evidence only when requested by the release gate.
      if (!process.env.PASEO_KEEP_SOAK_PROOF) await rm(root, { recursive: true, force: true });
    }
  },
  duration + 60000,
);
