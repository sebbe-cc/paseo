import { selectVoiceTarget, toggleGlobalVoice } from "./global-voice-controller";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DaemonServerInfo } from "@/stores/session-store";
import type { AudioEngine } from "@/audio";
import { createVoiceRuntime, type VoiceSessionAdapter } from "@/voice/voice-runtime";
import { REALTIME_VOICE_VAD_CONFIG } from "@/voice/realtime-voice-config";

const CUE_MIME_TYPE = "audio/pcm;rate=16000;bits=16";
const THINKING_TONE_MIN_SILENCE_MS = 1500;
const SEGMENT_MIME_TYPE = "audio/pcm;rate=24000;bits=16";

function createAudioEngineMock(): AudioEngine {
  return {
    initialize: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn().mockResolvedValue(undefined),
    startCapture: vi.fn().mockResolvedValue(undefined),
    stopCapture: vi.fn().mockResolvedValue(undefined),
    toggleMute: vi.fn().mockReturnValue(true),
    isMuted: vi.fn().mockReturnValue(false),
    play: vi.fn().mockResolvedValue(0.1),
    stop: vi.fn(),
    clearQueue: vi.fn(),
    isPlaying: vi.fn().mockReturnValue(false),
  };
}

function createSessionAdapter(serverId = "server-1"): VoiceSessionAdapter {
  return {
    serverId,
    setVoiceMode: vi.fn().mockResolvedValue(undefined),
    sendVoiceAudioChunk: vi.fn().mockResolvedValue(undefined),
    audioPlayed: vi.fn().mockResolvedValue(undefined),
    abortRequest: vi.fn().mockResolvedValue(undefined),
    setAssistantAudioPlaying: vi.fn(),
  };
}

function createAudioPayload(args: {
  id: string;
  groupId: string;
  chunkIndex: number;
  isLastChunk: boolean;
  isVoiceMode?: boolean;
}) {
  return {
    id: args.id,
    groupId: args.groupId,
    chunkIndex: args.chunkIndex,
    isLastChunk: args.isLastChunk,
    isVoiceMode: args.isVoiceMode ?? true,
    format: "pcm",
    audio: Buffer.from(`chunk-${args.chunkIndex}`).toString("base64"),
  } as const;
}

function createServerInfo(): DaemonServerInfo {
  return {
    serverId: "server-1",
    hostname: "host",
    version: "1.0.0",
    capabilities: {
      voice: {
        dictation: { enabled: true, reason: "" },
        voice: { enabled: true, reason: "" },
      },
    },
  };
}

function createRuntime(options?: {
  engine?: AudioEngine;
  getServerInfo?: (serverId: string) => DaemonServerInfo | null;
  isThinkingToneEnabled?: () => boolean;
}) {
  const engine = options?.engine ?? createAudioEngineMock();
  const runtime = createVoiceRuntime({
    engine,
    getServerInfo: options?.getServerInfo ?? (() => createServerInfo()),
    isThinkingToneEnabled: options?.isThinkingToneEnabled,
    activateKeepAwake: vi.fn().mockResolvedValue(undefined),
    deactivateKeepAwake: vi.fn().mockResolvedValue(undefined),
  });

  return { runtime, engine };
}

describe("voice runtime", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts voice when adapter is ready", async () => {
    const adapter = createSessionAdapter();
    const { runtime, engine } = createRuntime();
    runtime.registerSession(adapter);

    await runtime.startVoice("server-1", "agent-1");

    expect(engine.initialize).toHaveBeenCalled();
    expect(adapter.setVoiceMode).toHaveBeenCalledWith(true, "agent-1");
    expect(engine.startCapture).toHaveBeenCalled();
    expect(runtime.getSnapshot()).toMatchObject({
      phase: "listening",
      isVoiceMode: true,
      activeServerId: "server-1",
      activeAgentId: "agent-1",
    });
  });

  it("streams continuous PCM chunks and waits after receiving a transcript", async () => {
    const adapter = createSessionAdapter();
    const { runtime } = createRuntime();
    runtime.registerSession(adapter);

    await runtime.startVoice("server-1", "agent-1");
    runtime.handleCapturePcm(new Uint8Array(32000));
    expect(runtime.getSnapshot().phase).toBe("listening");

    expect(adapter.sendVoiceAudioChunk).toHaveBeenLastCalledWith(
      expect.any(String),
      "audio/pcm;rate=16000;bits=16",
    );

    runtime.onTranscriptionResult("server-1", "hello");
    expect(runtime.getSnapshot().phase).toBe("waiting");
  });

  it("moves from listening to playing on the first assistant audio", async () => {
    const adapter = createSessionAdapter();
    const { runtime, engine: _engine } = createRuntime();
    runtime.registerSession(adapter);

    await runtime.startVoice("server-1", "agent-1");
    runtime.onAssistantAudioStarted("server-1");

    expect(runtime.getSnapshot().phase).toBe("playing");
    expect(adapter.setAssistantAudioPlaying).toHaveBeenCalledWith(true);
  });

  it("starts playback on the first chunk before isLastChunk arrives", async () => {
    const adapter = createSessionAdapter();
    let resolvePlay!: (duration: number) => void;
    const engine = createAudioEngineMock();
    vi.mocked(engine.play).mockImplementation(
      () =>
        new Promise<number>((resolve) => {
          resolvePlay = resolve;
        }),
    );
    const { runtime } = createRuntime({ engine });
    runtime.registerSession(adapter);

    await runtime.startVoice("server-1", "agent-1");
    runtime.onTurnEvent("server-1", "agent-1", "turn_started");
    vi.mocked(engine.play).mockClear();

    runtime.handleAudioOutput(
      "server-1",
      createAudioPayload({
        id: "chunk-0",
        groupId: "group-1",
        chunkIndex: 0,
        isLastChunk: false,
      }),
    );

    await vi.waitFor(() => {
      expect(engine.play).toHaveBeenCalledTimes(1);
      expect(runtime.getSnapshot().phase).toBe("playing");
      expect(adapter.audioPlayed).not.toHaveBeenCalled();
    });

    runtime.handleAudioOutput(
      "server-1",
      createAudioPayload({
        id: "chunk-1",
        groupId: "group-1",
        chunkIndex: 1,
        isLastChunk: true,
      }),
    );

    expect(engine.play).toHaveBeenCalledTimes(1);
    resolvePlay(0.1);

    await vi.waitFor(() => {
      expect(adapter.audioPlayed).toHaveBeenCalledWith("chunk-0");
      expect(engine.play).toHaveBeenCalledTimes(2);
    });
  });

  it("acknowledges chunks only after they are consumed and finishes after the final chunk", async () => {
    const adapter = createSessionAdapter();
    const playResolvers: Array<(duration: number) => void> = [];
    const engine = createAudioEngineMock();
    vi.mocked(engine.play).mockImplementation(
      () =>
        new Promise<number>((resolve) => {
          playResolvers.push(resolve);
        }),
    );
    const { runtime } = createRuntime({ engine });
    runtime.registerSession(adapter);

    await runtime.startVoice("server-1", "agent-1");
    runtime.onTurnEvent("server-1", "agent-1", "turn_started");
    vi.mocked(engine.play).mockClear();
    playResolvers.length = 0;

    runtime.handleAudioOutput(
      "server-1",
      createAudioPayload({
        id: "chunk-0",
        groupId: "group-1",
        chunkIndex: 0,
        isLastChunk: false,
      }),
    );
    runtime.handleAudioOutput(
      "server-1",
      createAudioPayload({
        id: "chunk-1",
        groupId: "group-1",
        chunkIndex: 1,
        isLastChunk: true,
      }),
    );

    await vi.waitFor(() => {
      expect(engine.play).toHaveBeenCalledTimes(1);
    });
    expect(adapter.audioPlayed).not.toHaveBeenCalled();

    playResolvers.shift()!(0.1);
    await vi.waitFor(() => {
      expect(adapter.audioPlayed).toHaveBeenCalledWith("chunk-0");
      expect(engine.play).toHaveBeenCalledTimes(2);
    });

    playResolvers.shift()!(0.1);
    await vi.waitFor(() => {
      expect(adapter.audioPlayed).toHaveBeenCalledWith("chunk-1");
      expect(runtime.getSnapshot().phase).toBe("waiting");
    });
  });

  it("leaves playback phase unchanged after assistant playback while the turn is still active", async () => {
    const adapter = createSessionAdapter();
    const { runtime, engine } = createRuntime();
    runtime.registerSession(adapter);

    await runtime.startVoice("server-1", "agent-1");
    runtime.onTurnEvent("server-1", "agent-1", "turn_started");
    runtime.onAssistantAudioStarted("server-1");
    runtime.onAssistantAudioFinished("server-1");

    expect(runtime.getSnapshot().phase).toBe("waiting");
    await vi.advanceTimersByTimeAsync(THINKING_TONE_MIN_SILENCE_MS);
    expect(engine.play).toHaveBeenCalled();
  });

  it("starts the thinking tone once the wait for a reply outlasts an inter-segment gap", async () => {
    const adapter = createSessionAdapter();
    const { runtime, engine } = createRuntime();
    runtime.registerSession(adapter);

    await runtime.startVoice("server-1", "agent-1");
    runtime.onTurnEvent("server-1", "agent-1", "turn_started");

    expect(runtime.getSnapshot().phase).toBe("waiting");
    await vi.advanceTimersByTimeAsync(THINKING_TONE_MIN_SILENCE_MS - 1);
    expect(engine.play).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(engine.play).toHaveBeenCalled();
  });

  it("stays silent while waiting when the thinking tone setting is off", async () => {
    const adapter = createSessionAdapter();
    const { runtime, engine } = createRuntime({ isThinkingToneEnabled: () => false });
    runtime.registerSession(adapter);

    await runtime.startVoice("server-1", "agent-1");
    runtime.onTurnEvent("server-1", "agent-1", "turn_started");

    expect(runtime.getSnapshot().phase).toBe("waiting");
    await vi.advanceTimersByTimeAsync(THINKING_TONE_MIN_SILENCE_MS * 4);
    expect(engine.play).not.toHaveBeenCalled();
  });

  it("does not restart the thinking tone from local detection jitter while waiting", async () => {
    const adapter = createSessionAdapter();
    let resolvePlay!: (duration: number) => void;
    const engine = createAudioEngineMock();
    vi.mocked(engine.play).mockImplementation(
      () =>
        new Promise<number>((resolve) => {
          resolvePlay = resolve;
        }),
    );
    const { runtime } = createRuntime({ engine });
    runtime.registerSession(adapter);

    await runtime.startVoice("server-1", "agent-1");
    runtime.onTurnEvent("server-1", "agent-1", "turn_started");

    expect(runtime.getSnapshot().phase).toBe("waiting");
    await vi.advanceTimersByTimeAsync(THINKING_TONE_MIN_SILENCE_MS);
    expect(engine.play).toHaveBeenCalledTimes(1);
    vi.mocked(engine.stop).mockClear();
    vi.mocked(engine.clearQueue).mockClear();

    runtime.handleCaptureVolume(REALTIME_VOICE_VAD_CONFIG.volumeThreshold + 0.05);
    runtime.handleCaptureVolume(0);

    expect(engine.stop).not.toHaveBeenCalled();
    expect(engine.clearQueue).not.toHaveBeenCalled();
    expect(engine.play).toHaveBeenCalledTimes(1);

    runtime.onServerSpeechStateChanged("server-1", true);

    expect(engine.stop).not.toHaveBeenCalled();
    expect(engine.clearQueue).not.toHaveBeenCalled();
    expect(vi.mocked(engine.play).mock.calls[0][1]?.aborted).toBe(true);

    resolvePlay(0.1);
  });

  it("does not play the thinking tone in the gap between two segments of one reply", async () => {
    const adapter = createSessionAdapter();
    const engine = createAudioEngineMock();
    const played: string[] = [];
    vi.mocked(engine.play).mockImplementation(async (source: { type: string }) => {
      played.push(source.type);
      return 0.1;
    });
    const { runtime } = createRuntime({ engine });
    runtime.registerSession(adapter);

    await runtime.startVoice("server-1", "agent-1");
    runtime.onTurnEvent("server-1", "agent-1", "turn_started");

    runtime.handleAudioOutput(
      "server-1",
      createAudioPayload({
        id: "seg-1-chunk-0",
        groupId: "seg-1",
        chunkIndex: 0,
        isLastChunk: true,
      }),
    );
    await vi.waitFor(() => {
      expect(runtime.getSnapshot().phase).toBe("waiting");
    });

    await vi.advanceTimersByTimeAsync(400);

    runtime.handleAudioOutput(
      "server-1",
      createAudioPayload({
        id: "seg-2-chunk-0",
        groupId: "seg-2",
        chunkIndex: 0,
        isLastChunk: true,
      }),
    );
    await vi.waitFor(() => {
      expect(played).toContain(SEGMENT_MIME_TYPE);
    });

    const replyStart = played.indexOf(SEGMENT_MIME_TYPE);
    expect(replyStart).toBeGreaterThanOrEqual(0);
    expect(played.slice(replyStart).filter((type) => type === CUE_MIME_TYPE)).toEqual([]);
  });

  it("returns to listening after assistant playback once the turn is complete", async () => {
    const adapter = createSessionAdapter();
    const { runtime, engine } = createRuntime();
    runtime.registerSession(adapter);

    await runtime.startVoice("server-1", "agent-1");
    runtime.onTurnEvent("server-1", "agent-1", "turn_started");
    await vi.advanceTimersByTimeAsync(THINKING_TONE_MIN_SILENCE_MS);
    runtime.onAssistantAudioStarted("server-1");
    runtime.onTurnEvent("server-1", "agent-1", "turn_completed");
    runtime.onAssistantAudioFinished("server-1");

    expect(runtime.getSnapshot().phase).toBe("listening");
    expect(engine.play).toHaveBeenCalled();
  });

  it("keeps local volume alone non-authoritative for playback interruption", async () => {
    const adapter = createSessionAdapter();
    const { runtime, engine } = createRuntime();
    runtime.registerSession(adapter);

    await runtime.startVoice("server-1", "agent-1");
    runtime.onTurnEvent("server-1", "agent-1", "turn_started");
    runtime.onAssistantAudioStarted("server-1");
    vi.mocked(engine.stop).mockClear();
    vi.mocked(engine.clearQueue).mockClear();

    runtime.handleCaptureVolume(0.5);
    expect(runtime.getTelemetrySnapshot().isSpeaking).toBe(false);
    expect(adapter.abortRequest).not.toHaveBeenCalled();
    expect(runtime.getSnapshot().phase).toBe("playing");
  });

  it("keeps the meter white state driven by server speech detection", async () => {
    const adapter = createSessionAdapter();
    const { runtime } = createRuntime();
    runtime.registerSession(adapter);

    await runtime.startVoice("server-1", "agent-1");
    runtime.handleCaptureVolume(0.7);

    expect(runtime.getTelemetrySnapshot()).toMatchObject({
      volume: expect.any(Number),
      isSpeaking: false,
    });

    runtime.onServerSpeechStateChanged("server-1", true);
    expect(runtime.getTelemetrySnapshot().isSpeaking).toBe(true);

    runtime.onServerSpeechStateChanged("server-1", false);
    expect(runtime.getTelemetrySnapshot().isSpeaking).toBe(false);
  });

  it("stops assistant playback immediately when server speech starts", async () => {
    const adapter = createSessionAdapter();
    const { runtime, engine } = createRuntime();
    runtime.registerSession(adapter);

    await runtime.startVoice("server-1", "agent-1");
    runtime.onAssistantAudioStarted("server-1");

    runtime.onServerSpeechStateChanged("server-1", true);

    expect(engine.stop).toHaveBeenCalled();
    expect(engine.clearQueue).toHaveBeenCalled();
    expect(adapter.setAssistantAudioPlaying).toHaveBeenCalledWith(false);
    expect(runtime.getTelemetrySnapshot().isSpeaking).toBe(true);
  });

  it("drops queued voice chunks that arrive after server speech interrupts playback", async () => {
    const adapter = createSessionAdapter();
    const { runtime, engine } = createRuntime();
    runtime.registerSession(adapter);

    await runtime.startVoice("server-1", "agent-1");
    runtime.onTurnEvent("server-1", "agent-1", "turn_started");
    vi.mocked(engine.play).mockClear();

    runtime.handleAudioOutput(
      "server-1",
      createAudioPayload({
        id: "chunk-0",
        groupId: "group-1",
        chunkIndex: 0,
        isLastChunk: false,
      }),
    );
    await vi.waitFor(() => {
      expect(engine.play).toHaveBeenCalledTimes(1);
    });

    runtime.onServerSpeechStateChanged("server-1", true);
    runtime.handleAudioOutput(
      "server-1",
      createAudioPayload({
        id: "chunk-1",
        groupId: "group-1",
        chunkIndex: 1,
        isLastChunk: true,
      }),
    );

    expect(engine.stop).toHaveBeenCalled();
    expect(engine.clearQueue).toHaveBeenCalled();
    expect(vi.mocked(adapter.audioPlayed).mock.calls.flat()).not.toContain("chunk-1");
  });

  it("authoritatively stops and suppresses later voice audio", async () => {
    const adapter = createSessionAdapter();
    const { runtime, engine } = createRuntime();
    runtime.registerSession(adapter);

    await runtime.startVoice("server-1", "agent-1");
    await runtime.stopVoice();

    expect(adapter.setVoiceMode).toHaveBeenLastCalledWith(false);
    expect(engine.stopCapture).toHaveBeenCalled();
    expect(runtime.getSnapshot().phase).toBe("disabled");
    expect(runtime.shouldPlayVoiceAudio("server-1")).toBe(false);
  });

  it("rolls daemon voice mode back when capture fails after enabling it", async () => {
    const adapter = createSessionAdapter();
    const engine = createAudioEngineMock();
    vi.mocked(engine.startCapture).mockRejectedValue(new Error("audio focus unavailable"));
    const { runtime } = createRuntime({ engine });
    runtime.registerSession(adapter);

    await expect(runtime.startVoice("server-1", "agent-1")).rejects.toThrow(
      "audio focus unavailable",
    );

    expect(adapter.setVoiceMode).toHaveBeenNthCalledWith(1, true, "agent-1");
    expect(adapter.setVoiceMode).toHaveBeenNthCalledWith(2, false);
    expect(runtime.getSnapshot().phase).toBe("disabled");
  });

  it("returns an explicit not-ready error when the adapter is missing", async () => {
    const { runtime } = createRuntime();
    await expect(runtime.startVoice("server-1", "agent-1")).rejects.toThrow(
      "Voice runtime is not ready for host server-1",
    );
  });

  it("resyncs voice mode after connection recovers", async () => {
    const adapter = createSessionAdapter();
    const { runtime } = createRuntime();
    runtime.registerSession(adapter);

    await runtime.startVoice("server-1", "agent-1");
    vi.mocked(adapter.setVoiceMode).mockClear();

    runtime.updateSessionConnection("server-1", false);
    runtime.updateSessionConnection("server-1", true);
    await Promise.resolve();

    expect(adapter.setVoiceMode).toHaveBeenCalledWith(true, "agent-1");
  });

  it("does not emit when the snapshot is unchanged", async () => {
    const adapter = createSessionAdapter();
    const { runtime } = createRuntime();
    runtime.registerSession(adapter);
    await runtime.startVoice("server-1", "agent-1");

    const listener = vi.fn();
    const unsubscribe = runtime.subscribe(listener);

    runtime.handleCaptureVolume(0);
    runtime.handleCaptureVolume(0);

    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });
});

describe("plugin voice lifetime", () => {
  it("ignores a failed old reconnect after a new agent starts voice", async () => {
    const adapter = createSessionAdapter();
    const { runtime, engine } = createRuntime();
    runtime.registerSession(adapter);
    await runtime.startVoice("server-1", "agent-1");
    let rejectReconnect: ((error: Error) => void) | undefined;
    vi.mocked(adapter.setVoiceMode).mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          rejectReconnect = reject;
        }),
    );
    runtime.updateSessionConnection("server-1", false);
    runtime.updateSessionConnection("server-1", true);
    await runtime.startVoice("server-1", "agent-2");
    vi.mocked(engine.stopCapture).mockClear();
    rejectReconnect!(new Error("old call failed"));
    await Promise.resolve();
    await Promise.resolve();
    expect(runtime.getSnapshot().activeAgentId).toBe("agent-2");
    expect(runtime.getSnapshot().phase).toBe("listening");
    expect(engine.stopCapture).not.toHaveBeenCalled();
    await runtime.destroy();
  });

  it("stops capture when the provider ends during a pending microphone start", async () => {
    const engine = createAudioEngineMock();
    let finish: (() => void) | undefined;
    vi.mocked(engine.startCapture).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const adapter = createSessionAdapter();
    const { runtime } = createRuntime({ engine });
    runtime.registerSession(adapter);
    const starting = runtime.startVoice("server-1", "agent-1");
    await vi.waitFor(() => expect(finish).toBeDefined());
    const ending = runtime.onSessionEnded("server-1");
    runtime.handleCapturePcm(new Uint8Array(3200));
    expect(adapter.sendVoiceAudioChunk).not.toHaveBeenCalled();
    finish!();
    await starting;
    await ending;
    expect(engine.stopCapture).toHaveBeenCalled();
    expect(runtime.getSnapshot().phase).toBe("disabled");
  });

  it("gates plugin voice once before microphone capture", async () => {
    const info = createServerInfo();
    info.capabilities!.voice!.provider = { pluginId: "live", providerId: "live" };
    const { runtime, engine } = createRuntime({ getServerInfo: () => info });
    runtime.registerSession(createSessionAdapter());
    await expect(runtime.startVoice("server-1", "agent-1")).rejects.toThrow("Update the host");
    expect(engine.startCapture).not.toHaveBeenCalled();
    info.features = { pluginVoiceProviders: true };
    await runtime.startVoice("server-1", "agent-1");
    runtime.onTurnEvent("server-1", "agent-1", "turn_started");
    expect(runtime.getSnapshot().phase).toBe("listening");
    await runtime.destroy();
  });

  it("feeds Live packets ahead of playback completion and wakes a waiting stream on interruption", async () => {
    const info = createServerInfo();
    info.capabilities!.voice!.provider = { pluginId: "live", providerId: "live" };
    info.features = { pluginVoiceProviders: true };
    const engine = createAudioEngineMock();
    const chunks: import("@/audio/audio-engine-types").AudioPlaybackStreamChunk[] = [];
    let finished = false;
    const controller = new AbortController();
    vi.mocked(engine.play).mockImplementation(async (source) => {
      if (!source.stream) throw new Error("Expected continuous PCM playback");
      for await (const chunk of source.stream(controller.signal)) chunks.push(chunk);
      finished = true;
      return 0.2;
    });
    vi.mocked(engine.stop).mockImplementation(() => controller.abort());
    const adapter = createSessionAdapter();
    const { runtime } = createRuntime({ engine, getServerInfo: () => info });
    runtime.registerSession(adapter);
    await runtime.startVoice("server-1", "agent-1");
    runtime.handleAudioOutput(
      "server-1",
      createAudioPayload({ id: "first", groupId: "live", chunkIndex: 0, isLastChunk: false }),
    );
    await vi.waitFor(() => expect(chunks).toHaveLength(1));
    runtime.handleAudioOutput(
      "server-1",
      createAudioPayload({ id: "second", groupId: "live", chunkIndex: 1, isLastChunk: false }),
    );
    await vi.waitFor(() => expect(chunks).toHaveLength(2));
    expect(engine.play).toHaveBeenCalledTimes(1);
    expect(adapter.audioPlayed).not.toHaveBeenCalled();
    chunks[0].onPlayed();
    expect(adapter.audioPlayed).toHaveBeenCalledWith("first");
    runtime.onServerSpeechStateChanged("server-1", true);
    await vi.waitFor(() => expect(finished).toBe(true));
    chunks[1].onPlayed();
    expect(adapter.audioPlayed).not.toHaveBeenCalledWith("second");
    expect(adapter.abortRequest).not.toHaveBeenCalled();
    await runtime.destroy();
  });
});

describe("selected global voice target", () => {
  it("keeps selection separate from activation and never cancels a running agent during a switch", async () => {
    const { runtime, engine } = createRuntime();
    const adapter = createSessionAdapter();
    runtime.registerSession(adapter);
    const save = vi.fn();
    const king = { serverId: "server-1", agentId: "king", title: "King" };
    const chat = { serverId: "server-1", agentId: "chat", title: "Working chat" };
    await selectVoiceTarget(runtime, king, save);
    expect(save).toHaveBeenCalledWith(king);
    expect(engine.startCapture).not.toHaveBeenCalled();
    await toggleGlobalVoice(runtime, king);
    await selectVoiceTarget(runtime, chat, save);
    expect(runtime.isVoiceModeForAgent("server-1", "chat")).toBe(true);
    expect(adapter.abortRequest).not.toHaveBeenCalled();
    expect(adapter.setVoiceMode).toHaveBeenCalledWith(false);
    expect(engine.clearQueue).toHaveBeenCalled();
    await toggleGlobalVoice(runtime, chat);
    expect(runtime.getSnapshot().isVoiceMode).toBe(false);
    expect(adapter.abortRequest).not.toHaveBeenCalled();
    await runtime.destroy();
  });
  it("publishes the recipient after a direct chat start", async () => {
    const engine = createAudioEngineMock();
    const changed = vi.fn();
    const runtime = createVoiceRuntime({
      engine,
      onTargetChanged: changed,
      getServerInfo: () => createServerInfo(),
      activateKeepAwake: async () => {},
      deactivateKeepAwake: async () => {},
    });
    runtime.registerSession(createSessionAdapter());
    await runtime.startVoice("server-1", "chat");
    expect(changed).toHaveBeenCalledWith("server-1", "chat");
    await runtime.destroy();
  });
  it("does not start a different host when the selected host is disconnected", async () => {
    const { runtime, engine } = createRuntime();
    runtime.registerSession(createSessionAdapter());
    await expect(
      toggleGlobalVoice(runtime, { serverId: "offline", agentId: "king", title: "King" }),
    ).rejects.toThrow("not ready");
    expect(engine.startCapture).not.toHaveBeenCalled();
    await runtime.destroy();
  });
});
