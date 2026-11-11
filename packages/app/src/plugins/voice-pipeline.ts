import {
  DictationStreamSender,
  type DictationStreamClient,
} from "@/dictation/dictation-stream-sender";
import { PCM_DICTATION_FORMAT } from "@/hooks/use-dictation.shared";
import type { PluginClientActionsTarget } from "@getpaseo/plugin/client";
import type { ClientActionsVoicePipeline } from "./client-actions";

/**
 * Production voice pipeline for plugin hold-to-talk (pa-w4srq.4).
 *
 * Orchestrates the app's EXISTING dictation machinery — DictationStreamSender,
 * the daemon dictation stream client, headless mic capture — never a new
 * pipeline, never a fabricated transcript. Release-to-send delivers the
 * transcript to the routed agent via the daemon client; an empty transcript
 * sends nothing.
 *
 * Honest errors, never fallbacks: a missing/unconnected daemon client or a
 * missing capture source throws, and the plugin maps that to `unsupported`
 * with reason. The microphone is always stopped before anything else
 * (try/finally), so a failed finish or delivery can never leave it on.
 * Disconnect and window-blur auto-stop funnel through the capability's
 * guarded stop; a disconnect also makes finish throw, so a half-utterance
 * is never sent on connection loss.
 */

/** Daemon client surface the pipeline needs (DaemonClient satisfies this structurally). */
export interface VoicePipelineDaemonClient extends DictationStreamClient {
  sendMessage(agentId: string, text: string): Promise<unknown>;
  subscribeConnectionStatus(listener: (state: { status: string }) => void): () => void;
}

/**
 * Headless mic capture: PCM16 base64 segments via onPcmSegment until stop().
 * stop() is release (flushes the final partial chunk); cancel() discards
 * buffered audio without delivering it.
 */
export interface VoiceAudioSource {
  start(): Promise<void>;
  stop(): Promise<void>;
  cancel(): Promise<void>;
}

export interface VoiceAudioSourceConfig {
  onPcmSegment(pcm16Base64: string): void;
  onError?(error: Error): void;
}

export interface CreateVoicePipelineDeps {
  resolveClient(serverId: string): VoicePipelineDaemonClient | null;
  createAudioSource(config: VoiceAudioSourceConfig): VoiceAudioSource | null;
}

interface VoiceSession {
  route: { serverId: string; agentId: string };
  client: VoicePipelineDaemonClient;
  sender: DictationStreamSender;
  source: VoiceAudioSource;
}

/**
 * Packaged-desktop marker without importing the desktop host module (which
 * is web-only): the Electron preload exposes `window.paseoDesktop`. Browser,
 * mobile and SSR never have it, so voice stays honestly unsupported there.
 * Canonical check: `isElectronRuntime` in `@/desktop/host`.
 */
export function isPackagedDesktopVoiceHost(): boolean {
  const candidate = globalThis as { window?: { paseoDesktop?: unknown } };
  const win = candidate.window;
  if (typeof win !== "object" || win === null) return false;
  return typeof win.paseoDesktop === "object" && win.paseoDesktop !== null;
}

export interface VoiceInputDeps extends CreateVoicePipelineDeps {
  isDesktopHost(): boolean;
  isCaptureAvailable(): boolean;
}

/**
 * Gated factory for the runtime wiring: null everywhere except the packaged
 * desktop app with capturable mic APIs. Per-part probing stays honest —
 * browser/mobile/SSR report voiceInput false.
 */
export function createPluginVoiceInput(deps: VoiceInputDeps): ClientActionsVoicePipeline | null {
  if (!deps.isDesktopHost()) return null;
  if (!deps.isCaptureAvailable()) return null;
  return createDesktopVoicePipeline(deps);
}

export function createDesktopVoicePipeline(
  deps: CreateVoicePipelineDeps,
): ClientActionsVoicePipeline {
  let active: VoiceSession | null = null;
  let lossRelease: (() => void) | null = null;
  const lossHandlers = new Set<() => void>();

  function disarmLoss(): void {
    lossRelease?.();
    lossRelease = null;
  }

  function abandonSession(): void {
    const session = active;
    active = null;
    disarmLoss();
    if (!session) return;
    // Mic off first; buffered audio is discarded (never delivered from a
    // retired session), then the stream is cancelled.
    void (async () => {
      try {
        await session.source.cancel();
      } catch {
        // The mic is already gone; still cancel the stream below.
      }
      session.sender.cancel();
      session.sender.dispose();
    })();
  }

  return {
    subscribeConnectionLoss(handler: () => void): () => void {
      lossHandlers.add(handler);
      return () => {
        lossHandlers.delete(handler);
      };
    },

    async start(target: PluginClientActionsTarget): Promise<void> {
      const serverId = target.serverId.trim();
      const agentId = target.agentId.trim();
      if (!serverId) throw new Error("startVoiceInput requires a non-empty serverId");
      if (!agentId) throw new Error("startVoiceInput requires a non-empty agentId");
      // Last press wins: retire the previous session without delivery
      // (the capability already delivered it via stop()).
      abandonSession();
      const client = deps.resolveClient(serverId);
      if (!client) {
        throw new Error(`No daemon client for server "${serverId}" — voice input is unavailable.`);
      }
      if (!client.isConnected) {
        throw new Error("Daemon is not connected — voice input is unavailable.");
      }
      const sender = new DictationStreamSender({
        client,
        format: PCM_DICTATION_FORMAT,
      });
      let source: VoiceAudioSource | null = null;
      try {
        source = deps.createAudioSource({
          onPcmSegment: (pcm16Base64) => sender.enqueueSegment(pcm16Base64),
          onError: () => abandonSession(),
        });
        if (!source) {
          throw new Error("Microphone capture is unavailable here.");
        }
        active = { route: { serverId, agentId }, client, sender, source };
        // The capability is the last guarantor: connection loss
        // funnels into its guarded stop. Ignore the initial
        // subscription snapshot (connected by the check above).
        lossRelease = client.subscribeConnectionStatus((state) => {
          if (state.status !== "connected") {
            for (const handler of lossHandlers) handler();
          }
        });
        await source.start();
      } catch (error) {
        active = null;
        disarmLoss();
        sender.cancel();
        sender.dispose();
        throw error;
      }
    },

    async stop(): Promise<void> {
      const session = active;
      active = null;
      disarmLoss();
      if (!session) return;
      try {
        // Mic off first, always.
        await session.source.stop();
        if (!session.sender.hasSegments()) {
          session.sender.cancel();
          return;
        }
        const { text } = await session.sender.finish(session.sender.getFinalSeq());
        if (text.trim().length === 0) return;
        await session.client.sendMessage(session.route.agentId, text);
      } finally {
        session.sender.dispose();
      }
    },
  };
}
