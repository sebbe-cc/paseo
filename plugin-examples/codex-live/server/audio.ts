import { randomUUID } from "node:crypto";
import type { VoiceProviderEvent } from "@getpaseo/plugin/server";

/** WebRTC's audio source consumes exactly 10 ms at a time, including silence. */
export function createInputAudio(
  emit: (event: VoiceProviderEvent) => void,
  speechStarted: () => void,
) {
  let queued = Buffer.alloc(0);
  let speaking = false;
  let loudFrames = 0;
  let quietFrames = 0;
  return {
    append(audio: string) {
      const bytes = Buffer.from(audio, "base64");
      if (bytes.length % 2 || queued.length + bytes.length > 128_000)
        throw new Error("Invalid or excessive voice input");
      queued = Buffer.concat([queued, bytes]);
    },
    frame(): Int16Array {
      const samples = new Int16Array(160);
      const count = Math.min(160, queued.length / 2);
      let energy = 0;
      for (let index = 0; index < count; index++) {
        const sample = queued.readInt16LE(index * 2);
        samples[index] = sample;
        energy += sample * sample;
      }
      queued = queued.subarray(count * 2);
      const loud = Math.sqrt(energy / 160) > 600;
      loudFrames = loud ? loudFrames + 1 : 0;
      quietFrames = loud ? 0 : quietFrames + 1;
      if (!speaking && loudFrames >= 6) {
        speaking = true;
        speechStarted();
        emit({ type: "speech", isSpeaking: true });
      }
      if (speaking && quietFrames >= 40) {
        speaking = false;
        emit({ type: "speech", isSpeaking: false });
      }
      return samples;
    },
    get speaking() {
      return speaking;
    },
    clear() {
      queued = Buffer.alloc(0);
    },
  };
}

/** WebRTC may start with 16 kHz silence before Opus arrives. Keep output at 24 kHz mono. */
export function createOutputAudio(emit: (event: VoiceProviderEvent) => void) {
  let utteranceId: string | null = null;
  let chunkIndex = 0;
  let queued: Buffer[] = [];
  let queuedBytes = 0;
  let silentFrames = 0;
  function flush(last: boolean) {
    if (!utteranceId) return;
    emit({
      type: "audio",
      audio: Buffer.concat(queued).toString("base64"),
      utteranceId,
      chunkIndex: chunkIndex++,
      isLastChunk: last,
    });
    queued = [];
    queuedBytes = 0;
    if (last) utteranceId = null;
  }
  return {
    append(samples: Int16Array, sampleRate: number, channels: number) {
      if (sampleRate < 8000 || sampleRate > 96000 || channels < 1 || samples.length % channels)
        throw new Error("Unexpected WebRTC output format");
      const ratio = sampleRate / 24000;
      const sourceFrames = samples.length / channels;
      const frames = Math.round(sourceFrames / ratio);
      const bytes = Buffer.alloc(frames * 2);
      let energy = 0;
      for (let index = 0; index < frames; index++) {
        const start = index * ratio;
        const end = Math.min((index + 1) * ratio, sourceFrames);
        let value = 0;
        for (let sourceIndex = Math.floor(start); sourceIndex < Math.ceil(end); sourceIndex++) {
          const weight = Math.min(end, sourceIndex + 1) - Math.max(start, sourceIndex);
          for (let channel = 0; channel < channels; channel++)
            value += samples[sourceIndex * channels + channel] * weight;
        }
        value = Math.round(value / (channels * (end - start)));
        bytes.writeInt16LE(value, index * 2);
        energy += value * value;
      }
      const audible = Math.sqrt(energy / frames) > 12;
      silentFrames = audible ? 0 : silentFrames + frames;
      if (!utteranceId && !audible) return;
      if (!utteranceId) {
        utteranceId = randomUUID();
        chunkIndex = 0;
      }
      queued.push(bytes);
      queuedBytes += bytes.length;
      if (silentFrames >= 7200) flush(true);
      else if (queuedBytes >= 4800) flush(false);
    },
    clear() {
      utteranceId = null;
      queued = [];
      queuedBytes = 0;
      silentFrames = 0;
    },
  };
}
