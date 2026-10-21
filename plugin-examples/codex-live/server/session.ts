import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { VoiceProviderSession, VoiceProviderStartContext } from "@getpaseo/plugin/server";
import type { nonstandard } from "@roamhq/wrtc";
import { createDelegations } from "./delegation";
import { createInputAudio, createOutputAudio } from "./audio";
import type { VoiceSchema } from "../shared/preferences";

const SinkDataSchema = z.object({
  samples: z.instanceof(Int16Array),
  sampleRate: z.number(),
  channelCount: z.number().int().positive(),
});
const EventSchema = z.object({ type: z.string() }).passthrough();
const TurnSchema = z.object({
  turn: z.object({ role: z.enum(["user", "assistant"]), transcript: z.string() }),
});

export async function startCodexLive(
  context: VoiceProviderStartContext,
  voice: z.infer<typeof VoiceSchema>,
): Promise<VoiceProviderSession> {
  const require = createRequire(path.join(context.directory, "package.json"));
  const wrtc: typeof import("@roamhq/wrtc") = require("@roamhq/wrtc");
  const WebSocket: typeof import("ws").default = require("ws");
  const keyFile = process.env.CODEX_LIVE_API_KEY_FILE;
  if (!keyFile) throw new Error("Set CODEX_LIVE_API_KEY_FILE on the daemon");
  const apiKey = (await readFile(keyFile, "utf8")).trim();
  if (!apiKey) throw new Error("The Live API key file is empty");
  const base = new URL(process.env.CODEX_LIVE_BASE_URL ?? "http://127.0.0.1:8083/v1/");
  if (!base.pathname.endsWith("/")) base.pathname += "/";
  const headers = { Authorization: `Bearer ${apiKey}`, "OpenAI-Alpha": "quicksilver=v2" };
  const abort = new AbortController();
  const signal = AbortSignal.any([context.signal, abort.signal, AbortSignal.timeout(25_000)]);
  const peer = new wrtc.RTCPeerConnection();
  const source = new wrtc.nonstandard.RTCAudioSource();
  const track = source.createTrack();
  peer.addTrack(track);
  const data = peer.createDataChannel("oai-events");
  let sideband: InstanceType<typeof WebSocket> | null = null;
  let sink: nonstandard.RTCAudioSink | null = null;
  let pump: ReturnType<typeof setInterval> | null = null;
  let callURL: URL | null = null;
  let closing: Promise<void> | null = null;
  let stopped = false;
  let started = false;
  let stage = "agent observation";
  let failureReason = "";
  const output = createOutputAudio(context.emit);
  const input = createInputAudio(context.emit, () => output.clear());
  const delegations = createDelegations({
    paseo: context.paseo,
    agentId: context.agentId,
    send(message) {
      if (!sideband || sideband.readyState !== WebSocket.OPEN)
        throw new Error("Live control channel is closed");
      if (sideband.bufferedAmount > 256_000) throw new Error("Live control channel is congested");
      sideband.send(JSON.stringify(message));
    },
    fail() {
      fail("Agent observation was lost. Start voice again.");
    },
  });

  function close(): Promise<void> {
    if (closing) return closing;
    stopped = true;
    abort.abort();
    context.signal.removeEventListener("abort", onAbort);
    if (pump) clearInterval(pump);
    input.clear();
    output.clear();
    delegations.close();
    sink?.stop();
    track.stop();
    closing = (async () => {
      try {
        // CPA removes the call when sideband disconnects. Hang up first.
        if (callURL)
          await fetch(new URL(callURL.href + "/hangup"), {
            method: "POST",
            headers,
            redirect: "error",
            signal: AbortSignal.timeout(1500),
          });
      } finally {
        sideband?.terminate();
        data.close();
        peer.close();
      }
    })();
    return closing;
  }
  function onAbort() {
    void close().catch(() => undefined);
  }
  function fail(message: string) {
    if (stopped) return;
    failureReason = message;
    context.emit({ type: "closed", error: message });
    void close().catch(() => undefined);
  }
  context.signal.addEventListener("abort", onAbort, { once: true });

  async function event(raw: string, control: boolean) {
    const parsed = EventSchema.parse(JSON.parse(raw));
    if (parsed.type === "session.started") started = true;
    if (parsed.type === "error") throw new Error("Live protocol error");
    // Both channels mirror transcript events; the media channel owns transcripts.
    if (parsed.type === "turn.done" && !control) {
      const { turn } = TurnSchema.parse(parsed);
      context.emit({ type: "transcript", role: turn.role, text: turn.transcript });
    }
    if (parsed.type === "delegation.created" && control) await delegations.accept(parsed);
  }
  data.addEventListener("message", (message) => {
    void event(String(message.data), false).catch(() => fail("Live event processing failed"));
  });
  data.addEventListener("close", () => fail("Live event channel closed. Start voice again."));
  peer.onconnectionstatechange = () => {
    if (peer.connectionState === "failed" || peer.connectionState === "disconnected")
      fail("Live media connection was lost. Start voice again.");
  };
  peer.ontrack = (message) => {
    sink = new wrtc.nonstandard.RTCAudioSink(message.track);
    sink.ondata = (raw: unknown) => {
      if (stopped || input.speaking) return;
      try {
        const audio = SinkDataSchema.parse(raw);
        output.append(audio.samples, audio.sampleRate, audio.channelCount);
      } catch {
        fail("Live audio decoding failed");
      }
    };
  };
  async function waitFor(predicate: () => boolean) {
    while (!predicate()) {
      signal.throwIfAborted();
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    }
  }
  try {
    signal.throwIfAborted();
    let observationReady = false;
    let observationError: unknown;
    void delegations.ready.then(
      () => {
        observationReady = true;
        return undefined;
      },
      (error) => {
        observationError = error;
        observationReady = true;
        return undefined;
      },
    );
    await waitFor(() => observationReady);
    if (observationError) throw observationError;
    stage = "ICE gathering";
    await peer.setLocalDescription(await peer.createOffer());
    await waitFor(() => peer.iceGatheringState === "complete");
    const sdp = peer.localDescription?.sdp;
    if (!sdp) throw new Error("No WebRTC offer");
    const form = new FormData();
    form.set("sdp", sdp);
    form.set(
      "session",
      JSON.stringify({
        model: "gpt-live-1-codex",
        instructions:
          "You are the voice frontend for the selected Paseo coding agent. For coding, workspace actions, status and changes of plan, delegate to the client. You cannot inspect files yourself. Wait for the delegated agent's result before reporting any file contents, status or verification phrase. Never invent an example result while waiting. Användaren talar med dig på svenska eller engelska, aldrig något annat språk. Speak concise answers in the user's language. Read the agent's updates accurately. Talking interrupts speech, not the coding agent's job. Never claim a job was cancelled unless the agent reports it.",
        audio: { output: { voice } },
        delegation: { type: "client" },
      }),
    );
    stage = "call bootstrap";
    const response = await fetch(new URL("realtime/calls", base), {
      method: "POST",
      headers,
      body: form,
      redirect: "error",
      signal,
    });
    if (!response.ok) {
      stage = `call bootstrap HTTP ${response.status}`;
      throw new Error("Live bootstrap failed");
    }
    const location = response.headers.get("location");
    if (!location) throw new Error("Live bootstrap omitted call ID");
    callURL = new URL(location, base);
    if (
      callURL.origin !== base.origin ||
      !/\/realtime\/calls\/[a-zA-Z0-9_-]+$/.test(callURL.pathname)
    )
      throw new Error("Invalid Live call location");
    const callId = callURL.pathname.split("/").at(-1);
    const wsURL = new URL(`live/${callId}`, base);
    wsURL.protocol = base.protocol === "https:" ? "wss:" : "ws:";
    stage = "control channel";
    sideband = new WebSocket(wsURL, { headers, handshakeTimeout: 10_000, maxPayload: 1_048_576 });
    sideband.on("error", () => fail("Live control channel failed"));
    sideband.on("close", () => fail("Live control channel closed. Start voice again."));
    sideband.on("message", (raw) => {
      void event(raw.toString(), true).catch(() => fail("Live control event failed"));
    });
    await waitFor(() => sideband?.readyState === WebSocket.OPEN);
    stage = "setting remote media description";
    await peer.setRemoteDescription({ type: "answer", sdp: await response.text() });
    stage = "media connection";
    await waitFor(() => started && peer.connectionState === "connected");
    // No microphone audio leaves until both the sideband and media are ready.
    pump = setInterval(() => {
      if (stopped) return;
      try {
        source.onData({
          samples: input.frame(),
          sampleRate: 16_000,
          bitsPerSample: 16,
          channelCount: 1,
          numberOfFrames: 160,
        });
      } catch {
        fail("Live audio sending failed");
      }
    }, 10);
    return {
      appendAudio: (audio) => {
        if (stopped) throw new Error("Live session closed");
        input.append(audio);
      },
      close,
    };
  } catch (error) {
    const errorName = error instanceof Error ? error.name : "unknown";
    const diagnostic =
      failureReason ||
      `${stage}; ${errorName}; ICE ${peer.iceConnectionState}; peer ${peer.connectionState}; started ${started}`;
    await close().catch(() => undefined);
    // Do not forward vendor errors, SDP or credential-bearing request objects to clients/logs.
    // oxlint-disable-next-line preserve-caught-error
    throw new Error(
      `Codex Live could not connect (${diagnostic}). Check the daemon's Live endpoint and key file.`,
      { cause: errorName },
    );
  }
}
