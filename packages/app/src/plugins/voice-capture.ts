import { resampleToPcm16 } from "@/audio/pcm";
import type { VoiceAudioSource } from "./voice-pipeline";

/**
 * Headless microphone capture for plugin hold-to-talk (pa-w4srq.4).
 *
 * Mirrors the composer's web audio source (pcm ScriptProcessor path): mono
 * mic, 16 kHz PCM16 base64 in ~1 s chunks. Structural minimal types only —
 * no DOM imports — so native/SSR builds never crash: the factory returns
 * null where capture is impossible and the capability probes voiceInput
 * false there. Permission denial throws an honest error at start().
 *
 * Only the live PCM path is implemented. Where the composer falls back to
 * MediaRecorder (no MediaStreamAudioSourceNode), this throws instead of
 * silently switching latency profiles; the plugin reports it honestly.
 */

/** Structural mic stream: only the tracks we stop. */
export interface VoiceCaptureStream {
  getTracks(): Array<{ stop(): void }>;
}

/** Structural audio graph nodes for the live PCM path. */
export interface VoiceCaptureAudioContext {
  readonly sampleRate: number;
  createMediaStreamSource(stream: VoiceCaptureStream): {
    connect(node: unknown): void;
    disconnect(): void;
  };
  createScriptProcessor(
    bufferSize: number,
    inputs: number,
    outputs: number,
  ): {
    onaudioprocess:
      | ((event: { inputBuffer: { getChannelData(channel: number): Float32Array } }) => void)
      | null;
    connect(node: unknown): void;
    disconnect(): void;
  };
  createGain(): { gain: { value: number }; connect(node: unknown): void; disconnect(): void };
  readonly destination: unknown;
  close(): Promise<void>;
}

export interface VoiceCapturePlatform {
  getUserMedia(constraints: {
    audio: {
      channelCount: number;
      noiseSuppression: boolean;
      echoCancellation: boolean;
      autoGainControl: boolean;
    };
  }): Promise<VoiceCaptureStream>;
  createAudioContext(): VoiceCaptureAudioContext | null;
}

export interface VoiceCaptureConfig {
  onPcmSegment(pcm16Base64: string): void;
  onError?(error: Error): void;
}

function defaultPlatform(): VoiceCapturePlatform | null {
  const candidate = globalThis as {
    navigator?: {
      mediaDevices?: { getUserMedia?: (constraints: unknown) => Promise<unknown> };
    };
    AudioContext?: new () => VoiceCaptureAudioContext;
  };
  const getUserMedia = candidate.navigator?.mediaDevices?.getUserMedia;
  const AudioContextCtor = candidate.AudioContext;
  if (typeof getUserMedia !== "function" || typeof AudioContextCtor !== "function") {
    return null;
  }
  return {
    getUserMedia: (constraints) =>
      getUserMedia.call(
        candidate.navigator?.mediaDevices,
        constraints,
      ) as Promise<VoiceCaptureStream>,
    createAudioContext: () => {
      try {
        return new AudioContextCtor();
      } catch {
        return null;
      }
    },
  };
}

function int16ToBase64(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/** ~1 s PCM16 chunks at 16 kHz, mirroring the composer web source. */
const OUTPUT_RATE = 16000;
const CHUNK_SAMPLES = OUTPUT_RATE;

export function createVoiceAudioSource(
  config: VoiceCaptureConfig,
  platform: VoiceCapturePlatform | null = defaultPlatform(),
): VoiceAudioSource | null {
  if (!platform) return null;
  let stream: VoiceCaptureStream | null = null;
  let context: VoiceCaptureAudioContext | null = null;
  let started = false;
  let pending = new Int16Array(0);

  function teardown(): void {
    started = false;
    if (stream) {
      for (const track of stream.getTracks()) {
        try {
          track.stop();
        } catch {
          // no-op
        }
      }
      stream = null;
    }
    if (context) {
      const closing = context;
      context = null;
      void closing.close().catch(() => undefined);
    }
    pending = new Int16Array(0);
  }

  return {
    async start(): Promise<void> {
      const mic = await platform.getUserMedia({
        audio: {
          channelCount: 1,
          noiseSuppression: true,
          echoCancellation: true,
          autoGainControl: true,
        },
      });
      const audioContext = platform.createAudioContext();
      if (!audioContext) {
        for (const track of mic.getTracks()) {
          try {
            track.stop();
          } catch {
            // no-op
          }
        }
        throw new Error("AudioContext unavailable");
      }
      stream = mic;
      context = audioContext;
      try {
        const source = audioContext.createMediaStreamSource(mic);
        const processor = audioContext.createScriptProcessor(4096, 1, 1);
        const gain = audioContext.createGain();
        gain.gain.value = 0;
        processor.onaudioprocess = (event) => {
          if (!started) return;
          try {
            const input = event.inputBuffer.getChannelData(0);
            const next = resampleToPcm16(input, audioContext.sampleRate, OUTPUT_RATE);
            const merged = new Int16Array(pending.length + next.length);
            merged.set(pending, 0);
            merged.set(next, pending.length);
            pending = merged;
            while (pending.length >= CHUNK_SAMPLES) {
              const chunk = pending.slice(0, CHUNK_SAMPLES);
              pending = pending.slice(CHUNK_SAMPLES);
              config.onPcmSegment(int16ToBase64(chunk));
            }
          } catch (error) {
            config.onError?.(error instanceof Error ? error : new Error(String(error)));
          }
        };
        source.connect(processor);
        processor.connect(gain);
        gain.connect(audioContext.destination);
        started = true;
      } catch (error) {
        teardown();
        throw error;
      }
    },

    async stop(): Promise<void> {
      teardown();
    },
  };
}

/**
 * Capture-availability probe without side effects: no mic is opened, so the
 * runtime wiring can honestly report voiceInput false where capture APIs
 * are missing (browser without mic APIs, native, SSR, bare node).
 */
export function isVoiceCaptureAvailable(
  platform: VoiceCapturePlatform | null | undefined = defaultPlatform(),
): boolean {
  return platform !== null;
}
