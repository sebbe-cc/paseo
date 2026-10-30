import type { z } from "zod";
import type { MspConnection, Notification } from "./connection.js";
import { MuseError } from "./errors.js";

// A session loaded only to show its timeline must not pin a Muse host (pa-nxz7e).
export const IDLE_MS = 5 * 60 * 1000;

interface Dormancy {
  reopen(host: MspConnection): Promise<void>;
  busy(host: MspConnection): Promise<boolean>;
}

/** One session's Muse host: closed after IDLE_MS without calls, respawned on the next call. */
export class IdleHost {
  private current: MspConnection | undefined;
  private opening: Promise<MspConnection> | undefined;
  private stopping: Promise<void> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private dormancy: Dormancy | undefined;
  private inflight = 0;
  private closed = false;
  private readonly listeners = new Set<(notification: Notification) => void>();
  private readonly exitListeners = new Set<(error: MuseError) => void>();

  constructor(private readonly spawn: () => MspConnection) {
    this.current = this.attach(spawn());
  }

  get awake(): boolean {
    return this.current !== undefined;
  }
  arm(dormancy: Dormancy): void {
    this.dormancy = dormancy;
    this.schedule();
  }
  initialize(): Promise<void> {
    return this.use((host) => host.initialize());
  }
  onNotification(listener: (notification: Notification) => void): void {
    this.listeners.add(listener);
  }
  onExit(listener: (error: MuseError) => void): void {
    this.exitListeners.add(listener);
  }
  command<T, P extends object>(method: string, params: P, schema: z.ZodType<T>): Promise<T> {
    return this.use((host) => host.command(method, params, schema));
  }
  request<T>(method: string, params: object, schema: z.ZodType<T>, timeoutMs?: number): Promise<T> {
    return this.use((host) => host.request(method, params, schema, timeoutMs));
  }
  async close(): Promise<void> {
    this.closed = true;
    clearTimeout(this.timer);
    await this.opening?.catch(() => {});
    await this.stopping;
    await this.current?.close();
  }

  private attach(host: MspConnection): MspConnection {
    host.onNotification((notification) => {
      for (const listener of this.listeners) listener(notification);
    });
    host.onExit((error) => {
      for (const listener of this.exitListeners) listener(error);
    });
    return host;
  }
  private async use<T>(call: (host: MspConnection) => Promise<T>): Promise<T> {
    this.inflight++;
    clearTimeout(this.timer);
    try {
      return await call(await this.live());
    } finally {
      this.inflight--;
      this.schedule();
    }
  }
  private async live(): Promise<MspConnection> {
    for (;;) {
      if (this.closed) throw new MuseError("closed", "Muse host is closing");
      if (this.stopping) {
        await this.stopping;
        continue;
      }
      if (this.current) return this.current;
      this.opening ??= this.reopen().finally(() => (this.opening = undefined));
      return this.opening;
    }
  }
  private async reopen(): Promise<MspConnection> {
    const host = this.attach(this.spawn());
    try {
      await this.dormancy!.reopen(host);
      if (this.closed) throw new MuseError("closed", "Muse host is closing");
    } catch (error) {
      await host.close().catch(() => {});
      throw error;
    }
    this.current = host;
    return host;
  }
  private schedule(): void {
    clearTimeout(this.timer);
    if (!this.dormancy || this.closed || this.inflight > 0 || !this.current) return;
    this.timer = setTimeout(() => void this.sleep(), IDLE_MS);
  }
  private async sleep(): Promise<void> {
    const host = this.current;
    if (!host || this.inflight > 0 || this.stopping || this.closed) return;
    if (await this.dormancy!.busy(host)) return this.schedule();
    // A call that started during the busy check keeps the host.
    if (this.inflight > 0 || this.current !== host || this.closed) return;
    this.current = undefined;
    this.stopping = host
      .close()
      .catch(() => {})
      .finally(() => (this.stopping = undefined));
  }
}
