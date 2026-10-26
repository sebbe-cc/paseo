import { expect, test, vi } from "vitest";
import { createPlaybackQueue } from "./playback";

test("schedules streamed PCM contiguously ahead of completion and acknowledges consumed audio", async () => {
  const { playPcmStream } = await import("./pcm-stream");
  const played = vi.fn();
  const starts: number[] = [];
  const finish: (() => void)[] = [];
  const audio = {
    type: "audio/pcm;rate=24000;bits=16",
    size: 4800,
    arrayBuffer: async () => new ArrayBuffer(4800),
  };
  const result = playPcmStream(
    async function* () {
      yield { audio, onPlayed: () => played(0) };
      yield { audio, onPlayed: () => played(1) };
    },
    {
      now: () => 10,
      schedule: async (_audio, at) => {
        starts.push(at);
        await new Promise<void>((resolve) => finish.push(resolve));
      },
    },
    new AbortController().signal,
  );
  await vi.waitFor(() => expect(starts).toHaveLength(2));
  expect(starts[0]).toBeCloseTo(10.15);
  expect(starts[1]).toBeCloseTo(10.25);
  expect(played).not.toHaveBeenCalled();
  finish[0]();
  await vi.waitFor(() => expect(played).toHaveBeenCalledWith(0));
  expect(played).not.toHaveBeenCalledWith(1);
  finish[1]();
  await expect(result).resolves.toBeCloseTo(0.2);
  expect(played).toHaveBeenCalledWith(1);
});

test("an empty terminal PCM packet waits for the audible tail", async () => {
  const { playPcmStream } = await import("./pcm-stream");
  const played = vi.fn();
  let finish!: () => void;
  const audio = {
    type: "audio/pcm;rate=24000;bits=16",
    size: 4800,
    arrayBuffer: async () => new ArrayBuffer(4800),
  };
  const result = playPcmStream(
    async function* () {
      yield { audio, onPlayed: () => played("audio") };
      yield { audio: { ...audio, size: 0 }, onPlayed: () => played("terminal") };
    },
    {
      now: () => 0,
      schedule: () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    },
    new AbortController().signal,
  );
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  expect(played).not.toHaveBeenCalled();
  finish();
  await expect(result).resolves.toBe(0.1);
  expect(played.mock.calls).toEqual([["audio"], ["terminal"]]);
});

test("cancelling a PCM stream cancels scheduled audio and suppresses playback acknowledgements", async () => {
  const { playPcmStream } = await import("./pcm-stream");
  const owner = new AbortController();
  const played = vi.fn();
  const cancelled = vi.fn();
  const audio = {
    type: "audio/pcm;rate=24000;bits=16",
    size: 4800,
    arrayBuffer: async () => new ArrayBuffer(4800),
  };
  let scheduled = false;
  const result = playPcmStream(
    async function* () {
      yield { audio, onPlayed: played };
    },
    {
      now: () => 0,
      schedule: (_audio, _at, signal) =>
        new Promise<void>((_resolve, reject) => {
          scheduled = true;
          signal.addEventListener(
            "abort",
            () => {
              cancelled();
              reject(new Error("Playback stopped"));
            },
            { once: true },
          );
        }),
    },
    owner.signal,
  );
  const rejected = expect(result).rejects.toThrow("Playback stopped");
  await vi.waitFor(() => expect(scheduled).toBe(true));
  owner.abort();
  await rejected;
  expect(cancelled).toHaveBeenCalledTimes(1);
  expect(played).not.toHaveBeenCalled();
});

function harness() {
  const started: string[] = [];
  const finishes: (() => void)[] = [];
  const queue = createPlaybackQueue<string>((source, signal) => {
    started.push(source);
    return new Promise<number>((resolve, reject) => {
      finishes.push(() => resolve(1));
      signal.addEventListener("abort", () => reject(new Error("Playback stopped")), { once: true });
    });
  });
  return { queue, started, finishes };
}

test("plays in order and resolves only after playback completes", async () => {
  const h = harness();
  const first = h.queue.play("first");
  const second = h.queue.play("second");
  expect(h.started).toEqual(["first"]);
  h.finishes[0]();
  await expect(first).resolves.toBe(1);
  expect(h.started).toEqual(["first", "second"]);
  h.finishes[1]();
  await expect(second).resolves.toBe(1);
});

test("cancels one owner's queued and active work without stopping another owner", async () => {
  const h = harness();
  const owner = new AbortController();
  const first = h.queue.play("first", owner.signal);
  const queued = h.queue.play("cancelled", owner.signal);
  const other = h.queue.play("other");
  const rejected = Promise.all([
    expect(first).rejects.toThrow("Playback stopped"),
    expect(queued).rejects.toThrow("Playback stopped"),
  ]);
  owner.abort(new Error("unloaded"));
  await rejected;
  expect(h.started).toEqual(["first", "other"]);
  h.finishes[1]();
  await expect(other).resolves.toBe(1);
});

test("stop during loading cannot start cancelled audio or strand the next call", async () => {
  const h = harness();
  const first = h.queue.play("loading");
  const rejected = expect(first).rejects.toThrow("Playback stopped");
  h.queue.stop();
  await rejected;
  const second = h.queue.play("next");
  h.finishes[1]();
  await expect(second).resolves.toBe(1);
});

test("a failed file does not block the queue", async () => {
  const queue = createPlaybackQueue<string>(async (source) => {
    if (source === "invalid") throw new Error("Invalid audio");
    return 2;
  });
  const failed = queue.play("invalid");
  const next = queue.play("valid");
  await expect(failed).rejects.toThrow("Invalid audio");
  await expect(next).resolves.toBe(2);
});

test("ending the voice waiting cue leaves a plugin's active audio playing", async () => {
  const { createVoiceRuntime } = await import("../voice/voice-runtime");
  let finishPlugin!: () => void;
  let cueQueued!: () => void;
  const queued = new Promise<void>((resolve) => {
    cueQueued = resolve;
  });
  const output = createPlaybackQueue<{ type: string }>(
    (_source, signal) =>
      new Promise((resolve, reject) => {
        finishPlugin = () => resolve(1);
        signal.addEventListener("abort", () => reject(new Error("Playback stopped")), {
          once: true,
        });
      }),
  );
  const engine = {
    initialize: async () => {},
    destroy: async () => {
      output.destroy();
    },
    startCapture: async () => {},
    stopCapture: async () => {},
    toggleMute: () => false,
    isMuted: () => false,
    play(source: { type: string }, signal?: AbortSignal) {
      if (source.type.startsWith("audio/pcm")) cueQueued();
      return output.play(source, signal);
    },
    stop: output.stop,
    clearQueue: output.clearQueue,
    isPlaying: output.isPlaying,
  };
  const runtime = createVoiceRuntime({
    engine,
    getServerInfo: () => ({
      serverId: "host",
      hostname: "host",
      version: "1.0.0",
      capabilities: {
        voice: { dictation: { enabled: true, reason: "" }, voice: { enabled: true, reason: "" } },
      },
    }),
    activateKeepAwake: async () => {},
    deactivateKeepAwake: async () => {},
  });
  runtime.registerSession({
    serverId: "host",
    setVoiceMode: async () => {},
    sendVoiceAudioChunk: async () => {},
    audioPlayed: async () => {},
    abortRequest: async () => {},
    setAssistantAudioPlaying: () => {},
  });
  try {
    await runtime.startVoice("host", "agent");
    const result = engine.play({ type: "audio/wav" }).then(
      () => "finished",
      () => "stopped",
    );
    runtime.onTurnEvent("host", "agent", "turn_started");
    await queued;
    runtime.onAssistantAudioStarted("host");
    finishPlugin();
    expect(await result).toBe("finished");
  } finally {
    await runtime.destroy();
  }
});
