import { EventEmitter } from "node:events";
import { v4 as uuidv4 } from "uuid";
import type {
  DictationProviderSelection,
  DictationProviderSession,
  PluginDictationHost,
} from "@getpaseo/plugin/server";
import type { SpeechToTextProvider, StreamingTranscriptionSession } from "./speech-provider.js";

/** Plugin dictation as a streaming STT: each commit becomes one final segment. */
export function createPluginDictationStt(
  host: PluginDictationHost,
  selection: DictationProviderSelection,
): SpeechToTextProvider {
  return {
    id: `plugin:${selection.pluginId}/${selection.providerId}`,
    createSession: ({ agentId }) => createSession(host, selection, agentId),
  };
}

function createSession(
  host: PluginDictationHost,
  selection: DictationProviderSelection,
  agentId: string | undefined,
): StreamingTranscriptionSession {
  const emitter = new EventEmitter();
  const abort = new AbortController();
  let session: DictationProviderSession | null = null;
  // Audio and commits reach the plugin in order, so a commit covers all audio before it.
  let queue: Promise<unknown> = Promise.resolve();
  let previousSegmentId: string | null = null;
  const fail = (error: unknown) => {
    if (!abort.signal.aborted) emitter.emit("error", error);
  };
  const enqueue = (step: (session: DictationProviderSession) => Promise<unknown> | unknown) => {
    queue = queue.then(() => {
      if (abort.signal.aborted || !session) return undefined;
      return step(session);
    });
    queue = queue.catch(fail);
  };
  return {
    requiredSampleRate: 16000,
    async connect() {
      session = await host.startDictationProvider(selection, { agentId, signal: abort.signal });
      if (abort.signal.aborted) await session.close();
    },
    appendPcm16(pcm16le) {
      const audio = pcm16le.toString("base64");
      enqueue((current) => current.appendAudio(audio));
    },
    commit() {
      const segmentId = uuidv4();
      emitter.emit("committed", { segmentId, previousSegmentId });
      previousSegmentId = segmentId;
      enqueue(async (current) => {
        const transcript = await current.commit();
        if (!abort.signal.aborted)
          emitter.emit("transcript", { segmentId, transcript, isFinal: true });
      });
    },
    // Audio already sent cannot be withdrawn; the manager only clears silent segments.
    clear() {},
    close() {
      if (abort.signal.aborted) return;
      abort.abort();
      void Promise.resolve(session?.close()).catch(() => undefined);
    },
    on(event: string, handler: (...args: never[]) => void) {
      emitter.on(event, handler as (...args: unknown[]) => void);
      return this;
    },
  };
}
