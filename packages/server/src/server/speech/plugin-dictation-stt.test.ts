import { describe, expect, test, vi } from "vitest";
import pino from "pino";
import { createPluginDictationStt } from "./plugin-dictation-stt.js";

describe("plugin dictation STT", () => {
  test("commits cover the audio before them, in order, as final segments", async () => {
    const calls: string[] = [];
    const close = vi.fn();
    const startDictationProvider = vi.fn(async () => ({
      appendAudio: async (audio: string) => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        calls.push(`audio:${Buffer.from(audio, "base64").length}`);
      },
      commit: async () => {
        calls.push("commit");
        return `text ${calls.length}`;
      },
      close,
    }));
    const stt = createPluginDictationStt(
      { hasDictationProvider: () => true, startDictationProvider },
      { pluginId: "p", providerId: "d" },
    );
    const session = stt.createSession({ logger: pino({ level: "silent" }), agentId: "a1" });
    const committed: unknown[] = [];
    const transcripts: unknown[] = [];
    session.on("committed", (event) => committed.push(event));
    session.on("transcript", (event) => transcripts.push(event));
    await session.connect();
    expect(startDictationProvider.mock.calls[0]?.[1]).toMatchObject({ agentId: "a1" });
    session.appendPcm16(Buffer.alloc(4));
    session.appendPcm16(Buffer.alloc(6));
    session.commit();
    await vi.waitFor(() => expect(transcripts).toHaveLength(1));
    expect(calls).toEqual(["audio:4", "audio:6", "commit"]);
    const [first] = committed as Array<{ segmentId: string; previousSegmentId: null }>;
    expect(first?.previousSegmentId).toBeNull();
    expect(transcripts[0]).toEqual({
      segmentId: first?.segmentId,
      transcript: "text 3",
      isFinal: true,
    });
    session.close();
    session.close();
    expect(close).toHaveBeenCalledTimes(1);
  });

  test("a failing commit surfaces as a session error", async () => {
    const stt = createPluginDictationStt(
      {
        hasDictationProvider: () => true,
        startDictationProvider: async () => ({
          appendAudio() {},
          commit: async () => {
            throw new Error("Live call dropped");
          },
          close() {},
        }),
      },
      { pluginId: "p", providerId: "d" },
    );
    const session = stt.createSession({ logger: pino({ level: "silent" }) });
    const errors: unknown[] = [];
    session.on("error", (error) => errors.push(error));
    await session.connect();
    session.commit();
    await vi.waitFor(() => expect(errors).toHaveLength(1));
  });
});
