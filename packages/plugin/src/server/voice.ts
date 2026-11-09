import type { PaseoApi } from "@getpaseo/client";
import { z } from "zod";

/** PCM16 little-endian, mono. Input is 16 kHz; output is 24 kHz. */
export const VoiceProviderEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("audio"),
    audio: z.string().max(128_000),
    utteranceId: z.string().min(1),
    chunkIndex: z.number().int().nonnegative(),
    isLastChunk: z.boolean(),
  }),
  z.object({ type: z.literal("speech"), isSpeaking: z.boolean() }),
  z.object({
    type: z.literal("transcript"),
    role: z.enum(["user", "assistant"]),
    text: z.string(),
  }),
  z.object({ type: z.literal("closed"), error: z.string().optional() }),
]);
export type VoiceProviderEvent = z.infer<typeof VoiceProviderEventSchema>;

export interface VoiceProviderSession {
  /** Must accept promptly; bound any queued audio and fail on overflow. */
  appendAudio(pcm16Base64: string): void | Promise<void>;
  /** Idempotent. Release media, sockets, timers and agent observations. Do not cancel agent work. */
  close(): void | Promise<void>;
}

export interface VoiceProviderStartContext {
  agentId: string;
  directory: string;
  paseo: PaseoApi;
  signal: AbortSignal;
  emit(event: VoiceProviderEvent): void;
}

export interface VoiceProviderRegistration {
  id: string;
  label: string;
  /** Resolve only when ready for input. Honour abort during bootstrap. Credentials stay here. */
  start(context: VoiceProviderStartContext): Promise<VoiceProviderSession>;
}

export interface VoiceProviderSelection {
  pluginId: string;
  providerId: string;
}

/** Host transport; available only on daemons implementing pluginVoiceProviders. */
export interface PluginVoiceHost {
  hasVoiceProvider(selection: VoiceProviderSelection): boolean;
  startVoiceProvider(
    selection: VoiceProviderSelection,
    context: Omit<VoiceProviderStartContext, "paseo" | "directory">,
  ): Promise<VoiceProviderSession>;
}

export const VoiceProviderCommandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("start"), providerId: z.string().min(1), agentId: z.string().uuid() }),
  z.object({ type: z.literal("audio"), audio: z.string().max(128_000) }),
  z.object({ type: z.literal("close") }),
]);
export type VoiceProviderCommand = z.infer<typeof VoiceProviderCommandSchema>;
