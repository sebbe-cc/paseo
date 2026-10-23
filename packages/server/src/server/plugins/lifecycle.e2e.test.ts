import { z } from "zod";
import { PluginAdmissionRecordSchema } from "@getpaseo/plugin/server";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, onTestFinished, test } from "vitest";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { resolveDaemonVersion } from "../daemon-version.js";

test("a plugin transforms workspace creation once across receipt replays and observes its committed lifecycle", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-lifecycle-"));
  const daemon = await createTestPaseoDaemon({ daemonVersion: "0.8.0" });
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws`, appVersion: "0.8.0" });
  try {
    await writeFile(
      path.join(directory, "paseo-plugin.json"),
      JSON.stringify({ id: "lifecycle", requirements: { paseo: ">=0.8.0" } }),
    );
    await writeFile(
      path.join(directory, "index.server.ts"),
      `
export default function contribute(server) {
  server.before("workspace.create", ({ request }) => {
    console.log(JSON.stringify({ hook: "workspace.before" }));
    return { ...request, title: "Created through a hook" };
  });
  server.on("workspace.created", (event) => {
    console.log(JSON.stringify({ hook: "workspace.created", event }));
  });
  server.on("workspace.archived", (event) => {
    console.log(JSON.stringify({ hook: "workspace.archived", event }));
  });
  return () => {};
}
`,
    );
    await client.connect();
    await client.fetchAgents({ subscribe: {} });
    await client.patchDaemonConfig({ pluginsEnabled: true });
    await client.installDirectoryPlugin(directory);
    const created = await client.createWorkspace({
      idempotencyKey: "plugin-workspace",
      source: { kind: "directory", path: directory },
    });
    expect(created.workspace?.name).toBe("Created through a hook");
    const workspaceId = created.workspace!.id;
    const replay = await client.createWorkspace({
      idempotencyKey: "plugin-workspace",
      source: { kind: "directory", path: directory },
    });
    expect(replay.error).toBeNull();
    expect(replay.workspace?.id).toBe(workspaceId);
    await client.archiveWorkspace(workspaceId);
    await expect
      .poll(async () => {
        const logs = await client.getPluginLogs("lifecycle");
        return logs
          .filter((entry) => {
            return entry.message.startsWith('{"hook":');
          })
          .map((entry) => {
            return JSON.parse(entry.message);
          });
      })
      .toMatchObject([
        { hook: "workspace.before" },
        { hook: "workspace.created", event: { workspace: { id: workspaceId, cwd: directory } } },
        { hook: "workspace.archived", event: { workspace: { id: workspaceId } } },
      ]);
  } finally {
    await client.close();
    await daemon.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);

test("plugins observe turns, answer permissions, and observe archive without blocking the agent", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-turn-hooks-"));
  const daemon = await createTestPaseoDaemon({ daemonVersion: "0.8.0" });
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws`, appVersion: "0.8.0" });
  try {
    await writeFile(
      path.join(directory, "paseo-plugin.json"),
      JSON.stringify({ id: "turn-hooks", requirements: { paseo: ">=0.8.0" } }),
    );
    await writeFile(
      path.join(directory, "index.server.ts"),
      `
export default function contribute(server) {
  server.on("agent.turn_started", (event) => {
    console.log(JSON.stringify({ hook: "agent.turn_started", event }));
  });
  server.on("agent.turn_ended", (event) => {
    console.log(JSON.stringify({ hook: "agent.turn_ended", event }));
  });
  server.on("agent.permission_requested", async (event, context) => {
    console.log(JSON.stringify({ hook: "agent.permission_requested", event }));
    await context.paseo.agents.ref(event.agent.id).respondToPermission({
      requestId: event.request.id,
      response: { behavior: "deny", message: "Declined by plugin" },
    });
  });
  server.on("agent.permission_resolved", (event) => {
    console.log(JSON.stringify({ hook: "agent.permission_resolved", event }));
  });
  server.on("agent.archived", (event) => {
    console.log(JSON.stringify({ hook: "agent.archived", event }));
  });
  return () => {};
}
`,
    );
    await client.connect();
    await client.fetchAgents({ subscribe: {} });
    await client.patchDaemonConfig({ pluginsEnabled: true });
    await client.installDirectoryPlugin(directory);
    const agent = await client.createAgent({
      provider: "claude",
      cwd: directory,
      title: "Turn hooks",
      modeId: "default",
    });
    await client.sendMessage(agent.id, "Run rm -f permission.txt");
    await expect
      .poll(
        async () => {
          const logs = await client.getPluginLogs("turn-hooks");
          return logs
            .filter((entry) => {
              return entry.message.startsWith('{"hook":');
            })
            .map((entry) => {
              return JSON.parse(entry.message);
            })
            .sort((left, right) => {
              return left.hook.localeCompare(right.hook);
            });
        },
        { timeout: 10_000 },
      )
      .toMatchObject([
        {
          hook: "agent.permission_requested",
          event: { request: { input: { command: "rm -f permission.txt" } } },
        },
        { hook: "agent.permission_resolved", event: { resolution: { behavior: "deny" } } },
        {
          hook: "agent.turn_ended",
          event: { outcome: { kind: "completed" }, timeline: expect.any(Array) },
        },
        { hook: "agent.turn_started", event: { agent: { id: agent.id } } },
      ]);
    await client.archiveAgent(agent.id);
    await expect
      .poll(async () => {
        const logs = await client.getPluginLogs("turn-hooks");
        return logs.filter((entry) => {
          return entry.message.startsWith('{"hook":"agent.archived"');
        }).length;
      })
      .toBe(1);
  } finally {
    await client.close();
    await daemon.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);

test("agent creation hooks change the provider and environment before the session opens", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-agent-hooks-"));
  const daemon = await createTestPaseoDaemon({ daemonVersion: "0.8.0" });
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws`, appVersion: "0.8.0" });
  try {
    await writeFile(
      path.join(directory, "paseo-plugin.json"),
      JSON.stringify({ id: "agent-hooks", requirements: { paseo: ">=0.8.0" } }),
    );
    await writeFile(
      path.join(directory, "index.server.ts"),
      `
export default function contribute(server) {
  server.before("agent.create", ({ request }) => {
    return { ...request, config: { ...request.config, provider: "codex" }, env: { ...request.env, HOOK_CREATE: "created" } };
  });
  server.before("agent.session_open", ({ request }) => {
    console.log(JSON.stringify({ hook: "agent.session_open", request }));
    return { ...request, env: { ...request.env, HOOK_OPEN: "opened" } };
  });
  server.on("agent.created", (event) => {
    console.log(JSON.stringify({ hook: "agent.created", event }));
  });
  return () => {};
}
`,
    );
    await client.connect();
    await client.fetchAgents({ subscribe: {} });
    await client.patchDaemonConfig({ pluginsEnabled: true });
    await client.installDirectoryPlugin(directory);
    const agent = await client.createAgent({
      provider: "claude",
      cwd: directory,
      title: "Hook test",
    });
    expect(agent.provider).toBe("codex");
    await expect
      .poll(async () => {
        const logs = await client.getPluginLogs("agent-hooks");
        return logs
          .filter((entry) => {
            return entry.message.startsWith('{"hook":');
          })
          .map((entry) => {
            return JSON.parse(entry.message);
          });
      })
      .toMatchObject([
        {
          hook: "agent.session_open",
          request: { agentId: agent.id, env: { HOOK_CREATE: "created" } },
        },
        { hook: "agent.created", event: { agent: { id: agent.id, provider: "codex" } } },
      ]);
    await client.archiveAgent(agent.id);
  } finally {
    await client.close();
    await daemon.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);

test("invalid output from an untyped plugin rejects creation before later callbacks run", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-invalid-hook-"));
  const daemon = await createTestPaseoDaemon({ daemonVersion: "0.8.0" });
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws`, appVersion: "0.8.0" });
  try {
    await writeFile(
      path.join(directory, "paseo-plugin.json"),
      JSON.stringify({ id: "invalid-hook", requirements: { paseo: ">=0.8.0" } }),
    );
    await writeFile(
      path.join(directory, "index.server.ts"),
      `
export default function contribute(server) {
  server.before("workspace.create", () => {
    return { source: { kind: "worktree", branchName: 42 } };
  });
  server.before("workspace.create", ({ request }) => {
    console.log("Unexpected later callback");
    return request;
  });
  return () => {};
}
`,
    );
    await client.connect();
    await client.patchDaemonConfig({ pluginsEnabled: true });
    await client.installDirectoryPlugin(directory);
    const result = await client.createWorkspace({ source: { kind: "directory", path: directory } });
    expect(result.workspace).toBeNull();
    expect(result.error).toContain("Plugin invalid-hook before workspace.create failed");
    const logs = await client.getPluginLogs("invalid-hook");
    expect(
      logs.some((entry) => {
        return entry.message.includes("Unexpected later callback");
      }),
    ).toBe(false);
  } finally {
    await client.close();
    await daemon.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);

const PROVIDER_ID = "shutdown-provider";

async function createProviderPlugin(
  root: string,
  options: { acknowledgeClose: boolean } = { acknowledgeClose: true },
): Promise<string> {
  const directory = path.join(root, "plugin");
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, "paseo-plugin.json"),
    JSON.stringify({
      id: "shutdown-provider-plugin",
      requirements: { paseo: `>=${resolveDaemonVersion(import.meta.url)}` },
    }),
  );
  await writeFile(
    path.join(directory, "index.server.ts"),
    `import type {
  ProviderEvent,
  ProviderInput,
  ProviderRegistration,
} from "@getpaseo/plugin/server/provider";

const CAPABILITIES = ["prompt.message", "session.persistence"];

const provider: ProviderRegistration = {
  id: ${JSON.stringify(PROVIDER_ID)},
  label: "Shutdown provider",
  async connect() {
    let listener: ((event: ProviderEvent) => void) | null = null;
    const emit = (event: ProviderEvent) => listener?.(event);
    let turn = 0;
    return {
      version: 1,
      capabilities: CAPABILITIES,
      async send(input: ProviderInput) {
        if (input.type === "catalog") {
          emit({
            type: "catalog",
            requestId: input.requestId,
            catalog: {
              models: [{ id: "shutdown-model", label: "Shutdown model" }],
              modes: [],
              thinkingOptions: [],
              defaultModel: "shutdown-model",
            },
          });
          return;
        }
        if (input.type === "session.open") {
          emit({
            type: "session.opened",
            requestId: input.requestId,
            sessionId: input.sessionId,
            capabilities: CAPABILITIES,
            restoration: "core",
            persistence: { version: 1, data: { token: "root" } },
            cwd: input.config.cwd,
          });
          emit({ type: "session.ready", requestId: input.requestId, sessionId: input.sessionId });
          return;
        }
        if (input.type === "session.prompt") {
          turn += 1;
          const turnId = "turn-" + turn;
          emit({
            type: "session.prompt_result",
            sessionId: input.sessionId,
            clientMessageId: input.prompt.clientMessageId,
            result: { type: "turn", turnId },
          });
          emit({ type: "session.turn", sessionId: input.sessionId, turnId, state: "started" });
          emit({
            type: "timeline.item",
            sessionId: input.sessionId,
            item: { type: "assistant_message", id: "answer-" + turn, text: "Done" },
          });
          emit({ type: "session.turn", sessionId: input.sessionId, turnId, state: "completed" });
          return;
        }
        if (input.type === "session.close") {
          if (!${JSON.stringify(options.acknowledgeClose)}) return;
          emit({ type: "session.closed", sessionId: input.sessionId });
        }
        if ("requestId" in input) {
          emit({ type: "request.completed", requestId: input.requestId });
        }
      },
      onEvent(next: (event: ProviderEvent) => void) {
        listener = next;
        return () => {
          if (listener === next) listener = null;
        };
      },
      async close() {},
    };
  },
};

export default function contribute(server: { registerProvider(p: ProviderRegistration): void }) {
  server.registerProvider(provider);
  return () => undefined;
}`,
  );
  return directory;
}

test("a clean daemon shutdown leaves a completed plugin-provider agent without an error", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "plugin-provider-shutdown-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const pluginDirectory = await createProviderPlugin(root);
  const workspace = path.join(root, "workspace");
  await mkdir(workspace, { recursive: true });

  const daemon = await createTestPaseoDaemon({
    paseoHomeRoot: path.join(root, "daemon"),
    staticDir: path.join(root, "static"),
    cleanup: false,
    pluginsEnabled: true,
    plugins: {
      "shutdown-provider-plugin": { source: "directory", path: pluginDirectory, enabled: true },
    },
  });

  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws`, appVersion: "0.9.1" });
  await client.connect();
  await client.fetchAgents({ subscribe: {} });

  const agent = await client.createAgent({
    provider: PROVIDER_ID,
    model: "shutdown-model",
    cwd: workspace,
    title: "Shutdown provider agent",
  });
  await client.sendMessage(agent.id, "hello");
  const finished = await client.waitForFinish(agent.id, 30_000);
  expect(finished.status).toBe("idle");

  const beforeShutdown = await daemon.daemon.agentStorage.get(agent.id);
  expect(beforeShutdown?.lastError ?? null).toBeNull();

  await client.close();
  await daemon.daemon.stop();
  await daemon.daemon.agentStorage.flush().catch(() => undefined);

  const persisted = await daemon.daemon.agentStorage.get(agent.id);
  expect(persisted).not.toBeNull();
  expect(persisted?.lastError ?? null).toBeNull();
  expect(persisted?.attentionReason ?? null).not.toBe("error");
}, 60_000);

test("reloading a plugin leaves a completed plugin-provider agent without an error", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "plugin-provider-reload-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const pluginDirectory = await createProviderPlugin(root);
  const workspace = path.join(root, "workspace");
  await mkdir(workspace, { recursive: true });

  const daemon = await createTestPaseoDaemon({
    paseoHomeRoot: path.join(root, "daemon"),
    staticDir: path.join(root, "static"),
    pluginsEnabled: true,
    plugins: {
      "shutdown-provider-plugin": { source: "directory", path: pluginDirectory, enabled: true },
    },
  });
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws`, appVersion: "0.9.1" });
  onTestFinished(async () => {
    await client.close();
    await daemon.close();
  });
  await client.connect();
  await client.fetchAgents({ subscribe: {} });

  const agent = await client.createAgent({
    provider: PROVIDER_ID,
    model: "shutdown-model",
    cwd: workspace,
    title: "Reload provider agent",
  });
  await client.sendMessage(agent.id, "hello");
  expect((await client.waitForFinish(agent.id, 30_000)).status).toBe("idle");

  const reloaded = await client.reloadPlugin("shutdown-provider-plugin");
  expect(reloaded.status).toBe("running");

  const afterReload = await daemon.daemon.agentStorage.get(agent.id);
  expect(afterReload?.lastError ?? null).toBeNull();
  expect(afterReload?.attentionReason ?? null).not.toBe("error");
  const timeline = await client.fetchAgentTimeline(agent.id, {
    direction: "tail",
    limit: 0,
    projection: "canonical",
  });
  expect(JSON.stringify(timeline.entries)).not.toContain("Provider connection closed");

  await client.sendMessage(agent.id, "after reload");
  expect((await client.waitForFinish(agent.id, 30_000)).status).toBe("idle");
}, 60_000);

test("a provider that never acknowledges session.close does not hold the daemon open", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "plugin-provider-stuck-close-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const pluginDirectory = await createProviderPlugin(root, { acknowledgeClose: false });
  const workspace = path.join(root, "workspace");
  await mkdir(workspace, { recursive: true });

  const daemon = await createTestPaseoDaemon({
    paseoHomeRoot: path.join(root, "daemon"),
    staticDir: path.join(root, "static"),
    cleanup: false,
    pluginsEnabled: true,
    plugins: {
      "shutdown-provider-plugin": { source: "directory", path: pluginDirectory, enabled: true },
    },
  });

  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws`, appVersion: "0.9.1" });
  await client.connect();
  await client.fetchAgents({ subscribe: {} });

  const agent = await client.createAgent({
    provider: PROVIDER_ID,
    model: "shutdown-model",
    cwd: workspace,
    title: "Stuck close agent",
  });
  await client.sendMessage(agent.id, "hello");
  await client.waitForFinish(agent.id, 30_000);
  await client.close();

  // Without a deadline on each agent close, stop() never returns here and the
  // test fails by timing out.
  await expect(daemon.daemon.stop()).resolves.toBeUndefined();
}, 90_000);

const repoRoot = fileURLToPath(new URL("../../../../../", import.meta.url));

// Hold the provider close until the subprocess has entered shutdown cleanup.
async function createSlowClosingProviderPlugin() {
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-slow-close-plugin-"));
  const closeStarted = path.join(directory, "close-started");
  const closeRelease = path.join(directory, "close-release");
  const cleanupStarted = path.join(directory, "cleanup-started");
  await cp(path.join(repoRoot, "plugin-examples/provider-direct"), directory, { recursive: true });
  const providerPath = path.join(directory, "server", "provider.ts");
  const source = (await readFile(providerPath, "utf8")).replaceAll("\r\n", "\n");
  const patched = `import { readFile, writeFile } from "node:fs/promises";\n${source.replace(
    "      closed = true;\n      sessions.clear();",
    `      closed = true;
      await writeFile(${JSON.stringify(closeStarted)}, "started");
      while (true) {
        try { await readFile(${JSON.stringify(closeRelease)}); break; }
        catch { await new Promise((resolve) => setTimeout(resolve, 10)); }
      }
      sessions.clear();
      console.log("provider close completed");`,
  )}`;
  expect(patched).toContain(`await writeFile(${JSON.stringify(closeStarted)}, "started")`);
  await writeFile(providerPath, patched);
  const entryPath = path.join(directory, "index.server.ts");
  const entry = (await readFile(entryPath, "utf8")).replaceAll("\r\n", "\n");
  const withCleanup = `import { writeFile } from "node:fs/promises";\n${entry.replace(
    "  return () => {};",
    `  return async () => { await writeFile(${JSON.stringify(cleanupStarted)}, "started"); console.log("plugin cleanup completed"); };`,
  )}`;
  expect(withCleanup).toContain(`await writeFile(${JSON.stringify(cleanupStarted)}, "started")`);
  await writeFile(entryPath, withCleanup);
  return { directory, closeStarted, closeRelease, cleanupStarted };
}

test("reloading a plugin does not send on a closed IPC channel", async () => {
  const {
    directory: pluginDirectory,
    closeStarted,
    closeRelease,
    cleanupStarted,
  } = await createSlowClosingProviderPlugin();
  const cwd = await mkdtemp(path.join(tmpdir(), "paseo-reload-teardown-"));
  const daemon = await createTestPaseoDaemon();
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  try {
    await client.connect();
    await client.patchDaemonConfig({ pluginsEnabled: true });
    await client.installDirectoryPlugin(pluginDirectory);
    const agent = await client.createAgent({ provider: "direct-example", cwd });
    const turn = client.sendMessage(agent.id, "Say hello").catch(() => undefined);
    const reload = client.reloadPlugin("provider-direct-example");
    await expect
      .poll(() => readFile(closeStarted, "utf8").catch(() => null), { timeout: 20_000 })
      .toBe("started");
    await expect
      .poll(() => readFile(cleanupStarted, "utf8").catch(() => null), { timeout: 20_000 })
      .toBe("started");
    await writeFile(closeRelease, "release");
    const reloaded = await reload;
    expect(reloaded.status).toBe("running");
    const entries = await client.getPluginLogs("provider-direct-example");
    const messages = entries.map((entry) => entry.message).join("\n");
    expect(messages).not.toContain("ERR_IPC_CHANNEL_CLOSED");
    expect(entries.filter((entry) => entry.message === "plugin cleanup completed")).toHaveLength(1);
    expect(entries.filter((entry) => entry.message === "provider close completed")).toHaveLength(1);
    await turn;
    await client.archiveAgent(agent.id).catch(() => undefined);
  } finally {
    await writeFile(closeRelease, "release");
    await client.close();
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
    await rm(pluginDirectory, { recursive: true, force: true });
  }
}, 60_000);

test("admission binds creates before publication and replays unacknowledged outcomes", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-admission-"));
  const daemon = await createTestPaseoDaemon();
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  try {
    await writeFile(
      path.join(directory, "paseo-plugin.json"),
      JSON.stringify({
        id: "admission",
        requirements: { paseo: ">=0.12.0" },
        admission: { fence: "bound-agents", fenceWaitMs: 75, durableEvents: true },
      }),
    );
    await writeFile(
      path.join(directory, "index.server.ts"),
      `
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
export default function contribute(server) {
  const events = [];
  const requests = [];
  server.before("agent.create", ({ request }) => {
    if (request.origin.kind === "plugin" && request.origin.pluginId === "admission") return { ...request, bindingIntent: { pin: "durable" } };
  });
  server.before("agent.session_open", async ({ request }) => {
    requests.push(request);
    const persisted = await server.admissions.get(request.operation.id);
    if (persisted.status !== "pending") throw new Error("Operation was not journaled before hook");
    if (request.binding?.data.deny) return { deny: { code: "NO_RESERVATION", message: "Reservation refused" } };
  });
  server.on("agent.created", async ({ agent }) => {
    events.push({ name: "created", agentId: agent.id, binding: await server.agents.bindings.get(agent.id) });
  });
  for (const name of ["agent.session_opened", "agent.session_open_failed"]) server.on(name, (event) => events.push({ name, ...event }));
  const rpc = defineRpc({ name: "control", input: z.unknown(), output: z.unknown() });
  server.handle(rpc, async (input, { paseo }) => {
    if (input.action === "create") {
      const workspace = await paseo.workspaces.create({ source: { kind: "directory", path: input.path } });
      const agent = await workspace.agents.create({ config: { provider: "claude/haiku" } });
      return { agentId: agent.id };
    }
    if (input.action === "inspect") return { events, requests, records: await server.admissions.query({}) };
    if (input.action === "bind") return server.agents.bindings.set(input.agentId, input.data, { expectRevision: input.revision });
    if (input.action === "ack") { await server.admissions.ack(input.id); return null; }
  });
  return () => {};
}`,
    );
    await client.connect();
    await client.patchDaemonConfig({ pluginsEnabled: true });
    await client.installDirectoryPlugin(directory);
    const other = path.join(directory, "other-plugin");
    await mkdir(other);
    await writeFile(
      path.join(other, "paseo-plugin.json"),
      JSON.stringify({ id: "other", requirements: { paseo: ">=0.12.0" } }),
    );
    await writeFile(
      path.join(other, "index.server.ts"),
      'export default function(server) { server.before("agent.session_open", ({request}) => console.log(JSON.stringify({ seenBinding: request.binding }))); return () => {}; }',
    );
    await client.installDirectoryPlugin(other);
    const control = (input: unknown) => client.invokePluginRpc("admission", "control", input);
    const inspect = async () => admissionInspection.parse(await control({ action: "inspect" }));
    const { agentId } = z
      .object({ agentId: z.string() })
      .parse(await control({ action: "create", path: directory }));
    await expect
      .poll(async () => (await inspect()).events)
      .toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "created",
            agentId,
            binding: expect.objectContaining({ revision: 1, data: { pin: "durable" } }),
          }),
          expect.objectContaining({
            name: "agent.session_opened",
            agent: expect.objectContaining({ id: agentId }),
          }),
        ]),
      );
    const initial = await inspect();
    const first = initial.records.find((record) => record.agentId === agentId)!;
    expect(first).toMatchObject({
      status: "opened",
      origin: { kind: "plugin", pluginId: "admission" },
    });
    expect(initial.requests[0]).toMatchObject({
      binding: { revision: 1, data: { pin: "durable" } },
      operation: { id: first.id },
    });
    expect(
      (await client.getPluginLogs("other"))
        .filter((log) => log.message.startsWith('{"seenBinding":'))
        .map((log) => JSON.parse(log.message)),
    ).toEqual([{ seenBinding: null }]);
    await client.refreshAgent(agentId);
    const refreshed = await inspect();
    const second = refreshed.records.find((record) => record.reason === "refresh")!;
    expect(second).toMatchObject({
      status: "opened",
      supersedes: first.id,
      origin: { kind: "client", principalId: "owner" },
    });
    expect(refreshed.requests[1]).toMatchObject({
      binding: { revision: 1, data: { pin: "durable" } },
    });
    await control({ action: "ack", id: first.id });
    await client.reloadPlugin("admission");
    await expect
      .poll(async () => (await inspect()).events)
      .toMatchObject([{ name: "agent.session_opened", operation: { id: second.id } }]);
    const manager = daemon.daemon.agentManager;
    const live = manager.getAgent(agentId)!;
    const handle = live.persistence!;
    await manager.closeAgent(agentId);
    await manager.resumeAgentFromPersistence(
      handle,
      { provider: live.provider, cwd: directory },
      agentId,
      { workspaceId: live.workspaceId },
    );
    const resumed = await inspect();
    const third = resumed.records.find((record) => record.reason === "resume")!;
    expect(third).toMatchObject({ status: "opened", supersedes: second.id });
    expect(resumed.requests.at(-1)).toMatchObject({
      binding: { revision: 1, data: { pin: "durable" } },
      operation: { id: third.id },
    });
    await control({ action: "bind", agentId, revision: 1, data: { deny: true } });
    await expect(client.refreshAgent(agentId)).rejects.toThrow("Reservation refused");
    const failure = (await inspect()).records.find((record) => record.status === "failed")!;
    expect(failure).toMatchObject({
      supersedes: third.id,
      error: { code: "NO_RESERVATION", stage: "hook" },
    });
    await expect
      .poll(async () => (await inspect()).events)
      .toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "agent.session_open_failed",
            operation: expect.objectContaining({ id: failure.id }),
            error: { code: "NO_RESERVATION", message: "Reservation refused" },
          }),
        ]),
      );
  } finally {
    await client.close();
    await daemon.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);

const admissionInspection = z.object({
  events: z.array(z.record(z.string(), z.unknown())),
  requests: z.array(z.record(z.string(), z.unknown())),
  records: z.array(PluginAdmissionRecordSchema),
});
