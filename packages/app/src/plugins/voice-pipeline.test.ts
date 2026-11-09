import { describe, expect, it } from "vitest";
import type { SessionOutboundMessage } from "@getpaseo/protocol/messages";
import {
  createDesktopVoicePipeline,
  createPluginVoiceInput,
  isPackagedDesktopVoiceHost,
} from "@/plugins/voice-pipeline";
import type { VoiceAudioSource, VoiceAudioSourceConfig } from "@/plugins/voice-pipeline";

type RawListener = (message: SessionOutboundMessage) => void;
type StatusListener = (state: { status: string }) => void;

class FakeDaemonClient {
  isConnected = true;
  transcript = "hej agenten";
  starts: string[] = [];
  sentMessages: Array<{ agentId: string; text: string }> = [];
  cancels: string[] = [];
  finishCalls = 0;
  finishSeqs: number[] = [];
  failFinish = false;
  private readonly rawListeners = new Set<RawListener>();
  private readonly statusListeners = new Set<StatusListener>();

  async startDictationStream(dictationId: string, format: string): Promise<void> {
    this.starts.push(`${dictationId}:${format}`);
  }

  sendDictationStreamChunk(dictationId: string, seq: number): void {
    this.emitAck(dictationId, seq);
  }

  async finishDictationStream(
    dictationId: string,
    finalSeq: number,
  ): Promise<{ dictationId: string; text: string }> {
    this.finishCalls += 1;
    if (this.failFinish) throw new Error("stream failed");
    this.finishSeqs.push(finalSeq);
    return { dictationId, text: this.transcript };
  }

  cancelDictationStream(dictationId: string): void {
    this.cancels.push(dictationId);
  }

  subscribeRawMessages(handler: RawListener): () => void {
    this.rawListeners.add(handler);
    return () => this.rawListeners.delete(handler);
  }

  subscribeConnectionStatus(listener: StatusListener): () => void {
    this.statusListeners.add(listener);
    listener({ status: this.isConnected ? "connected" : "disconnected" });
    return () => this.statusListeners.delete(listener);
  }

  async sendMessage(agentId: string, text: string): Promise<void> {
    this.sentMessages.push({ agentId, text });
  }

  setConnected(connected: boolean): void {
    this.isConnected = connected;
    for (const listener of this.statusListeners) {
      listener({ status: connected ? "connected" : "disconnected" });
    }
  }

  emitAck(dictationId: string, ackSeq: number): void {
    for (const listener of this.rawListeners) {
      listener({
        type: "dictation_stream_ack",
        payload: { dictationId, ackSeq },
      });
    }
  }
}

class FakeAudioSource implements VoiceAudioSource {
  started = false;
  stopped = 0;
  cancelled = 0;
  failStart = false;
  private config: VoiceAudioSourceConfig | null = null;

  constructor(config: VoiceAudioSourceConfig) {
    this.config = config;
  }

  async start(): Promise<void> {
    if (this.failStart) throw new Error("permission denied");
    this.started = true;
  }

  async stop(): Promise<void> {
    this.stopped += 1;
    this.started = false;
  }

  async cancel(): Promise<void> {
    this.cancelled += 1;
    this.started = false;
  }

  emitPcm(base64: string): void {
    this.config?.onPcmSegment(base64);
  }

  emitError(error: Error): void {
    this.config?.onError?.(error);
  }
}

function setup(options?: { client?: FakeDaemonClient | null; transcript?: string }) {
  const client = options?.client === undefined ? new FakeDaemonClient() : options.client;
  if (client && options?.transcript !== undefined) client.transcript = options.transcript;
  const sources: FakeAudioSource[] = [];
  const pipeline = createDesktopVoicePipeline({
    resolveClient: () => client,
    createAudioSource: (config) => {
      const source = new FakeAudioSource(config);
      sources.push(source);
      return source;
    },
  });
  return { client: client as FakeDaemonClient | null, sources, pipeline };
}

const TARGET = { serverId: "srv", agentId: "agent-1" };

describe("desktop voice pipeline", () => {
  it("throws honestly without a daemon client", async () => {
    const { pipeline, sources } = setup({ client: null });
    await expect(pipeline.start(TARGET)).rejects.toThrow(/No daemon client/);
    expect(sources).toHaveLength(0);
    // A failed start leaves no session behind.
    await expect(pipeline.stop()).resolves.toBeUndefined();
  });

  it("throws honestly when the daemon is disconnected", async () => {
    const client = new FakeDaemonClient();
    client.setConnected(false);
    const { pipeline } = setup({ client });
    await expect(pipeline.start(TARGET)).rejects.toThrow(/not connected/);
  });

  it("release-to-send delivers the transcript to the routed agent", async () => {
    const { client, pipeline, sources } = setup({ transcript: "status?" });
    await pipeline.start(TARGET);
    expect(sources).toHaveLength(1);
    sources[0].emitPcm("cGNtMQ==");
    sources[0].emitPcm("cGNtMg==");
    await pipeline.stop();
    expect(client?.sentMessages).toEqual([{ agentId: "agent-1", text: "status?" }]);
    expect(sources[0].stopped).toBe(1);
    expect(sources[0].started).toBe(false);
  });

  it("sends nothing without audio segments", async () => {
    const { client, pipeline, sources } = setup();
    await pipeline.start(TARGET);
    await pipeline.stop();
    expect(client?.sentMessages).toEqual([]);
    expect(sources[0].stopped).toBe(1);
  });

  it("sends nothing for an empty transcript", async () => {
    const { client, pipeline, sources } = setup({ transcript: "   " });
    await pipeline.start(TARGET);
    sources[0].emitPcm("cGNtMQ==");
    await pipeline.stop();
    expect(client?.sentMessages).toEqual([]);
  });

  it("a new press retires the previous session without delivering it", async () => {
    const { client, pipeline, sources } = setup({ transcript: "ett" });
    await pipeline.start(TARGET);
    sources[0].emitPcm("cGNtMQ==");
    await pipeline.start({ serverId: "srv", agentId: "agent-2" });
    // Abandonment is fire-and-forget; let its microtasks land.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sources[0].started).toBe(false);
    // Retired sessions are cancelled (buffer discarded), never released.
    expect(sources[0].cancelled).toBe(1);
    expect(sources[0].stopped).toBe(0);
    expect(sources).toHaveLength(2);
    sources[1].emitPcm("cGNtMg==");
    await pipeline.stop();
    // Only the second session delivers, to its own agent.
    expect(client?.sentMessages).toEqual([{ agentId: "agent-2", text: "ett" }]);
  });

  it("a failed mic start clears the session and stops nothing twice", async () => {
    const { sources } = setup();
    const failing = createDesktopVoicePipeline({
      resolveClient: () => new FakeDaemonClient(),
      createAudioSource: (config) => {
        const source = new FakeAudioSource(config);
        source.failStart = true;
        sources.push(source);
        return source;
      },
    });
    await expect(failing.start(TARGET)).rejects.toThrow(/permission denied/);
    await expect(failing.stop()).resolves.toBeUndefined();
  });

  it("missing capture reports honestly", async () => {
    const pipeline = createDesktopVoicePipeline({
      resolveClient: () => new FakeDaemonClient(),
      createAudioSource: () => null,
    });
    await expect(pipeline.start(TARGET)).rejects.toThrow(/Microphone capture is unavailable/);
  });

  it("a mid-press capture error abandons the session without delivery", async () => {
    const { client, pipeline, sources } = setup();
    await pipeline.start(TARGET);
    sources[0].emitPcm("cGNtMQ==");
    sources[0].emitError(new Error("device unplugged"));
    await pipeline.stop();
    expect(client?.sentMessages).toEqual([]);
    expect(sources[0].started).toBe(false);
  });

  it("a failed finish disposes the session and propagates", async () => {
    const client = new FakeDaemonClient();
    client.failFinish = true;
    const { pipeline, sources } = setup({ client });
    await pipeline.start(TARGET);
    sources[0].emitPcm("cGNtMQ==");
    await expect(pipeline.stop()).rejects.toThrow(/stream failed/);
    // The mic is off even though delivery failed.
    expect(sources[0].started).toBe(false);
    // Nothing lingers: a second stop is a no-op.
    await expect(pipeline.stop()).resolves.toBeUndefined();
    expect(client.finishCalls).toBe(1);
  });

  it("connection loss notifies capability handlers, initial state does not", async () => {
    const { client, pipeline } = setup();
    const seen: string[] = [];
    const seenAgain: string[] = [];
    pipeline.subscribeConnectionLoss(() => seen.push("lost"));
    await pipeline.start(TARGET);
    expect(seen).toEqual([]);
    const release = pipeline.subscribeConnectionLoss(() => seenAgain.push("lost"));
    client?.setConnected(false);
    expect(seen).toEqual(["lost"]);
    expect(seenAgain).toEqual(["lost"]);
    release();
    client?.setConnected(true);
    client?.setConnected(false);
    expect(seenAgain).toEqual(["lost"]);
  });

  it("stop without start is a no-op", async () => {
    const { pipeline } = setup();
    await expect(pipeline.stop()).resolves.toBeUndefined();
  });

  it("reports no desktop host honestly (browser/mobile/SSR stay unsupported)", () => {
    expect(isPackagedDesktopVoiceHost()).toBe(false);
    expect(
      createPluginVoiceInput({
        isDesktopHost: () => false,
        isCaptureAvailable: () => true,
        resolveClient: () => new FakeDaemonClient(),
        createAudioSource: (config) => new FakeAudioSource(config),
      }),
    ).toBeNull();
  });

  it("reports missing capture honestly", () => {
    expect(
      createPluginVoiceInput({
        isDesktopHost: () => true,
        isCaptureAvailable: () => false,
        resolveClient: () => new FakeDaemonClient(),
        createAudioSource: (config) => new FakeAudioSource(config),
      }),
    ).toBeNull();
  });

  it("builds the pipeline on a packaged desktop host with capture", async () => {
    const pipeline = createPluginVoiceInput({
      isDesktopHost: () => true,
      isCaptureAvailable: () => true,
      resolveClient: () => new FakeDaemonClient(),
      createAudioSource: (config) => new FakeAudioSource(config),
    });
    expect(pipeline).not.toBeNull();
    await expect(pipeline?.start(TARGET)).resolves.toBeUndefined();
    await expect(pipeline?.stop()).resolves.toBeUndefined();
  });

  it("validates the route target", async () => {
    const { pipeline } = setup();
    await expect(pipeline.start({ serverId: " ", agentId: "a" })).rejects.toThrow(
      /non-empty serverId/,
    );
    await expect(pipeline.start({ serverId: "s", agentId: " " })).rejects.toThrow(
      /non-empty agentId/,
    );
  });
});
