import { execFile, spawn } from "node:child_process";
import { UsageSourceRegistry } from "../../../packages/server/src/server/plugins/usage-sources/index.js";
import { Usage as MuseUsage } from "../server/usage.js";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test, vi } from "vitest";
import {
  PROVIDER_CAPABILITIES,
  ProviderEventSchema,
  type ProviderConnection,
  type ProviderEvent,
  type ProviderRegistration,
  type ProviderLaunch,
  type ProviderInput,
} from "@getpaseo/plugin/server/provider";
import type { UsageSourceRegistration } from "@getpaseo/plugin/server";
import { execCommand } from "@getpaseo/plugin/server";
import contribute from "../index.server.js";
import { IDLE_MS } from "../server/idle-host.js";
import { MspConnection } from "../server/connection.js";
import { z } from "zod";

const connections: ProviderConnection[] = [];
const roots: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(connections.splice(0).map((connection) => connection.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
function registration(
  registerUsageSource = (_source: UsageSourceRegistration) => {},
  id = "muse",
): ProviderRegistration {
  const providers = new Map<string, ProviderRegistration>();
  let usageRegistered = false;
  const server = {
    registerUsageSource(source: UsageSourceRegistration) {
      if (usageRegistered) throw new Error("usage source registered twice");
      usageRegistered = true;
      registerUsageSource(source);
    },
    registerProvider(value: ProviderRegistration) {
      providers.set(value.id, value);
    },
  };
  contribute(server);
  const provider = providers.get(id);
  if (!provider) throw new Error(`Provider ${id} was not registered`);
  return provider;
}
async function harness(
  scenario = "text-reasoning",
  env: Record<string, string> = {},
  providerOptions?: Record<string, unknown>,
  connectCapabilities: readonly string[] = PROVIDER_CAPABILITIES,
  providerId = "muse",
) {
  const root = await mkdtemp(path.join(os.tmpdir(), "muse-provider-test-"));
  roots.push(root);
  const requests = path.join(root, "requests.ndjson");
  const launch: ProviderLaunch = {
    command: process.execPath,
    args: [fileURLToPath(new URL("./fake-muse.mjs", import.meta.url))],
    env: { MUSE_TEST_SCENARIO: scenario, MUSE_TEST_REQUESTS: requests, ...env },
  };
  await writeFile(requests, "");
  let usageSource!: UsageSourceRegistration;
  const provider = registration((source) => {
    usageSource = source;
  }, providerId);
  const connection = await provider.connect({
    launch,
    versions: [1],
    capabilities: connectCapabilities,
  });
  connections.push(connection);
  const events: ProviderEvent[] = [];
  connection.onEvent((event) => {
    events.push(ProviderEventSchema.parse(event));
  });
  async function wait(
    predicate: (event: ProviderEvent) => boolean,
    from = 0,
  ): Promise<ProviderEvent> {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const event = events.slice(from).find(predicate);
      if (event) return event;
      await delay(10);
    }
    throw new Error(`Missing event; received ${JSON.stringify(events)}`);
  }
  async function send(input: ProviderInput) {
    const from = events.length;
    await connection.send(input);
    return from;
  }
  async function open(
    persistence?: Extract<ProviderInput, { type: "session.open" }>["persistence"],
    mode = "onRequest",
    model: string | null = "meta/muse-spark-1.3",
    sessionEnv: Record<string, string> = {},
    thinkingOption: string | null | undefined = "high",
  ) {
    await send({
      type: "session.open",
      requestId: "open",
      sessionId: "paseo-session",
      config: {
        cwd: root,
        providerOptions,
        env: sessionEnv,
        settings: {},
        mcpServers: {},
        persist: true,
        mode,
        model: model ?? undefined,
        // null exercises an unset composer value so persistence/catalog must supply the level.
        thinkingOption: thinkingOption ?? undefined,
        systemPrompt: "Test instructions",
      },
      persistence,
      history: "replay",
    });
    return wait((event) => event.type === "session.ready" || event.type === "request.failed");
  }
  async function prompt(delivery: "auto" | "steer" = "auto", image = false) {
    return send({
      type: "session.prompt",
      sessionId: "paseo-session",
      prompt: {
        clientMessageId: `client-${events.length}`,
        delivery,
        input: {
          type: "message",
          content: image
            ? [
                { type: "text", text: "hello" },
                { type: "image", mimeType: "image/png", data: "image-bytes" },
              ]
            : [{ type: "text", text: "hello" }],
        },
      },
    });
  }
  async function recorded() {
    return (await readFile(requests, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }
  return {
    provider,
    launch,
    connection,
    events,
    wait,
    send,
    open,
    prompt,
    recorded,
    root,
    usageSource,
  };
}

test("registration exposes Muse with a daemon-resolved command", () => {
  expect(registration()).toMatchObject({
    id: "muse",
    label: "Muse Code",
    command: ["muse"],
    icon: "icon.svg",
  });
});
test("catalog uses model effort variants, modes, and bounded cached discovery", async () => {
  const h = await harness("catalog-controls");
  await h.send({ type: "catalog", requestId: "catalog-1" });
  const catalogEvent = await h.wait((candidate) => candidate.type === "catalog");
  expect(catalogEvent).toMatchObject({
    catalog: {
      models: [
        {
          id: "meta/muse-spark-1.3",
          label: "meta/muse-spark-1.3",
          defaultThinkingOptionId: "high",
          thinkingOptions: [
            { id: "minimal" },
            { id: "low" },
            { id: "medium" },
            { id: "high" },
            { id: "xhigh" },
          ],
        },
      ],
      defaultMode: "onRequest",
      modes: [
        { id: "onRequest" },
        { id: "promptUnmatched" },
        { id: "denyUnmatched" },
        { id: "allowAll", isUnattended: true },
      ],
    },
  });
  await h.send({ type: "catalog", requestId: "catalog-2" });
  await h.wait((event) => event.type === "catalog" && event.requestId === "catalog-2");
  expect((await h.recorded()).filter((frame) => frame.method === "model/list")).toHaveLength(1);
});
test("text and reasoning stream, completion overwrites deltas, user echo retains client identity", async () => {
  const h = await harness();
  expect(await h.open()).toMatchObject({ type: "session.ready" });
  await h.prompt();
  await h.wait((event) => event.type === "session.turn" && event.state === "completed");
  expect(h.events).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: "timeline.item",
        item: expect.objectContaining({ type: "reasoning" }),
      }),
      expect.objectContaining({
        type: "timeline.item",
        item: expect.objectContaining({
          type: "user_message",
          clientMessageId: expect.stringMatching(/^client-/),
        }),
      }),
    ]),
  );
  const frames = await h.recorded();
  expect(frames.find((frame) => frame.method === "turn/start").params).toMatchObject({
    ifBusy: "queue",
    reasoningEffort: "high",
    displayText: "hello",
    input: [
      {
        type: "text",
        text: '<system-reminder source="paseo-system-prompt">\nTest instructions\n</system-reminder>',
      },
      { type: "text", text: "hello" },
    ],
  });
  expect(h.events.findLast((event) => event.type === "session.persistence")).toMatchObject({
    persistence: { version: 1, data: { model: "meta/muse-spark-1.3", thinkingOption: "high" } },
  });
});
test("system prompt uses Muse's own system-reminder shape exactly once", async () => {
  const h = await harness("image-followup");
  expect(await h.open()).toMatchObject({ type: "session.ready" });
  await h.prompt("auto", true);
  await h.wait((event) => event.type === "session.turn" && event.state === "completed");
  const from = await h.prompt();
  await h.wait((event) => event.type === "session.turn" && event.state === "completed", from);
  const turns = (await h.recorded()).filter((frame) => frame.method === "turn/start");
  expect(turns).toHaveLength(2);
  // pa-89is1.16: Muse's own servers wrap system context as
  // <system-reminder source="…">…</system-reminder>; the Paseo system prompt
  // must match that shape (attribute name and newlines), not
  // <system_instructions>.
  expect(turns[0].params.input[0]).toEqual({
    type: "text",
    text: '<system-reminder source="paseo-system-prompt">\nTest instructions\n</system-reminder>',
  });
  for (const turn of turns.slice(1))
    expect(JSON.stringify(turn.params.input)).not.toContain("paseo-system-prompt");
  expect(JSON.stringify(turns[0].params.input)).not.toContain("system_instructions");
});
test("resumed sessions do not resend the system prompt", async () => {
  const h = await harness("resume-without-cursor");
  await h.open({
    version: 1,
    data: { sessionId: "saved-session" },
  });
  await h.prompt();
  await h.wait((event) => event.type === "session.turn" && event.state === "completed");
  const turns = (await h.recorded()).filter((frame) => frame.method === "turn/start");
  expect(turns).toHaveLength(1);
  // The native session keeps its own context across resume, so the reminder
  // is first-turn only; config.systemPrompt (create/resume/turn_prepare,
  // pa-89is1.4) still flows through the same send-point above.
  expect(JSON.stringify(turns[0].params.input)).not.toContain("paseo-system-prompt");
  expect(JSON.stringify(turns[0].params.input)).not.toContain("system_instructions");
});
test("tool calls classify read, shell, and edit with fetched JSON patch converted to unified diff", async () => {
  const h = await harness("tools-edit");
  await h.open();
  await h.prompt();
  await h.wait((event) => event.type === "session.turn" && event.state === "completed");
  expect(h.events).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: "timeline.item",
        item: expect.objectContaining({
          detail: expect.objectContaining({ type: "read", filePath: "f" }),
        }),
      }),
      expect.objectContaining({
        type: "timeline.item",
        item: expect.objectContaining({
          detail: expect.objectContaining({ type: "shell", command: "wc -l f", output: "2 f\n" }),
        }),
      }),
      expect.objectContaining({
        type: "timeline.item",
        item: expect.objectContaining({
          detail: expect.objectContaining({
            type: "edit",
            unifiedDiff: expect.stringContaining("@@ -1,2 +1,2 @@\n alpha\n-beta\n+gamma\n"),
          }),
        }),
      }),
    ]),
  );
});

test("multi-stage approvals surface Stage 2 then Stage 3 and send the current requirement guard", async () => {
  const h = await harness("multi-stage-approval");
  await h.open();
  await h.prompt();
  const first = await h.wait((event) => event.type === "session.permission");
  expect(first).toMatchObject({
    request: {
      title: "Stage 2 of 3",
      detail: { type: "shell", command: "rm -rf f" },
      actions: [
        { id: "allow_once", behavior: "allow" },
        { id: "allow_local_prefix", behavior: "allow" },
        { id: "abort", behavior: "deny" },
      ],
    },
  });
  if (first.type !== "session.permission") throw new Error("Expected approval");
  const from = await h.send({
    type: "session.permission",
    sessionId: "paseo-session",
    permissionId: first.request.id,
    response: { behavior: "allow", selectedActionId: first.request.actions![0]!.id },
  });
  const second = await h.wait((event) => event.type === "session.permission", from);
  expect(second).toMatchObject({
    request: { title: "Stage 3 of 3", detail: { command: "rm -rf g" } },
  });
  await h.send({
    type: "session.permission",
    sessionId: "paseo-session",
    permissionId: first.request.id,
    response: { behavior: "allow", selectedActionId: first.request.actions![0]!.id },
  });
  await h.wait((event) => event.type === "session.permission_resolved");
  await h.wait((event) => event.type === "session.turn" && event.state === "completed");
  expect(
    (await h.recorded())
      .filter((frame) => frame.method === "approval/decide")
      .map((frame) => frame.params.requirementId.sourceIndex),
  ).toEqual([1, 2]);
});
test("Full access automatically answers every escalated stage with the published allow-once choice", async () => {
  const h = await harness("multi-stage-approval");
  await h.open(undefined, "allowAll");
  await h.prompt();
  await h.wait((event) => event.type === "session.turn" && event.state === "completed");
  expect(h.events.filter((event) => event.type === "session.permission")).toEqual([]);
  expect(
    (await h.recorded())
      .filter((frame) => frame.method === "approval/decide")
      .map((frame) => frame.params.choiceId),
  ).toEqual(["allow_once", "allow_once"]);
});
test("interrupt awaits cancelled terminal and reconciles the tool", async () => {
  const h = await harness("interrupt");
  await h.open();
  await h.prompt();
  await h.wait((event) => event.type === "session.prompt_result");
  await h.send({ type: "session.interrupt", sessionId: "paseo-session", requestId: "interrupt" });
  await h.wait((event) => event.type === "request.completed" && event.requestId === "interrupt");
  const terminalIndex = h.events.findIndex(
    (event) => event.type === "session.turn" && event.state === "canceled",
  );
  expect(terminalIndex).toBeGreaterThan(-1);
  expect(
    h.events.findIndex(
      (event) => event.type === "request.completed" && event.requestId === "interrupt",
    ),
  ).toBeGreaterThan(terminalIndex);
});
test("a fresh connection restores earlier messages from persisted session state", async () => {
  const original = await harness();
  const historyPath = path.join(original.root, "native-history.ndjson");
  original.launch.env.MUSE_TEST_HISTORY = historyPath;
  await original.open();
  await original.prompt();
  await original.wait((event) => event.type === "session.turn" && event.state === "completed");
  const messages = [
    ...new Map(
      original.events
        .filter((event) => event.type === "timeline.item")
        .map((event) => event.item)
        .filter((item) => item.type === "user_message" || item.type === "assistant_message")
        .map((item) => [item.id, item] as const),
    ).values(),
  ];
  expect(messages.map((item) => item.type)).toEqual(["user_message", "assistant_message"]);
  const saved = original.events.findLast((event) => event.type === "session.persistence");
  if (!saved) throw new Error("Expected session persistence");
  const persistencePath = path.join(original.root, "persistence.json");
  // Older daemon records carry a view cursor even though their timeline is not durable.
  await writeFile(
    persistencePath,
    JSON.stringify({
      ...saved.persistence,
      data: { ...saved.persistence.data, cursor: saved.persistence.data.cursor ?? "v:old:7" },
    }),
  );
  await original.connection.close();
  const reopened = await harness("text-reasoning", { MUSE_TEST_HISTORY: historyPath });
  expect(await reopened.open(JSON.parse(await readFile(persistencePath, "utf8")))).toMatchObject({
    type: "session.ready",
  });
  const restored = reopened.events
    .filter((event) => event.type === "timeline.item")
    .map((event) => event.item)
    .filter((item) => item.type === "user_message" || item.type === "assistant_message");
  expect(restored.map((item) => ({ type: item.type, text: item.text }))).toEqual(
    messages.map((item) => ({ type: item.type, text: item.text })),
  );
  const reopenedState = reopened.events.findLast((event) => event.type === "session.persistence");
  expect(reopenedState?.persistence.data).not.toHaveProperty("cursor");
  expect(reopened.events.filter((event) => event.type === "session.turn")).toEqual([]);
  await reopened.prompt();
  await reopened.wait((event) => event.type === "session.turn" && event.state === "completed");
});

for (const cursor of [undefined, "v:old:7"]) {
  test(`resume ${cursor ? "with a legacy persistence cursor" : "without a persistence cursor"} replays inline history`, async () => {
    const h = await harness("resume-without-cursor");
    await h.open({
      version: 1,
      data: { sessionId: "saved-session", ...(cursor ? { cursor } : {}) },
    });
    expect(h.events.filter((event) => event.type === "session.turn")).toEqual([]);
    const history = h.events.filter((event) => event.type === "timeline.item");
    expect(history).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          item: expect.objectContaining({ type: "assistant_message", text: "RESUME_MARKER_OK" }),
        }),
      ]),
    );
    await h.prompt();
    await h.wait((event) => event.type === "session.turn" && event.state === "completed");
    expect(
      h.events.filter((event) => event.type === "session.turn" && event.state === "completed"),
    ).toHaveLength(1);
    expect(
      (await h.recorded()).find((frame) => frame.method === "session/resume").params,
    ).toMatchObject({ sessionId: "saved-session" });
    expect(
      (await h.recorded()).find((frame) => frame.method === "session/resume").params,
    ).not.toHaveProperty("cursor");
  });
}
test("resume keeps the configured model and re-selects it on the native session", async () => {
  const h = await harness("resume-without-cursor");
  await h.open(
    { version: 1, data: { sessionId: "saved-session" } },
    "onRequest",
    "meta/muse-spark-1.3-contributor",
  );
  await h.wait((event) => event.type === "session.ready");
  // The native fixture session stands on the base model; the configured
  // contributor model must win and be re-selected, not drift.
  const config = h.events.findLast((event) => event.type === "session.config");
  expect(config).toMatchObject({ config: { model: "meta/muse-spark-1.3-contributor" } });
  expect(
    (await h.recorded()).find((frame) => frame.method === "session/setModel")?.params,
  ).toMatchObject({ model: { modelId: "meta/muse-spark-1.3-contributor" } });
  const saved = h.events.findLast((event) => event.type === "session.persistence");
  expect(saved?.persistence.data.model).toBe("meta/muse-spark-1.3-contributor");
});
test("resume without model drift does not re-select the model", async () => {
  const h = await harness("resume-without-cursor");
  await h.open({ version: 1, data: { sessionId: "saved-session" } });
  await h.wait((event) => event.type === "session.ready");
  expect((await h.recorded()).filter((frame) => frame.method === "session/setModel")).toEqual([]);
  expect(h.events.findLast((event) => event.type === "session.config")).toMatchObject({
    config: { model: "meta/muse-spark-1.3" },
  });
});
test("steer sends ifBusy steer and joins the running turn", async () => {
  const h = await harness("steer");
  await h.open();
  await h.prompt();
  await h.wait((event) => event.type === "session.prompt_result");
  const from = await h.prompt("steer");
  expect(await h.wait((event) => event.type === "session.prompt_result", from)).toMatchObject({
    result: { type: "steer" },
  });
  await h.wait((event) => event.type === "session.turn" && event.state === "completed");
  expect(
    (await h.recorded()).filter((frame) => frame.method === "turn/start")[1].params.ifBusy,
  ).toBe("steer");
});
test("image turn sends a native image and the subsequent text turn succeeds", async () => {
  const h = await harness("image-followup");
  await h.open();
  await h.prompt("auto", true);
  await h.wait((event) => event.type === "session.turn" && event.state === "completed");
  const from = await h.prompt();
  await h.wait((event) => event.type === "session.turn" && event.state === "completed", from);
  const turns = (await h.recorded()).filter((frame) => frame.method === "turn/start");
  expect(turns[0].params.input).toContainEqual({
    type: "image",
    mediaType: "image/png",
    base64Data: "image-bytes",
  });
  expect(turns[1].params.input).toEqual([{ type: "text", text: "hello" }]);
});
for (const source of ["live", "history", "backfill"]) {
  test(`reminder housekeeping emits no timeline items or child sessions from ${source}`, async () => {
    const scenario = source === "history" ? "resume-without-cursor" : "text-reasoning";
    const frames = (
      await readFile(new URL(`./fixtures/${scenario}.ndjson`, import.meta.url), "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const reminderIds = new Set<string>(
      frames
        .flatMap(({ msg }) =>
          msg.params?.item ? [msg.params.item] : (msg.result?.history?.items ?? []),
        )
        .filter((item) => item?.kind === "reminderChild")
        .map((item) => item.itemId),
    );
    expect(reminderIds.size).toBeGreaterThan(0);
    const h = await harness(scenario, source === "backfill" ? { MUSE_TEST_GAP: "1" } : {});
    await h.open(
      source === "history" ? { version: 1, data: { sessionId: "saved-session" } } : undefined,
    );
    await h.prompt();
    await h.wait((event) => event.type === "session.turn" && event.state === "completed");
    expect(
      h.events.filter((event) => event.type === "timeline.item" && reminderIds.has(event.item.id)),
    ).toEqual([]);
    expect(
      h.events.filter((event) => event.type === "session.opened").map((event) => event.sessionId),
    ).toEqual(["paseo-session"]);
    expect(
      (await h.recorded()).filter(
        (frame) => frame.method === "session/read" && reminderIds.has(frame.params.sessionId),
      ),
    ).toEqual([]);
  });
}
for (const [scenario, code, guidance] of [
  ["auto-review-unavailable", "defaultProfileUnavailable", "permissions.default_profile"],
  ["unsafe-path", "unsafePath", path.join("/test-data", "muse")],
]) {
  test(`${scenario} is a typed actionable construction error`, async () => {
    const h = await harness(scenario, { XDG_DATA_HOME: "/test-data" });
    expect(await h.open()).toMatchObject({
      type: "request.failed",
      error: { code, message: expect.stringContaining(guidance!) },
    });
  });
}
for (const [code, kind] of [
  [0, "cleanExit"],
  [2, "usage"],
  [3, "credentials"],
  [4, "leaseHeld"],
  [5, "surfaceOff"],
  [17, "crash"],
]) {
  test(`exit ${code} is classified ${kind} with stderr diagnostics`, async () => {
    const h = await harness("text-reasoning", { MUSE_TEST_EXIT: String(code) });
    expect(await h.open()).toMatchObject({
      type: "request.failed",
      error: { code: kind, message: expect.stringContaining("diagnostic tail, not protocol") },
    });
  });
}
for (const [env, expected] of [
  [
    { MUSE_TEST_VERSION: "1.2.9" },
    { available: false, diagnostic: "Update Muse Code: found 1.2.9, need ≥1.3.0" },
  ],
  [
    { MUSE_TEST_ACCOUNT: "loggedOut" },
    { available: false, diagnostic: "Run `muse login` or set META_API_KEY" },
  ],
  [{ MUSE_TEST_ACCOUNT: "envKey" }, { available: true }],
  [{ MUSE_TEST_ACCOUNT: "apiKey" }, { available: true }],
  [{ MUSE_TEST_ACCOUNT: "accountLogin" }, { available: true }],
] as const) {
  test(`status checks version and credential state ${JSON.stringify(env)}`, async () => {
    const h = await harness("catalog-controls", env);
    expect(await h.provider.status!({ launch: h.launch })).toEqual(expected);
  });
}
test("status preserves the version-probe command and stderr diagnostic", async () => {
  const h = await harness("catalog-controls", {
    MUSE_TEST_VERSION_ERROR: "Muse version probe could not read its installation metadata",
  });
  // Compare against the original execFile callback: wrapping in MuseError only changed its kind.
  const previousDiagnostic = await new Promise<string>((resolve, reject) => {
    execFile(h.launch.command, [...h.launch.args, "--version"], { env: h.launch.env }, (error) => {
      if (error) resolve(error.message);
      else reject(new Error("Expected the version probe to fail"));
    });
  });
  const status = await h.provider.status!({ launch: h.launch });
  expect(status).toEqual({ available: false, diagnostic: previousDiagnostic });
  expect(status.diagnostic).toContain("--version");
  expect(status.diagnostic).toContain(
    "Muse version probe could not read its installation metadata",
  );
  expect(await h.recorded()).toEqual([]);
});
test("status reports a missing executable", async () => {
  const h = await harness();
  expect(
    await h.provider.status!({ launch: { ...h.launch, command: "/missing/muse" } }),
  ).toMatchObject({ available: false, diagnostic: expect.stringContaining("ENOENT") });
});
test("overloaded retry reuses UUIDv7 commandId", async () => {
  const h = await harness("text-reasoning", { MUSE_TEST_RETRY: "turn/start" });
  await h.open();
  await h.prompt();
  await h.wait((event) => event.type === "session.turn" && event.state === "completed");
  const turns = (await h.recorded()).filter((frame) => frame.method === "turn/start");
  expect(turns).toHaveLength(2);
  expect(turns[0].params.commandId).toBe(turns[1].params.commandId);
});
test("missing saved session refuses to start fresh", async () => {
  const h = await harness("resume-without-cursor", { MUSE_TEST_GONE: "1" });
  expect(await h.open({ version: 1, data: { sessionId: "gone" } })).toMatchObject({
    type: "request.failed",
    error: {
      code: "sessionNotFound",
      message: "This Muse session no longer exists. Create a new agent.",
    },
  });
  expect((await h.recorded()).filter((frame) => frame.method === "session/start")).toEqual([]);
});
test("empty resume viewCursor is a typed error", async () => {
  const h = await harness("resume-without-cursor", { MUSE_TEST_EMPTY_CURSOR: "1" });
  expect(await h.open({ version: 1, data: { sessionId: "saved" } })).toMatchObject({
    type: "request.failed",
    error: { code: "emptyViewCursor" },
  });
});
test("catalogue identity includes command and routing credentials without exposing them", async () => {
  const h = await harness();
  const first = await h.provider.getCatalogCacheKey!({ scope: "global", launch: h.launch });
  const second = await h.provider.getCatalogCacheKey!({
    scope: "global",
    launch: { ...h.launch, env: { ...h.launch.env, META_API_KEY: "secret" } },
  });
  expect(first).not.toBe(second);
  expect(second).not.toContain("secret");
});

test("configure reports the effective model, approval mode, and per-turn effort", async () => {
  const h = await harness("catalog-controls");
  await h.open();
  const from = await h.send({
    type: "session.configure",
    requestId: "configure",
    sessionId: "paseo-session",
    changes: { model: "meta/muse-spark-1.3", mode: "promptUnmatched", thinkingOption: "low" },
  });
  await h.wait((event) => event.type === "request.completed" && event.requestId === "configure");
  expect(h.events.slice(from)).toContainEqual(
    expect.objectContaining({
      type: "session.config",
      config: expect.objectContaining({
        model: "meta/muse-spark-1.3",
        mode: "promptUnmatched",
        thinkingOption: "low",
        models: [expect.objectContaining({ id: "meta/muse-spark-1.3" })],
      }),
    }),
  );
});
test("CLI-style allow response selects a published allow action without a supplied id", async () => {
  const h = await harness("staged-approval");
  await h.open();
  await h.prompt();
  const permissionEvent = await h.wait((candidate) => candidate.type === "session.permission");
  if (permissionEvent.type !== "session.permission") throw new Error("Expected approval");
  await h.send({
    type: "session.permission",
    sessionId: "paseo-session",
    permissionId: permissionEvent.request.id,
    response: { behavior: "allow" },
  });
  await h.wait((event) => event.type === "session.turn" && event.state === "completed");
  expect(
    (await h.recorded()).find((frame) => frame.method === "approval/decide").params.choiceId,
  ).toBe("allow_once");
});
test("closing cancels a catalogue host instead of waiting for a stalled request", async () => {
  const h = await harness("catalog-controls", { MUSE_TEST_HANG: "model/list" });
  await h.send({ type: "catalog", requestId: "catalog" });
  await expect
    .poll(async () => (await h.recorded()).some((frame) => frame.method === "model/list"))
    .toBe(true);
  await h.connection.close();
  expect(h.events.filter((event) => event.type === "catalog")).toEqual([]);
  expect(await h.recorded()).toContainEqual({ event: "hostClosed" });
});

for (const retryKind of ["overloaded", "backpressured"]) {
  test(`${retryKind} session construction retries with the same UUIDv7`, async () => {
    const h = await harness("text-reasoning", {
      MUSE_TEST_RETRY: "session/start",
      MUSE_TEST_RETRY_KIND: retryKind,
    });
    expect(await h.open()).toMatchObject({ type: "session.ready" });
    const attempts = (await h.recorded()).filter((frame) => frame.method === "session/start");
    expect(attempts).toHaveLength(2);
    expect(attempts[0].params.commandId).toBe(attempts[1].params.commandId);
  });
}
test("higher-revision item completion replaces streamed text and ignores stale snapshots", async () => {
  const h = await harness("text-reasoning", { MUSE_TEST_STALE: "1" });
  await h.open();
  await h.prompt();
  await h.wait((event) => event.type === "session.turn" && event.state === "completed");
  const assistant = h.events.filter(
    (event) => event.type === "timeline.item" && event.item.type === "assistant_message",
  );
  expect(assistant.length).toBeGreaterThan(2);
  expect(assistant.at(-1)).toMatchObject({
    item: { text: expect.stringContaining("`147/60 = 49/20`") },
  });
  expect(assistant).not.toContainEqual(
    expect.objectContaining({ item: expect.objectContaining({ text: "STALE_REVISION" }) }),
  );
  expect(h.events).toContainEqual(
    expect.objectContaining({
      type: "timeline.item",
      item: {
        type: "reasoning",
        id: "f3c7d3fc-1644-46c3-b63c-74e0c7dee6c3",
        text: "Computing the rational sum by finding a common denominator and reducing the fraction to lowest terms via gcd.",
      },
    }),
  );
});
test("ordinary subagent tool calls render sub_agent details without inventing child identity", async () => {
  const h = await harness("subagent");
  await h.open();
  await h.prompt();
  await h.wait((event) => event.type === "session.turn" && event.state === "completed");
  expect(h.events).toContainEqual(
    expect.objectContaining({
      type: "timeline.item",
      item: expect.objectContaining({
        name: "subagent_read_result",
        status: "completed",
        detail: expect.objectContaining({
          type: "sub_agent",
          log: expect.stringContaining("SUBAGENT_PHASE0_OK"),
        }),
      }),
    }),
  );
});
for (const [variants, expected] of [
  [
    ["low", "high"],
    ["low", "high"],
  ],
  ["unknown", ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"]],
  [[], ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"]],
] as const) {
  test(`catalogue effort discovery with variants ${JSON.stringify(variants)}`, async () => {
    const model = {
      modelId: "test-model",
      providerId: "meta",
      displayLabel: "Test model",
      contextLimit: 123456,
      isDefault: true,
      variants,
      defaultReasoningEffort: "high",
    };
    const h = await harness("catalog-controls", { MUSE_TEST_MODELS: JSON.stringify([model]) });
    await h.send({ type: "catalog", requestId: "models" });
    const result = await h.wait((event) => event.type === "catalog");
    expect(result).toMatchObject({
      catalog: {
        defaultModel: "test-model",
        models: [
          { contextWindowMaxTokens: 123456, thinkingOptions: expected.map((id) => ({ id })) },
        ],
      },
    });
  });
}
test("catalogue loads models whose effort tiers carry descriptions", async () => {
  const deepest = "Use this for deepest analysis and complex fixes.";
  const row = (modelId: string, isDefault: boolean) => ({
    modelId,
    providerId: "meta",
    displayLabel: modelId,
    contextLimit: 1000000,
    isDefault,
    defaultReasoningEffort: "max",
    variants: ["minimal", "low", "medium", "high", "xhigh", "max"],
    reasoningEffortVariants: isDefault ? [] : [{ tier: "xhigh", description: deepest }],
  });
  const models = [
    row("muse-spark-1.3", true),
    row("muse-spark-1.3-contributor", false),
    row("muse-spark-1.2", false),
    row("muse-spark-1.2-contributor", false),
  ];
  const h = await harness("catalog-controls", { MUSE_TEST_MODELS: JSON.stringify(models) });
  await h.send({ type: "catalog", requestId: "models" });
  const result = await h.wait(
    (event) => event.type === "catalog" || event.type === "request.failed",
  );
  const offered = [
    { id: "minimal" },
    { id: "low" },
    { id: "medium" },
    { id: "high" },
    { id: "xhigh" },
    { id: "max", isDefault: true },
  ];
  expect(result).toMatchObject({
    type: "catalog",
    catalog: {
      defaultModel: "muse-spark-1.3",
      models: [
        { id: "muse-spark-1.3", defaultThinkingOptionId: "max" },
        { id: "muse-spark-1.3-contributor", thinkingOptions: offered },
        { id: "muse-spark-1.2", thinkingOptions: offered },
        { id: "muse-spark-1.2-contributor", thinkingOptions: offered },
      ],
    },
  });
});
for (const [configuredModel, catalogModels, expectedModel] of [
  ["configured-model", [], "configured-model"],
  [
    "",
    [
      {
        modelId: "catalog-model",
        providerId: "meta",
        displayLabel: "Catalog model",
        contextLimit: null,
        isDefault: true,
        variants: ["high"],
      },
    ],
    "catalog-model",
  ],
  ["", [], undefined],
] as const) {
  test(`null session model preserves ${expectedModel ?? "unset model"}`, async () => {
    const h = await harness("text-reasoning", {
      MUSE_TEST_NULL_MODEL: "1",
      MUSE_TEST_MODELS: JSON.stringify(catalogModels),
    });
    expect(await h.open(undefined, "onRequest", configuredModel || null)).toEqual({
      type: "session.ready",
      requestId: "open",
      sessionId: "paseo-session",
    });
    const config = await h.wait((event) => event.type === "session.config");
    if (config.type !== "session.config") throw new Error("Expected session config");
    expect(config.config.model).toBe(expectedModel);
    const saved = h.events.findLast((event) => event.type === "session.persistence");
    if (!saved) throw new Error("Expected persistence");
    expect(saved.persistence.data.model).toBe(expectedModel);
    await h.prompt();
    await h.wait((event) => event.type === "session.turn" && event.state === "completed");
  });
}
test("session startup accepts described catalog efforts and publishes the complete list", async () => {
  const model = {
    modelId: "meta/muse-spark-1.3",
    providerId: "meta",
    displayLabel: "Muse Spark",
    contextLimit: null,
    isDefault: true,
    defaultReasoningEffort: "max",
    variants: ["minimal", "low", "medium", "high", "xhigh", "max"],
    reasoningEffortVariants: [{ tier: "xhigh", description: "Deepest analysis" }],
  };
  const h = await harness("text-reasoning", { MUSE_TEST_MODELS: JSON.stringify([model]) });
  expect(await h.open()).toEqual({
    type: "session.ready",
    requestId: "open",
    sessionId: "paseo-session",
  });
  expect(await h.wait((event) => event.type === "session.config")).toMatchObject({
    config: {
      models: [{ id: model.modelId, defaultThinkingOptionId: "max" }],
      thinkingOptions: model.variants.map((id) => ({ id, isDefault: id === "max" })),
    },
  });
  await h.send({
    type: "session.configure",
    requestId: "choose-max",
    sessionId: "paseo-session",
    changes: { thinkingOption: "max" },
  });
  await h.wait((event) => event.type === "request.completed" && event.requestId === "choose-max");
  await h.prompt();
  await h.wait((event) => event.type === "session.turn" && event.state === "completed");
  expect(
    (await h.recorded()).find((frame) => frame.method === "turn/start").params.reasoningEffort,
  ).toBe("max");
});
test("fresh open mirrors the configured effort into the host session default", async () => {
  const h = await harness();
  expect(await h.open()).toEqual({
    type: "session.ready",
    requestId: "open",
    sessionId: "paseo-session",
  });
  const frames = await h.recorded();
  const startIndex = frames.findIndex((frame) => frame.method === "session/start");
  const setIndex = frames.findIndex((frame) => frame.method === "session/setReasoningEffort");
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(setIndex).toBeGreaterThan(startIndex);
  expect(frames[setIndex].params).toMatchObject({ reasoningEffort: "high" });
});
test("configure mirrors the chosen effort into the host session default", async () => {
  const h = await harness();
  await h.open();
  await h.send({
    type: "session.configure",
    requestId: "choose-max",
    sessionId: "paseo-session",
    changes: { thinkingOption: "max" },
  });
  await h.wait((event) => event.type === "request.completed" && event.requestId === "choose-max");
  const frames = await h.recorded();
  const applied = frames.filter((frame) => frame.method === "session/setReasoningEffort");
  expect(applied.length).toBeGreaterThanOrEqual(2);
  expect(applied.at(-1).params).toMatchObject({ reasoningEffort: "max" });
  // The per-turn override still rides along, so older hosts keep working.
  await h.prompt();
  await h.wait((event) => event.type === "session.turn" && event.state === "completed");
  expect(
    (await h.recorded()).find((frame) => frame.method === "turn/start").params.reasoningEffort,
  ).toBe("max");
});
test("resume re-applies the saved effort to the host session", async () => {
  const h = await harness("resume-without-cursor");
  expect(
    await h.open(
      {
        version: 1,
        data: { sessionId: "saved-session", model: "meta/muse-spark-1.3", thinkingOption: "max" },
      },
      "onRequest",
      "meta/muse-spark-1.3",
      {},
      null,
    ),
  ).toEqual({
    type: "session.ready",
    requestId: "open",
    sessionId: "paseo-session",
  });
  const frames = await h.recorded();
  const resumeIndex = frames.findIndex((frame) => frame.method === "session/resume");
  const setIndex = frames.findIndex((frame) => frame.method === "session/setReasoningEffort");
  expect(resumeIndex).toBeGreaterThanOrEqual(0);
  expect(setIndex).toBeGreaterThan(resumeIndex);
  expect(frames[setIndex].params).toMatchObject({ reasoningEffort: "max" });
  const config = await h.wait((event) => event.type === "session.config");
  expect(config).toMatchObject({ config: { thinkingOption: "max" } });
});
test("open and configure survive a host without session/setReasoningEffort", async () => {
  const h = await harness("text-reasoning", { MUSE_TEST_REJECT_EFFORT: "1" });
  expect(await h.open()).toMatchObject({ type: "session.ready" });
  await h.send({
    type: "session.configure",
    requestId: "choose-max",
    sessionId: "paseo-session",
    changes: { thinkingOption: "max" },
  });
  await h.wait((event) => event.type === "request.completed" && event.requestId === "choose-max");
  await h.prompt();
  await h.wait((event) => event.type === "session.turn" && event.state === "completed");
  expect(
    (await h.recorded()).find((frame) => frame.method === "turn/start").params.reasoningEffort,
  ).toBe("max");
});
for (const metadata of [
  "unknown",
  [{ tier: "future-tier", description: { text: "Future metadata" } }],
]) {
  test(`catalog ignores unused effort descriptions ${JSON.stringify(metadata)}`, async () => {
    const model = {
      modelId: "test-model",
      providerId: "meta",
      displayLabel: "Muse Spark",
      contextLimit: null,
      isDefault: true,
      defaultReasoningEffort: "high",
      variants: ["low", "high"],
      reasoningEffortVariants: metadata,
    };
    const h = await harness("catalog-controls", { MUSE_TEST_MODELS: JSON.stringify([model]) });
    await h.send({ type: "catalog", requestId: "models" });
    expect(
      await h.wait((event) => event.type === "catalog" || event.type === "request.failed"),
    ).toMatchObject({
      type: "catalog",
      catalog: {
        models: [
          { id: model.modelId, thinkingOptions: [{ id: "low" }, { id: "high", isDefault: true }] },
        ],
      },
    });
  });
}
test("status accepts future credential states and drains its maintenance host", async () => {
  const h = await harness("catalog-controls", { MUSE_TEST_ACCOUNT: "futureCredential" });
  expect(await h.provider.status!({ launch: h.launch })).toEqual({ available: true });
  expect(await h.recorded()).toContainEqual({ event: "hostClosed" });
});

for (const [tool, detail] of [
  ["grep", "search"],
  ["glob", "search"],
  ["ls", "search"],
  ["web_search", "search"],
  ["web_fetch", "fetch"],
  ["custom_tool", "unknown"],
]) {
  test(`${tool} tool calls use ${detail} detail`, async () => {
    const h = await harness("tools-edit", { MUSE_TEST_TOOL: tool! });
    await h.open();
    await h.prompt();
    await h.wait((event) => event.type === "session.turn" && event.state === "completed");
    expect(h.events).toContainEqual(
      expect.objectContaining({
        type: "timeline.item",
        item: expect.objectContaining({
          name: tool,
          status: "completed",
          detail: expect.objectContaining({ type: detail }),
        }),
      }),
    );
  });
}
test("a future item kind uses fallbackText without breaking turn completion", async () => {
  const h = await harness("tools-edit", { MUSE_TEST_UNKNOWN_KIND: "1" });
  await h.open();
  await h.prompt();
  await h.wait((event) => event.type === "session.turn" && event.state === "completed");
  expect(h.events).toContainEqual(
    expect.objectContaining({
      type: "timeline.item",
      item: expect.objectContaining({
        name: "futureItem",
        detail: { type: "plain_text", label: "futureItem", text: "New MSP item" },
      }),
    }),
  );
});
test("fingerprint mismatch is logged but does not prevent opening", async () => {
  const h = await harness("text-reasoning", { MUSE_TEST_FINGERPRINT: "sha256:unverified" });
  expect(await h.open()).toMatchObject({ type: "session.ready" });
});
for (const restoring of [false, true]) {
  test(`MCP servers map to MSP stdio and streamableHttp on ${restoring ? "resume" : "start"}`, async () => {
    const h = await harness(restoring ? "resume-without-cursor" : "text-reasoning");
    await h.send({
      type: "session.open",
      sessionId: "paseo-session",
      requestId: "mcp",
      persistence: restoring
        ? { version: 1, data: { sessionId: "saved-session", cursor: "v:old:7" } }
        : undefined,
      history: "replay",
      config: {
        cwd: h.root,
        env: {},
        persist: true,
        settings: {},
        mcpServers: {
          stdio: {
            type: "stdio",
            command: "test-server",
            args: ["--serve"],
            env: { TEST_ENV: "yes" },
          },
          paseo: {
            type: "http",
            url: "http://localhost/mcp/agents",
            headers: { Authorization: "Bearer test-token" },
          },
        },
      },
    });
    await h.wait((event) => event.type === "session.ready");
    expect(
      (await h.recorded()).find(
        (frame) => frame.method === (restoring ? "session/resume" : "session/start"),
      ).params.config.mcpServers,
    ).toEqual({
      stdio: {
        transport: "stdio",
        command: "test-server",
        args: ["--serve"],
        env: { TEST_ENV: "yes" },
        framing: "lineDelimitedJson",
      },
      paseo: {
        transport: "streamableHttp",
        url: "http://localhost/mcp/agents",
        headers: { Authorization: "Bearer test-token" },
      },
    });
  });
}

test("authRequired turn errors retain their kind and explain login recovery", async () => {
  const h = await harness("text-reasoning", { MUSE_TEST_AUTH_REQUIRED: "1" });
  await h.open();
  await h.prompt();
  expect(
    await h.wait((event) => event.type === "session.turn" && event.state === "failed"),
  ).toMatchObject({
    error: { code: "authRequired", message: "Run `muse login` or set META_API_KEY." },
  });
});
test("status bounds a stalled account read and closes the host", async () => {
  const h = await harness("catalog-controls", { MUSE_TEST_HANG: "account/read" });
  expect(await h.provider.status!({ launch: h.launch })).toEqual({
    available: false,
    diagnostic: "Muse account/read timed out after 10 s",
  });
  expect(await h.recorded()).toContainEqual({ event: "hostClosed" });
}, 30000);

test("status tolerates a slow version probe when the daemon starts under load", async () => {
  // pa-4ua43: a cold daemon under load can stall spawn past the old 3 s
  // probe timeout and stick the snapshot at unavailable. The raised probe
  // timeout must still report the provider as available.
  const h = await harness("catalog-controls", { MUSE_TEST_VERSION_DELAY_MS: "5000" });
  expect(await h.provider.status!({ launch: h.launch })).toEqual({ available: true });
  expect(await h.recorded()).toContainEqual({ event: "hostClosed" });
}, 30000);

test("interrupt targets the running turn when another prompt is queued", async () => {
  const h = await harness("interrupt", { MUSE_TEST_QUEUE: "1" });
  await h.open();
  await h.prompt();
  await h.wait((event) => event.type === "session.prompt_result");
  const from = await h.prompt();
  await h.wait((event) => event.type === "session.prompt_result", from);
  await h.send({
    type: "session.interrupt",
    sessionId: "paseo-session",
    requestId: "interrupt-queued",
  });
  await h.wait(
    (event) => event.type === "request.completed" && event.requestId === "interrupt-queued",
  );
  const requests = await h.recorded();
  const active = requests.find((frame) => frame.method === "turn/start");
  expect(requests.find((frame) => frame.method === "turn/interrupt").params.turnId).toBe(
    active.params.commandId,
  );
});

for (const terminal of ["completed", "failed"]) {
  test(`interrupt resolves when its targeted turn independently ends ${terminal}`, async () => {
    const h = await harness("interrupt", { MUSE_TEST_INTERRUPT_TERMINAL: terminal });
    await h.open();
    await h.prompt();
    await h.wait((event) => event.type === "session.prompt_result");
    await h.send({
      type: "session.interrupt",
      sessionId: "paseo-session",
      requestId: "racing-interrupt",
    });
    await h.wait((event) => event.type === "session.turn" && event.state === terminal);
    await h.wait(
      (event) => event.type === "request.completed" && event.requestId === "racing-interrupt",
    );
    expect(h.events.filter((event) => event.type === "request.failed")).toEqual([]);
  });
}
test("a backfilled failed terminal for a natively active turn is ignored and interrupt still reaches the run", async () => {
  const h = await harness("text-reasoning", {
    MUSE_TEST_SILENT: "1",
    MUSE_TEST_GAP: "1",
    MUSE_TEST_ACTIVE_TURN: "1",
    MUSE_TEST_PHANTOM: "1",
  });
  await h.open();
  await h.prompt();
  await h.wait((event) => event.type === "session.turn" && event.state === "started");
  await expect
    .poll(
      async () =>
        (await h.recorded()).filter(
          (frame) =>
            frame.method === "session/read" &&
            frame.params.sessionId === "01a0ee4c-c501-7d50-9020-effa9f9956e1",
        ),
      { timeout: 10000 },
    )
    .toHaveLength(1);
  await delay(500);
  expect(
    h.events.filter((event) => event.type === "session.turn" && event.state === "failed"),
  ).toEqual([]);
  const from = await h.send({
    type: "session.interrupt",
    sessionId: "paseo-session",
    requestId: "phantom-interrupt",
  });
  await h.wait(
    (event) => event.type === "request.completed" && event.requestId === "phantom-interrupt",
    from,
  );
  const requests = await h.recorded();
  const started = requests.find((frame) => frame.method === "turn/start");
  expect(requests.find((frame) => frame.method === "turn/interrupt")?.params.turnId).toBe(
    started.params.commandId,
  );
}, 15000);
test("a backfilled failed terminal is accepted when the native run already ended", async () => {
  const h = await harness("text-reasoning", {
    MUSE_TEST_SILENT: "1",
    MUSE_TEST_GAP: "1",
    MUSE_TEST_PHANTOM: "1",
  });
  await h.open();
  await h.prompt();
  await h.wait((event) => event.type === "session.turn" && event.state === "started");
  const failed = await h.wait((event) => event.type === "session.turn" && event.state === "failed");
  expect(failed).toMatchObject({ state: "failed", error: { message: "Muse turn failed" } });
  expect(
    (await h.recorded()).filter(
      (frame) =>
        frame.method === "session/read" &&
        frame.params.sessionId === "01a0ee4c-c501-7d50-9020-effa9f9956e1",
    ),
  ).toHaveLength(1);
  expect(h.events.filter((event) => event.type === "session.runtime_failed")).toEqual([]);
});
test("interrupt timeout fails the session and closes the host without an unhandled rejection", async () => {
  const h = await harness("text-reasoning", {
    MUSE_TEST_SILENT: "1",
    MUSE_TEST_HANG: "turn/interrupt",
  });
  await h.open();
  await h.prompt();
  await h.wait((event) => event.type === "session.turn" && event.state === "started");
  await h.send({
    type: "session.interrupt",
    sessionId: "paseo-session",
    requestId: "slow-interrupt",
  });
  await expect
    .poll(() => h.events.find((event) => event.type === "session.runtime_failed"), {
      timeout: 20000,
    })
    .toBeDefined();
  await h.connection.close();
  const requests = await h.recorded();
  expect(requests.filter((frame) => frame.method === "turn/interrupt")).toHaveLength(1);
  expect(requests.find((frame) => frame.event === "hostClosed")).toBeDefined();
}, 30000);
test("interrupt timeout terminates the turn so a retry does not re-target the dead host", async () => {
  const h = await harness("text-reasoning", {
    MUSE_TEST_SILENT: "1",
    MUSE_TEST_HANG: "turn/interrupt",
  });
  await h.open();
  await h.prompt();
  const started = await h.wait(
    (event) => event.type === "session.turn" && event.state === "started",
  );
  if (started.type !== "session.turn" || !started.turnId) throw new Error("Expected started turn");
  await h.send({
    type: "session.interrupt",
    sessionId: "paseo-session",
    requestId: "slow-interrupt",
  });
  // The interrupted turn ends locally even though the host never confirms.
  await expect
    .poll(
      () => h.events.find((event) => event.type === "session.turn" && event.state === "failed"),
      {
        timeout: 20000,
      },
    )
    .toBeDefined();
  expect(
    h.events.find((event) => event.type === "session.turn" && event.state === "failed"),
  ).toMatchObject({
    turnId: started.turnId,
    state: "failed",
    error: { message: expect.stringContaining("did not confirm cancellation") },
  });
  await expect
    .poll(() => h.events.find((event) => event.type === "session.runtime_failed"), {
      timeout: 20000,
    })
    .toBeDefined();
  // A retry must not send turn/interrupt again: the turn is over.
  await h.send({
    type: "session.interrupt",
    sessionId: "paseo-session",
    requestId: "retry-interrupt",
  });
  await h.wait(
    (event) => event.type === "request.completed" && event.requestId === "retry-interrupt",
  );
  const requests = await h.recorded();
  expect(requests.filter((frame) => frame.method === "turn/interrupt")).toHaveLength(1);
  await h.connection.close();
}, 60000);
for (const [behavior, choiceId] of [
  ["allow", "allow_once"],
  ["deny", "abort"],
] as const) {
  test(`CLI ${behavior} prefers the plain once choice over a broader fixture grant`, async () => {
    const h = await harness("staged-approval", { MUSE_TEST_CHOICES: "reverse" });
    await h.open();
    await h.prompt();
    const permission = await h.wait((event) => event.type === "session.permission");
    if (permission.type !== "session.permission") throw new Error("Expected permission");
    await h.send({
      type: "session.permission",
      sessionId: "paseo-session",
      permissionId: permission.request.id,
      response: { behavior },
    });
    await expect
      .poll(
        async () =>
          (await h.recorded()).find((frame) => frame.method === "approval/decide")?.params.choiceId,
      )
      .toBe(choiceId);
  });
}

test("CLI deny rejects a tool without aborting when denied/once is offered", async () => {
  const h = await harness("staged-approval", { MUSE_TEST_DENIED: "1" });
  await h.open();
  await h.prompt();
  const permission = await h.wait((event) => event.type === "session.permission");
  if (permission.type !== "session.permission") throw new Error("Expected permission");
  await h.send({
    type: "session.permission",
    sessionId: "paseo-session",
    permissionId: permission.request.id,
    response: { behavior: "deny" },
  });
  await expect
    .poll(
      async () =>
        (await h.recorded()).find((frame) => frame.method === "approval/decide")?.params.choiceId,
    )
    .toBe("reject_once");
});

test("skills publish commands and command prompts submit structured skill parts", async () => {
  const h = await harness("skill");
  await h.open();
  expect(await h.wait((e) => e.type === "session.commands")).toMatchObject({
    commands: expect.arrayContaining([
      expect.objectContaining({ name: "phase0", description: expect.any(String) }),
      expect.objectContaining({ name: "compact", description: expect.any(String) }),
    ]),
  });
  await h.send({
    type: "session.prompt",
    sessionId: "paseo-session",
    prompt: {
      clientMessageId: "skill-client",
      delivery: "auto",
      input: { type: "command", name: "phase0", arguments: "argument text" },
    },
  });
  await h.wait((e) => e.type === "session.turn" && e.state === "completed");
  expect((await h.recorded()).find((f) => f.method === "turn/start").params).toMatchObject({
    input: expect.arrayContaining([
      { type: "skill", selector: "phase0", arguments: "argument text" },
    ]),
    displayText: "/phase0 argument text",
  });
});

test("skill changes refresh the session command catalog", async () => {
  const h = await harness("skill", { MUSE_TEST_SKILLS_CHANGED: "1" });
  await h.open();
  const from = await h.prompt();
  expect(await h.wait((e) => e.type === "session.commands", from)).toMatchObject({
    commands: [{ name: "compact", description: "Compact conversation context" }],
  });
  expect((await h.recorded()).filter((f) => f.method === "skill/list")).toHaveLength(2);
});
for (const mode of ["answer", "cancel"] as const) {
  test(`todo and question ${mode} replay through the provider interface`, async () => {
    const h = await harness(mode === "answer" ? "phase3-controls" : "phase3-cancel");
    await h.open();
    await h.prompt();
    if (mode === "answer")
      expect(
        await h.wait((e) => e.type === "timeline.item" && e.item.type === "todo"),
      ).toMatchObject({
        item: {
          items: [
            { text: "inspect f", completed: false, status: "in_progress" },
            { text: "report", completed: false, status: "pending" },
          ],
        },
      });
    const permission = await h.wait(
      (e) => e.type === "session.permission" && e.request.kind === "question",
    );
    if (permission.type !== "session.permission") throw new Error("Expected question");
    expect(permission.request.input).toMatchObject({
      questions: [
        { header: "Color", options: [{ label: "Blue" }, { label: "Green" }], multiSelect: false },
      ],
    });
    await h.send({
      type: "session.permission",
      sessionId: "paseo-session",
      permissionId: permission.request.id,
      response:
        mode === "answer"
          ? { behavior: "allow", updatedInput: { answers: { Color: "Blue" } } }
          : { behavior: "deny", message: "QA cancellation" },
    });
    await h.wait(
      (e) => e.type === "session.permission_resolved" && e.permissionId === permission.request.id,
    );
    const frame = (await h.recorded()).find(
      (f) => f.method === (mode === "answer" ? "userInput/answer" : "userInput/cancel"),
    );
    expect(frame.params.userInputId).toBe(permission.request.id);
    if (mode === "answer")
      expect(frame.params.answers).toEqual([{ questionId: "color_choice", selectedLabel: "Blue" }]);
    expect((await h.recorded()).some((f) => f.result && Object.keys(f.result).length === 0)).toBe(
      true,
    );
  });
}
for (const variant of ["tool", "dedicated", "workflow"]) {
  test(`${variant} subagent opens only the supplied child and pages its real transcript`, async () => {
    const h = await harness("subagent", { MUSE_TEST_CHILD: variant });
    await h.open();
    await h.prompt();
    expect(
      await h.wait((e) => e.type === "session.opened" && e.sessionId === "fixture-child"),
    ).toMatchObject({
      parentSessionId: "paseo-session",
      restoration: "parent",
      toolCallId: expect.any(String),
    });
    expect(
      await h.wait(
        (e) =>
          e.type === "timeline.item" &&
          e.sessionId === "fixture-child" &&
          e.item.type === "assistant_message",
      ),
    ).toMatchObject({ item: { text: "SUBAGENT_PHASE0_OK" } });
    await h.wait((e) => e.type === "session.turn" && e.state === "completed");
    expect(
      h.events.filter((e) => e.type === "session.opened" && e.sessionId === "fixture-child"),
    ).toHaveLength(1);
    expect(
      (await h.recorded())
        .filter((f) => f.method === "session/read")
        .map((f) => f.params.sessionId),
    ).toEqual(["fixture-child"]);
    expect(
      h.events.filter(
        (e) =>
          e.type === "timeline.item" &&
          e.sessionId === "fixture-child" &&
          e.item.type === "assistant_message",
      ),
    ).toHaveLength(1);
  });
}

test("session.opened advertises session.subsession so the daemon accepts child sessions", async () => {
  const h = await harness("subagent", { MUSE_TEST_CHILD: "workflow" });
  expect(h.connection.capabilities).toContain("session.subsession");
  await h.open();
  const opened = h.events.find((e) => e.type === "session.opened");
  expect(opened).toMatchObject({
    sessionId: "paseo-session",
    capabilities: expect.arrayContaining(["session.subsession"]),
  });
  await h.prompt();
  await h.wait((e) => e.type === "session.opened" && e.sessionId === "fixture-child");
});

test("three parallel workflow children project as three subagents sharing one turn", async () => {
  const h = await harness("subagent-3", { MUSE_TEST_CHILD: "workflow", MUSE_TEST_CHILD_SEQ: "1" });
  await h.open();
  await h.prompt();
  for (const id of ["fixture-child-1", "fixture-child-2", "fixture-child-3"]) {
    expect(await h.wait((e) => e.type === "session.opened" && e.sessionId === id)).toMatchObject({
      parentSessionId: "paseo-session",
      restoration: "parent",
    });
  }
  await h.wait((e) => e.type === "session.turn" && e.state === "completed");
  const opened = h.events.filter(
    (e) => e.type === "session.opened" && e.parentSessionId === "paseo-session",
  );
  expect(opened.map((e) => e.sessionId).sort()).toEqual([
    "fixture-child-1",
    "fixture-child-2",
    "fixture-child-3",
  ]);
  for (const id of ["fixture-child-1", "fixture-child-2", "fixture-child-3"]) {
    expect(
      h.events.filter(
        (e) =>
          e.type === "timeline.item" && e.sessionId === id && e.item.type === "assistant_message",
      ),
    ).toHaveLength(1);
  }
  expect(
    (await h.recorded())
      .filter((f) => f.method === "session/read")
      .map((f) => f.params.sessionId)
      .sort(),
  ).toEqual(["fixture-child-1", "fixture-child-2", "fixture-child-3"]);
});

test("without session.subsession the parent gets a timeline error instead of a projected child", async () => {
  const withoutSubsession = PROVIDER_CAPABILITIES.filter(
    (capability) => capability !== "session.subsession",
  );
  const h = await harness(
    "subagent",
    { MUSE_TEST_CHILD: "workflow" },
    undefined,
    withoutSubsession,
  );
  expect(h.connection.capabilities).not.toContain("session.subsession");
  await h.open();
  await h.prompt();
  await h.wait((e) => e.type === "session.turn" && e.state === "completed");
  expect(
    h.events.filter((e) => e.type === "session.opened" && e.sessionId === "fixture-child"),
  ).toEqual([]);
  const error = h.events.find(
    (e) =>
      e.type === "timeline.item" &&
      e.sessionId === "paseo-session" &&
      e.item.type === "error" &&
      e.item.id === "subsession-unsupported:fixture-child",
  );
  expect(error).toMatchObject({
    item: { message: expect.stringContaining("session.subsession") },
  });
  // The connection stays alive: the parent session closes cleanly afterwards.
  const from = await h.send({
    type: "session.close",
    sessionId: "paseo-session",
    requestId: "close",
  });
  await h.wait((e) => e.type === "session.closed", from);
});

test("status names session.subsession when the daemon never offered it", async () => {
  const withoutSubsession = PROVIDER_CAPABILITIES.filter(
    (capability) => capability !== "session.subsession",
  );
  const h = await harness("catalog-controls", {}, undefined, withoutSubsession);
  expect(await h.provider.status!({ launch: h.launch })).toMatchObject({
    available: true,
    diagnostic: expect.stringContaining("session.subsession"),
  });
});
test("gap backfill repairs a missing completion without duplicating item revisions", async () => {
  const h = await harness("text-reasoning", { MUSE_TEST_GAP: "1" });
  await h.open();
  await h.prompt();
  await h.wait((e) => e.type === "session.turn" && e.state === "completed");
  const frames = (await h.recorded()).filter((f) => f.method === "view/page");
  expect(frames.map((f) => f.params.cursor)).toEqual(["fixture-last-cursor"]);
  const messages = h.events.filter(
    (e) => e.type === "timeline.item" && e.item.type === "assistant_message",
  );
  expect(messages.at(-1)).toMatchObject({ item: { text: expect.stringContaining("49/20") } });
  expect(h.events.filter((e) => e.type === "session.turn" && e.state === "completed")).toHaveLength(
    1,
  );
});
test("silent active turns page after two minutes and stop polling on recovered terminal", async () => {
  const h = await harness("text-reasoning", { MUSE_TEST_SILENT: "1" });
  await h.open();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  await h.prompt();
  await h.wait((e) => e.type === "session.prompt_result");
  await vi.advanceTimersByTimeAsync(119999);
  expect((await h.recorded()).filter((f) => f.method === "view/page")).toEqual([]);
  await vi.advanceTimersByTimeAsync(1);
  await h.wait((e) => e.type === "session.turn" && e.state === "completed");
  await vi.advanceTimersByTimeAsync(240000);
  expect((await h.recorded()).filter((f) => f.method === "view/page")).toHaveLength(1);
});
test("session readiness accepts initialization beyond the old event polling window", async () => {
  const h = await harness("text-reasoning", { MUSE_TEST_INITIALIZE_DELAY_MS: "3500" });
  expect(await h.open()).toMatchObject({ type: "session.ready" });
  expect((await h.recorded()).find((frame) => frame.event === "hostStarted").args).toEqual([
    "serve",
    "--sandbox-network",
    "proxy-only",
    "--disable-sandbox",
    "--trust-workspace",
  ]);
}, 10000);

// pa-89is1.21: the first session/start on a fresh `muse serve` scans the whole
// session store first; under load that took up to 13.5 s, past the 10 s request
// budget. Session construction gets its own budget, other requests keep 10 s.
test("session/start slower than the request budget still opens the session", async () => {
  const h = await harness("text-reasoning", {
    MUSE_TEST_DELAY_METHOD: "session/start",
    MUSE_TEST_DELAY_MS: "11000",
  });
  // h.open() waits only 5 s for readiness; this start answers after 11 s.
  void h.open().catch(() => {});
  await expect
    .poll(
      () =>
        h.events.find((event) => event.type === "session.ready" || event.type === "request.failed"),
      { timeout: 20000, interval: 100 },
    )
    .toMatchObject({ type: "session.ready" });
}, 30000);

test("a session/start that never answers fails naming its budget", async () => {
  const connection = new MspConnection({
    launch: {
      command: process.execPath,
      args: [fileURLToPath(new URL("./fake-muse.mjs", import.meta.url))],
      env: { MUSE_TEST_SCENARIO: "text-reasoning", MUSE_TEST_HANG: "session/start" },
    },
  });
  try {
    await connection.initialize();
    await expect(
      connection.command("session/start", { workspaceRoot: os.tmpdir() }, z.unknown(), 300),
    ).rejects.toMatchObject({
      kind: "timeout",
      message: "Muse session/start timed out after 0.3 s",
    });
  } finally {
    await connection.close();
  }
});

test("default launch disables sandbox and trusts workspace", async () => {
  const h = await harness();
  await h.open();
  expect((await h.recorded()).find((f) => f.event === "hostStarted").args).toEqual([
    "serve",
    "--sandbox-network",
    "proxy-only",
    "--disable-sandbox",
    "--trust-workspace",
  ]);
});
test.each([
  [{ sandbox: { enabled: true } }, ["--sandbox-network", "proxy-only", "--trust-workspace"]],
  [{ trustWorkspace: false }, ["--sandbox-network", "proxy-only", "--disable-sandbox"]],
  [
    { sandbox: { network: "restricted" } },
    ["--sandbox-network", "restricted", "--disable-sandbox", "--trust-workspace"],
  ],
  [
    { sandbox: { network: "enabled" } },
    ["--sandbox-network", "enabled", "--disable-sandbox", "--trust-workspace"],
  ],
  [
    { sandbox: { enabled: true, network: "proxy-only" }, trustWorkspace: false },
    ["--sandbox-network", "proxy-only"],
  ],
])("provider options %j control launch flags", async (params, args) => {
  const h = await harness("text-reasoning", {}, params);
  await h.open();
  expect((await h.recorded()).find((f) => f.event === "hostStarted").args).toEqual([
    "serve",
    ...args,
  ]);
});
test.each([
  [{ sandbox: { enabled: "true" } }, "sandbox.enabled"],
  [{ sandbox: { network: "invalid" } }, "sandbox.network"],
  [{ trustWorkspace: 1 }, "trustWorkspace"],
  [{ unexpected: true }, "unexpected"],
])("invalid provider options %j fail session creation clearly", async (options, field) => {
  const h = await harness("text-reasoning", {}, options);
  const event = await h.open();
  expect(event).toMatchObject({
    type: "request.failed",
    error: { code: "invalidProviderOptions" },
  });
  if (event.type !== "request.failed") throw new Error("Expected failure");
  expect(event.error.message).toContain("Invalid Muse providerOptions");
  expect(event.error.message).toContain(field);
  expect(await h.recorded()).toEqual([]);
});
test("resuming a session reapplies its provider options to the new host", async () => {
  const h = await harness(
    "resume-without-cursor",
    {},
    {
      sandbox: { enabled: true, network: "restricted" },
      trustWorkspace: false,
    },
  );
  await h.open({ version: 1, data: { sessionId: "saved-session" } });
  const saved = h.events.find((e) => e.type === "session.opened");
  if (saved?.type !== "session.opened" || !saved.persistence)
    throw new Error("Expected persistence");
  await h.send({ type: "session.close", sessionId: "paseo-session", requestId: "close" });
  await h.wait((e) => e.type === "session.closed");
  const from = h.events.length;
  await h.open(saved.persistence);
  await h.wait((e) => e.type === "session.ready", from);
  const frames = await h.recorded();
  expect(frames.filter((f) => f.event === "hostStarted").map((f) => f.args)).toEqual([
    ["serve", "--sandbox-network", "restricted"],
    ["serve", "--sandbox-network", "restricted"],
  ]);
  expect(frames.some((f) => f.method === "session/resume")).toBe(true);
});
// Daemon sessions need a daemon that answers on the well-known socket. Each
// test gets its own XDG_DATA_HOME and a listener standing in for
// `muse serve --listen`, so no test touches the machine's real daemon.
const daemons: net.Server[] = [];
afterEach(async () => {
  await Promise.all(
    daemons
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});
async function daemonHome(listen = true): Promise<string> {
  const data = await mkdtemp(path.join(os.tmpdir(), "muse-daemon-test-"));
  roots.push(data);
  const dir = path.join(data, "muse", "session-server");
  await mkdir(dir, { recursive: true });
  if (listen) {
    const server = net.createServer((socket) => socket.destroy());
    daemons.push(server);
    await new Promise<void>((resolve) =>
      server.listen(path.join(dir, "session-server.sock"), () => resolve()),
    );
  }
  return data;
}
let DAEMON_SESSION_ENV: Record<string, string> = {};
afterEach(() => {
  DAEMON_SESSION_ENV = {};
});
// A wrapper that logs its argv to <wrapper>.log and runs the rest.
async function writeWrapper(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "muse-wrapper-test-"));
  roots.push(dir);
  const file = path.join(dir, "wrap");
  await writeFile(file, `#!/bin/sh\necho "$*" >> "$0.log"\n[ "$1" = --tag ] && shift\nexec "$@"\n`);
  await chmod(file, 0o755);
  return file;
}
async function daemonEnv(): Promise<Record<string, string>> {
  DAEMON_SESSION_ENV = { PASEO_MUSE_DAEMON: "1", XDG_DATA_HOME: await daemonHome() };
  return DAEMON_SESSION_ENV;
}
function hostArgs(frames: { event?: string; args?: string[] }[]): string[] {
  const started = frames.find((f) => f.event === "hostStarted");
  if (!started?.args) throw new Error("Expected a hostStarted record");
  return started.args;
}
test("a daemon session joins the shared host and keeps the default sandbox posture", async () => {
  await daemonEnv();
  const h = await harness();
  expect(
    await h.open(undefined, "onRequest", "meta/muse-spark-1.3", DAEMON_SESSION_ENV),
  ).toMatchObject({ type: "session.ready" });
  expect(hostArgs(await h.recorded())).toEqual([
    "serve",
    "--sandbox-network",
    "proxy-only",
    "--disable-sandbox",
    "--trust-workspace",
    "--join",
  ]);
});
test("a daemon session stores its launch env for the daemon's command hook", async () => {
  const envDir = await daemonHome(false);
  const env = {
    ...(await daemonEnv()),
    PASEO_MUSE_SESSION_ENV_DIR: envDir,
    ORBIT_BEAD: "bead-1",
    PATH: "/agent/bin:/usr/bin",
  };
  const h = await harness("text-reasoning", { LAUNCH_ONLY: "launch" });
  expect(await h.open(undefined, "onRequest", "meta/muse-spark-1.3", env)).toMatchObject({
    type: "session.ready",
  });
  const start = (await h.recorded()).find((f) => f.method === "session/start").params;
  expect(start.limits).toBeUndefined();
  const files = (await readdir(envDir)).filter((f) => f !== "muse").sort();
  expect(files).toEqual(
    ["01a0ee4c-c501-7d50-9020-effa9f9956e1.json", "hook.cjs", "run.cjs"].sort(),
  );
  const stored = JSON.parse(
    await readFile(path.join(envDir, "01a0ee4c-c501-7d50-9020-effa9f9956e1.json"), "utf8"),
  );
  expect(stored.wrapper).toEqual([]);
  expect(stored.env).toMatchObject({
    ORBIT_BEAD: "bead-1",
    PATH: "/agent/bin:/usr/bin",
    LAUNCH_ONLY: "launch",
  });
  expect(
    (await stat(path.join(envDir, "01a0ee4c-c501-7d50-9020-effa9f9956e1.json"))).mode & 0o777,
  ).toBe(0o600);
  expect((await stat(envDir)).mode & 0o777).toBe(0o700);
  await h.connection.close();
  expect(await readdir(envDir)).not.toContain("01a0ee4c-c501-7d50-9020-effa9f9956e1.json");
});
test("an own-host session stores no env file", async () => {
  const envDir = await daemonHome(false);
  const h = await harness("text-reasoning", { PASEO_MUSE_SESSION_ENV_DIR: envDir });
  await h.open();
  expect(await readdir(envDir)).toEqual(["muse"]);
});
test("daemon sessions give stdio MCP servers the launch env under their own env", async () => {
  const env = { ...(await daemonEnv()), ORBIT_BEAD: "bead-3", TEST_ENV: "session" };
  const h = await harness();
  await h.send({
    type: "session.open",
    sessionId: "paseo-session",
    requestId: "mcp-env",
    history: "replay",
    config: {
      cwd: h.root,
      env,
      persist: true,
      settings: {},
      mcpServers: {
        stdio: { type: "stdio", command: "srv", args: [], env: { TEST_ENV: "server" } },
        http: { type: "http", url: "http://localhost/mcp", headers: { A: "b" } },
      },
    },
  });
  await h.wait((event) => event.type === "session.ready");
  const servers = (await h.recorded()).find((f) => f.method === "session/start").params.config
    .mcpServers;
  expect(servers.stdio.env).toMatchObject({ ORBIT_BEAD: "bead-3", TEST_ENV: "server" });
  expect(servers.http).toEqual({
    transport: "streamableHttp",
    url: "http://localhost/mcp",
    headers: { A: "b" },
  });
});
test("the plugin registers muse and muse-ws", () => {
  expect(registration(undefined, "muse").label).toBe("Muse Code");
  expect(registration(undefined, "muse-ws").label).toBe("Muse Code (worktree sandbox)");
});
test("muse-ws without a wrapper fails to open and spawns nothing", async () => {
  const h = await harness("text-reasoning", {}, undefined, PROVIDER_CAPABILITIES, "muse-ws");
  expect(await h.open()).toMatchObject({
    type: "request.failed",
    error: { code: "wrapperRequired" },
  });
  expect((await h.recorded()).filter((f) => f.event === "hostStarted")).toEqual([]);
});
test("an own muse-ws host runs muse serve through the wrapper", async () => {
  const wrapper = await writeWrapper();
  const h = await harness(
    "text-reasoning",
    {},
    { wrapper: [wrapper, "--tag"] },
    PROVIDER_CAPABILITIES,
    "muse-ws",
  );
  expect(await h.open()).toMatchObject({ type: "session.ready" });
  const log = await readFile(`${wrapper}.log`, "utf8");
  expect(log).toContain("--tag ");
  expect(log).toMatch(/fake-muse\.mjs serve /);
});
test("a joined muse-ws session wraps stdio MCP servers and stores the wrapper, not the host", async () => {
  const envDir = await daemonHome(false);
  const wrapper = await writeWrapper();
  const env = { ...(await daemonEnv()), PASEO_MUSE_SESSION_ENV_DIR: envDir };
  const h = await harness(
    "text-reasoning",
    {},
    { wrapper: [wrapper] },
    PROVIDER_CAPABILITIES,
    "muse-ws",
  );
  await h.send({
    type: "session.open",
    sessionId: "paseo-session",
    requestId: "ws",
    history: "replay",
    config: {
      cwd: h.root,
      env,
      persist: true,
      settings: {},
      providerOptions: { wrapper: [wrapper] },
      mcpServers: { srv: { type: "stdio", command: "mcp-bin", args: ["--x"] } },
    },
  });
  await h.wait((event) => event.type === "session.ready");
  expect(hostArgs(await h.recorded())).toContain("--join");
  await expect(readFile(`${wrapper}.log`, "utf8")).rejects.toThrow();
  const servers = (await h.recorded()).find((f) => f.method === "session/start").params.config
    .mcpServers;
  expect(servers.srv).toMatchObject({ command: wrapper, args: ["mcp-bin", "--x"] });
  const stored = JSON.parse(
    await readFile(path.join(envDir, "01a0ee4c-c501-7d50-9020-effa9f9956e1.json"), "utf8"),
  );
  expect(stored.wrapper).toEqual([wrapper]);
});
test("a daemon session reattached after idle re-declares stdio MCP with its env and wrapper", async () => {
  const envDir = await daemonHome(false);
  const wrapper = await writeWrapper();
  const env = {
    ...(await daemonEnv()),
    PASEO_MUSE_SESSION_ENV_DIR: envDir,
    ORBIT_BEAD: "bead-r",
  };
  const history = path.join(envDir, "native-history.ndjson");
  const h = await harness(
    "text-reasoning",
    { MUSE_TEST_HISTORY: history },
    { wrapper: [wrapper] },
    PROVIDER_CAPABILITIES,
    "muse-ws",
  );
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  await h.send({
    type: "session.open",
    sessionId: "paseo-session",
    requestId: "reattach",
    history: "replay",
    config: {
      cwd: h.root,
      env,
      persist: true,
      settings: {},
      providerOptions: { wrapper: [wrapper] },
      mcpServers: { srv: { type: "stdio", command: "mcp-bin", args: ["--x"] } },
    },
  });
  // Fake the idle timer before open arms it; the open itself still waits on
  // short timers, so step them until the session is ready.
  for (let tries = 0; !h.events.some((e) => e.type === "session.ready") && tries < 500; tries++) {
    await vi.advanceTimersByTimeAsync(10);
    await delay(10);
  }
  await h.wait((event) => event.type === "session.ready");
  // One turn before idle writes the native history the resume replays.
  const turnDone = () =>
    h.events.filter((e) => e.type === "session.turn" && e.state === "completed").length;
  await h.prompt();
  for (let tries = 0; turnDone() < 1 && tries < 500; tries++) {
    await vi.advanceTimersByTimeAsync(10);
    await delay(10);
  }
  expect(turnDone()).toBe(1);
  const hosts = async (event: string) =>
    (await h.recorded()).filter((frame) => frame.event === event).length;
  await vi.advanceTimersByTimeAsync(IDLE_MS);
  for (let tries = 0; (await hosts("hostClosed")) === 0 && tries < 500; tries++) await delay(10);
  expect(await hosts("hostClosed")).toBe(1);
  await h.prompt();
  for (let tries = 0; turnDone() < 2 && tries < 500; tries++) {
    await vi.advanceTimersByTimeAsync(10);
    await delay(10);
  }
  expect(turnDone()).toBe(2);
  const resume = (await h.recorded()).find((f) => f.method === "session/resume");
  expect(resume.params.config.mcpServers.srv).toMatchObject({
    command: wrapper,
    args: ["mcp-bin", "--x"],
    env: { ORBIT_BEAD: "bead-r" },
  });
  expect(await readdir(envDir)).toContain("01a0ee4c-c501-7d50-9020-effa9f9956e1.json");
}, 15000);
test("a non-daemon PASEO_MUSE_DAEMON value spawns an own host", async () => {
  const h = await harness();
  await h.open(undefined, "onRequest", "meta/muse-spark-1.3", { PASEO_MUSE_DAEMON: "0" });
  expect(hostArgs(await h.recorded())).not.toContain("--join");
});
test("a daemon-joined session runs the thinking path end to end", async () => {
  await daemonEnv();
  const h = await harness();
  expect(
    await h.open(undefined, "onRequest", "meta/muse-spark-1.3", DAEMON_SESSION_ENV),
  ).toMatchObject({ type: "session.ready" });
  await h.prompt();
  await h.wait((event) => event.type === "session.turn" && event.state === "completed");
  const frames = await h.recorded();
  expect(frames.find((frame) => frame.method === "turn/start").params).toMatchObject({
    reasoningEffort: "high",
  });
  expect(h.events.findLast((event) => event.type === "session.persistence")).toMatchObject({
    persistence: { version: 1, data: { model: "meta/muse-spark-1.3", thinkingOption: "high" } },
  });
  expect(
    h.events.filter((event) => event.type === "timeline.item" && event.item.type === "reasoning"),
  ).not.toEqual([]);
});
for (const variant of ["tool", "dedicated", "workflow"]) {
  test(`${variant} subagent opens the supplied child on a daemon-joined host`, async () => {
    await daemonEnv();
    const h = await harness("subagent", { MUSE_TEST_CHILD: variant });
    expect(
      await h.open(undefined, "onRequest", "meta/muse-spark-1.3", DAEMON_SESSION_ENV),
    ).toMatchObject({ type: "session.ready" });
    expect(hostArgs(await h.recorded())).toContain("--join");
    await h.prompt();
    expect(
      await h.wait((e) => e.type === "session.opened" && e.sessionId === "fixture-child"),
    ).toMatchObject({ parentSessionId: "paseo-session", restoration: "parent" });
    expect(
      await h.wait(
        (e) =>
          e.type === "timeline.item" &&
          e.sessionId === "fixture-child" &&
          e.item.type === "assistant_message",
      ),
    ).toMatchObject({ item: { text: "SUBAGENT_PHASE0_OK" } });
    await h.wait((e) => e.type === "session.turn" && e.state === "completed");
  });
}
for (const kind of ["overloaded", "backpressured"]) {
  test(`a ${kind} daemon refusal at start fails the session instead of spawning an own host`, async () => {
    const h = await harness("text-reasoning", {
      MUSE_TEST_REFUSE_JOIN: "1",
      MUSE_TEST_REFUSE_KIND: kind,
    });
    expect(
      await h.open(undefined, "onRequest", "meta/muse-spark-1.3", await daemonEnv()),
    ).toMatchObject({ type: "request.failed", error: { code: kind } });
    const starts = (await h.recorded()).filter((f) => f.event === "hostStarted");
    expect(starts).toHaveLength(1);
    expect(starts[0].args).toContain("--join");
  });
}
test("a daemon session fails with daemonUnavailable when no daemon socket exists", async () => {
  const h = await harness();
  const env = { PASEO_MUSE_DAEMON: "1", XDG_DATA_HOME: await daemonHome(false) };
  expect(await h.open(undefined, "onRequest", "meta/muse-spark-1.3", env)).toMatchObject({
    type: "request.failed",
    error: { code: "daemonUnavailable", message: expect.stringContaining("session-server.sock") },
  });
  expect((await h.recorded()).filter((f) => f.event === "hostStarted")).toEqual([]);
});
test("a stale socket left by a killed daemon counts as no daemon", async () => {
  const h = await harness();
  const data = await daemonHome(false);
  const socket = path.join(data, "muse", "session-server", "session-server.sock");
  // SIGKILL leaves the socket file with no listener: the connect is refused.
  const child = await new Promise<import("node:child_process").ChildProcess>((resolve) => {
    const proc = spawn(process.execPath, [
      "-e",
      `require("net").createServer().listen(${JSON.stringify(socket)}, () => console.log("up"))`,
    ]);
    proc.stdout?.once("data", () => resolve(proc));
  });
  child.kill("SIGKILL");
  await new Promise((resolve) => child.once("exit", resolve));
  expect(
    await h.open(undefined, "onRequest", "meta/muse-spark-1.3", {
      PASEO_MUSE_DAEMON: "1",
      XDG_DATA_HOME: data,
    }),
  ).toMatchObject({
    type: "request.failed",
    error: { code: "daemonUnavailable", message: expect.stringContaining("ECONNREFUSED") },
  });
  expect((await h.recorded()).filter((f) => f.event === "hostStarted")).toEqual([]);
});
test("a daemon-joined session resumes inline history after its host restarts", async () => {
  await daemonEnv();
  const original = await harness();
  const historyPath = path.join(original.root, "native-history.ndjson");
  original.launch.env.MUSE_TEST_HISTORY = historyPath;
  await original.open(undefined, "onRequest", "meta/muse-spark-1.3", DAEMON_SESSION_ENV);
  await original.prompt();
  await original.wait((event) => event.type === "session.turn" && event.state === "completed");
  const messages = [
    ...new Map(
      original.events
        .filter((event) => event.type === "timeline.item")
        .map((event) => event.item)
        .filter((item) => item.type === "user_message" || item.type === "assistant_message")
        .map((item) => [item.id, item] as const),
    ).values(),
  ];
  const saved = original.events.findLast((event) => event.type === "session.persistence");
  if (!saved || saved.type !== "session.persistence") throw new Error("Expected persistence");
  await original.connection.close();
  const reopened = await harness("text-reasoning", { MUSE_TEST_HISTORY: historyPath });
  expect(
    await reopened.open(saved.persistence, "onRequest", "meta/muse-spark-1.3", DAEMON_SESSION_ENV),
  ).toMatchObject({ type: "session.ready" });
  expect(hostArgs(await reopened.recorded())).toContain("--join");
  expect(reopened.events.filter((event) => event.type === "session.turn")).toEqual([]);
  const restored = reopened.events
    .filter((event) => event.type === "timeline.item")
    .map((event) => event.item)
    .filter((item) => item.type === "user_message" || item.type === "assistant_message");
  expect(restored.map((item) => ({ type: item.type, text: item.text }))).toEqual(
    messages.map((item) => ({ type: item.type, text: item.text })),
  );
  await reopened.prompt();
  await reopened.wait((event) => event.type === "session.turn" && event.state === "completed");
});
test("an uncorrelated MSP parse error keeps the provider diagnostic", async () => {
  const h = await harness("text-reasoning", { MUSE_TEST_NULL_ERROR_ID: "1" });
  expect(await h.open()).toMatchObject({
    type: "request.failed",
    error: { code: "parseError", message: "Cannot recover request id" },
  });
});
test("text deltas with an omitted field stream as text", async () => {
  const h = await harness("text-reasoning", { MUSE_TEST_IMPLICIT_TEXT_DELTA: "1" });
  await h.open();
  await h.wait((e) => e.type === "session.ready");
  await h.prompt();
  await h.wait((e) => e.type === "session.turn" && e.state === "completed");
  expect(
    h.events.some(
      (e) =>
        e.type === "timeline.item" &&
        e.item.type === "assistant_message" &&
        e.item.text === "Sum with",
    ),
  ).toBe(true);
});
test("sessions with a null model import and resume without a null persistence model", async () => {
  const h = await harness("resume-without-cursor", { MUSE_TEST_NULL_MODEL: "1" });
  await h.send({
    type: "sessions",
    requestId: "null-list",
    cwd: "/tmp/muse-phase0/repo",
    limit: 2,
  });
  const listed = await h.wait((e) => e.type === "sessions");
  if (listed.type !== "sessions") throw new Error("Expected sessions");
  expect(listed.sessions).toHaveLength(2);
  expect(listed.sessions[0]!.persistence.data.model).toBeUndefined();
  await h.open(listed.sessions[0]!.persistence);
  await h.wait((e) => e.type === "session.ready");
  expect(
    h.events.some((e) => e.type === "session.config" && e.config.model === "meta/muse-spark-1.3"),
  ).toBe(true);
});
test("sessions list filters workspace and imported persistence opens via resume", async () => {
  const h = await harness("resume-without-cursor");
  await h.send({
    type: "sessions",
    requestId: "import-list",
    cwd: "/tmp/muse-phase0/repo",
    limit: 2,
  });
  const listed = await h.wait((e) => e.type === "sessions");
  if (listed.type !== "sessions") throw new Error("Expected sessions");
  expect(listed.sessions).toHaveLength(2);
  expect((await h.recorded()).find((f) => f.method === "session/list").params.workspaceRoot).toBe(
    "/tmp/muse-phase0/repo",
  );
  await h.open(listed.sessions[0]!.persistence);
  expect((await h.recorded()).filter((f) => f.method === "session/start")).toEqual([]);
  expect((await h.recorded()).find((f) => f.method === "session/resume").params.sessionId).toBe(
    listed.sessions[0]!.persistence.data.sessionId,
  );
});
test("sessions list skips muse subagent sessions", async () => {
  const h = await harness("resume-without-cursor", { MUSE_TEST_SUBAGENT_LIST: "1" });
  await h.send({
    type: "sessions",
    requestId: "subagent-list",
    cwd: "/tmp/muse-phase0/repo",
    limit: 10,
  });
  const listed = await h.wait((e) => e.type === "sessions");
  if (listed.type !== "sessions") throw new Error("Expected sessions");
  expect(listed.sessions.map((s) => s.persistence.data.sessionId)).toEqual([
    "09b0ee4b-8364-7aa1-9ba3-c251d4cf0cb6",
  ]);
});
for (const fixture of ["phase3-compact", "phase3-compact-history", "phase3-compact-limit"]) {
  test(`${fixture} routes compact and exposes the recorded outcome`, async () => {
    const h = await harness(fixture);
    const rows = (
      await readFile(
        fileURLToPath(new URL(`./fixtures/${fixture}.ndjson`, import.meta.url)),
        "utf8",
      )
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const nativeId = rows.find((row) => row.msg.method === "session/resume").msg.params.sessionId;
    await h.open({ version: 1, data: { sessionId: nativeId } });
    await h.send({
      type: "session.prompt",
      sessionId: "paseo-session",
      prompt: {
        clientMessageId: "compact",
        delivery: "auto",
        input: { type: "command", name: "compact", arguments: "" },
      },
    });
    if (fixture === "phase3-compact-limit") {
      expect(await h.wait((e) => e.type === "session.prompt_result")).toMatchObject({
        result: { type: "completed" },
      });
      expect(
        await h.wait(
          (e) =>
            e.type === "timeline.item" &&
            e.item.type === "compaction" &&
            e.item.status === "completed",
        ),
      ).toMatchObject({ item: { preTokens: 22192 } });
    } else
      expect(await h.wait((e) => e.type === "session.prompt_result")).toMatchObject({
        result: {
          type: "failed",
          error: {
            code: "commandRejected",
            message: expect.stringContaining("context_compaction.provider_context_limit_tokens"),
          },
        },
      });
    expect((await h.recorded()).filter((f) => f.method === "turn/start")).toEqual([]);
  });
}
for (const usage of [
  {},
  {
    usage: {
      observedAtMs: 1700000000000,
      tier: "Pro",
      window: { usedPercent: 75, resetsAtMs: 1700018000000, windowDurationMins: 300 },
      weekly: { usedPercent: 105, resetsAtMs: 1700604800000 },
    },
  },
]) {
  test(`usage source presents ${"usage" in usage ? "subscription windows" : "real route absence"} from discovered accounts`, async () => {
    const h = await harness("catalog-controls", { MUSE_TEST_USAGE: JSON.stringify(usage) });
    await h.open();
    const inputs = await h.usageSource.discover({ kind: "global" });
    expect(inputs).toHaveLength(1);
    const account = inputs[0]!;
    expect(account).toEqual({
      key: expect.stringMatching(/^[a-f0-9]{64}$/),
      label: "Muse Code",
      input: { account: account.key },
    });
    const report = await h.usageSource.fetch(account.input);
    if ("usage" in usage)
      expect(report).toMatchObject({
        status: "available",
        planLabel: "Pro",
        windows: [
          {
            id: "five_hour",
            label: "5-hour",
            usedPct: 75,
            remainingPct: 25,
            tone: "warning",
          },
          { id: "weekly", usedPct: 105, remainingPct: 0, tone: "danger" },
        ],
      });
    else
      expect(report).toEqual({
        status: "unavailable",
        problem: { kind: "no_quota", detail: "No usage quota reported" },
      });
    expect((await h.recorded()).filter((f) => f.method === "usage/read")).toHaveLength(1);
  });
}

test("a terminal before turn admission does not start an idle watchdog", async () => {
  const h = await harness("text-reasoning", { MUSE_TEST_ACK_LAST: "1" });
  await h.open();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  await h.prompt();
  await h.wait((e) => e.type === "session.prompt_result");
  await h.wait((e) => e.type === "session.turn" && e.state === "completed");
  await vi.advanceTimersByTimeAsync(120000);
  await delay(30);
  expect((await h.recorded()).filter((f) => f.method === "view/page")).toEqual([]);
});
test("admitted compact publishes compaction progress and completes the command without a turn", async () => {
  const h = await harness("text-reasoning", { MUSE_TEST_COMPACT: "1" });
  await h.open();
  await h.send({
    type: "session.prompt",
    sessionId: "paseo-session",
    prompt: {
      clientMessageId: "compact-admitted",
      delivery: "auto",
      input: { type: "command", name: "compact", arguments: "" },
    },
  });
  expect(await h.wait((e) => e.type === "session.prompt_result")).toMatchObject({
    result: { type: "completed" },
  });
  await h.wait(
    (e) =>
      e.type === "timeline.item" && e.item.type === "compaction" && e.item.status === "completed",
  );
  expect(
    h.events
      .filter((e) => e.type === "timeline.item" && e.item.type === "compaction")
      .map((e) => e.type === "timeline.item" && e.item),
  ).toEqual([
    { type: "compaction", id: "fixture-compaction", status: "loading" },
    { type: "compaction", id: "fixture-compaction", status: "completed" },
  ]);
  expect((await h.recorded()).filter((f) => f.method === "turn/start")).toEqual([]);
});

test("default workflow children render structured tool details from the real no-flag run", async () => {
  const h = await harness("text-reasoning", { MUSE_TEST_WORKFLOW: "1" });
  await h.open();
  await h.prompt();
  const event = await h.wait(
    (e) =>
      e.type === "timeline.item" &&
      e.item.type === "tool_call" &&
      e.item.name === "workflow" &&
      e.item.detail.type === "sub_agent" &&
      e.item.detail.log?.includes("MUSE_PARITY_CHILD_OK") === true,
  );
  expect(event).toMatchObject({ item: { status: "completed", detail: { type: "sub_agent" } } });
  expect(h.events.filter((e) => e.type === "session.opened")).toHaveLength(1);
  const workflows = h.events.filter(
    (e) => e.type === "timeline.item" && e.item.type === "tool_call" && e.item.name === "workflow",
  );
  expect(workflows.length).toBeGreaterThan(1);
  for (const workflow of workflows)
    expect(workflow).toMatchObject({ item: { detail: { type: "sub_agent" } } });
});

for (const source of ["user", "project"] as const) {
  test(`real ${source} skill catalog and command replay with explicit workspace trust`, async () => {
    const h = await harness(`phase3-${source}-skill`, {}, { trustWorkspace: source === "project" });
    await h.open();
    expect(await h.wait((e) => e.type === "session.commands")).toMatchObject({
      commands: expect.arrayContaining([
        expect.objectContaining({ name: `muse-parity-${source}` }),
      ]),
    });
    await h.send({
      type: "session.prompt",
      sessionId: "paseo-session",
      prompt: {
        clientMessageId: "real-skill",
        delivery: "auto",
        input: { type: "command", name: `muse-parity-${source}`, arguments: "QA" },
      },
    });
    await h.wait((e) => e.type === "session.turn" && e.state === "completed");
    expect(h.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "timeline.item",
          item: expect.objectContaining({
            type: "assistant_message",
            text: `MUSE_PARITY_${source.toUpperCase()}_OK`,
          }),
        }),
      ]),
    );
    const recorded = await h.recorded();
    expect(recorded.find((f) => f.method === "turn/start").params.input).toContainEqual({
      type: "skill",
      selector: `muse-parity-${source}`,
      arguments: "QA",
    });
    expect(recorded.find((f) => f.event === "hostStarted").args.includes("--trust-workspace")).toBe(
      source === "project",
    );
  });
}

test("usage identity follows the resolved config directory across credential and route changes", async () => {
  const identities: string[] = [];
  for (const [config, token, route] of [
    ["/usage/config", "token-a", "route-a"],
    ["/usage/config", "token-b", "route-b"],
    ["/usage/other", "token-b", "route-b"],
  ]) {
    const h = await harness("catalog-controls", {
      XDG_CONFIG_HOME: config!,
      META_API_KEY: token!,
      META_BASE_URL: route!,
    });
    await h.open();
    const inputs = await h.usageSource.discover({ kind: "global" });
    expect(inputs).toHaveLength(1);
    identities.push(inputs[0]!.key);
  }
  expect(identities[0]).toBe(identities[1]);
  expect(identities[2]).not.toBe(identities[0]);
});

test.each(["no sessions", "unrelated environment"])("Muse discovery is empty with %s", async () => {
  const { Usage } = await import("../server/usage.js");
  expect(await new Usage().registration().discover({ kind: "global" })).toEqual([]);
});

test("Muse window identity follows the reported duration instead of assuming five hours", async () => {
  const h = await harness("catalog-controls", {
    MUSE_TEST_USAGE: JSON.stringify({
      usage: {
        observedAtMs: 1700000000000,
        tier: "Pro",
        window: { usedPercent: 11, resetsAtMs: 1700018000000, windowDurationMins: 120 },
        weekly: { usedPercent: 22, resetsAtMs: 1700604800000 },
      },
    }),
  });
  await h.open();
  const [account] = await h.usageSource.discover({ kind: "global" });
  expect(await h.usageSource.fetch(account!.input)).toMatchObject({
    status: "available",
    windows: [
      { id: "7200s", label: "2-hour", shortLabel: "2h" },
      { id: "weekly", label: "Weekly", shortLabel: "wk" },
    ],
  });
});

test("status accepts initialization slower than the account deadline without isolating history", async () => {
  const h = await harness("catalog-controls", { MUSE_TEST_INITIALIZE_DELAY_MS: "3500" });
  expect(await h.provider.status!({ launch: h.launch })).toEqual({ available: true });
  expect(await h.recorded()).toContainEqual({ event: "hostClosed" });
}, 10000);

for (const extension of ["cmd", "bat"]) {
  test.runIf(process.platform === "win32")(
    `launches the discovered Muse .${extension} for status, catalog and sessions`,
    async () => {
      const h = await harness("catalog-controls");
      const shim = path.join(h.root, `muse launcher.${extension}`);
      await writeFile(shim, `@echo off\r\n"${process.execPath}" "${h.launch.args[0]}" %*\r\n`);
      h.launch.command = shim;
      h.launch.args = [];
      expect(await h.provider.status!({ launch: h.launch })).toEqual({ available: true });
      await h.send({ type: "catalog", requestId: "shim-catalog" });
      expect(await h.wait((event) => event.type === "catalog")).toMatchObject({
        requestId: "shim-catalog",
      });
      await h.open();
      expect(await h.wait((event) => event.type === "session.opened")).toMatchObject({
        sessionId: "paseo-session",
      });
    },
    20000,
  );
}

test("force-stops a Muse host that ignores stdin EOF", async () => {
  const h = await stubbornHostHarness();
  try {
    const result = await Promise.race([
      h.provider.status!({ launch: h.launch }),
      delay(10000).then(() => {
        throw new Error("Muse status did not finish closing its host");
      }),
    ]);
    expect(result).toEqual({ available: true });
    const hosts = (await h.recorded()).filter((row) => row.event === "stubbornHost");
    expect(hosts).toHaveLength(1);
    expect(() => process.kill(hosts[0].pid, 0)).toThrow();
  } finally {
    await cleanupStubbornHosts(h);
  }
}, 15000);

test("does not reject when a killed Muse host's pipe stays open", async () => {
  const h = await stubbornHostHarness({ MUSE_TEST_ORPHAN_PIPE: "1" });
  try {
    const result = await Promise.race([
      h.provider.status!({ launch: h.launch }),
      delay(12000).then(() => {
        throw new Error("Muse status did not finish closing its host");
      }),
    ]);
    expect(result).toEqual({ available: true });
    const recorded = await h.recorded();
    const hosts = recorded.filter((row) => row.event === "stubbornHost");
    expect(hosts).toHaveLength(1);
    expect(() => process.kill(hosts[0].pid, 0)).toThrow();
  } finally {
    await cleanupStubbornHosts(h);
    for (const orphan of (await h.recorded()).filter((row) => row.event === "orphanHost")) {
      try {
        process.kill(orphan.pid, "SIGKILL");
      } catch {}
    }
  }
}, 20000);

test("closes the whole Muse host after an uncorrelated MSP error", async () => {
  const h = await stubbornHostHarness({ MUSE_TEST_NULL_ERROR_ID: "1" });
  try {
    const result = await h.provider.status!({ launch: h.launch });
    expect(result).toEqual({ available: false, diagnostic: "Cannot recover request id" });
    const recorded = await h.recorded();
    expect(recorded.some((row) => row.event === "hostClosed")).toBe(true);
    const hosts = recorded.filter((row) => row.event === "stubbornHost");
    expect(hosts).toHaveLength(1);
    expect(() => process.kill(hosts[0].pid, 0)).toThrow();
  } finally {
    await cleanupStubbornHosts(h);
  }
}, 15000);

async function stubbornHostHarness(env: Record<string, string> = {}) {
  const h = await harness("catalog-controls", { MUSE_TEST_STUBBORN: "1", ...env });
  if (process.platform === "win32") {
    const shim = path.join(h.root, "stubborn muse.cmd");
    await writeFile(shim, `@echo off\r\n"${process.execPath}" "${h.launch.args[0]}" %*\r\n`);
    h.launch.command = shim;
    h.launch.args = [];
  }
  return h;
}
async function cleanupStubbornHosts(h: Awaited<ReturnType<typeof harness>>) {
  // Keep a failing Windows regression from leaving its deliberately stubborn child alive.
  for (const host of (await h.recorded()).filter((row) => row.event === "stubbornHost")) {
    if (process.platform === "win32") {
      await execCommand("taskkill.exe", ["/PID", String(host.pid), "/T", "/F"], {
        shell: false,
      }).catch(() => {});
    } else {
      try {
        process.kill(host.pid, "SIGKILL");
      } catch {}
    }
  }
}

test("Muse reports belong only to the session's account and remain available globally", async () => {
  const usage = new MuseUsage();
  const homeEnv = { HOME: "/usage/home" };
  const configEnv = { HOME: "/usage/home", XDG_CONFIG_HOME: "/usage/work" };
  const accountIds = [homeEnv, configEnv].map((env, index) => {
    const launch = { command: "muse", args: [], env };
    usage.attach(`session-${index}`, launch, async () => ({
      usage: {
        observedAtMs: 1700000000000,
        tier: "Pro",
        window: { usedPercent: 11, resetsAtMs: 1700018000000, windowDurationMins: 120 },
        weekly: { usedPercent: 22, resetsAtMs: 1700604800000 },
      },
    }));
    return `muse:${usage.remember(launch).account}`;
  });
  const sessions = new Map([
    ["claude", { provider: "claude", env: homeEnv, sessionKey: "claude" }],
    ["codex", { provider: "codex", env: configEnv, sessionKey: "codex" }],
    ["muse-home", { provider: "muse", env: homeEnv, sessionKey: "muse-home" }],
    ["muse-work", { provider: "muse", env: configEnv, sessionKey: "muse-work" }],
    ["muse-unknown", { provider: "muse", env: { HOME: "/usage/unknown" }, sessionKey: "unknown" }],
  ]);
  const registry = new UsageSourceRegistry(Date.now, 300_000, undefined, {
    hasAgent: (id) => sessions.has(id),
    usageSession: (id) => sessions.get(id) ?? null,
  });
  registry.register(usage.registration());

  expect((await registry.listReports()).map((report) => report.id)).toEqual(accountIds);
  expect(await registry.listReports({ agentId: "claude" })).toEqual([]);
  expect(await registry.listReports({ agentId: "codex" })).toEqual([]);
  for (const [index, agentId] of ["muse-home", "muse-work"].entries()) {
    const reports = await registry.listReports({ agentId });
    expect(reports.map((report) => report.id)).toEqual([accountIds[index]]);
    expect(reports[0]!.report.status).toBe("available");
  }
  expect(await registry.listReports({ agentId: "muse-unknown" })).toEqual([]);
  expect((await registry.listReports()).map((report) => report.id)).toEqual(accountIds);
});

test("an opened closed session closes its idle Muse host and the next prompt resumes on a new one", async () => {
  const original = await harness();
  const history = path.join(original.root, "native-history.ndjson");
  original.launch.env.MUSE_TEST_HISTORY = history;
  await original.open();
  await original.prompt();
  await original.wait((event) => event.type === "session.turn" && event.state === "completed");
  const saved = original.events.findLast((event) => event.type === "session.persistence");
  if (!saved) throw new Error("Expected session persistence");
  await original.connection.close();
  const h = await harness("text-reasoning", { MUSE_TEST_HISTORY: history });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  expect(await h.open(saved.persistence)).toMatchObject({ type: "session.ready" });
  const hosts = async (event: string) =>
    (await h.recorded()).filter((frame) => frame.event === event).length;
  await vi.advanceTimersByTimeAsync(IDLE_MS - 1);
  expect(await hosts("hostClosed")).toBe(0);
  await vi.advanceTimersByTimeAsync(1);
  for (let tries = 0; (await hosts("hostClosed")) === 0 && tries < 500; tries++) await delay(10);
  expect(await hosts("hostClosed")).toBe(1);
  expect((await h.recorded()).some((frame) => frame.method === "session/read")).toBe(true);
  await h.prompt();
  await h.wait((event) => event.type === "session.turn" && event.state === "completed");
  expect(await hosts("hostStarted")).toBe(2);
  expect((await h.recorded()).filter((frame) => frame.method === "session/resume")).toHaveLength(2);
  expect(h.events.some((event) => event.type === "session.runtime_failed")).toBe(false);
}, 15000);
