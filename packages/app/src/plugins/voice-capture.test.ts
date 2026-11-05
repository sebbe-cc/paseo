import { describe, expect, it } from "vitest";
import { createVoiceAudioSource } from "@/plugins/voice-capture";
import type {
  VoiceCaptureAudioContext,
  VoiceCapturePlatform,
  VoiceCaptureStream,
} from "@/plugins/voice-capture";

class FakeAudioContext implements VoiceCaptureAudioContext {
  readonly sampleRate = 16000;
  readonly destination = {};
  closed = false;
  processors: Array<{ fire(samples: Float32Array): void }> = [];

  createMediaStreamSource(_stream: VoiceCaptureStream): {
    connect(node: unknown): void;
    disconnect(): void;
  } {
    return { connect: () => undefined, disconnect: () => undefined };
  }

  createScriptProcessor(): {
    onaudioprocess:
      | ((event: { inputBuffer: { getChannelData(channel: number): Float32Array } }) => void)
      | null;
    connect(node: unknown): void;
    disconnect(): void;
    fire(samples: Float32Array): void;
  } {
    const entry: {
      handler:
        | ((event: { inputBuffer: { getChannelData(channel: number): Float32Array } }) => void)
        | null;
    } = { handler: null };
    const processor = {
      get onaudioprocess() {
        return entry.handler;
      },
      set onaudioprocess(handler: typeof entry.handler) {
        entry.handler = handler;
      },
      connect: () => undefined,
      disconnect: () => undefined,
      fire: (samples: Float32Array) => {
        entry.handler?.({ inputBuffer: { getChannelData: () => samples } });
      },
    };
    this.processors.push(processor);
    return processor;
  }

  createGain(): { gain: { value: number }; connect(node: unknown): void; disconnect(): void } {
    return { gain: { value: 0 }, connect: () => undefined, disconnect: () => undefined };
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

class FakePlatform implements VoiceCapturePlatform {
  contexts: FakeAudioContext[] = [];
  stoppedTracks = 0;
  failGetUserMedia = false;
  noAudioContext = false;
  private deferred: {
    promise: Promise<VoiceCaptureStream>;
    resolve: (stream: VoiceCaptureStream) => void;
  } | null = null;
  stream: VoiceCaptureStream = {
    getTracks: () => [
      {
        stop: () => {
          this.stoppedTracks += 1;
        },
      },
    ],
  };

  /** Next getUserMedia() stays pending until releaseDeferred() (permission dialog). */
  armDeferred(): void {
    let resolve!: (stream: VoiceCaptureStream) => void;
    const promise = new Promise<VoiceCaptureStream>((accept) => {
      resolve = accept;
    });
    this.deferred = { promise, resolve };
  }

  releaseDeferred(): void {
    this.deferred?.resolve(this.stream);
    this.deferred = null;
  }

  async getUserMedia(): Promise<VoiceCaptureStream> {
    if (this.failGetUserMedia) throw new Error("Permission denied");
    if (this.deferred) return this.deferred.promise;
    return this.stream;
  }

  createAudioContext(): VoiceCaptureAudioContext | null {
    if (this.noAudioContext) return null;
    const context = new FakeAudioContext();
    this.contexts.push(context);
    return context;
  }
}

function sineFrames(frames: number, value = 0.5): Float32Array {
  return new Float32Array(frames).fill(value);
}

describe("voice capture", () => {
  it("returns null without a platform", () => {
    const segments: string[] = [];
    expect(
      createVoiceAudioSource({ onPcmSegment: (segment) => segments.push(segment) }, null),
    ).toBeNull();
  });

  it("streams ~1 s PCM chunks while held", async () => {
    const platform = new FakePlatform();
    const segments: string[] = [];
    const source = createVoiceAudioSource(
      { onPcmSegment: (segment) => segments.push(segment) },
      platform,
    );
    expect(source).not.toBeNull();
    await source?.start();
    expect(platform.contexts).toHaveLength(1);
    // 16 kHz context, 4096 frames per callback: four callbacks pass one chunk.
    for (let i = 0; i < 4; i++) {
      platform.contexts[0].processors[0]?.fire(sineFrames(4096));
    }
    expect(segments).toHaveLength(1);
    const bytes = Buffer.from(segments[0], "base64");
    expect(bytes.length).toBe(16000 * 2);
    await source?.stop();
    // code-2: release flushes the 384-sample tail as a second segment.
    expect(segments).toHaveLength(2);
    expect(Buffer.from(segments[1], "base64").length).toBe(384 * 2);
    expect(platform.stoppedTracks).toBe(1);
    expect(platform.contexts[0].closed).toBe(true);
  });

  it("denied microphone permission throws honestly and leaks nothing", async () => {
    const platform = new FakePlatform();
    platform.failGetUserMedia = true;
    const source = createVoiceAudioSource({ onPcmSegment: () => undefined }, platform);
    await expect(source?.start()).rejects.toThrow(/Permission denied/);
    expect(platform.stoppedTracks).toBe(0);
    expect(platform.contexts).toHaveLength(0);
    await source?.stop();
  });

  it("missing AudioContext stops the mic tracks and throws", async () => {
    const platform = new FakePlatform();
    platform.noAudioContext = true;
    const source = createVoiceAudioSource({ onPcmSegment: () => undefined }, platform);
    await expect(source?.start()).rejects.toThrow(/AudioContext unavailable/);
    expect(platform.stoppedTracks).toBe(1);
  });

  it("stop without start resolves", async () => {
    const platform = new FakePlatform();
    const source = createVoiceAudioSource({ onPcmSegment: () => undefined }, platform);
    await expect(source?.stop()).resolves.toBeUndefined();
    expect(platform.stoppedTracks).toBe(0);
  });

  it("code-2: sub-second speech is preserved as one tail segment", async () => {
    const platform = new FakePlatform();
    const segments: string[] = [];
    const source = createVoiceAudioSource(
      { onPcmSegment: (segment) => segments.push(segment) },
      platform,
    );
    await source?.start();
    // Two callbacks: 8192 samples, no full chunk while held.
    for (let i = 0; i < 2; i++) {
      platform.contexts[0].processors[0]?.fire(sineFrames(4096));
    }
    expect(segments).toHaveLength(0);
    await source?.stop();
    expect(segments).toHaveLength(1);
    expect(Buffer.from(segments[0], "base64").length).toBe(8192 * 2);
    expect(platform.stoppedTracks).toBe(1);
  });

  it("code-2: cancel discards buffered audio instead of flushing it", async () => {
    const platform = new FakePlatform();
    const segments: string[] = [];
    const source = createVoiceAudioSource(
      { onPcmSegment: (segment) => segments.push(segment) },
      platform,
    );
    await source?.start();
    for (let i = 0; i < 2; i++) {
      platform.contexts[0].processors[0]?.fire(sineFrames(4096));
    }
    await source?.cancel();
    expect(segments).toHaveLength(0);
    expect(platform.stoppedTracks).toBe(1);
    expect(platform.contexts[0].closed).toBe(true);
  });

  it("code-1: release during deferred acquisition never enables recording", async () => {
    const platform = new FakePlatform();
    platform.armDeferred();
    const segments: string[] = [];
    const source = createVoiceAudioSource(
      { onPcmSegment: (segment) => segments.push(segment) },
      platform,
    );
    // Hold starts; the permission dialog keeps getUserMedia pending.
    const starting = source?.start();
    await Promise.resolve();
    // Release (or window blur / daemon disconnect) retires the hold.
    await source?.stop();
    // Permission granted afterwards: stale result must not record.
    platform.releaseDeferred();
    await starting;
    expect(platform.contexts).toHaveLength(0);
    expect(segments).toHaveLength(0);
    // The stale mic stream is stopped, never graphed.
    expect(platform.stoppedTracks).toBe(1);
    // A later new hold works normally.
    const second = createVoiceAudioSource(
      { onPcmSegment: (segment) => segments.push(segment) },
      platform,
    );
    await second?.start();
    expect(platform.contexts).toHaveLength(1);
    platform.contexts[0].processors[0]?.fire(sineFrames(4096));
    await second?.stop();
    expect(segments).toHaveLength(1);
    expect(platform.stoppedTracks).toBe(2);
  });
});
