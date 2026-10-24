import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, renameSync, lstatSync, unlinkSync } from "node:fs";
import path from "node:path";
import { HostInventoryFence, HostFenceError } from "./host-inventory-fence.js";
import type { HostInventoryDomain, HostWatermark } from "@getpaseo/plugin/server";

export const HOST_FENCE_WAIT_MS = 30_000;
const MAX_FENCE_WAITERS = 1024;

interface FenceWaiter {
  domain: HostInventoryDomain;
  since: number;
  resolve: (finish: () => void) => void;
  reject: (error: unknown) => void;
}

export const HOST_INVENTORY_COVERED: HostInventoryDomain[] = [
  "agent-records",
  "admissions",
  "live-history",
  "provider-registry",
  "plugin-lifecycle",
];
export const HOST_INVENTORY_EXCLUDED = [
  "gc-ownership-incarnation",
  "git-workspace-identity",
  "external-capability-revocation",
  "old-publishers",
  "provider-native-history",
  "cross-process-publication-locks",
];

/** A host observation token, deliberately NOT a production publication fence.
 * Every participating writer marks its whole mutation, including awaited I/O.
 * Restart gets a new epoch. A bounded suffix is diagnostic; equality always
 * compares epoch + sequence and requires zero active writers on both sides.
 */
export class HostInventoryClock {
  private readonly epoch = randomUUID();
  private sequence = 0;
  private active = 0;
  private changes: HostWatermark["changes"] = [];
  private expiresAt = 0;
  private failed = false;
  private readonly fenceLock: HostInventoryFence | null;
  private readonly waiters: FenceWaiter[] = [];
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private warnedAt = -Infinity;
  constructor(
    private readonly directory?: string,
    private readonly warn: (message: string) => void = console.warn,
  ) {
    const supported = process.platform === "linux" || process.platform === "darwin";
    this.fenceLock = directory && supported ? new HostInventoryFence(directory) : null;
  }

  /** Queue only lock acquisition: a failed mutation must never be replayed. */
  beginAsync(domain: HostInventoryDomain): Promise<() => void> {
    try {
      // Nested writers must be able to complete while holding SH. Otherwise
      // new independent writers join the existing FIFO acquisition queue.
      if (this.waiters.length === 0 || this.active > 0) return Promise.resolve(this.begin(domain));
    } catch (error) {
      if (!(error instanceof HostFenceError && error.code === "HOST_FENCE_BUSY"))
        return Promise.reject(error);
    }
    if (this.waiters.length >= MAX_FENCE_WAITERS)
      return Promise.reject(
        new HostFenceError("HOST_FENCE_SATURATED", "Host publication writer queue is full"),
      );
    return new Promise((resolve, reject) => {
      this.waiters.push({ domain, since: Date.now(), resolve, reject });
      this.scheduleRetry();
    });
  }

  private scheduleRetry(): void {
    if (this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      while (this.waiters.length) {
        const waiter = this.waiters[0];
        const elapsed = Date.now() - waiter.since;
        if (elapsed >= 5_000 && Date.now() - this.warnedAt >= 60_000) {
          this.warnedAt = Date.now();
          this.warn(
            "Host publication is blocking inventory writers; bounded retry queue is waiting",
          );
        }
        try {
          const finish = this.begin(waiter.domain);
          this.waiters.shift();
          waiter.resolve(finish);
        } catch (error) {
          if (error instanceof HostFenceError && error.code === "HOST_FENCE_BUSY") {
            if (elapsed < HOST_FENCE_WAIT_MS) break;
            this.waiters.shift();
            waiter.reject(
              new HostFenceError(
                "HOST_FENCE_SATURATED",
                "Host publication blocked writes for 30 seconds",
              ),
            );
          } else {
            this.waiters.shift();
            waiter.reject(error);
          }
        }
      }
      if (this.waiters.length) this.scheduleRetry();
    }, 25);
  }

  private acquireFence(): () => void {
    try {
      return this.fenceLock?.acquire() ?? (() => {});
    } catch (error) {
      if (!(error instanceof HostFenceError && error.code === "HOST_FENCE_BUSY"))
        this.failed = true;
      throw error;
    }
  }

  snapshot(): HostWatermark {
    if (this.failed)
      throw Object.assign(new Error("Host watermark publication failed"), {
        code: "HOST_INVENTORY_UNAVAILABLE",
      });
    return {
      version: 1,
      scope: "paseo-host",
      epoch: this.epoch,
      sequence: this.sequence,
      activeWriters: this.active,
      productionFence: false,
      covered: [...HOST_INVENTORY_COVERED],
      excluded: [...HOST_INVENTORY_EXCLUDED],
      oldestSequence: this.changes[0]?.sequence ?? this.sequence,
      changes: this.changes.map((change) => ({ ...change })),
    };
  }

  begin(domain: HostInventoryDomain): () => void {
    const release = this.acquireFence();
    this.active++;
    try {
      this.advance(domain);
    } catch (error) {
      this.active--;
      release();
      throw error;
    }
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.active--;
      try {
        this.advance(domain);
      } finally {
        release();
      }
    };
  }

  run<T>(domain: HostInventoryDomain, action: () => T): T {
    const finish = this.begin(domain);
    try {
      return action();
    } finally {
      finish();
    }
  }

  async track<T>(domain: HostInventoryDomain, action: () => Promise<T>): Promise<T> {
    const finish = await this.beginAsync(domain);
    try {
      return await action();
    } finally {
      finish();
    }
  }

  fence() {
    if (!this.fenceLock)
      throw new HostFenceError("HOST_FENCE_UNAVAILABLE", "Native host fencing is unavailable");
    const release = this.acquireFence();
    try {
      const observation = this.export();
      if (!observation.local || observation.watermark.activeWriters !== 0)
        throw new HostFenceError("HOST_FENCE_BUSY", "Host writes are still in flight");
      return {
        version: 1 as const,
        scope: "paseo-host" as const,
        watermark: observation.watermark,
        local: observation.local,
        lock: this.fenceLock.token(),
      };
    } finally {
      release();
    }
  }

  export() {
    const release = this.acquireFence();
    try {
      return this.exportLocked();
    } finally {
      release();
    }
  }

  private exportLocked() {
    if (!this.directory) return { watermark: this.snapshot(), local: null };
    // No timer or steady-state file writes. Local observers have a ten-second
    // lease; expired files must be rejected even if their bytes match.
    this.expiresAt = Date.now() + 10_000;
    this.publish();
    return {
      watermark: this.snapshot(),
      local: {
        path: path.join(this.directory, "watermark.json"),
        expiresAt: this.expiresAt,
      },
    };
  }

  private advance(domain: HostInventoryDomain): void {
    if (!Number.isSafeInteger(this.sequence + 1))
      throw new Error("Host watermark sequence exhausted");
    this.sequence++;
    this.changes.push({ sequence: this.sequence, domain });
    if (this.changes.length > 64) this.changes.shift();
    if (this.expiresAt > Date.now()) this.publish();
  }

  private publish(): void {
    if (!this.directory) return;
    const temporary = path.join(this.directory, `${this.epoch}.tmp`);
    try {
      mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      const stat = lstatSync(this.directory);
      if (
        !stat.isDirectory() ||
        (stat.mode & 0o077) !== 0 ||
        (process.getuid && stat.uid !== process.getuid())
      ) {
        throw new Error("Host watermark directory must be private and owned by the daemon");
      }
      const document = {
        watermark: this.snapshot(),
        expiresAt: this.expiresAt,
      };
      writeFileSync(temporary, JSON.stringify(document) + "\n", {
        mode: 0o600,
        flag: "wx",
      });
      renameSync(temporary, path.join(this.directory, "watermark.json"));
    } catch (error) {
      this.failed = true;
      throw error;
    } finally {
      try {
        unlinkSync(temporary);
      } catch {
        /* renamed, or never created */
      }
    }
  }
}
