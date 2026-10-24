import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, renameSync, lstatSync, unlinkSync } from "node:fs";
import path from "node:path";
import type { HostInventoryDomain, HostWatermark } from "@getpaseo/plugin/server";

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
  constructor(private readonly directory?: string) {}

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
    this.active++;
    try {
      this.advance(domain);
    } catch (error) {
      this.active--;
      throw error;
    }
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.active--;
      this.advance(domain);
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
    const finish = this.begin(domain);
    try {
      return await action();
    } finally {
      finish();
    }
  }

  export() {
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
