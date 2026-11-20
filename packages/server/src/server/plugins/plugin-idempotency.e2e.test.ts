import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";
import { resolveDaemonVersion } from "../daemon-version.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { createTestAgentClient, createTestAgentClients } from "../test-utils/fake-agent-client.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

// Mirrors paseo-workflows' PaseoPort: one keyed worktree workspace per run and one
// keyed agent per start, found again by label.
const KEYED_SERVER = `import { defineRpc } from "@getpaseo/plugin";
import { type PluginServerContext } from "@getpaseo/plugin/server";
import { z } from "zod";

const ensure = defineRpc({
  name: "ensure",
  input: z.object({ cwd: z.string(), base: z.string(), branch: z.string(), key: z.string() }),
  output: z.object({ workspaceId: z.string() }),
});
const start = defineRpc({
  name: "start",
  input: z.object({ workspaceId: z.string(), key: z.string() }),
  output: z.object({ agentId: z.string() }),
});
const find = defineRpc({
  name: "find",
  input: z.object({ op: z.string() }),
  output: z.object({ agentIds: z.array(z.string()) }),
});

export default function contribute(server: PluginServerContext) {
  server.handle(ensure, async ({ cwd, base, branch, key }, { paseo }) => {
    const workspace = await paseo.workspaces.create({
      idempotencyKey: key,
      title: branch,
      source: { kind: "worktree", cwd, action: "branch-off", refName: base, branchName: branch },
    });
    return { workspaceId: workspace.id };
  });
  server.handle(start, async ({ workspaceId, key }, { paseo }) => {
    const workspace = paseo.workspaces.ref(workspaceId);
    await workspace.refresh();
    const agent = await workspace.agents.create({
      idempotencyKey: key,
      labels: { "paseo-workflows/op": key },
      config: { provider: "pi/test" },
    });
    return { agentId: agent.id };
  });
  server.handle(find, async ({ op }, { paseo }) => {
    const result = await paseo.agents.list({
      filter: { labels: { "paseo-workflows/op": op } },
      page: { limit: 10 },
    });
    return { agentIds: result.entries.map((entry) => entry.agent.id) };
  });
  return () => undefined;
}`;

async function gitRepo(): Promise<{ repo: string; base: string }> {
  const repo = await mkdtemp(path.join(tmpdir(), "idem-repo-"));
  roots.push(repo);
  await execFileAsync("git", ["init", "-q", "-b", "main", repo]);
  await execFileAsync("git", [
    "-C",
    repo,
    "-c",
    "user.email=t@example.invalid",
    "-c",
    "user.name=t",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "base",
  ]);
  const { stdout } = await execFileAsync("git", ["-C", repo, "rev-parse", "HEAD"]);
  return { repo, base: stdout.trim() };
}

async function writePlugin(id: string, server: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), `${id}-plugin-`));
  roots.push(directory);
  await writeFile(
    path.join(directory, "paseo-plugin.json"),
    JSON.stringify({ id, requirements: { paseo: `>=${resolveDaemonVersion(import.meta.url)}` } }),
  );
  await writeFile(path.join(directory, "index.server.ts"), server);
  return directory;
}

test("workspace and agent idempotency keys survive a plugin process restart", async () => {
  const { repo, base } = await gitRepo();
  const pluginDirectory = await writePlugin("idem", KEYED_SERVER);
  const daemon = await createTestPaseoDaemon({
    agentClients: { ...createTestAgentClients(), pi: createTestAgentClient("pi") },
  });
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws`, appVersion: "0.4.0" });
  try {
    await client.connect();
    await client.patchDaemonConfig({ pluginsEnabled: true });
    await client.installDirectoryPlugin(pluginDirectory);
    const rpc = (method: string, input: unknown) => client.invokePluginRpc("idem", method, input);
    const ensure = { cwd: repo, base, branch: "wf/cm-12-1", key: "cm-12#1/worktree" };

    const workspace = (await rpc("ensure", ensure)) as { workspaceId: string };
    const first = (await rpc("start", {
      workspaceId: workspace.workspaceId,
      key: "cm-12#1/implement/1",
    })) as {
      agentId: string;
    };

    // A new plugin process stands in for a crash between the call and the DBOS checkpoint.
    await client.reloadPlugin("idem");

    await expect(rpc("ensure", ensure)).resolves.toEqual(workspace);
    await expect(
      rpc("start", { workspaceId: workspace.workspaceId, key: "cm-12#1/implement/1" }),
    ).resolves.toEqual(first);
    const second = (await rpc("start", {
      workspaceId: workspace.workspaceId,
      key: "cm-12#1/implement/2",
    })) as {
      agentId: string;
    };
    expect(second.agentId).not.toBe(first.agentId);
    await expect(
      rpc("start", { workspaceId: workspace.workspaceId, key: "cm-12#1/implement/2" }),
    ).resolves.toEqual(second);
    await expect(rpc("find", { op: "cm-12#1/implement/1" })).resolves.toEqual({
      agentIds: [first.agentId],
    });
  } finally {
    await client.close();
    await daemon.close();
  }
});

const BACKGROUND_SERVER = `import { defineRpc } from "@getpaseo/plugin";
import { type PluginServerContext } from "@getpaseo/plugin/server";
import { z } from "zod";

const probe = defineRpc({
  name: "probe",
  input: z.object({}),
  output: z.object({ sameApi: z.boolean(), listed: z.boolean() }),
});

export default function contribute(server: PluginServerContext) {
  const background = server.paseo;
  // Runs before any handler or hook: background work such as workflow recovery.
  const listed = background.agents.list({ page: { limit: 1 } }).then(() => true, () => false);
  server.handle(probe, async (_input, { paseo }) => ({ sameApi: paseo === background, listed: await listed }));
  return () => undefined;
}`;

test("contributions get the plugin process's Paseo API before any handler runs", async () => {
  const pluginDirectory = await writePlugin("background", BACKGROUND_SERVER);
  const daemon = await createTestPaseoDaemon({ agentClients: createTestAgentClients() });
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws`, appVersion: "0.4.0" });
  try {
    await client.connect();
    await client.patchDaemonConfig({ pluginsEnabled: true });
    await client.installDirectoryPlugin(pluginDirectory);
    await expect(client.invokePluginRpc("background", "probe", {})).resolves.toEqual({
      sameApi: true,
      listed: true,
    });
  } finally {
    await client.close();
    await daemon.close();
  }
});
