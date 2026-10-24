import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { test, expect, onTestFinished, vi } from "vitest";
import { PluginService } from "./index.js";
import { DaemonConfigStore } from "../daemon-config-store.js";
import { AgentStorage } from "../agent/agent-storage.js";
import { AdmissionJournal } from "./admission-journal.js";

async function fixture() {
  const home = await mkdtemp(path.join(tmpdir(), "bound-admissions-"));
  vi.stubEnv("PASEO_HOME", home);
  vi.stubEnv("FLEET_TOWN_STATE_DIR", path.join(home, "fleet-state"));
  onTestFinished(async () => {
    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true });
  });
  const plugins: Record<string, { source: "directory"; path: string }> = {};
  for (const id of ["scoped", "global"]) {
    const directory = path.join(home, id);
    await mkdir(directory);
    await writeFile(
      path.join(directory, "paseo-plugin.json"),
      JSON.stringify({
        id,
        admission: {
          durableEvents: true,
          ...(id === "scoped"
            ? {
                recipients: "bound-agents",
                fence: "bound-agents",
                fenceWaitMs: 0,
              }
            : {}),
        },
      }),
    );
    plugins[id] = { source: "directory", path: directory };
  }
  const store = new DaemonConfigStore(home, {
    mcp: { injectIntoAgents: true },
    browserTools: { enabled: false },
    providers: {},
    metadataGeneration: { providers: [] },
    autoArchiveAfterMerge: false,
    enableTerminalAgentHooks: false,
    appendSystemPrompt: "",
    pluginsEnabled: true,
    plugins,
  });
  const journal = new AdmissionJournal(path.join(home, "admissions"));
  const storage = new AgentStorage(path.join(home, "agents"), pino({ level: "silent" }));
  const service = new PluginService(pino({ level: "silent" }), store, "0.12.0", {
    admission: { journal, storage: () => storage },
  });
  await service.prepareAdmission();
  return { home, service, store, journal, storage };
}

const binding = {
  revision: 1,
  data: {},
  boundAt: new Date().toISOString(),
  boundBy: { kind: "plugin" as const, pluginId: "scoped" },
};

test("bound durable recipient excludes foreign admissions; default global recipient remains", async () => {
  const { service } = await fixture();
  expect(
    (await service.admissionRecipients({ agentId: "foreign", bindings: {} })).recipients,
  ).toEqual(["global"]);
  expect(
    (
      await service.admissionRecipients({
        agentId: "own",
        bindings: { scoped: binding },
      })
    ).recipients,
  ).toEqual(["scoped", "global"]);
  expect(
    (
      await service.admissionRecipients({
        agentId: "foreign",
        bindings: { other: binding },
      })
    ).recipients,
  ).toEqual(["global"]);
});

test("bound policy survives removal, restart and global disable without fencing unrelated agents", async () => {
  const { service, store, storage, home } = await fixture();
  const stored = { pluginBindings: { scoped: binding } };
  vi.spyOn(storage, "get").mockImplementation(async (id) =>
    id === "own" ? (stored as never) : null,
  );
  store.patch({ plugins: {}, pluginsEnabled: false });
  const journal = new AdmissionJournal(path.join(home, "admissions"));
  const restarted = new PluginService(pino({ level: "silent" }), store, "0.12.0", {
    admission: { journal, storage: () => storage },
  });
  await restarted.prepareAdmission();
  const request = {
    origin: { kind: "daemon" as const, source: "restore" as const },
    operation: {
      id: "operation",
      agentId: "own",
      reason: "resume" as const,
      attempt: 1,
      supersedes: null,
      startedAt: new Date().toISOString(),
    },
    binding: null,
    history: { epoch: null, nextSeq: 1, persistence: null },
    agentId: "own",
    provider: "claude",
    cwd: home,
    workspaceId: null,
    reason: "resume" as const,
    purpose: "interactive" as const,
    env: {},
  };
  await expect(restarted.before("agent.session_open", request)).rejects.toMatchObject({
    code: "PLUGIN_ADMISSION_UNAVAILABLE",
  });
  await expect(
    restarted.before("agent.session_open", { ...request, agentId: "foreign" }),
  ).resolves.toMatchObject({ agentId: "foreign" });
  expect(
    service.admissionRecipients({
      agentId: "own",
      bindings: { scoped: binding },
    }).recipients,
  ).toEqual(["scoped"]);
});

test("operator release is scoped by historical binding, audited, durable and leaves global/legacy records", async () => {
  const { journal, home } = await fixture();
  const input = {
    agent: {
      id: "own",
      provider: "claude",
      cwd: home,
      title: null,
      workspaceId: null,
      parentAgentId: null,
    },
    reason: "resume" as const,
    origin: { kind: "daemon" as const, source: "restore" as const },
    previousEpoch: null,
    recipients: ["scoped", "global"],
    boundRecipients: { scoped: binding },
  };
  const own = await journal.begin(input);
  const legacy = await journal.begin({
    ...input,
    agent: { ...input.agent, id: "foreign" },
    boundRecipients: undefined,
  });
  const outcome = {
    status: "opened" as const,
    error: null,
    effect: {
      persistence: { provider: "claude", sessionId: "native" },
      historyEpoch: "epoch",
    },
  };
  await journal.finish(own.id, outcome);
  await journal.finish(legacy.id, outcome);
  const operator = {
    kind: "client" as const,
    principalId: "operator",
    clientId: "cli",
    clientType: "cli",
  };
  await expect(journal.releaseBoundRecipient("global", operator, "retired")).rejects.toThrow(
    "no bound",
  );
  await expect(
    journal.releaseBoundRecipient("scoped", { kind: "plugin", pluginId: "scoped" }, "retired"),
  ).rejects.toThrow("operator");
  await journal.releaseBoundRecipient("scoped", operator, "retired replay probe");
  const restarted = new AdmissionJournal(path.join(home, "admissions"));
  expect(await restarted.get(own.id)).toMatchObject({
    id: own.id,
    effect: outcome.effect,
    undeliveredTo: ["global"],
    recipientReleases: [
      {
        pluginId: "scoped",
        origin: operator,
        reason: "retired replay probe",
        binding,
      },
    ],
  });
  expect((await restarted.undelivered("scoped")).map((record) => record.id)).toEqual([legacy.id]);
  expect((await restarted.undelivered("global")).map((record) => record.id)).toEqual([
    own.id,
    legacy.id,
  ]);
  await restarted.releaseBoundRecipient("scoped", operator, "retry");
  expect((await restarted.get(own.id))!.recipientReleases).toHaveLength(1);
});

test("release refuses unfinished operations and create intent is journaled before an outcome", async () => {
  const { journal, home } = await fixture();
  const operation = await journal.begin({
    agent: {
      id: "new",
      provider: "claude",
      cwd: home,
      title: null,
      workspaceId: null,
      parentAgentId: null,
    },
    reason: "create",
    origin: { kind: "plugin", pluginId: "scoped" },
    previousEpoch: null,
    recipients: ["global"],
  });
  await journal.addBoundRecipients(operation.id, { scoped: binding });
  await expect(
    journal.releaseBoundRecipient(
      "scoped",
      {
        kind: "client",
        principalId: "operator",
        clientId: "cli",
        clientType: "cli",
      },
      "retired",
    ),
  ).rejects.toThrow("still pending");
  const restarted = new AdmissionJournal(path.join(home, "admissions"));
  expect(await restarted.get(operation.id)).toMatchObject({
    id: operation.id,
    status: "interrupted",
    boundRecipients: { scoped: binding },
    undeliveredTo: ["global", "scoped"],
  });
});

test("release audit survives retention and the delivered-failure budget", async () => {
  const { journal, home } = await fixture();
  const input = {
    agent: {
      id: "audited",
      provider: "claude",
      cwd: home,
      title: null,
      workspaceId: null,
      parentAgentId: null,
    },
    reason: "resume" as const,
    origin: { kind: "daemon" as const, source: "restore" as const },
    previousEpoch: null,
    recipients: ["scoped"],
    boundRecipients: { scoped: binding },
  };
  const failed = {
    status: "failed" as const,
    effect: null,
    error: { code: "UNAVAILABLE", message: "offline", stage: "fence" as const },
  };
  const audited = await journal.begin(input);
  await journal.finish(audited.id, failed);
  await journal.releaseBoundRecipient(
    "scoped",
    { kind: "client", principalId: "operator", clientId: "cli", clientType: "cli" },
    "retired",
  );
  for (let i = 0; i < 66; i++) {
    const record = await journal.begin({ ...input, recipients: [], boundRecipients: undefined });
    await journal.finish(record.id, failed);
  }
  expect(await journal.get(audited.id)).toMatchObject({
    recipientReleases: [{ reason: "retired" }],
  });
  // Expire all delivered rows and force a checkpoint on restart.
  const restarted = new AdmissionJournal(path.join(home, "admissions"), 0);
  expect(await restarted.get(audited.id)).toMatchObject({
    id: audited.id,
    recipientReleases: [{ reason: "retired" }],
  });
  const again = new AdmissionJournal(path.join(home, "admissions"));
  expect(await again.get(audited.id)).toMatchObject({
    id: audited.id,
    recipientReleases: [{ reason: "retired" }],
  });
});
