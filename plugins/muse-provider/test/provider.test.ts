import { execFile } from "node:child_process";
import { UsageSourceRegistry } from "../../../packages/server/src/server/plugins/usage-sources/index.js";
import { Usage as MuseUsage } from "../server/usage.js";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

const connections: ProviderConnection[] = [];
const roots: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(connections.splice(0).map((connection) => connection.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
function registration(
  registerUsageSource = (_source: UsageSourceRegistration) => {},
): ProviderRegistration {
  let provider: ProviderRegistration | undefined;
  const server = {
    registerUsageSource,
    registerProvider(value: ProviderRegistration) {
      provider = value;
    },
  };
  contribute(server);
  if (!provider) throw new Error("Provider was not registered");
  return provider;
}
async function harness(
  scenario = "text-reasoning",
  env: Record<string, string> = {},
  providerOptions?: Record<string, unknown>,
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
  });
  const connection = await provider.connect({
    launch,
    versions: [1],
    capabilities: PROVIDER_CAPABILITIES,
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
  ) {
    await send({
      type: "session.open",
      requestId: "open",
      sessionId: "paseo-session",
      config: {
        cwd: root,
        providerOptions,
        env: {},
        settings: {},
        mcpServers: {},
        persist: true,
        mode,
        model: model ?? undefined,
        thinkingOption: "high",
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
      { type: "text", text: "<system_instructions>\nTest instructions\n</system_instructions>" },
      { type: "text", text: "hello" },
    ],
  });
  expect(h.events.findLast((event) => event.type === "session.persistence")).toMatchObject({
    persistence: { version: 1, data: { model: "meta/muse-spark-1.3", thinkingOption: "high" } },
  });
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
    expect((await h.recorded()).filter((frame) => frame.method === "session/read")).toEqual([]);
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
    diagnostic: "Muse account/read timed out",
  });
  expect(await h.recorded()).toContainEqual({ event: "hostClosed" });
});

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
      input: { account: account.key, generation: expect.any(Number) },
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
    expect((await h.recorded()).filter((f) => f.method === "usage/read")).toHaveLength(2);
  });
}

const changedUsage = {
  observedAtMs: 1700000005000,
  tier: "Pro",
  window: { usedPercent: 81, resetsAtMs: 1700018000000, windowDurationMins: 300 },
  weekly: { usedPercent: 106, resetsAtMs: 1700604800000 },
};

test("usage/changed observations update the card and survive close without waking a host", async () => {
  const h = await harness("catalog-controls", {
    MUSE_TEST_USAGE: JSON.stringify({
      usage: {
        observedAtMs: 1700000000000,
        tier: "Pro",
        window: { usedPercent: 75, resetsAtMs: 1700018000000, windowDurationMins: 300 },
        weekly: { usedPercent: 105, resetsAtMs: 1700604800000 },
      },
    }),
    MUSE_TEST_USAGE_CHANGED: JSON.stringify(changedUsage),
  });
  await h.open();
  const [account] = await h.usageSource.discover({ kind: "global" });
  // The seed read at connect returned the initial values, then the host
  // emitted usage/changed; live reads now serve the event's values.
  const first = await h.usageSource.fetch(account!.input);
  expect(first).toMatchObject({
    status: "available",
    planLabel: "Pro",
    windows: [{ usedPct: 81 }, { usedPct: 106 }],
    details: [{ id: "observed", value: new Date(changedUsage.observedAtMs).toISOString() }],
  });
  expect((await h.recorded()).filter((f) => f.method === "usage/read")).toHaveLength(2);
  await h.send({ type: "session.close", sessionId: "paseo-session", requestId: "close" });
  await h.wait((e) => e.type === "session.closed");
  // No live session left: the stored observation is served stale, with no new host read.
  // The event races close over stdio, so retry until the queued notification lands.
  const deadline = Date.now() + 5000;
  let afterClose = await h.usageSource.fetch(account!.input);
  while (afterClose.status !== "available" || afterClose.windows[0]?.usedPct !== 81) {
    if (Date.now() > deadline) break;
    await delay(20);
    afterClose = await h.usageSource.fetch(account!.input);
  }
  expect(afterClose).toMatchObject({
    status: "available",
    windows: [{ usedPct: 81 }, { usedPct: 106 }],
    details: [
      { id: "observed", value: new Date(changedUsage.observedAtMs).toISOString() },
      { id: "staleness", label: "Stale" },
    ],
  });
  expect((await h.recorded()).filter((f) => f.method === "usage/read")).toHaveLength(2);
});

test("usage snapshots ignore out-of-order and invalid observations, never two accounts mix", async () => {
  const { Usage } = await import("../server/usage.js");
  const usage = new Usage();
  const launchA = { command: "muse", args: [], env: { HOME: "/usage/a" } };
  const launchB = { command: "muse", args: [], env: { HOME: "/usage/b" } };
  const attachedA = usage.attach("session-a", launchA, async () => ({}));
  const attachedB = usage.attach("session-b", launchB, async () => ({}));
  expect(attachedA.account).not.toBe(attachedB.account);
  const changed: string[] = [];
  usage.onChanged((account) => changed.push(account));
  const fresh = { ...changedUsage, observedAtMs: 1700000010000 };
  expect(usage.observe(attachedA.account, attachedA.generation, fresh)).toBe(true);
  expect(changed).toEqual([attachedA.account]);
  // Older observations never overwrite newer ones for the same host.
  expect(usage.observe(attachedA.account, attachedA.generation, changedUsage)).toBe(false);
  expect(
    usage.observe(attachedA.account, attachedA.generation, {
      ...fresh,
      observedAtMs: 1700000010000,
    }),
  ).toBe(false);
  expect(changed).toEqual([attachedA.account]);
  // Invalid observations are rejected and never become zero quota.
  expect(
    usage.observe(attachedA.account, attachedA.generation, {
      ...fresh,
      window: { ...fresh.window, usedPercent: -5 },
    }),
  ).toBe(false);
  expect(usage.observe(attachedA.account, attachedA.generation, "not-an-observation")).toBe(false);
  expect(usage.observe(attachedB.account, attachedB.generation, fresh)).toBe(true);
  expect(changed).toEqual([attachedA.account, attachedB.account]);
  expect(usage.snapshot(attachedA.account)).toEqual(fresh);
  expect(usage.snapshot(attachedB.account)).toEqual(fresh);
  expect(usage.snapshot("unknown")).toBeUndefined();
});

test("a replacement host in the same home never inherits the closed host's quota", async () => {
  const { Usage } = await import("../server/usage.js");
  const usage = new Usage();
  const homeEnv = { HOME: "/usage/same-home" };
  const launch = { command: "muse", args: [], env: homeEnv };
  const hostA = usage.attach("session-a", launch, async () => ({
    usage: { ...changedUsage, observedAtMs: 1700000005000 },
  }));
  expect(usage.observe(hostA.account, hostA.generation, changedUsage)).toBe(true);
  usage.detach("session-a");
  // Host B opens in the same config home but stays silent: no seed, no event.
  const hostB = usage.attach("session-b", launch, async () => ({}));
  expect(hostB.account).toBe(hostA.account);
  expect(hostB.generation).not.toBe(hostA.generation);
  const report = await usage.registration().fetch({ account: hostB.account });
  // A's observation is history for A's context, not B's current quota — and a
  // silent host is honestly unavailable, never zero quota from thin air.
  expect(report).toEqual({
    status: "unavailable",
    problem: { kind: "no_quota", detail: "No usage quota reported" },
  });
});

test("a deferred read after detach never serves the retired host's result", async () => {
  const { Usage } = await import("../server/usage.js");
  const usage = new Usage();
  const launch = { command: "muse", args: [], env: { HOME: "/usage/deferred" } };
  let releaseA!: (value: { usage?: typeof changedUsage }) => void;
  const gateA = new Promise<{ usage?: typeof changedUsage }>((resolve) => {
    releaseA = resolve;
  });
  const hostA = usage.attach("session-a", launch, () => gateA);
  // A silent second host stays live in the same home.
  const hostB = usage.attach("session-b", launch, async () => ({}));
  expect(hostB.account).toBe(hostA.account);
  // A's read is in flight when A detaches; its late result is retired.
  const pending = usage.registration().fetch({
    account: hostA.account,
    generation: hostA.generation,
  });
  const changed: string[] = [];
  usage.onChanged((account) => changed.push(account));
  usage.detach("session-a");
  expect(changed).toEqual([hostA.account]);
  releaseA({ usage: { ...changedUsage, observedAtMs: 1700000010000 } });
  const report = await pending;
  expect(report).toEqual({
    status: "unavailable",
    problem: { kind: "no_quota", detail: "No usage quota reported" },
  });
  // The retired result was dropped, never stored: A's generation left no snapshot.
  expect(usage.snapshot(hostA.account)).toBeUndefined();
  // B's silent context is honestly unavailable too — never A's quota.
  const reportB = await usage.registration().fetch({
    account: hostB.account,
    generation: hostB.generation,
  });
  expect(reportB).toEqual({
    status: "unavailable",
    problem: { kind: "no_quota", detail: "No usage quota reported" },
  });
});

test("observations from generations never attached are rejected", async () => {
  const { Usage } = await import("../server/usage.js");
  const usage = new Usage();
  const launch = { command: "muse", args: [], env: { HOME: "/usage/forged" } };
  const attached = usage.attach("session-a", launch, async () => ({}));
  const changed: string[] = [];
  usage.onChanged((account) => changed.push(account));
  const fresh = { ...changedUsage, observedAtMs: 1700000010000 };
  expect(usage.observe(attached.account, attached.generation + 100, fresh)).toBe(false);
  expect(usage.observe(attached.account, 0, fresh)).toBe(false);
  expect(usage.snapshot(attached.account)).toBeUndefined();
  expect(changed).toEqual([]);
  // The genuinely attached generation still accepts.
  expect(usage.observe(attached.account, attached.generation, fresh)).toBe(true);
  expect(changed).toEqual([attached.account]);
});

test("same-home replacement gets a fresh registry identity with no inherited history", async () => {
  const { Usage } = await import("../server/usage.js");
  const usage = new Usage();
  const homeEnv = { HOME: "/usage/registry-turnover" };
  const launch = { command: "muse", args: [], env: homeEnv };
  const registry = new UsageSourceRegistry(Date.now, 300_000, undefined, {
    hasAgent: () => false,
    usageSession: () => null,
  });
  registry.register(usage.registration());
  const changed: string[] = [];
  usage.onChanged((account) => changed.push(account));
  // Host A lives and reports; the global card warms.
  const hostA = usage.attach("session-a", launch, async () => ({}));
  expect(usage.observe(hostA.account, hostA.generation, changedUsage)).toBe(true);
  const [warmed] = await registry.listReports();
  expect(warmed?.report.status).toBe("available");
  const cardId = warmed!.id;
  // A closes, B opens silently in the same home: attach, observe and detach
  // each push, so the registry re-reads instead of replaying the warm entry.
  usage.detach("session-a");
  const hostB = usage.attach("session-b", launch, async () => ({}));
  expect(hostB.account).toBe(hostA.account);
  expect(changed).toHaveLength(4);
  // The global re-read discovers B's distinct context: honestly unavailable,
  // with no warm hit and no inherited last-success from A.
  const [current] = await registry.listReports();
  expect(current?.id).toBe(cardId);
  expect(current?.report).toEqual({
    status: "unavailable",
    problem: { kind: "no_quota", detail: "No usage quota reported" },
  });
  expect(current?.lastSuccessful).toBeUndefined();
});

test("targeted refresh after same-home turnover never serves the retired host's quota", async () => {
  const { Usage } = await import("../server/usage.js");
  const usage = new Usage();
  const launch = { command: "muse", args: [], env: { HOME: "/usage/targeted-turnover" } };
  const registry = new UsageSourceRegistry(Date.now, 300_000, undefined, {
    hasAgent: () => false,
    usageSession: () => null,
  });
  registry.register(usage.registration());
  // Wire pushes the way the plugin service does: every locally observed
  // change invalidates the source so cards re-read.
  usage.onChanged(() => {
    registry.invalidateSource("muse");
  });
  const quotaA = {
    ...changedUsage,
    window: { ...changedUsage.window, usedPercent: 10 },
  };
  const hostA = usage.attach("session-a", launch, async () => ({}));
  expect(usage.observe(hostA.account, hostA.generation, quotaA)).toBe(true);
  const [warmed] = await registry.listReports();
  expect(warmed?.report.status).toBe("available");
  const cardId = warmed!.id;
  // A closes, silent B opens in the same home. A targeted re-read must use
  // B's freshly discovered login — never A's retired login plus A's history.
  usage.detach("session-a");
  const hostB = usage.attach("session-b", launch, async () => ({}));
  expect(hostB.account).toBe(hostA.account);
  const seen: string[] = [];
  const [current] = await registry.listReports({
    reportIds: [cardId],
    forceRefresh: true,
    onReport: (entry) => seen.push(entry.id),
  });
  expect(current?.id).toBe(cardId);
  expect(current?.report).toEqual({
    status: "unavailable",
    problem: { kind: "no_quota", detail: "No usage quota reported" },
  });
  expect(current?.lastSuccessful).toBeUndefined();
  // The callback fires for the current context's own honest result — which
  // carries neither A's windows nor A's history.
  expect(seen).toEqual([cardId]);
});

test("agent-scoped reads after same-home turnover never serve the retired host's quota", async () => {
  const { Usage } = await import("../server/usage.js");
  const usage = new Usage();
  const homeEnv = { HOME: "/usage/agent-turnover" };
  const launch = { command: "muse", args: [], env: homeEnv };
  const sessions = new Map([
    ["muse-agent", { provider: "muse", env: homeEnv, sessionKey: "muse-session" }],
  ]);
  const registry = new UsageSourceRegistry(Date.now, 300_000, undefined, {
    hasAgent: (id) => sessions.has(id),
    usageSession: (id) => sessions.get(id) ?? null,
  });
  registry.register(usage.registration());
  usage.onChanged(() => {
    registry.invalidateSource("muse");
  });
  const quotaA = {
    ...changedUsage,
    window: { ...changedUsage.window, usedPercent: 10 },
  };
  const hostA = usage.attach("session-a", launch, async () => ({}));
  expect(usage.observe(hostA.account, hostA.generation, quotaA)).toBe(true);
  const [warmed] = await registry.listReports();
  expect(warmed?.report.status).toBe("available");
  const agentWarmed = await registry.listReports({ agentId: "muse-agent" });
  expect(agentWarmed).toHaveLength(1);
  expect(agentWarmed[0]?.report.status).toBe("available");
  // Same session key, but the host behind it turned over to silent B: the
  // agent mapping must not replay A's login and history.
  usage.detach("session-a");
  const hostB = usage.attach("session-b", launch, async () => ({}));
  expect(hostB.account).toBe(hostA.account);
  const agentCurrent = await registry.listReports({ agentId: "muse-agent" });
  expect(agentCurrent).toHaveLength(1);
  expect(agentCurrent[0]?.report).toEqual({
    status: "unavailable",
    problem: { kind: "no_quota", detail: "No usage quota reported" },
  });
  expect(agentCurrent[0]?.lastSuccessful).toBeUndefined();
  // Even after a global rediscovery the session scope stays clean.
  const [globalCurrent] = await registry.listReports();
  expect(globalCurrent?.report.status).toBe("unavailable");
  const agentAgain = await registry.listReports({ agentId: "muse-agent" });
  expect(agentAgain[0]?.report.status).toBe("unavailable");
  expect(agentAgain[0]?.lastSuccessful).toBeUndefined();
});

test("idle history after a silent replacement never resurrects the retired host's quota", async () => {
  const { Usage } = await import("../server/usage.js");
  const usage = new Usage();
  const launch = { command: "muse", args: [], env: { HOME: "/usage/idle-turnover" } };
  const registry = new UsageSourceRegistry(Date.now, 300_000, undefined, {
    hasAgent: () => false,
    usageSession: () => null,
  });
  registry.register(usage.registration());
  usage.onChanged(() => {
    registry.invalidateSource("muse");
  });
  const quotaA = {
    ...changedUsage,
    window: { ...changedUsage.window, usedPercent: 10 },
  };
  const hostA = usage.attach("session-a", launch, async () => ({}));
  expect(usage.observe(hostA.account, hostA.generation, quotaA)).toBe(true);
  const [warmed] = await registry.listReports();
  expect(warmed?.report.status).toBe("available");
  // Silent B replaces A and closes again without any observation of its own.
  // The idle account is B's context with no quota — not A's resurrected 10%.
  usage.detach("session-a");
  usage.attach("session-b", launch, async () => ({}));
  usage.detach("session-b");
  await expect(usage.registration().fetch({ account: hostA.account })).resolves.toEqual({
    status: "unavailable",
    problem: { kind: "no_quota", detail: "No usage quota reported" },
  });
  const [idle] = await registry.listReports();
  expect(idle?.report).toEqual({
    status: "unavailable",
    problem: { kind: "no_quota", detail: "No usage quota reported" },
  });
  expect(idle?.lastSuccessful).toBeUndefined();
});

test("an idle read between silent host swaps never lends history to the new context", async () => {
  const { Usage } = await import("../server/usage.js");
  const usage = new Usage();
  const launch = { command: "muse", args: [], env: { HOME: "/usage/idle-between-swaps" } };
  const registry = new UsageSourceRegistry(Date.now, 300_000, undefined, {
    hasAgent: () => false,
    usageSession: () => null,
  });
  registry.register(usage.registration());
  usage.onChanged(() => {
    registry.invalidateSource("muse");
  });
  const quotaA = {
    ...changedUsage,
    window: { ...changedUsage.window, usedPercent: 10 },
  };
  const hostA = usage.attach("session-a", launch, async () => ({}));
  expect(usage.observe(hostA.account, hostA.generation, quotaA)).toBe(true);
  const [warmed] = await registry.listReports();
  expect(warmed?.report.status).toBe("available");
  const cardId = warmed!.id;
  // A closes; an idle read now serves A's own context history stale — the
  // registry-bound plain-close control for the same context.
  usage.detach("session-a");
  const [idleA] = await registry.listReports();
  expect(idleA?.id).toBe(cardId);
  expect(idleA?.report.status).toBe("available");
  // Silent B opens and closes without reporting and without any read in
  // between. The next read discovers B's context: honestly unavailable, and
  // A's windows must not return as B's history under the same card id.
  usage.attach("session-b", launch, async () => ({}));
  usage.detach("session-b");
  const seen: string[] = [];
  const [idleB] = await registry.listReports({ onReport: (entry) => seen.push(entry.id) });
  expect(idleB?.id).toBe(cardId);
  expect(idleB?.report).toEqual({
    status: "unavailable",
    problem: { kind: "no_quota", detail: "No usage quota reported" },
  });
  expect(idleB?.lastSuccessful).toBeUndefined();
  expect(seen).toEqual([cardId]);
});

test("a targeted read spanning a silent turnover never installs the retired login", async () => {
  const { Usage } = await import("../server/usage.js");
  const usage = new Usage();
  const launch = { command: "muse", args: [], env: { HOME: "/usage/stale-targeted-discovery" } };
  const registry = new UsageSourceRegistry(Date.now, 300_000, undefined, {
    hasAgent: () => false,
    usageSession: () => null,
  });
  const museRegistration = usage.registration();
  let museDiscovers = 0;
  const innerDiscover = museRegistration.discover.bind(museRegistration);
  museRegistration.discover = async (scope) => {
    museDiscovers += 1;
    return innerDiscover(scope);
  };
  registry.register(museRegistration);
  usage.onChanged(() => {
    registry.invalidateSource("muse");
  });
  const quotaA = {
    ...changedUsage,
    window: { ...changedUsage.window, usedPercent: 10 },
  };
  const hostA = usage.attach("session-a", launch, async () => ({}));
  expect(usage.observe(hostA.account, hostA.generation, quotaA)).toBe(true);
  const warmed = await registry.listReports();
  const card = warmed.find((entry) => entry.id.startsWith("muse:"));
  expect(card?.report.status).toBe("available");
  const cardId = card!.id;
  // A sibling source whose discovery stalls behind a gate: Muse answers with
  // A's login while the registry still waits for the sibling.
  let siblingStarted = false;
  let releaseSibling!: () => void;
  const siblingGate = new Promise<void>((resolve) => {
    releaseSibling = resolve;
  });
  registry.register({
    id: "sibling",
    label: "sibling",
    discover: async () => {
      siblingStarted = true;
      await siblingGate;
      return [{ key: "s", input: {} }];
    },
    fetch: async () => ({ status: "available", windows: [] }),
  });
  // A targeted re-read starts: Muse resolves A's login, the sibling stalls.
  museDiscovers = 0;
  siblingStarted = false;
  const seen: string[] = [];
  const pending = registry.listReports({
    reportIds: [cardId],
    forceRefresh: true,
    onReport: (entry) => seen.push(entry.id),
  });
  for (let i = 0; i < 50; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    if (museDiscovers >= 1 && siblingStarted) break;
  }
  expect(museDiscovers).toBeGreaterThanOrEqual(1);
  expect(siblingStarted).toBe(true);
  // A closes and silent B opens while discovery still waits: the pending
  // discovery must not install A's retired login with a fresh token.
  usage.detach("session-a");
  const hostB = usage.attach("session-b", launch, async () => ({}));
  expect(hostB.account).toBe(hostA.account);
  releaseSibling();
  const entries = await pending;
  expect(entries.map((entry) => entry.id)).toEqual([cardId]);
  expect(entries[0]?.report).toEqual({
    status: "unavailable",
    problem: { kind: "no_quota", detail: "No usage quota reported" },
  });
  expect(entries[0]?.lastSuccessful).toBeUndefined();
  expect(seen).toEqual([cardId]);
});

test("a pending agent discovery across a silent turnover never installs the retired login", async () => {
  const { Usage } = await import("../server/usage.js");
  const usage = new Usage();
  const homeEnv = { HOME: "/usage/stale-agent-discovery" };
  const launch = { command: "muse", args: [], env: homeEnv };
  const sessions = new Map([
    ["muse-agent", { provider: "muse", env: homeEnv, sessionKey: "muse-session" }],
  ]);
  const registry = new UsageSourceRegistry(Date.now, 300_000, undefined, {
    hasAgent: (id) => sessions.has(id),
    usageSession: (id) => sessions.get(id) ?? null,
  });
  const museRegistration = usage.registration();
  let museDiscovers = 0;
  const innerDiscover = museRegistration.discover.bind(museRegistration);
  museRegistration.discover = async (scope) => {
    museDiscovers += 1;
    return innerDiscover(scope);
  };
  registry.register(museRegistration);
  usage.onChanged(() => {
    registry.invalidateSource("muse");
  });
  const quotaA = {
    ...changedUsage,
    window: { ...changedUsage.window, usedPercent: 10 },
  };
  const hostA = usage.attach("session-a", launch, async () => ({}));
  expect(usage.observe(hostA.account, hostA.generation, quotaA)).toBe(true);
  const [warmed] = await registry.listReports();
  expect(warmed?.report.status).toBe("available");
  // A sibling source whose discovery stalls behind a gate, registered after
  // the warm read so the warm read itself never waits on the gate.
  let siblingStarted = false;
  let releaseSibling!: () => void;
  const siblingGate = new Promise<void>((resolve) => {
    releaseSibling = resolve;
  });
  registry.register({
    id: "sibling",
    label: "sibling",
    discover: async () => {
      siblingStarted = true;
      await siblingGate;
      return [{ key: "s", input: {} }];
    },
    fetch: async () => ({ status: "available", windows: [] }),
  });
  // The agent read has no mapping yet, so it discovers while the sibling
  // stalls; the turnover lands mid-discovery with the same session key.
  museDiscovers = 0;
  const pending = registry.listReports({ agentId: "muse-agent" });
  for (let i = 0; i < 50; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    if (museDiscovers >= 1 && siblingStarted) break;
  }
  expect(museDiscovers).toBeGreaterThanOrEqual(1);
  expect(siblingStarted).toBe(true);
  usage.detach("session-a");
  const hostB = usage.attach("session-b", launch, async () => ({}));
  expect(hostB.account).toBe(hostA.account);
  releaseSibling();
  const entries = await pending;
  const agentCard = entries.find((entry) => entry.id.startsWith("muse:"));
  expect(agentCard?.report).toEqual({
    status: "unavailable",
    problem: { kind: "no_quota", detail: "No usage quota reported" },
  });
  expect(agentCard?.lastSuccessful).toBeUndefined();
});

test("idle history still serves the same context after a plain close", async () => {
  const { Usage } = await import("../server/usage.js");
  const usage = new Usage();
  const launch = { command: "muse", args: [], env: { HOME: "/usage/plain-idle" } };
  const hostA = usage.attach("session-a", launch, async () => ({}));
  const quotaA = {
    ...changedUsage,
    window: { ...changedUsage.window, usedPercent: 10 },
  };
  expect(usage.observe(hostA.account, hostA.generation, quotaA)).toBe(true);
  usage.detach("session-a");
  const idle = await usage.registration().fetch({ account: hostA.account });
  if (idle.status !== "available") throw new Error("Expected the same context's idle history");
  expect(idle.windows[0]).toMatchObject({ usedPct: 10 });
  expect(idle.details).toContainEqual({
    id: "staleness",
    label: "Stale",
    value: expect.any(String),
  });
});

test("retired generations accept no new seed or event observations", async () => {
  const { Usage } = await import("../server/usage.js");
  const usage = new Usage();
  const launch = { command: "muse", args: [], env: { HOME: "/usage/retired-write" } };
  const otherLaunch = { command: "muse", args: [], env: { HOME: "/usage/retired-other" } };
  const hostA = usage.attach("session-a", launch, async () => ({}));
  const hostB = usage.attach("session-b", launch, async () => ({}));
  const hostC = usage.attach("session-c", otherLaunch, async () => ({}));
  expect(hostC.account).not.toBe(hostA.account);
  const changed: string[] = [];
  usage.onChanged((account) => changed.push(account));
  const late = { ...changedUsage, observedAtMs: 1700000020000 };
  // A detaches; a deferred seed or a late event for its generation — even
  // with a newer stamp — must store nothing and notify nothing.
  usage.detach("session-a");
  changed.length = 0;
  expect(usage.observe(hostA.account, hostA.generation, late)).toBe(false);
  expect(usage.snapshot(hostA.account)).toBeUndefined();
  // A generation issued for another account is not this account's context,
  // even though its number is inside the attached range.
  expect(usage.observe(hostA.account, hostC.generation, late)).toBe(false);
  expect(usage.snapshot(hostA.account)).toBeUndefined();
  expect(changed).toEqual([]);
  // The still-live generation still accepts.
  expect(usage.observe(hostB.account, hostB.generation, late)).toBe(true);
  expect(changed).toEqual([hostB.account]);
  expect(usage.snapshot(hostB.account)).toEqual(late);
});

test("concurrent hosts in one home never merge: each context serves only its own quota", async () => {
  const { Usage } = await import("../server/usage.js");
  const usage = new Usage();
  const launch = { command: "muse", args: [], env: { HOME: "/usage/pool-home" } };
  const quotaA = {
    ...changedUsage,
    observedAtMs: 1700000005000,
    window: { ...changedUsage.window, usedPercent: 10 },
  };
  const quotaB = {
    ...changedUsage,
    observedAtMs: 1700000010000,
    window: { ...changedUsage.window, usedPercent: 90 },
  };
  const hostA = usage.attach("session-a", launch, async () => ({ usage: quotaA }));
  const hostB = usage.attach("session-b", launch, async () => ({ usage: quotaB }));
  expect(hostB.account).toBe(hostA.account);
  expect(hostB.generation).not.toBe(hostA.generation);
  // Simultaneous hosts with different quotas: the account-wide fetch fails
  // closed instead of merging unidentified hosts by timestamp.
  const ambiguous = await usage.registration().fetch({ account: hostA.account });
  expect(ambiguous).toEqual({
    status: "unavailable",
    problem: {
      kind: "no_quota",
      detail: "Multiple live Muse sessions share this config home; quota attribution is ambiguous",
    },
  });
  // Each pinned host context serves exactly its own quota.
  const reportA = await usage.registration().fetch({
    account: hostA.account,
    generation: hostA.generation,
  });
  if (reportA.status !== "available") throw new Error("Expected A's own quota");
  expect(reportA.windows[0]).toMatchObject({ usedPct: 10 });
  const reportB = await usage.registration().fetch({
    account: hostB.account,
    generation: hostB.generation,
  });
  if (reportB.status !== "available") throw new Error("Expected B's own quota");
  expect(reportB.windows[0]).toMatchObject({ usedPct: 90 });
  // Closing A resolves the ambiguity: the account-wide fetch serves B alone,
  // never A's older quota.
  usage.detach("session-a");
  const afterDetach = await usage.registration().fetch({ account: hostB.account });
  if (afterDetach.status !== "available") throw new Error("Expected B's quota to survive A");
  expect(afterDetach.windows[0]).toMatchObject({ usedPct: 90 });
});

test("a cold account with no observation is unavailable without starting a host", async () => {
  const { Usage } = await import("../server/usage.js");
  const usage = new Usage();
  // status/connect remembers the launch, but no host ever opened and no
  // event ever arrived: usage must not start a transient host to answer.
  const { account } = usage.remember({ command: "muse", args: [], env: { HOME: "/usage/cold" } });
  const report = await usage.registration().fetch({ account });
  expect(report).toEqual({
    status: "unavailable",
    problem: { kind: "no_quota", detail: "No usage quota reported" },
  });
});

test("attach and detach invalidate whenever the shown context may change", async () => {
  const { Usage } = await import("../server/usage.js");
  const usage = new Usage();
  const launch = { command: "muse", args: [], env: { HOME: "/usage/notify" } };
  const changed: string[] = [];
  usage.onChanged((account) => changed.push(account));
  // A new host can change the served context (live, or ambiguous with the
  // hosts already there), so every attach invalidates.
  const hostA = usage.attach("session-a", launch, async () => ({}));
  const hostB = usage.attach("session-b", launch, async () => ({}));
  expect(changed).toEqual([hostA.account, hostB.account]);
  changed.length = 0;
  // Detaching the host that served the shown values changes the card even
  // while another host stays live: the remainder may be silent, ambiguous,
  // or a different quota.
  usage.detach("session-a");
  expect(changed).toEqual([hostA.account]);
  // The last host closes: the card turns stale, so clients must re-read.
  usage.detach("session-b");
  expect(changed).toEqual([hostA.account, hostB.account]);
  // Unknown ids stay silent.
  usage.detach("session-not-attached");
  expect(changed).toHaveLength(2);
});

test("a newer event wins over an older read that resolves later; a failed reader keeps the snapshot", async () => {
  const { Usage } = await import("../server/usage.js");
  const usage = new Usage();
  const launch = { command: "muse", args: [], env: { HOME: "/usage/race" } };
  let releaseOld!: (value: { usage?: typeof changedUsage }) => void;
  const oldRead = new Promise<{ usage?: typeof changedUsage }>((resolve) => {
    releaseOld = resolve;
  });
  const attached = usage.attach("session-a", launch, () => oldRead);
  const source = usage.registration();
  const pending = source.fetch({ account: attached.account });
  // The event lands while the older read is still in flight.
  const fresh = { ...changedUsage, observedAtMs: 1700000010000 };
  expect(usage.observe(attached.account, attached.generation, fresh)).toBe(true);
  releaseOld({ usage: changedUsage });
  const won = await pending;
  if (won.status !== "available") throw new Error("Expected the newer event to serve");
  expect(won.windows[0]).toMatchObject({ usedPct: 81 });
  // A failing reader must not fail the whole read: the stored live snapshot
  // still serves with its true age.
  const failing = new Usage();
  const attachedFailing = failing.attach("session-x", launch, async () => {
    throw new Error("host gone");
  });
  const stored = { ...changedUsage, observedAtMs: 1700000020000 };
  expect(failing.observe(attachedFailing.account, attachedFailing.generation, stored)).toBe(true);
  const served = await failing.registration().fetch({ account: attachedFailing.account });
  if (served.status !== "available") throw new Error("Expected the live snapshot to serve");
  expect(served.windows[0]).toMatchObject({ usedPct: 81 });
  expect(served.details?.[0]).toMatchObject({
    id: "observed",
    value: new Date(stored.observedAtMs).toISOString(),
  });
});

test("unrepresentable timestamps and blank tiers are rejected without poisoning the snapshot", async () => {
  const { Usage } = await import("../server/usage.js");
  const usage = new Usage();
  const launch = { command: "muse", args: [], env: { HOME: "/usage/dates" } };
  const attached = usage.attach("session-a", launch, async () => ({}));
  const valid = { ...changedUsage, observedAtMs: 1700000010000 };
  // A finite-but-unrepresentable arrival stamp must not lodge in the snapshot
  // and block every later observation through the ordering rule.
  expect(
    usage.observe(attached.account, attached.generation, { ...valid, observedAtMs: 1e100 }),
  ).toBe(false);
  expect(
    usage.observe(attached.account, attached.generation, {
      ...valid,
      window: { ...valid.window, resetsAtMs: 1e100 },
    }),
  ).toBe(false);
  expect(
    usage.observe(attached.account, attached.generation, {
      ...valid,
      weekly: { ...valid.weekly, resetsAtMs: 1e100 },
    }),
  ).toBe(false);
  expect(usage.observe(attached.account, attached.generation, { ...valid, tier: "   " })).toBe(
    false,
  );
  expect(usage.snapshot(attached.account)).toBeUndefined();
  // A later valid observation is still accepted, over-quota percentages kept.
  expect(usage.observe(attached.account, attached.generation, valid)).toBe(true);
  expect(usage.snapshot(attached.account)).toEqual(valid);
});

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

test("a second event during the final discovery pass never installs the retired login (targeted)", async () => {
  const { Usage } = await import("../server/usage.js");
  const usage = new Usage();
  const launch = { command: "muse", args: [], env: { HOME: "/usage/two-gate-targeted" } };
  const registry = new UsageSourceRegistry(Date.now, 300_000, undefined, {
    hasAgent: () => false,
    usageSession: () => null,
  });
  const museRegistration = usage.registration();
  let museDiscovers = 0;
  const innerDiscover = museRegistration.discover.bind(museRegistration);
  museRegistration.discover = async (scope) => {
    museDiscovers += 1;
    return innerDiscover(scope);
  };
  registry.register(museRegistration);
  usage.onChanged(() => {
    registry.invalidateSource("muse");
  });
  const quotaA = {
    ...changedUsage,
    window: { ...changedUsage.window, usedPercent: 10 },
  };
  const hostA = usage.attach("session-a", launch, async () => ({}));
  expect(usage.observe(hostA.account, hostA.generation, quotaA)).toBe(true);
  const warmed = await registry.listReports();
  const card = warmed.find((entry) => entry.id.startsWith("muse:"));
  expect(card?.report.status).toBe("available");
  const cardId = card!.id;
  // A sibling source whose discovery stalls behind a separate gate per pass.
  // Later passes (the converging follow-up read) resolve immediately.
  const siblingGates: Array<() => void> = [];
  let siblingCalls = 0;
  registry.register({
    id: "sibling",
    label: "sibling",
    discover: async () => {
      siblingCalls += 1;
      if (siblingCalls <= 2) {
        await new Promise<void>((resolve) => {
          siblingGates.push(resolve);
        });
      }
      return [{ key: "s", input: {} }];
    },
    fetch: async () => ({ status: "available", windows: [{ id: "w", label: "sibling" }] }),
  });
  // A targeted re-read starts while the sibling stalls its first pass.
  museDiscovers = 0;
  const seen: string[] = [];
  const pending = registry.listReports({
    reportIds: [cardId],
    forceRefresh: true,
    onReport: (entry) => seen.push(entry.id),
  });
  for (let i = 0; i < 50; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    if (museDiscovers >= 1 && siblingCalls >= 1) break;
  }
  expect(museDiscovers).toBeGreaterThanOrEqual(1);
  expect(siblingCalls).toBe(1);
  // A sibling freshness event consumes the single re-pass budget while the
  // first pass is still in flight. The sibling card is not yet known, so no
  // card ids are reported, but its epoch still moves and retires the pass.
  expect(registry.invalidateSource("sibling")).toEqual([]);
  siblingGates[0]!();
  // The wrapper re-passes; the sibling stalls its second pass too while
  // Muse's second discover resolves A's login (A is still attached).
  for (let i = 0; i < 50; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    if (museDiscovers >= 2 && siblingCalls >= 2) break;
  }
  expect(museDiscovers).toBeGreaterThanOrEqual(2);
  expect(siblingCalls).toBe(2);
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
  // The only Muse turnover lands during the last allowed pass.
  usage.detach("session-a");
  usage.attach("session-b", launch, async () => ({}));
  siblingGates[1]!();
  const entries = await pending;
  // The retired A login must never publish: no callback, no return, and no
  // attached last-successful carrying A's 10% windows.
  expect(entries).toEqual([]);
  expect(seen).toEqual([]);
  for (const entry of entries) {
    expect(JSON.stringify(entry)).not.toContain('"usedPct":10');
    expect(entry.lastSuccessful).toBeUndefined();
  }
  // The next read converges on the current context instead: the sibling card
  // still delivers, and the Muse card carries no retired history.
  const converged = await registry.listReports();
  const siblingCard = converged.find((entry) => entry.id === "sibling:s");
  expect(siblingCard?.report).toMatchObject({ windows: [{ label: "sibling" }] });
  for (const entry of converged) {
    expect(JSON.stringify(entry.report)).not.toContain('"usedPct":10');
    expect(entry.lastSuccessful).toBeUndefined();
  }
});

test("a second event during the final discovery pass never installs the retired login (agent)", async () => {
  const { Usage } = await import("../server/usage.js");
  const usage = new Usage();
  const homeEnv = { HOME: "/usage/two-gate-agent" };
  const launch = { command: "muse", args: [], env: homeEnv };
  const sessions = new Map([
    ["muse-agent", { provider: "muse", env: homeEnv, sessionKey: "muse-session" }],
  ]);
  const registry = new UsageSourceRegistry(Date.now, 300_000, undefined, {
    hasAgent: (id) => sessions.has(id),
    usageSession: (id) => sessions.get(id) ?? null,
  });
  const museRegistration = usage.registration();
  let museDiscovers = 0;
  const innerDiscover = museRegistration.discover.bind(museRegistration);
  museRegistration.discover = async (scope) => {
    museDiscovers += 1;
    return innerDiscover(scope);
  };
  registry.register(museRegistration);
  usage.onChanged(() => {
    registry.invalidateSource("muse");
  });
  const quotaA = {
    ...changedUsage,
    window: { ...changedUsage.window, usedPercent: 10 },
  };
  const hostA = usage.attach("session-a", launch, async () => ({}));
  expect(usage.observe(hostA.account, hostA.generation, quotaA)).toBe(true);
  const [warmed] = await registry.listReports();
  expect(warmed?.report.status).toBe("available");
  // A sibling source whose discovery stalls behind a separate gate per pass,
  // registered after the warm read so the warm read never waits on the gate.
  // Later passes resolve immediately.
  const siblingGates: Array<() => void> = [];
  let siblingCalls = 0;
  registry.register({
    id: "sibling",
    label: "sibling",
    discover: async () => {
      siblingCalls += 1;
      if (siblingCalls <= 2) {
        await new Promise<void>((resolve) => {
          siblingGates.push(resolve);
        });
      }
      return [{ key: "s", input: {} }];
    },
    fetch: async () => ({ status: "available", windows: [{ id: "w", label: "sibling" }] }),
  });
  // The agent read has no mapping yet, so it discovers while the sibling
  // stalls; the turnover lands mid-discovery with the same session key.
  museDiscovers = 0;
  const pending = registry.listReports({ agentId: "muse-agent" });
  for (let i = 0; i < 50; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    if (museDiscovers >= 1 && siblingCalls >= 1) break;
  }
  expect(museDiscovers).toBeGreaterThanOrEqual(1);
  expect(siblingCalls).toBe(1);
  // A sibling freshness event consumes the single re-pass budget while the
  // first pass is still in flight.
  registry.invalidateSource("sibling");
  siblingGates[0]!();
  for (let i = 0; i < 50; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    if (museDiscovers >= 2 && siblingCalls >= 2) break;
  }
  expect(museDiscovers).toBeGreaterThanOrEqual(2);
  expect(siblingCalls).toBe(2);
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
  // The only Muse turnover lands during the last allowed pass.
  usage.detach("session-a");
  usage.attach("session-b", launch, async () => ({}));
  siblingGates[1]!();
  const entries = await pending;
  // No retired A login may lodge as the agent mapping: no Muse card may
  // carry A's quota or history, while the unrelated sibling still delivers.
  for (const entry of entries) {
    expect(JSON.stringify(entry)).not.toContain('"usedPct":10');
    if (entry.id.startsWith("muse:")) expect(entry.lastSuccessful).toBeUndefined();
  }
  expect(entries.map((entry) => entry.id)).toContain("sibling:s");
  // A follow-up agent read converges on the current context without history.
  const reconverged = await registry.listReports({ agentId: "muse-agent" });
  for (const entry of reconverged) {
    expect(JSON.stringify(entry.report)).not.toContain('"usedPct":10');
    if (entry.id.startsWith("muse:")) expect(entry.lastSuccessful).toBeUndefined();
  }
});

test("a turnover between discovery validation and mapping installation never publishes the retired login (targeted)", async () => {
  const { Usage } = await import("../server/usage.js");
  const usage = new Usage();
  const launch = { command: "muse", args: [], env: { HOME: "/usage/handoff-targeted" } };
  const registry = new UsageSourceRegistry(Date.now, 300_000, undefined, {
    hasAgent: () => false,
    usageSession: () => null,
  });
  registry.register(usage.registration());
  usage.onChanged(() => {
    registry.invalidateSource("muse");
  });
  const quotaA = {
    ...changedUsage,
    window: { ...changedUsage.window, usedPercent: 10 },
  };
  const hostA = usage.attach("session-a", launch, async () => ({}));
  expect(usage.observe(hostA.account, hostA.generation, quotaA)).toBe(true);
  const warmed = await registry.listReports();
  const card = warmed.find((entry) => entry.id.startsWith("muse:"));
  expect(card?.report.status).toBe("available");
  const cardId = card!.id;
  registry.register({
    id: "sibling",
    label: "sibling",
    discover: async () => [{ key: "s", input: {} }],
    fetch: async () => ({ status: "available", windows: [{ id: "w", label: "sibling" }] }),
  });
  // Queue the only Muse turnover from inside the validation's epoch read, so
  // it lands after the wrapper's check but before the caller's installation.
  // Attempt 0 iterates the epochs once for the snapshot and once for the
  // validation; the turnover fires on the validation read.
  const epochs = (registry as unknown as { sourceEpoch: Map<string, number> }).sourceEpoch;
  let iterations = 0;
  let fired = false;
  const rawIterator = epochs[Symbol.iterator].bind(epochs);
  (epochs as unknown as Record<symbol, unknown>)[Symbol.iterator] = function* () {
    iterations += 1;
    if (iterations === 2 && !fired) {
      fired = true;
      queueMicrotask(() => {
        usage.detach("session-a");
        usage.attach("session-b", launch, async () => ({}));
      });
    }
    yield* rawIterator();
  };
  const seen: string[] = [];
  let entries;
  try {
    entries = await registry.listReports({
      reportIds: [cardId],
      forceRefresh: true,
      onReport: (entry) => seen.push(entry.id),
    });
  } finally {
    delete (epochs as unknown as Record<symbol, unknown>)[Symbol.iterator];
  }
  expect(fired).toBe(true);
  // The retired A login must never publish: no callback, no return, and no
  // attached last-successful carrying A's 10% windows.
  expect(entries).toEqual([]);
  expect(seen).toEqual([]);
  // The next read converges: the sibling still delivers and no card carries
  // A's retired quota or history.
  const converged = await registry.listReports();
  expect(converged.map((entry) => entry.id)).toContain("sibling:s");
  for (const entry of converged) {
    expect(JSON.stringify(entry.report)).not.toContain('"usedPct":10');
    expect(entry.lastSuccessful).toBeUndefined();
  }
});

test("a turnover between discovery validation and agent mapping installation never publishes the retired login (agent)", async () => {
  const { Usage } = await import("../server/usage.js");
  const usage = new Usage();
  const homeEnv = { HOME: "/usage/handoff-agent" };
  const launch = { command: "muse", args: [], env: homeEnv };
  const sessions = new Map([
    ["muse-agent", { provider: "muse", env: homeEnv, sessionKey: "muse-session" }],
  ]);
  const registry = new UsageSourceRegistry(Date.now, 300_000, undefined, {
    hasAgent: (id) => sessions.has(id),
    usageSession: (id) => sessions.get(id) ?? null,
  });
  registry.register(usage.registration());
  usage.onChanged(() => {
    registry.invalidateSource("muse");
  });
  const quotaA = {
    ...changedUsage,
    window: { ...changedUsage.window, usedPercent: 10 },
  };
  const hostA = usage.attach("session-a", launch, async () => ({}));
  expect(usage.observe(hostA.account, hostA.generation, quotaA)).toBe(true);
  const [warmed] = await registry.listReports();
  expect(warmed?.report.status).toBe("available");
  registry.register({
    id: "sibling",
    label: "sibling",
    discover: async () => [{ key: "s", input: {} }],
    fetch: async () => ({ status: "available", windows: [{ id: "w", label: "sibling" }] }),
  });
  // Same handoff placement as the targeted case: the turnover lands after
  // the wrapper's validation but before the agent mapping is installed.
  const epochs = (registry as unknown as { sourceEpoch: Map<string, number> }).sourceEpoch;
  let iterations = 0;
  let fired = false;
  const rawIterator = epochs[Symbol.iterator].bind(epochs);
  (epochs as unknown as Record<symbol, unknown>)[Symbol.iterator] = function* () {
    iterations += 1;
    if (iterations === 2 && !fired) {
      fired = true;
      queueMicrotask(() => {
        usage.detach("session-a");
        usage.attach("session-b", launch, async () => ({}));
      });
    }
    yield* rawIterator();
  };
  let entries;
  try {
    entries = await registry.listReports({ agentId: "muse-agent" });
  } finally {
    delete (epochs as unknown as Record<symbol, unknown>)[Symbol.iterator];
  }
  expect(fired).toBe(true);
  // The unrelated sibling still delivers, but no retired A quota or history
  // reaches the callback, the return, or an agent mapping.
  expect(entries.map((entry) => entry.id)).toContain("sibling:s");
  for (const entry of entries) {
    expect(JSON.stringify(entry)).not.toContain('"usedPct":10');
    if (entry.id.startsWith("muse:")) expect(entry.lastSuccessful).toBeUndefined();
  }
});

test("a budget-truncated agent mapping is not cached as complete: the next read rediscovers the current context", async () => {
  const { Usage } = await import("../server/usage.js");
  const usage = new Usage();
  const homeEnv = { HOME: "/usage/partial-agent" };
  const launch = { command: "muse", args: [], env: homeEnv };
  const sessions = new Map([
    ["muse-agent", { provider: "muse", env: homeEnv, sessionKey: "muse-session" }],
  ]);
  const registry = new UsageSourceRegistry(Date.now, 300_000, undefined, {
    hasAgent: (id) => sessions.has(id),
    usageSession: (id) => sessions.get(id) ?? null,
  });
  const museRegistration = usage.registration();
  let museDiscovers = 0;
  const innerDiscover = museRegistration.discover.bind(museRegistration);
  museRegistration.discover = async (scope) => {
    museDiscovers += 1;
    return innerDiscover(scope);
  };
  registry.register(museRegistration);
  usage.onChanged(() => {
    registry.invalidateSource("muse");
  });
  const quotaA = {
    ...changedUsage,
    window: { ...changedUsage.window, usedPercent: 10 },
  };
  const hostA = usage.attach("session-a", launch, async () => ({}));
  expect(usage.observe(hostA.account, hostA.generation, quotaA)).toBe(true);
  const [warmed] = await registry.listReports();
  expect(warmed?.report.status).toBe("available");
  // A sibling source whose discovery stalls behind a separate gate per pass;
  // later passes resolve immediately.
  const siblingGates: Array<() => void> = [];
  let siblingCalls = 0;
  registry.register({
    id: "sibling",
    label: "sibling",
    discover: async () => {
      siblingCalls += 1;
      if (siblingCalls <= 2) {
        await new Promise<void>((resolve) => {
          siblingGates.push(resolve);
        });
      }
      return [{ key: "s", input: {} }];
    },
    fetch: async () => ({ status: "available", windows: [{ id: "w", label: "sibling" }] }),
  });
  // The agent read has no mapping yet, so it discovers while the sibling
  // stalls; the turnover lands during the last allowed pass.
  museDiscovers = 0;
  const pending = registry.listReports({ agentId: "muse-agent" });
  for (let i = 0; i < 50; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    if (museDiscovers >= 1 && siblingCalls >= 1) break;
  }
  expect(museDiscovers).toBeGreaterThanOrEqual(1);
  expect(siblingCalls).toBe(1);
  // A sibling freshness event consumes the single re-pass budget while the
  // first pass is still in flight.
  registry.invalidateSource("sibling");
  siblingGates[0]!();
  for (let i = 0; i < 50; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    if (museDiscovers >= 2 && siblingCalls >= 2) break;
  }
  expect(museDiscovers).toBeGreaterThanOrEqual(2);
  expect(siblingCalls).toBe(2);
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
  // The only Muse turnover lands during the last allowed pass.
  usage.detach("session-a");
  const hostB = usage.attach("session-b", launch, async () => ({}));
  siblingGates[1]!();
  const entries = await pending;
  // No retired A login lodges as the agent mapping: no Muse card may carry
  // A's quota or history, while the unrelated sibling still delivers.
  for (const entry of entries) {
    expect(JSON.stringify(entry)).not.toContain('"usedPct":10');
    if (entry.id.startsWith("muse:")) expect(entry.lastSuccessful).toBeUndefined();
  }
  expect(entries.map((entry) => entry.id)).toContain("sibling:s");
  // The replacement context now reports; the next same-session read must
  // rediscover it instead of reusing the partial mapping — never A.
  const quotaB = {
    ...changedUsage,
    window: { ...changedUsage.window, usedPercent: 90 },
  };
  expect(usage.observe(hostB.account, hostB.generation, quotaB)).toBe(true);
  const reconverged = await registry.listReports({ agentId: "muse-agent" });
  expect(reconverged.map((entry) => entry.id)).toContain("sibling:s");
  const museCard = reconverged.find((entry) => entry.id.startsWith("muse:"));
  expect(museCard?.report.status).toBe("available");
  expect(JSON.stringify(museCard?.report)).toContain('"usedPct":90');
  for (const entry of reconverged) {
    // Trailing comma: the weekly "usedPct":106 in every available card must
    // not prefix-match; only a real 10% window may fail here.
    expect(JSON.stringify(entry)).not.toContain('"usedPct":10,');
  }
});
