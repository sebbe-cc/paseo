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
  stream: VoiceCaptureStream = {
    getTracks: () => [
      {
        stop: () => {
          this.stoppedTracks += 1;
        },
      },
    ],
  };

  async getUserMedia(): Promise<VoiceCaptureStream> {
    if (this.failGetUserMedia) throw new Error("Permission denied");
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
});
