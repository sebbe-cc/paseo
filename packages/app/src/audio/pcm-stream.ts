import type { AudioPlaybackSource, AudioPlaybackStreamChunk } from "./audio-engine-types";
import { parsePcmSampleRate } from "./pcm";

interface PcmStreamOutput {
  now(): number;
  schedule(audio: AudioPlaybackSource, at: number, signal: AbortSignal): Promise<void>;
}

/** Keep JS completion callbacks out of the boundaries between PCM packets. */
export async function playPcmStream(
  chunks: (signal: AbortSignal) => AsyncIterable<AudioPlaybackStreamChunk>,
  output: PcmStreamOutput,
  signal: AbortSignal,
): Promise<number> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  let nextAt = output.now() + 0.15;
  let duration = 0;
  const pending: Promise<void>[] = [];
  try {
    for await (const chunk of chunks(controller.signal)) {
      if (controller.signal.aborted) throw new Error("Playback stopped");
      const { audio } = chunk;
      if (!audio.type.startsWith("audio/pcm") || audio.size % 2)
        throw new Error("Streaming playback requires PCM16");
      const seconds = audio.size / 2 / (parsePcmSampleRate(audio.type) ?? 24000);
      // An empty terminal packet is acknowledged after the scheduled tail.
      if (seconds === 0) {
        await Promise.all(pending);
        if (!controller.signal.aborted) chunk.onPlayed();
        continue;
      }
      const at = Math.max(nextAt, output.now());
      nextAt = at + seconds;
      duration += seconds;
      const playing = output.schedule(audio, at, controller.signal).then(() => {
        if (!controller.signal.aborted) chunk.onPlayed();
        return undefined;
      });
      // Observe failures immediately, including while waiting for another packet.
      void playing.catch(abort);
      pending.push(playing);
      if (nextAt - output.now() > 0.5) await pending.shift();
    }
    await Promise.all(pending);
    if (controller.signal.aborted) throw new Error("Playback stopped");
    return duration;
  } finally {
    signal.removeEventListener("abort", abort);
    controller.abort();
  }
}
