import type { PaseoApi } from "@getpaseo/client";
import { z } from "zod";

export interface DictationProviderSession {
  /** PCM16 little-endian mono at 16 kHz. Must accept promptly; bound queued audio. */
  appendAudio(pcm16Base64: string): void | Promise<void>;
  /** Resolves with the text spoken since the previous commit. */
  commit(): Promise<string>;
  /** Idempotent. Drops uncommitted audio and releases media, sockets and timers. */
  close(): void | Promise<void>;
}

export interface DictationProviderStartContext {
  /** The agent chat being dictated into, when the client knows it. */
  agentId?: string;
  directory: string;
  paseo: PaseoApi;
  signal: AbortSignal;
}

export interface DictationProviderRegistration {
  id: string;
  label: string;
  /** Resolve only when ready for input. Honour abort during bootstrap. Credentials stay here. */
  start(context: DictationProviderStartContext): Promise<DictationProviderSession>;
}

export interface DictationProviderSelection {
  pluginId: string;
  providerId: string;
}

/** Host transport; available only on daemons implementing pluginDictationProviders. */
export interface PluginDictationHost {
  hasDictationProvider(selection: DictationProviderSelection): boolean;
  startDictationProvider(
    selection: DictationProviderSelection,
    context: Pick<DictationProviderStartContext, "agentId" | "signal">,
  ): Promise<DictationProviderSession>;
}

export const DictationProviderCommandSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("start"),
    providerId: z.string().min(1),
    agentId: z.string().uuid().optional(),
  }),
  z.object({ type: z.literal("audio"), audio: z.string().max(128_000) }),
  z.object({ type: z.literal("commit") }),
  z.object({ type: z.literal("close") }),
]);
export type DictationProviderCommand = z.infer<typeof DictationProviderCommandSchema>;

export const DictationCommitResultSchema = z.object({ text: z.string().max(100_000) });
