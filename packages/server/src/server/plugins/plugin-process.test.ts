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

it("runs dictation commands in order and closes a session once", async () => {
  const { PluginDictationWorker } = await import("./dictation-worker.js");
  const { createPaseoApi } = await import("@getpaseo/client");
  const { DaemonClient } = await import("@getpaseo/client/internal/daemon-client");
  const { vi } = await import("vitest");
  const api = createPaseoApi(
    new DaemonClient({ url: "ws://127.0.0.1:1/ws", clientId: "dictation-worker-test" }),
  );
  const worker = new PluginDictationWorker();
  const close = vi.fn();
  const heard: string[] = [];
  let agentId: string | undefined;
  worker.register({
    id: "live",
    label: "Live",
    async start(context) {
      agentId = context.agentId;
      return {
        appendAudio: (audio) => void heard.push(audio),
        commit: async () => heard.splice(0).join("+"),
        close,
      };
    },
  });
  expect(worker.catalog()).toEqual([{ id: "live", label: "Live" }]);
  const chat = "11111111-1111-4111-8111-111111111111";
  await worker.request("s", { type: "start", providerId: "live", agentId: chat }, api, "/tmp");
  expect(agentId).toBe(chat);
  await worker.request("s", { type: "audio", audio: "a" }, api, "/tmp");
  await worker.request("s", { type: "audio", audio: "b" }, api, "/tmp");
  await expect(worker.request("s", { type: "commit" }, api, "/tmp")).resolves.toEqual({
    text: "a+b",
  });
  await worker.request("s", { type: "close" }, api, "/tmp");
  await expect(worker.request("s", { type: "commit" }, api, "/tmp")).rejects.toThrow("closed");
  await worker.shutdown();
  expect(close).toHaveBeenCalledTimes(1);
  await api.dispose();
});
