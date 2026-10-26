import { Readable } from "node:stream";
import type { VoiceSpeakHandler } from "../../voice-types.js";
import { EventEmitter, once } from "node:events";
import pino from "pino";
import { describe, expect, test, vi } from "vitest";

import { VoiceSession, type VoiceSessionHost } from "./voice-session.js";
import type { ManagedAgent } from "../../agent/agent-manager.js";
import type { SessionOutboundMessage } from "../../messages.js";
import type {
  SpeechToTextProvider,
  TextToSpeechProvider,
  StreamingTranscriptionCommittedEvent,
  StreamingTranscriptionEvent,
  StreamingTranscriptionSession,
} from "../../speech/speech-provider.js";
import type {
  TurnDetectionProvider,
  TurnDetectionSession,
} from "../../speech/turn-detection-provider.js";

const VOICE_AGENT_ID = "11111111-1111-4111-8111-111111111111";

class FakeVoiceTurnDetectionSession extends EventEmitter implements TurnDetectionSession {
  public readonly requiredSampleRate = 16000;

  async connect(): Promise<void> {}

  appendPcm16(_chunk: Buffer): void {}

  flush(): void {}
  reset(): void {}
  close(): void {}
}

class FakeVoiceSttSession extends EventEmitter implements StreamingTranscriptionSession {
  public readonly requiredSampleRate = 16000;
  public commitCount = 0;

  async connect(): Promise<void> {}

  appendPcm16(_pcm16le: Buffer): void {}

  commit(): void {
    this.commitCount += 1;
  }

  clear(): void {}
  close(): void {}

  emitCommitted(event: StreamingTranscriptionCommittedEvent): void {
    this.emit("committed", event);
  }

  emitTranscript(event: StreamingTranscriptionEvent): void {
    this.emit("transcript", event);
  }
}

interface FakeVoiceHost extends VoiceSessionHost {
  readonly emitted: SessionOutboundMessage[];
  readonly spokenInput: Array<{ agentId: string; text: string }>;
}

function createFakeHost(): FakeVoiceHost {
  const emitted: SessionOutboundMessage[] = [];
  const spokenInput: Array<{ agentId: string; text: string }> = [];
  return {
    emitted,
    spokenInput,
    emit: (msg) => {
      emitted.push(msg);
    },
    loadAgent: async (agentId) =>
      ({ id: agentId, config: { systemPrompt: undefined } }) as unknown as ManagedAgent,
    reloadAgentSession: async (agentId) => ({ id: agentId }) as unknown as ManagedAgent,
    sendSpokenInput: async (agentId, text) => {
      spokenInput.push({ agentId, text });
    },
    interruptAgentIfRunning: async () => {},
    hasActiveAgentRun: () => false,
  };
}

function createVoiceSession(tts: TextToSpeechProvider | null = null) {
  let speakHandler: VoiceSpeakHandler | undefined;
  const detector = new FakeVoiceTurnDetectionSession();
  const sttSession = new FakeVoiceSttSession();
  const stt: SpeechToTextProvider = {
    id: "local",
    createSession: vi.fn(() => sttSession),
  };
  const turnDetection: TurnDetectionProvider = {
    id: "local",
    createSession: vi.fn(() => detector),
  };
  const host = createFakeHost();
  const voiceSession = new VoiceSession({
    host,
    logger: pino({ level: "silent" }),
    sessionId: "voice-session-test",
    sttLanguage: "en",
    tts,
    voiceBridge: {
      registerVoiceSpeakHandler: (_id, handler) => {
        speakHandler = handler;
      },
    },
    stt,
    voice: { turnDetection },
  });
  return {
    voiceSession,
    detector,
    sttSession,
    host,
    speak: (args: Parameters<VoiceSpeakHandler>[0]) => {
      if (!speakHandler) throw new Error("Voice speak handler not registered");
      return speakHandler(args);
    },
  };
}

function isAudioOutput(message: SessionOutboundMessage): boolean {
  return message.type === "audio_output";
}

async function waitForAudioOutput(host: FakeVoiceHost): Promise<void> {
  await vi.waitFor(() => expect(host.emitted.filter(isAudioOutput)).toHaveLength(1));
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("VoiceSession streaming transcription", () => {
  test("interrupts playback and the agent on speech detection without partial transcripts", async () => {
    const tts: TextToSpeechProvider = {
      async synthesizeSpeech() {
        return { stream: Readable.from([Buffer.from("audio")]), format: "pcm;rate=24000" };
      },
    };
    const { voiceSession, detector, host, speak } = createVoiceSession(tts);
    const interrupted: string[] = [];
    async function recordInterruption(agentId: string) {
      interrupted.push(agentId);
    }
    host.interruptAgentIfRunning = recordInterruption;
    await voiceSession.handleSetVoiceMode(true, VOICE_AGENT_ID);
    const playback = speak({ text: "A spoken response." });
    try {
      await waitForAudioOutput(host);
      detector.emit("speech_started");
      await settle();
      expect(host.emitted).toContainEqual({
        type: "voice_input_state",
        payload: { isSpeaking: true },
      });
      expect(interrupted).toEqual([VOICE_AGENT_ID]);
      await playback;
    } finally {
      await voiceSession.cleanup();
      await playback.catch(() => {});
    }
  });

  test("session abort stops later audio even when the speak tool supplies its own signal", async () => {
    const tts: TextToSpeechProvider = {
      async synthesizeSpeech() {
        return { stream: Readable.from([Buffer.from("audio")]), format: "pcm;rate=24000" };
      },
    };
    const { voiceSession, host, speak } = createVoiceSession(tts);
    const external = new AbortController();
    let abortRequested = false;
    const emit = host.emit;
    function acknowledgeLaterAudio(message: SessionOutboundMessage) {
      emit(message);
      if (message.type === "audio_output" && abortRequested)
        voiceSession.handleAudioPlayed(message.payload.id);
    }
    host.emit = acknowledgeLaterAudio;
    await voiceSession.handleSetVoiceMode(true, VOICE_AGENT_ID);
    const playback = speak({
      text: "First sentence. Second sentence. Third sentence.",
      signal: external.signal,
    });
    try {
      await waitForAudioOutput(host);
      abortRequested = true;
      await voiceSession.handleAbort();
      await playback;
      expect(host.emitted.filter(isAudioOutput)).toHaveLength(1);
      expect(external.signal.aborted).toBe(false);
    } finally {
      external.abort();
      await voiceSession.cleanup();
      await playback.catch(() => {});
    }
  });

  test("surfaces a refused voice-mode agent interruption", async () => {
    const { voiceSession, host } = createVoiceSession();
    host.interruptAgentIfRunning = vi.fn(async () => {
      throw new Error("active run cancellation was not acknowledged");
    });

    await voiceSession.handleSetVoiceMode(true, VOICE_AGENT_ID);

    await expect(voiceSession.handleAbort()).rejects.toThrow(
      "active run cancellation was not acknowledged",
    );
    expect(host.interruptAgentIfRunning).toHaveBeenCalledWith(VOICE_AGENT_ID);
    expect(host.emitted).toContainEqual(
      expect.objectContaining({
        type: "activity_log",
        payload: expect.objectContaining({
          type: "error",
          content: "Voice interruption failed: active run cancellation was not acknowledged",
          metadata: { voiceAbortFailed: true },
        }),
      }),
    );

    await voiceSession.cleanup();
  });

  test("delivers the streaming final transcript to the agent exactly once", async () => {
    const { voiceSession, detector, sttSession, host } = createVoiceSession();

    await voiceSession.handleSetVoiceMode(true, VOICE_AGENT_ID);
    detector.emit("speech_started");
    await settle();
    detector.emit("speech_stopped");
    await settle();
    sttSession.emitCommitted({ segmentId: "segment-1", previousSegmentId: null });
    sttSession.emitTranscript({
      segmentId: "segment-1",
      transcript: "ship the streaming final",
      isFinal: true,
      language: "en",
      avgLogprob: -0.1,
      isLowConfidence: false,
    });
    await settle();

    expect(sttSession.commitCount).toBe(1);
    expect(host.spokenInput).toEqual([
      { agentId: VOICE_AGENT_ID, text: "ship the streaming final" },
    ]);
    expect(host.emitted).toContainEqual(
      expect.objectContaining({
        type: "transcription_result",
        payload: expect.objectContaining({
          text: "ship the streaming final",
          language: "en",
          avgLogprob: -0.1,
        }),
      }),
    );

    await voiceSession.cleanup();
  });

  test("emits an empty transcript on finalization timeout without submitting to the agent", async () => {
    vi.useFakeTimers();
    try {
      const { voiceSession, detector, sttSession, host } = createVoiceSession();

      await voiceSession.handleSetVoiceMode(true, VOICE_AGENT_ID);
      detector.emit("speech_started");
      await settle();
      detector.emit("speech_stopped");
      await settle();
      sttSession.emitCommitted({ segmentId: "segment-1", previousSegmentId: null });

      await vi.advanceTimersByTimeAsync(10_000);
      await settle();

      expect(host.spokenInput).toEqual([]);
      expect(host.emitted).toContainEqual(
        expect.objectContaining({
          type: "transcription_result",
          payload: expect.objectContaining({ text: "" }),
        }),
      );

      await voiceSession.cleanup();
    } finally {
      vi.useRealTimers();
    }
  });

  test("filters a low-confidence streaming final without submitting to the agent", async () => {
    const { voiceSession, detector, sttSession, host } = createVoiceSession();

    await voiceSession.handleSetVoiceMode(true, VOICE_AGENT_ID);
    detector.emit("speech_started");
    await settle();
    detector.emit("speech_stopped");
    await settle();
    sttSession.emitCommitted({ segmentId: "segment-1", previousSegmentId: null });
    sttSession.emitTranscript({
      segmentId: "segment-1",
      transcript: "background noise",
      isFinal: true,
      avgLogprob: -2.5,
      isLowConfidence: true,
    });
    await settle();

    expect(host.spokenInput).toEqual([]);
    expect(host.emitted).toContainEqual(
      expect.objectContaining({
        type: "transcription_result",
        payload: expect.objectContaining({
          text: "",
          avgLogprob: -2.5,
          isLowConfidence: true,
        }),
      }),
    );

    await voiceSession.cleanup();
  });
});

describe("plugin voice", () => {
  function fixture() {
    const host = createFakeHost();
    const interrupt = vi.spyOn(host, "interruptAgentIfRunning");
    const reload = vi.spyOn(host, "reloadAgentSession");
    const close = vi.fn(async () => {});
    const appendAudio = vi.fn();
    let emit: (event: import("@getpaseo/plugin/server").VoiceProviderEvent) => void = () => {};
    const start = vi.fn(async (_selection, context) => {
      emit = context.emit;
      return { close, appendAudio };
    });
    const voice = new VoiceSession({
      host,
      sessionId: "plugin-test",
      logger: pino({ level: "silent" }),
      stt: null,
      tts: null,
      voice: {
        plugin: {
          getSelection: () => ({ pluginId: "test", providerId: "live" }),
          host: { hasVoiceProvider: () => true, startVoiceProvider: start },
        },
      },
    });
    return {
      host,
      voice,
      start,
      close,
      appendAudio,
      reload,
      interrupt,
      emit: (event: import("@getpaseo/plugin/server").VoiceProviderEvent) => emit(event),
    };
  }

  test("routes PCM through the plugin without STT, TTS or agent reload, and speech leaves the job running", async () => {
    const f = fixture();
    await f.voice.handleSetVoiceMode(true, VOICE_AGENT_ID, "start");
    expect(f.voice.isActiveForAgent(VOICE_AGENT_ID)).toBe(true);
    await f.voice.handleAudioChunk({
      type: "voice_audio_chunk",
      audio: "AAABAA==",
      format: "audio/pcm;rate=16000;bits=16",
    });
    expect(f.appendAudio).toHaveBeenCalledWith("AAABAA==");
    f.emit({ type: "speech", isSpeaking: true });
    f.emit({ type: "transcript", role: "user", text: "keep working" });
    f.emit({
      type: "audio",
      audio: "AAABAA==",
      utteranceId: "u",
      chunkIndex: 0,
      isLastChunk: true,
    });
    expect(f.interrupt).not.toHaveBeenCalled();
    expect(f.reload).not.toHaveBeenCalled();
    expect(f.host.spokenInput).toEqual([]);
    expect(f.host.emitted).toContainEqual(
      expect.objectContaining({
        type: "audio_output",
        payload: expect.objectContaining({ format: "pcm" }),
      }),
    );
    await f.voice.handleAbort();
    expect(f.interrupt).toHaveBeenCalledWith(VOICE_AGENT_ID);
    await f.voice.cleanup();
    expect(f.close).toHaveBeenCalledTimes(1);
    expect(f.reload).not.toHaveBeenCalled();
  });

  test("switching agents closes the old provider and ignores its late events", async () => {
    const f = fixture();
    await f.voice.handleSetVoiceMode(true, VOICE_AGENT_ID);
    const oldEmit = f.start.mock.calls[0][1].emit;
    await f.voice.handleSetVoiceMode(true, "22222222-2222-4222-8222-222222222222");
    const count = f.host.emitted.length;
    oldEmit({ type: "speech", isSpeaking: true });
    expect(f.host.emitted).toHaveLength(count);
    expect(f.close).toHaveBeenCalledTimes(1);
    await f.voice.cleanup();
    expect(f.close).toHaveBeenCalledTimes(2);
  });

  test("unload releases demand, reports session end and stops input", async () => {
    const f = fixture();
    await f.voice.handleSetVoiceMode(true, VOICE_AGENT_ID);
    f.emit({ type: "closed", error: "Plugin stopped" });
    expect(f.voice.hasDemand).toBe(false);
    expect(f.voice.isActiveForAgent(VOICE_AGENT_ID)).toBe(false);
    expect(f.host.emitted).toContainEqual({
      type: "voice_input_state",
      payload: { isSpeaking: false, sessionEnded: true, error: "Plugin stopped" },
    });
    await f.voice.cleanup();
    expect(f.close).toHaveBeenCalledTimes(1);
  });

  test("disconnect during bootstrap aborts the provider and closes a late session", async () => {
    const f = fixture();
    let finish:
      | ((value: { close: typeof f.close; appendAudio: typeof f.appendAudio }) => void)
      | undefined;
    f.start.mockImplementationOnce(async (_selection, context) => {
      expect(context.signal.aborted).toBe(false);
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    const starting = f.voice.handleSetVoiceMode(true, VOICE_AGENT_ID, "start");
    await vi.waitFor(() => expect(finish).toBeDefined());
    f.voice.cancel();
    expect(f.start.mock.calls[0][1].signal.aborted).toBe(true);
    finish!({ close: f.close, appendAudio: f.appendAudio });
    await starting;
    await f.voice.cleanup();
    expect(f.close).toHaveBeenCalledTimes(1);
    expect(f.host.emitted).toEqual([]);
  });

  test("stop interrupts pending bootstrap before the transition queue drains", async () => {
    const f = fixture();
    f.start.mockImplementationOnce(async (_selection, context) => {
      await once(context.signal, "abort");
      return { close: f.close, appendAudio: f.appendAudio };
    });
    const starting = f.voice.handleSetVoiceMode(true, VOICE_AGENT_ID, "start");
    await vi.waitFor(() => expect(f.start).toHaveBeenCalled());
    const stopping = f.voice.handleSetVoiceMode(false, undefined, "stop");
    expect(f.start.mock.calls[0][1].signal.aborted).toBe(true);
    await starting;
    await stopping;
    expect(f.voice.hasDemand).toBe(false);
    expect(f.close).toHaveBeenCalledTimes(1);
    expect(f.interrupt).not.toHaveBeenCalled();
    await f.voice.cleanup();
  });
});
