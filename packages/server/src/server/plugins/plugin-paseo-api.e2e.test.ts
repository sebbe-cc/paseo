import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { EventEmitter, once } from "node:events";
import { resolveDaemonVersion } from "../daemon-version.js";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { z } from "zod";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { createTestAgentClient, createTestAgentClients } from "../test-utils/fake-agent-client.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test.each(["React Native", "native"])(
  "provider readiness works with %s AbortController",
  async (runtime) => {
    const require = createRequire(import.meta.url);
    const reactNativeRequire = createRequire(require.resolve("react-native/package.json"));
    const { AbortController: ReactNativeAbortController } = reactNativeRequire(
      "abort-controller/dist/abort-controller",
    );
    const bundle = await build({
      entryPoints: [fileURLToPath(new URL("../../../../client/src/index.ts", import.meta.url))],
      bundle: true,
      write: false,
      format: "iife",
      globalName: "paseoSdk",
      platform: "browser",
    });
    // A separate runtime starts with React Native's real abort implementation.
    // Node's globals and the daemon's runtime remain unchanged.
    const sdk: typeof import("@getpaseo/client") = runInNewContext(
      `${bundle.outputFiles[0]!.text}\npaseoSdk`,
      {
        AbortController: runtime === "React Native" ? ReactNativeAbortController : AbortController,
        setTimeout,
        clearTimeout,
        queueMicrotask,
        TextEncoder,
        TextDecoder,
      },
    );
    const daemon = await createTestPaseoDaemon({ mcpEnabled: false });
    const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
    const api = sdk.createPaseoApi(client);
    try {
      await client.connect();
      const snapshot = await api.providers.waitForReady({ cwd: daemon.staticDir });
      expect(snapshot.entries.length).toBeGreaterThan(0);
      expect(snapshot.entries.every((entry) => entry.status !== "loading")).toBe(true);
      const waiting = api.providers.waitForReady({ cwd: daemon.staticDir });
      const canceled = expect(waiting).rejects.toThrow(/disposed|released/);
      await api.dispose();
      await canceled;
      const { diagnostic } = await client.collectDiagnostics();
      expect(diagnostic).toContain("Source registrations: 0");
      expect(diagnostic).toContain("Producer listeners: 0");
      expect(() => api.providers.waitForReady()).toThrow("disposed");
    } finally {
      await api.dispose();
      await client.close();
      await daemon.close();
    }
  },
);

test("plugin handlers create workspaces and agents through their Paseo API", async () => {
  const pluginDirectory = await mkdtemp(path.join(tmpdir(), "paseo-api-plugin-"));
  const workspaceDirectory = await mkdtemp(path.join(tmpdir(), "paseo-api-workspace-"));
  roots.push(pluginDirectory, workspaceDirectory);
  await writeFile(
    path.join(pluginDirectory, "paseo-plugin.json"),
    JSON.stringify({
      id: "paseo-api",
      requirements: { paseo: `>=${resolveDaemonVersion(import.meta.url)}` },
    }),
  );
  await writeFile(
    path.join(pluginDirectory, "index.server.ts"),
    `import { defineRpc } from "@getpaseo/plugin";
import { type PluginServerContext } from "@getpaseo/plugin/server";
import { z } from "zod";

const create = defineRpc({
  name: "create",
  input: z.object({ path: z.string() }),
  output: z.object({ workspaceId: z.string(), agentId: z.string() }),
});

const list = defineRpc({
  name: "list",
  input: z.object({}),
  output: z.object({ agentIds: z.array(z.string()) }),
});

const append = defineRpc({
  name: "append",
  input: z.object({ agentId: z.string(), status: z.string() }),
  output: z.object({ seq: z.number(), epoch: z.string() }),
});

export default function contribute(server: PluginServerContext) {
  server.handle(create, async ({ path }, { paseo }) => {
    const workspace = await paseo.workspaces.create({
      source: { kind: "directory", path },
      title: "Plugin workspace",
    });
    const agent = await workspace.agents.create({
      config: { provider: "pi/test" },
      prompt: "Created by a plugin handler",
    });
    return { workspaceId: workspace.id, agentId: agent.id };
  });
  server.handle(list, async (_input, { paseo }) => {
    const result = await paseo.agents.list({ page: { limit: 100 } });
    return { agentIds: result.entries.map((entry) => entry.agent.id) };
  });
  server.handle(append, ({ agentId, status }, { paseo }) =>
    paseo.agents.ref(agentId).timeline.append({
      type: "plugin",
      id: "review-1",
      kind: "review",
      version: 1,
      data: { status },
    }),
  );
  return () => undefined;
}`,
  );

  const daemon = await createTestPaseoDaemon({
    agentClients: { ...createTestAgentClients(), pi: createTestAgentClient("pi") },
  });
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.4.0",
  });

  try {
    await client.connect();
    await client.patchDaemonConfig({ pluginsEnabled: true });
    await expect(client.installDirectoryPlugin(pluginDirectory)).resolves.toMatchObject({
      id: "paseo-api",
      status: "running",
    });

    const created = await client.invokePluginRpc("paseo-api", "create", {
      path: workspaceDirectory,
    });

    expect(created).toEqual({
      workspaceId: expect.stringMatching(/^wks_/),
      agentId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
    if (typeof created !== "object" || created === null) {
      throw new Error("Plugin returned an invalid creation result");
    }
    const listed = await client.invokePluginRpc("paseo-api", "list", {});
    expect(listed).toEqual({
      agentIds: expect.arrayContaining([Reflect.get(created, "agentId")]),
    });
    const agentId = Reflect.get(created, "agentId");
    await expect(
      client.invokePluginRpc("paseo-api", "append", { agentId, status: "running" }),
    ).resolves.toEqual({ seq: expect.any(Number), epoch: expect.any(String) });
    await client.invokePluginRpc("paseo-api", "append", { agentId, status: "complete" });
    const timeline = await client.fetchAgentTimeline(agentId, { projection: "projected" });
    expect(timeline.entries.filter((entry) => entry.item.type === "plugin")).toEqual([
      expect.objectContaining({
        item: expect.objectContaining({
          type: "plugin",
          id: "review-1",
          pluginId: "paseo-api",
          data: { status: "complete" },
        }),
      }),
    ]);
    await client.removePlugin("paseo-api");
    const workspaces = await client.fetchWorkspaces();
    const agents = await client.fetchAgents();
    expect(workspaces.entries.map((workspace) => workspace.id)).toContain(
      Reflect.get(created, "workspaceId"),
    );
    expect(agents.entries.map((entry) => entry.agent.id)).toContain(
      Reflect.get(created, "agentId"),
    );
  } finally {
    await client.close().catch(() => undefined);
    await daemon.close();
  }
}, 60_000);

test("daemon config reload enables and disables configured plugins without restarting", async () => {
  const pluginDirectory = await mkdtemp(path.join(tmpdir(), "paseo-reload-plugin-"));
  const paseoHomeRoot = await mkdtemp(path.join(tmpdir(), "paseo-reload-home-"));
  const paseoHome = path.join(paseoHomeRoot, ".paseo");
  roots.push(pluginDirectory, paseoHomeRoot);
  await writeFile(
    path.join(pluginDirectory, "paseo-plugin.json"),
    JSON.stringify({
      id: "reloadable-plugin",
      requirements: { paseo: `>=${resolveDaemonVersion(import.meta.url)}` },
    }),
  );
  await writeFile(
    path.join(pluginDirectory, "index.server.ts"),
    `export default function contribute(server: unknown) {
  void server;
  return () => undefined;
    }`,
  );

  const plugins = {
    "reloadable-plugin": { source: "directory" as const, path: pluginDirectory, enabled: true },
  };
  await mkdir(paseoHome, { recursive: true });
  await writeFile(
    path.join(paseoHome, "config.json"),
    `${JSON.stringify({ version: 1, pluginsEnabled: false, plugins }, null, 2)}\n`,
  );
  const daemon = await createTestPaseoDaemon({
    paseoHomeRoot,
    cleanup: false,
    pluginsEnabled: false,
    plugins,
  });
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.4.0",
  });
  const configPath = path.join(daemon.paseoHome, "config.json");
  const catalogChanges = new EventEmitter();

  async function setPluginsEnabled(enabled: boolean): Promise<void> {
    const config = JSON.parse(await readFile(configPath, "utf8"));
    await writeFile(
      configPath,
      `${JSON.stringify({ ...config, pluginsEnabled: enabled }, null, 2)}\n`,
    );
  }

  try {
    await client.connect();
    const catalog = client.observeEvents(["status.plugin_catalog_changed"]);
    catalog.subscribe({
      snapshot: () => undefined,
      update: (message) => {
        if (
          message.type === "status" &&
          message.payload.status === "plugin_catalog_changed" &&
          message.payload.pluginId === "reloadable-plugin"
        ) {
          catalogChanges.emit("changed");
        }
      },
    });
    await catalog.ready;
    await expect(client.listPlugins()).resolves.toEqual([
      expect.objectContaining({ id: "reloadable-plugin", status: "disabled" }),
    ]);

    const enabled = once(catalogChanges, "changed");
    await setPluginsEnabled(true);
    await expect(client.reloadDaemonConfig()).resolves.toMatchObject({
      requestId: expect.any(String),
      appliedPaths: expect.arrayContaining(["pluginsEnabled"]),
      restartRequiredPaths: [],
      overrideControlledPaths: [],
    });
    await enabled;
    expect((await client.listPlugins()).find(({ id }) => id === "reloadable-plugin")).toMatchObject(
      { enabled: true, status: "running" },
    );

    const disabled = once(catalogChanges, "changed");

    await setPluginsEnabled(false);
    await expect(client.reloadDaemonConfig()).resolves.toEqual({
      requestId: expect.any(String),
      appliedPaths: ["pluginsEnabled"],
      restartRequiredPaths: [],
      overrideControlledPaths: [],
    });
    await disabled;
    expect((await client.listPlugins()).find(({ id }) => id === "reloadable-plugin")).toMatchObject(
      { enabled: true, status: "disabled" },
    );
    await catalog.release();
  } finally {
    await client.close().catch(() => undefined);
    await daemon.close();
  }
}, 60_000);

const ReconnectingPluginStateSchema = z.object({
  snapshots: z.array(z.string()),
  names: z.array(z.string()),
});

async function readReconnectingPluginState(client: DaemonClient) {
  return ReconnectingPluginStateSchema.parse(
    await client.invokePluginRpc("reconnecting", "state", {}),
  );
}

test("plugin host APIs and observations recover after repeated daemon-side socket closes", async () => {
  const pluginDirectory = await mkdtemp(path.join(tmpdir(), "paseo-reconnecting-plugin-"));
  const workspaceDirectory = await mkdtemp(path.join(tmpdir(), "paseo-reconnecting-workspace-"));
  roots.push(pluginDirectory, workspaceDirectory);
  await writeFile(
    path.join(pluginDirectory, "paseo-plugin.json"),
    JSON.stringify({ id: "reconnecting", requirements: { paseo: ">=0.8.0" } }),
  );
  await writeFile(
    path.join(pluginDirectory, "index.server.ts"),
    `
import { defineRpc } from "@getpaseo/plugin";
import { type PluginServerContext } from "@getpaseo/plugin/server";
import { z } from "zod";

export default function contribute(server: PluginServerContext) {
  const snapshots: string[] = [];
  const names: string[] = [];
  const snapshotWaiters = new Map<number, (id: string) => void>();
  const nameWaiters = new Map<string, (name: string) => void>();
  let reconnected = Promise.resolve();
  let release: (() => Promise<void>) | undefined;
  server.handle(defineRpc({ name: "observe", input: z.object({}), output: z.string() }), async (_, { paseo }) => {
    const { subscription } = await paseo.workspaces.list({ subscribe: {} });
    subscription.subscribe({
      snapshot: (snapshot) => {
        const id = snapshot.subscriptionId!;
        snapshots.push(id);
        snapshotWaiters.get(snapshots.length)?.(id);
        snapshotWaiters.delete(snapshots.length);
      },
      update: (message) => {
        if (message.type === "workspace_update" && message.payload.kind === "upsert") {
          const name = message.payload.workspace.name;
          names.push(name);
          nameWaiters.get(name)?.(name);
          nameWaiters.delete(name);
        }
      },
    });
    release = () => subscription.release();
    return subscription.subscriptionId!;
  });
  server.handle(defineRpc({ name: "wait-snapshot", input: z.object({ count: z.number().int().positive() }), output: z.string() }), ({ count }) => {
    const id = snapshots[count - 1];
    return id ?? new Promise<string>((resolve) => snapshotWaiters.set(count, resolve));
  });
  server.handle(defineRpc({ name: "wait-name", input: z.object({ name: z.string() }), output: z.string() }), ({ name }) => {
    return names.includes(name) ? name : new Promise<string>((resolve) => nameWaiters.set(name, resolve));
  });
  server.handle(defineRpc({ name: "state", input: z.object({}), output: z.object({ snapshots: z.array(z.string()), names: z.array(z.string()) }) }), () => ({ snapshots, names }));
  server.handle(defineRpc({ name: "probe", input: z.object({}), output: z.object({ pid: z.number(), projectIds: z.array(z.string()) }) }), async (_, { paseo }) => {
    await reconnected;
    return { pid: process.pid, projectIds: (await paseo.projects.list()).projects.map((project) => project.projectId) };
  });
  server.handle(defineRpc({ name: "release", input: z.object({}), output: z.null() }), async () => {
    await release?.();
    return null;
  });
  server.handle(defineRpc({ name: "disconnect", input: z.object({}), output: z.null() }), () => new Promise((resolve) => {
    // Inject a protocol violation through real IPC. The real daemon closes the
    // active socket, and the worker's normal transport must observe that close.
    function closed(message: { type: string }) {
      if (message.type !== "paseo_close") return;
      process.off("message", closed);
      resolve(null);
    }
    process.on("message", closed);
    reconnected = new Promise<void>((connected) => {
      function ready(message: { type: string; data?: unknown }) {
        if (message.type !== "paseo_frame" || typeof message.data !== "string") return;
        const frame = JSON.parse(message.data);
        if (frame.type !== "session" || frame.message.type !== "status" || frame.message.payload.status !== "server_info") return;
        process.off("message", ready);
        connected();
      }
      process.on("message", ready);
    });
    process.send!({ type: "paseo_frame", isBinary: false, data: JSON.stringify({
      type: "hello", clientId: "plugin:reconnecting", clientType: "cli", protocolVersion: 1,
    }) });
  }));
  return async () => { await release?.(); };
}`,
  );
  const daemon = await createTestPaseoDaemon();
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  let projectId: string | undefined;
  try {
    await client.connect();
    const opened = await client.openProject(workspaceDirectory);
    if (!opened.workspace) throw new Error(opened.error ?? "Workspace did not open");
    projectId = opened.workspace.projectId;
    const workspaceId = opened.workspace.id;
    await client.patchDaemonConfig({ pluginsEnabled: true });
    await client.installDirectoryPlugin(pluginDirectory);
    const original = await client.invokePluginRpc("reconnecting", "probe", {});
    expect(original).toEqual({ pid: expect.any(Number), projectIds: [projectId] });
    const initialId = await client.invokePluginRpc("reconnecting", "observe", {});
    const app = await client.fetchWorkspaces({ subscribe: {} });
    const appUpdates = new EventEmitter();
    app.subscription.subscribe({
      snapshot: () => undefined,
      update: (message) => {
        if (message.type === "workspace_update" && message.payload.kind === "upsert") {
          appUpdates.emit(message.payload.workspace.name);
        }
      },
    });
    await client.setWorkspaceTitle(workspaceId, "Before disconnect");
    await expect(
      client.invokePluginRpc("reconnecting", "wait-name", { name: "Before disconnect" }),
    ).resolves.toBe("Before disconnect");
    const ids = [initialId];
    for (const name of ["First recovery", "Second recovery"]) {
      await client.invokePluginRpc("reconnecting", "disconnect", {});
      const id = await client.invokePluginRpc("reconnecting", "wait-snapshot", {
        count: ids.length + 1,
      });
      ids.push(id);
      expect((await readReconnectingPluginState(client)).snapshots).toEqual(ids);
      expect(new Set(ids).size).toBe(ids.length);
      expect(app.subscription.subscriptionId).toBe(app.subscriptionId);
      const appUpdate = once(appUpdates, name);
      await client.setWorkspaceTitle(workspaceId, name);
      await expect(client.invokePluginRpc("reconnecting", "wait-name", { name })).resolves.toBe(
        name,
      );
      await appUpdate;
      expect(await client.invokePluginRpc("reconnecting", "probe", {})).toEqual(original);
    }
    await client.invokePluginRpc("reconnecting", "release", {});
    const releasedState = await client.invokePluginRpc("reconnecting", "state", {});
    await client.invokePluginRpc("reconnecting", "disconnect", {});
    expect(await client.invokePluginRpc("reconnecting", "probe", {})).toEqual(original);
    const appUpdateAfterRelease = once(appUpdates, "After release");
    await client.setWorkspaceTitle(workspaceId, "After release");
    await appUpdateAfterRelease;
    await client.invokePluginRpc("reconnecting", "probe", {});
    expect(await client.invokePluginRpc("reconnecting", "state", {})).toEqual(releasedState);
    await app.subscription.release();
    // Removal while reconnect is scheduled must stop the child, not reload it.
    await client.invokePluginRpc("reconnecting", "disconnect", {});
    await client.removePlugin("reconnecting");
    expect(await client.listPlugins()).toEqual([]);
    await expect(client.invokePluginRpc("reconnecting", "probe", {})).rejects.toThrow(
      "Plugin is not available",
    );
  } finally {
    if (projectId) await client.removeProject(projectId);
    await client.close();
    await daemon.close();
  }
}, 60_000);

test("plugin voice uses the existing source-owned PCM transport and tears down on unload", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-voice-e2e-"));
  roots.push(root);
  const pluginDirectory = path.join(root, "voice-plugin");
  await mkdir(pluginDirectory);
  await mkdir(path.join(root, ".paseo"));
  await writeFile(
    path.join(root, ".paseo/config.json"),
    JSON.stringify({
      features: { voiceMode: { provider: { pluginId: "voice-fixture", providerId: "live" } } },
    }),
  );
  await writeFile(
    path.join(pluginDirectory, "paseo-plugin.json"),
    JSON.stringify({ id: "voice-fixture", requirements: { paseo: ">=0.12.0" } }),
  );
  await writeFile(
    path.join(pluginDirectory, "index.server.ts"),
    `
export default function contribute(server) {
  server.registerVoiceProvider({ id: "live", label: "Fixture Live", async start({ agentId, paseo, emit, signal }) {
    let sent = false;
    console.log("voice started", agentId);
    return {
      async appendAudio(audio) {
        if (sent) return;
        sent = true;
        emit({ type: "speech", isSpeaking: true });
        await paseo.agents.ref(agentId).send("fixture voice request", { activeTurnBehavior: "steer_only" });
        emit({ type: "audio", audio, utteranceId: "fixture-output", chunkIndex: 0, isLastChunk: true });
      },
      close() { console.log("voice closed", signal.aborted); },
    };
  } });
  return () => {};
}`,
  );
  const daemon = await createTestPaseoDaemon({
    paseoHomeRoot: root,
    daemonVersion: "0.12.0",
    pluginsEnabled: true,
    plugins: { "voice-fixture": { source: "directory", path: pluginDirectory, enabled: true } },
  });
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.12.0",
  });
  const sibling = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.12.0",
    capabilities: { plugin_voice_providers: false },
  });
  const audio: unknown[] = [];
  const leakedAudio: unknown[] = [];
  const ended: unknown[] = [];
  client.on("audio_output", (message) => audio.push(message));
  sibling.on("audio_output", (message) => leakedAudio.push(message));
  client.on("voice_input_state", (message) => {
    if (message.type === "voice_input_state" && message.payload.sessionEnded) ended.push(message);
  });
  try {
    await client.connect();
    await sibling.connect();
    await client.observeEvents(["status.server_info"]).ready;

    const created = await client.createAgent({ provider: "codex", cwd: root });
    expect(client.getLastServerInfoMessage()?.features?.pluginVoiceProviders).toBe(true);
    expect(client.getLastServerInfoMessage()?.capabilities?.voice?.provider).toEqual({
      pluginId: "voice-fixture",
      providerId: "live",
    });
    await expect(sibling.setVoiceMode(true, created.id)).rejects.toThrow("Update the Paseo app");
    await client.setVoiceMode(true, created.id);
    await client.sendVoiceAudioChunk("AAABAA==", "audio/pcm;rate=16000;bits=16");
    await expect.poll(() => audio.length).toBe(1);
    expect(audio[0]).toMatchObject({ payload: { format: "pcm" } });
    expect(leakedAudio).toEqual([]);
    const timeline = await client.fetchAgentTimeline(created.id);
    expect(
      timeline.entries.some(
        (entry) =>
          entry.item.type === "user_message" && entry.item.text.includes("fixture voice request"),
      ),
    ).toBe(true);
    await client.disablePlugin("voice-fixture");
    await expect.poll(() => ended.length).toBe(1);
    await expect
      .poll(() => client.getLastServerInfoMessage()?.capabilities?.voice?.voice.enabled)
      .toBe(false);
    expect(
      (await client.getPluginLogs("voice-fixture")).filter((entry) =>
        entry.message.includes("voice closed"),
      ),
    ).toHaveLength(1);
  } finally {
    await client.close();
    await sibling.close();
    await daemon.close();
  }
}, 60_000);

test("Codex Live saves a validated voice across reload and finds the current Gas City King", async () => {
  const { settingsRpc } = await import("@getpaseo/plugin");
  const { createPaseoApi } = await import("@getpaseo/client");
  const { findKing } = await import("../../../../../plugin-examples/codex-live/shared/king.js");
  const directory = fileURLToPath(
    new URL("../../../../../plugin-examples/codex-live/", import.meta.url),
  );
  const daemon = await createTestPaseoDaemon({
    daemonVersion: "0.12.0",
    mcpEnabled: false,
    agentClients: createTestAgentClients(),
    pluginsEnabled: true,
    plugins: { "codex-live": { source: "directory", path: directory, enabled: true } },
  });
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.12.0",
  });
  const api = createPaseoApi(client);
  const rpc = settingsRpc("voice");
  try {
    await client.connect();
    const read = () => client.invokePluginRpc("codex-live", rpc.read.name, {});
    await expect(read()).resolves.toMatchObject({ status: "ready", values: { voice: "cove" } });
    const invalid = await client.invokePluginRpc("codex-live", rpc.write.name, {
      revision: "missing",
      values: { voice: "not-a-voice" },
    });
    expect(invalid).toMatchObject({ status: "invalid" });
    const saved = await client.invokePluginRpc("codex-live", rpc.write.name, {
      revision: "missing",
      values: { voice: "maple" },
    });
    expect(saved).toMatchObject({ status: "saved", values: { voice: "maple" } });
    await client.reloadPlugin("codex-live");
    await expect(read()).resolves.toMatchObject({ status: "ready", values: { voice: "maple" } });
    await expect(findKing(api)).rejects.toThrow("Expected one active");
    const king = await client.createAgent({
      provider: "codex",
      cwd: daemon.staticDir,
      labels: { "gc-session": "king" },
    });
    await expect(findKing(api)).resolves.toBe(king.id);
    const replacement = await client.createAgent({
      provider: "codex",
      cwd: daemon.staticDir,
      labels: { "gc-session": "king" },
    });
    await expect(findKing(api)).rejects.toThrow("Expected one active");
    await api.agents.ref(king.id).archive();
    await expect(findKing(api)).resolves.toBe(replacement.id);
  } finally {
    await api.dispose();
    await client.close();
    await daemon.close();
  }
}, 60_000);

test("Codex Live previews every voice with a stable clip without changing saved settings", async () => {
  const { settingsRpc } = await import("@getpaseo/plugin");
  const { VoiceSchema } =
    await import("../../../../../plugin-examples/codex-live/shared/preferences.js");
  const { previewVoice, previewText } =
    await import("../../../../../plugin-examples/codex-live/shared/preview.js");
  const directory = fileURLToPath(
    new URL("../../../../../plugin-examples/codex-live/", import.meta.url),
  );
  const catalog = z
    .object({
      text: z.string(),
      model: z.literal("gpt-live-1-codex"),
      clips: z.record(VoiceSchema, z.string().min(1).nullable()),
    })
    .parse(JSON.parse(await readFile(path.join(directory, "server/previews.json"), "utf8")));
  expect(catalog.text).toBe(previewText);
  const daemon = await createTestPaseoDaemon({
    daemonVersion: "0.12.0",
    mcpEnabled: false,
    agentClients: createTestAgentClients(),
    pluginsEnabled: true,
    plugins: {
      "codex-live": { source: "directory", path: directory, enabled: true },
    },
  });
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.12.0",
  });
  try {
    await client.connect();
    const read = () => client.invokePluginRpc("codex-live", settingsRpc("voice").read.name, {});
    const settings = await read();
    const clips = new Set<string>();
    for (const voice of VoiceSchema.options) {
      const clip = previewVoice.output.parse(
        await client.invokePluginRpc("codex-live", previewVoice.name, { voice }),
      );
      if ("unavailable" in clip) {
        expect(["porto", "selva"]).toContain(voice);
        expect(catalog.clips[voice]).toBeNull();
        continue;
      }
      expect(clip.base64).toBe(catalog.clips[voice]);
      expect(clip.mimeType).toBe("audio/mpeg");
      expect(Buffer.from(clip.base64, "base64").length).toBeGreaterThan(5_000);
      expect(await client.invokePluginRpc("codex-live", previewVoice.name, { voice })).toEqual(
        clip,
      );
      clips.add(clip.base64);
    }
    expect(clips.size).toBe(VoiceSchema.options.length - 2);
    await expect(
      client.invokePluginRpc("codex-live", previewVoice.name, {
        voice: "not-a-voice",
      }),
    ).rejects.toThrow();
    expect(await read()).toEqual(settings);
  } finally {
    await client.close();
    await daemon.close();
  }
}, 60_000);

test.runIf(process.env.PASEO_TEST_CODEX_LIVE === "1")(
  "Codex Live carries PCM and delegated file inspection through a real Paseo agent",
  async () => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const { randomInt } = await import("node:crypto");
    const { CodexAppServerAgentClient } =
      await import("../agent/providers/codex-app-server-agent.js");
    const pino = (await import("pino")).default;
    const root = await mkdtemp(path.join(tmpdir(), "paseo-live-real-"));
    roots.push(root);
    const words = [
      "copper",
      "silver",
      "violet",
      "amber",
      "willow",
      "marble",
      "panda",
      "otter",
      "meadow",
      "orchid",
      "falcon",
      "maple",
      "forest",
      "garden",
      "poppy",
      "rabbit",
    ];
    const phrase = Array.from({ length: 4 }, () => words[randomInt(words.length)]).join(" ");
    await writeFile(
      path.join(root, "status.txt"),
      `The workspace test status is green. The verification phrase is ${phrase}.\n`,
    );
    const wavPath = path.join(root, "input.wav");
    await promisify(execFile)(process.env.PASEO_TEST_ESPEAK ?? "espeak-ng", [
      "-v",
      "en-us",
      "-s",
      "145",
      "-w",
      wavPath,
      "Please ask the coding agent to inspect the text file in the workspace, then tell me the test status and the exact verification phrase from that file.",
    ]);
    const wav = await readFile(wavPath);
    const rate = wav.readUInt32LE(24);
    let offset = 12;
    while (wav.toString("ascii", offset, offset + 4) !== "data")
      offset += 8 + wav.readUInt32LE(offset + 4);
    const source = wav.subarray(offset + 8);
    const pcm = Buffer.alloc(Math.floor(((source.length / 2) * 16_000) / rate) * 2);
    for (let index = 0; index < pcm.length / 2; index++)
      pcm.writeInt16LE(source.readInt16LE(Math.floor((index * rate) / 16_000) * 2), index * 2);
    const directory = fileURLToPath(
      new URL("../../../../../plugin-examples/codex-live/", import.meta.url),
    );
    await mkdir(path.join(root, ".paseo"));
    await writeFile(
      path.join(root, ".paseo/config.json"),
      JSON.stringify({
        features: { voiceMode: { provider: { pluginId: "codex-live", providerId: "live" } } },
      }),
    );
    const daemon = await createTestPaseoDaemon({
      paseoHomeRoot: root,
      daemonVersion: "0.12.0",
      mcpEnabled: false,
      agentClients: { codex: new CodexAppServerAgentClient(pino({ level: "silent" })) },
      pluginsEnabled: true,
      plugins: { "codex-live": { source: "directory", path: directory, enabled: true } },
    });
    const client = new DaemonClient({
      url: `ws://127.0.0.1:${daemon.port}/ws`,
      appVersion: "0.12.0",
    });
    let energy = 0;
    const spoken: string[] = [];
    const failures: string[] = [];
    client.on("audio_output", (message) => {
      if (message.type !== "audio_output") return;
      const audio = Buffer.from(message.payload.audio, "base64");
      for (let index = 0; index + 1 < audio.length; index += 2)
        energy += audio.readInt16LE(index) ** 2;
    });
    client.on("activity_log", (message) => {
      if (message.type === "activity_log" && message.payload.type === "assistant")
        spoken.push(message.payload.content);
    });
    client.on("voice_input_state", (message) => {
      if (message.type === "voice_input_state" && message.payload.error)
        failures.push(message.payload.error);
    });
    try {
      await client.connect();
      const { settingsRpc } = await import("@getpaseo/plugin");
      const voiceSettings = settingsRpc("voice");
      const selected = await client.invokePluginRpc("codex-live", voiceSettings.write.name, {
        revision: "missing",
        values: { voice: "maple" },
      });
      expect(selected).toMatchObject({ status: "saved", values: { voice: "maple" } });
      const agent = await client.createAgent({
        provider: "codex",
        cwd: root,
        modeId: "full-access",
        thinkingOptionId: "low",
      });
      await client.setVoiceMode(true, agent.id);
      for (let index = 0; index < pcm.length; index += 3200) {
        await client.sendVoiceAudioChunk(
          pcm.subarray(index, index + 3200).toString("base64"),
          "audio/pcm;rate=16000;bits=16",
        );
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      await expect
        .poll(
          () => {
            if (failures.length) throw new Error(failures.join("; "));
            return spoken.join(" ").toLowerCase();
          },
          { timeout: 120_000 },
        )
        .toContain(phrase);
      expect(energy).toBeGreaterThan(0);
      const timeline = await client.fetchAgentTimeline(agent.id, { limit: 200 });
      expect(timeline.entries.some((entry) => entry.item.type === "user_message")).toBe(true);
      expect(
        timeline.entries.some(
          (entry) => entry.item.type === "assistant_message" && entry.item.text.includes(phrase),
        ),
      ).toBe(true);
      await client.setVoiceMode(false);
      // Evidence contains no keys, SDP or full provider payloads.
      process.stdout.write(
        JSON.stringify({
          liveVoiceEvidence: {
            voice: "maple",
            inputPcmBytes: pcm.length,
            outputEnergy: energy,
            phrase,
            spoken,
            selectedAgentId: agent.id,
            failures,
          },
        }) + "\n",
      );
    } finally {
      await client.close();
      await daemon.close();
    }
  },
  180_000,
);
