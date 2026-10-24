import { createRequire } from "node:module";
import { constants, openSync, closeSync, fstatSync, lstatSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { HostFenceLock } from "@getpaseo/plugin/server";

const require = createRequire(import.meta.url);

export class HostFenceError extends Error {
  constructor(
    readonly code: "HOST_FENCE_BUSY" | "HOST_FENCE_UNAVAILABLE",
    message: string,
  ) {
    super(message);
  }
}

/** The publisher takes EX|NB only AFTER admission and registry locks. Host
 * writers may call admission hooks while holding SH, so waiting for EX would
 * invert that order. Never unlink this file, even at shutdown.
 */
export class HostInventoryFence {
  private identity: HostFenceLock | null = null;
  private fd: number | null = null;
  private users = 0;
  private readonly flockSync: typeof import("fs-ext").flockSync;
  readonly lockPath: string;

  constructor(private readonly directory: string) {
    this.lockPath = path.join(directory, "host-fence.lock");
    // fs-ext is optional only for unsupported platforms. A missing native
    // module on a supported host must fail closed, never silently omit locks.
    this.flockSync = require("fs-ext").flockSync;
  }

  acquire(): () => void {
    if (this.users === 0) this.open();
    this.users++;
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      if (--this.users === 0 && this.fd !== null) {
        closeSync(this.fd);
        this.fd = null;
      }
    };
  }

  token(): HostFenceLock {
    const release = this.acquire();
    try {
      if (!this.identity)
        throw new HostFenceError("HOST_FENCE_UNAVAILABLE", "Missing lock identity");
      return { ...this.identity };
    } finally {
      release();
    }
  }

  private open(): void {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const directory = lstatSync(this.directory);
    if (
      !directory.isDirectory() ||
      (directory.mode & 0o077) !== 0 ||
      directory.uid !== process.getuid!()
    ) {
      throw new HostFenceError(
        "HOST_FENCE_UNAVAILABLE",
        "Host fence directory must be private and daemon-owned",
      );
    }
    const create = this.identity === null ? constants.O_CREAT : 0;
    const fd = openSync(this.lockPath, constants.O_RDWR | constants.O_NOFOLLOW | create, 0o600);
    try {
      const stat = fstatSync(fd, { bigint: true });
      const named = lstatSync(this.lockPath, { bigint: true });
      const identity = { path: this.lockPath, device: String(stat.dev), inode: String(stat.ino) };
      const replaced =
        this.identity !== null &&
        (identity.device !== this.identity.device || identity.inode !== this.identity.inode);
      if (
        !stat.isFile() ||
        stat.nlink !== 1n ||
        (stat.mode & 0o777n) !== 0o600n ||
        stat.uid !== BigInt(process.getuid!()) ||
        named.dev !== stat.dev ||
        named.ino !== stat.ino ||
        replaced
      ) {
        throw new HostFenceError(
          "HOST_FENCE_UNAVAILABLE",
          "Host fence lock identity or ownership changed",
        );
      }
      this.flockSync(fd, "shnb");
      this.identity = identity;
      this.fd = fd;
    } catch (error) {
      closeSync(fd);
      if (
        error instanceof Error &&
        "code" in error &&
        (error.code === "EAGAIN" || error.code === "EWOULDBLOCK")
      ) {
        throw new HostFenceError(
          "HOST_FENCE_BUSY",
          "Host publication in progress; retry outside publication locks",
        );
      }
      throw error;
    }
  }
}
