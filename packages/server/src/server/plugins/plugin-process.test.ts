import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { expect, it } from "vitest";

it("keeps React out of the plugin host's runtime dependency graph", async () => {
  await expect(
    build({
      entryPoints: [
        fileURLToPath(new URL("./plugin-process.ts", import.meta.url)),
        "@getpaseo/plugin",
        "@getpaseo/plugin/server",
        "@getpaseo/plugin/server/provider",
        "@getpaseo/plugin/server/acp",
      ],
      outdir: "unused",
      conditions: ["source"],
      bundle: true,
      platform: "node",
      format: "esm",
      // Node evaluates re-exports even when the host only imports one helper.
      treeShaking: false,
      write: false,
      logLevel: "silent",
      plugins: [
        {
          name: "no-react",
          setup(context) {
            context.onResolve(
              { filter: /^(react|react-dom|react-native|use-sync-external-store)(\/|$)/ },
              ({ path, importer }) => ({
                errors: [{ text: `React dependency ${path} imported by ${importer}` }],
              }),
            );
          },
        },
      ],
    }),
  ).resolves.toMatchObject({ errors: [] });
});

it("exposes CLI probes through the plugin host's server SDK", async () => {
  const { evaluateBundle } = await import("./bundle-evaluator.js");
  const setup = evaluateBundle(`(require) => ({ default: async () => {
    const { execCommand } = require("@getpaseo/plugin/server");
    const { stdout } = await execCommand(${JSON.stringify(process.execPath)}, ["-e", "process.stdout.write('plugin CLI ready')"]);
    if (stdout !== "plugin CLI ready") throw new Error("CLI output was lost");
  } })`);
  // This contribution uses no server context APIs; it exercises the host's real SDK binding.
  await expect(setup(undefined as never)).resolves.toBeUndefined();
});

it("owns provider registration, abort during bootstrap, and exactly-once cleanup", async () => {
  const { PluginVoiceWorker } = await import("./voice-worker.js");
  const { createPaseoApi } = await import("@getpaseo/client");
  const { DaemonClient } = await import("@getpaseo/client/internal/daemon-client");
  const { vi } = await import("vitest");
  const api = createPaseoApi(
    new DaemonClient({ url: "ws://127.0.0.1:1/ws", clientId: "voice-worker-test" }),
  );
  const worker = new PluginVoiceWorker();
  const close = vi.fn();
  let signal: AbortSignal | null = null;
  let finish: (() => void) | null = null;
  worker.register({
    id: "live",
    label: "Live",
    async start(context) {
      signal = context.signal;
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return { close, appendAudio() {} };
    },
  });
  expect(() =>
    worker.register({
      id: "live",
      label: "Duplicate",
      start: async () => ({ close, appendAudio() {} }),
    }),
  ).toThrow("Duplicate");
  expect(worker.catalog()).toEqual([{ id: "live", label: "Live" }]);
  const starting = worker.request(
    "s",
    { type: "start", providerId: "live", agentId: "11111111-1111-4111-8111-111111111111" },
    api,
    "/tmp",
    () => {},
  );
  const rejected = expect(starting).rejects.toThrow();
  await vi.waitFor(() => expect(finish).not.toBeNull());
  const closing = worker.shutdown();
  expect(signal!.aborted).toBe(true);
  finish!();
  await closing;
  await rejected;
  await worker.shutdown();
  expect(close).toHaveBeenCalledTimes(1);
  await api.dispose();
});

it("chunks speakable context by UTF-8 bytes without damaging characters", async () => {
  const { utf8Chunks } =
    await import("../../../../../plugin-examples/codex-live/server/delegation.js");
  const text = "åäö 🧑🏽‍💻 日本語 ".repeat(150);
  const chunks = utf8Chunks(text);
  expect(chunks.join("")).toBe(text);
  expect(chunks.every((chunk) => Buffer.byteLength(chunk) <= 500)).toBe(true);
});

it("paces input audio, bounds its backlog, and emits PCM24k output with a terminal chunk", async () => {
  const { createInputAudio, createOutputAudio } =
    await import("../../../../../plugin-examples/codex-live/server/audio.js");
  const events: import("@getpaseo/plugin/server").VoiceProviderEvent[] = [];
  const input = createInputAudio(
    (event) => events.push(event),
    () => {},
  );
  const loud = new Int16Array(160 * 10).fill(2000);
  input.append(Buffer.from(loud.buffer).toString("base64"));
  for (let index = 0; index < 10; index++) expect(input.frame()).toHaveLength(160);
  for (let index = 0; index < 40; index++) input.frame();
  expect(events).toEqual([
    { type: "speech", isSpeaking: true },
    { type: "speech", isSpeaking: false },
  ]);
  expect(() => input.append(Buffer.alloc(128_002).toString("base64"))).toThrow();
  const output = createOutputAudio((event) => events.push(event));
  // The native sink starts at 16 kHz and switches to the negotiated Opus rate.
  output.append(new Int16Array(160), 16_000, 1);
  for (let index = 0; index < 10; index++) output.append(new Int16Array(480).fill(2000), 48_000, 1);
  for (let index = 0; index < 30; index++) output.append(new Int16Array(480), 48_000, 1);
  expect(events.at(-1)).toMatchObject({ type: "audio", isLastChunk: true });
  const audio = events.find((event) => event.type === "audio");
  expect(audio).toMatchObject({ chunkIndex: 0 });
  if (audio?.type !== "audio") throw new Error("Missing PCM output");
  expect(Buffer.from(audio.audio, "base64").readInt16LE(0)).toBe(2000);
});

it("correlates Live delegation IDs with accepted messages, agents and turns and drops stale output", async () => {
  const { createDelegations } =
    await import("../../../../../plugin-examples/codex-live/server/delegation.js");
  const { createPaseoApi } = await import("@getpaseo/client");
  const { DaemonClient } = await import("@getpaseo/client/internal/daemon-client");
  const { vi } = await import("vitest");
  const api = createPaseoApi(
    new DaemonClient({ url: "ws://127.0.0.1:1/ws", clientId: "delegation-test" }),
  );
  const agent = api.agents.ref("agent-a");
  let listener: Parameters<typeof agent.timeline.subscribe>[0] = () => {};
  const unsubscribe = vi.fn();
  vi.spyOn(agent.timeline, "subscribe").mockImplementation((callback) => {
    listener = callback;
    return Object.assign(unsubscribe, { ready: Promise.resolve() });
  });
  vi.spyOn(api.agents, "ref").mockReturnValue(agent);
  let nextTurn = "turn-a";
  const send = vi.spyOn(agent, "send").mockImplementation(async (_text, options) => {
    expect(options?.activeTurnBehavior).toBe("steer_only");
    listener({
      agentId: "agent-a",
      event: {
        type: "timeline",
        provider: "codex",
        turnId: nextTurn,
        item: { type: "user_message", text: "request", clientMessageId: options?.messageId },
      },
    });
  });
  const replies: unknown[] = [];
  const fail = vi.fn();
  const delegations = createDelegations({
    paseo: api,
    agentId: "agent-a",
    send: (message) => replies.push(message),
    fail,
  });
  const request = (id: string) => ({
    type: "delegation.created",
    item: {
      type: "delegation",
      target: "client",
      id,
      content: [{ type: "input_text", text: "inspect file" }],
    },
  });
  const assistant = (agentId: string, turnId: string, text: string) =>
    listener({
      agentId,
      event: {
        type: "timeline",
        provider: "codex",
        turnId,
        item: { type: "assistant_message", text },
      },
    });
  await delegations.ready;
  await delegations.accept(request("d1"));
  await delegations.accept(request("d1"));
  expect(send).toHaveBeenCalledTimes(1);
  assistant("agent-b", "turn-a", "wrong agent");
  assistant("agent-a", "old-turn", "wrong turn");
  expect(replies).toEqual([]);
  assistant("agent-a", "turn-a", "first reply");
  expect(replies).toEqual([
    expect.objectContaining({
      delegation_item_id: "d1",
      content: [{ type: "input_text", text: "first reply" }],
    }),
  ]);
  nextTurn = "turn-b";
  await delegations.accept(request("d2"));
  assistant("agent-a", "turn-a", "late reply");
  expect(replies).toHaveLength(1);
  assistant("agent-a", "turn-b", "second reply");
  expect(replies[1]).toMatchObject({ delegation_item_id: "d2" });
  listener({
    agentId: "agent-a",
    event: {
      type: "timeline",
      provider: "codex",
      turnId: "turn-b",
      item: { type: "user_message", text: "external message", clientMessageId: "external" },
    },
  });
  assistant("agent-a", "turn-b", "externally redirected reply");
  expect(replies).toHaveLength(2);
  delegations.close();
  assistant("agent-a", "turn-b", "after close");
  expect(unsubscribe).toHaveBeenCalledTimes(1);
  expect(fail).not.toHaveBeenCalled();
  const idle = createDelegations({ paseo: api, agentId: "agent-a", send: () => {}, fail });
  listener({ agentId: "agent-a", event: { type: "subscription_restored" } });
  expect(fail).toHaveBeenCalledTimes(1);
  idle.close();
  await api.dispose();
});
