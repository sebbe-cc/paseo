import type { PaseoApi } from "@getpaseo/client";
import type {
  DictationProviderCommand,
  DictationProviderRegistration,
  DictationProviderSession,
} from "@getpaseo/plugin/server";

interface Session {
  abort: AbortController;
  ready: Promise<DictationProviderSession>;
  closing: Promise<void> | null;
}

/** Plugin-side owner of dictation sessions, including in-flight bootstrap during teardown. */
export class PluginDictationWorker {
  private readonly providers = new Map<string, DictationProviderRegistration>();
  private readonly sessions = new Map<string, Session>();
  private stopped = false;

  register = (provider: DictationProviderRegistration): void => {
    if (
      !/^[a-z][a-z0-9._-]*$/.test(provider.id) ||
      !provider.label.trim() ||
      typeof provider.start !== "function"
    )
      throw new Error("Invalid dictation provider registration");
    if (this.providers.has(provider.id))
      throw new Error(`Duplicate dictation provider: ${provider.id}`);
    this.providers.set(provider.id, provider);
  };

  catalog(): Array<{ id: string; label: string }> {
    return [...this.providers.values()].map(({ id, label }) => ({ id, label }));
  }

  async request(
    sessionId: string,
    command: DictationProviderCommand,
    paseo: PaseoApi,
    directory: string,
  ): Promise<{ text: string } | undefined> {
    if (command.type === "close") return this.close(sessionId);
    if (this.stopped) throw new Error("Plugin is stopping");
    if (command.type === "start") return this.start(sessionId, command, paseo, directory);
    const current = this.sessions.get(sessionId);
    if (!current || current.abort.signal.aborted) throw new Error("Dictation session is closed");
    const session = await current.ready;
    current.abort.signal.throwIfAborted();
    if (command.type === "audio") return void (await session.appendAudio(command.audio));
    return { text: await session.commit() };
  }

  private async start(
    sessionId: string,
    command: Extract<DictationProviderCommand, { type: "start" }>,
    paseo: PaseoApi,
    directory: string,
  ): Promise<undefined> {
    if (this.sessions.has(sessionId)) throw new Error("Duplicate dictation session");
    const provider = this.providers.get(command.providerId);
    if (!provider) throw new Error("Unknown dictation provider");
    const abort = new AbortController();
    const current: Session = {
      abort,
      closing: null,
      ready: Promise.resolve().then(() =>
        provider.start({ agentId: command.agentId, directory, paseo, signal: abort.signal }),
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
    return undefined;
  }

  private async close(sessionId: string): Promise<undefined> {
    const current = this.sessions.get(sessionId);
    if (!current) return undefined;
    if (!current.closing) {
      current.abort.abort();
      current.closing = (async () => {
        const session = await current.ready.catch(() => null);
        try {
          await session?.close();
        } finally {
          this.sessions.delete(sessionId);
        }
      })();
    }
    await current.closing;
    return undefined;
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    await Promise.allSettled([...this.sessions.keys()].map((id) => this.close(id)));
  }
}
