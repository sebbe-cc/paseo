import type { PaseoApi } from "@getpaseo/client";
import {
  VoiceProviderEventSchema,
  type VoiceProviderCommand,
  type VoiceProviderEvent,
  type VoiceProviderRegistration,
  type VoiceProviderSession,
} from "@getpaseo/plugin/server";

interface Session {
  abort: AbortController;
  ready: Promise<VoiceProviderSession>;
  closing: Promise<void> | null;
}

/** Owns in-flight bootstrap as well as established sessions during plugin teardown. */
export class PluginVoiceWorker {
  private readonly providers = new Map<string, VoiceProviderRegistration>();
  private readonly sessions = new Map<string, Session>();
  private stopped = false;

  register = (provider: VoiceProviderRegistration): void => {
    if (
      !/^[a-z][a-z0-9._-]*$/.test(provider.id) ||
      !provider.label.trim() ||
      typeof provider.start !== "function"
    )
      throw new Error("Invalid voice provider registration");
    if (this.providers.has(provider.id))
      throw new Error(`Duplicate voice provider: ${provider.id}`);
    this.providers.set(provider.id, provider);
  };

  catalog(): Array<{ id: string; label: string }> {
    return [...this.providers.values()].map(({ id, label }) => ({ id, label }));
  }

  async request(
    sessionId: string,
    command: VoiceProviderCommand,
    paseo: PaseoApi,
    directory: string,
    emit: (event: VoiceProviderEvent) => void,
  ): Promise<void> {
    if (command.type === "close") return this.close(sessionId);
    if (this.stopped) throw new Error("Plugin is stopping");
    if (command.type === "audio") {
      const current = this.sessions.get(sessionId);
      if (!current || current.abort.signal.aborted) throw new Error("Voice session is closed");
      const session = await current.ready;
      if (!current.abort.signal.aborted) await session.appendAudio(command.audio);
      return;
    }
    if (this.sessions.has(sessionId)) throw new Error("Duplicate voice session");
    const provider = this.providers.get(command.providerId);
    if (!provider) throw new Error("Unknown voice provider");
    const abort = new AbortController();
    const current: Session = {
      abort,
      closing: null,
      ready: Promise.resolve().then(() =>
        provider.start({
          directory,
          agentId: command.agentId,
          paseo,
          signal: abort.signal,
          emit(event) {
            if (!abort.signal.aborted) emit(VoiceProviderEventSchema.parse(event));
          },
        }),
      ),
    };
    this.sessions.set(sessionId, current);
    try {
      await current.ready;
      abort.signal.throwIfAborted();
    } catch (error) {
      await this.close(sessionId);
      throw error;
    }
  }

  private async close(sessionId: string): Promise<void> {
    const current = this.sessions.get(sessionId);
    if (!current) return;
    if (current.closing) return current.closing;
    current.abort.abort();
    current.closing = (async () => {
      const result = await current.ready.then(
        (session) => ({ session }),
        () => null,
      );
      try {
        await result?.session.close();
      } finally {
        this.sessions.delete(sessionId);
      }
    })();
    return current.closing;
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    await Promise.allSettled([...this.sessions.keys()].map((id) => this.close(id)));
  }
}
