// Per-device ownership (pa-yi0bsm). Main-side registry: one owner
// (installation + window) reads input and writes output per device,
// every other instance only watches. Same rules as the plugin's
// DeviceOwnership (plugins/creator-micro/shared/ownership.ts):
//
// - A claim is granted when the device has no owner, when the same
//   installation + window claims again (reload), or when the version
//   is higher (focus moved ownership).
// - Everything else is refused; stale callbacks are dropped by
//   isCurrent — a window that lost ownership stops reading and
//   writing immediately.

import type { HidDeviceOwner } from "./types.js";

function sameWindow(
  a: Pick<HidDeviceOwner, "installationId" | "windowId">,
  b: Pick<HidDeviceOwner, "installationId" | "windowId">,
): boolean {
  return a.installationId === b.installationId && a.windowId === b.windowId;
}

export class HidDeviceOwnership {
  private readonly owners = new Map<string, HidDeviceOwner>();

  get(deviceKey: string): HidDeviceOwner | null {
    return this.owners.get(deviceKey) ?? null;
  }

  /**
   * True when the claim is granted and stored. The same window may
   * always reclaim (a reload with a new version); another window
   * only with a strictly higher version (focus moved). An equal or
   * lower version from another window is refused — it is a stale
   * callback.
   */
  claim(deviceKey: string, owner: HidDeviceOwner): boolean {
    const current = this.owners.get(deviceKey);
    if (!current) {
      this.owners.set(deviceKey, { ...owner });
      return true;
    }
    if (sameWindow(current, owner)) {
      this.owners.set(deviceKey, { ...owner });
      return true;
    }
    if (owner.version > current.version) {
      this.owners.set(deviceKey, { ...owner });
      return true;
    }
    return false;
  }

  /** Releases only when the releaser is the owner — no stealing via release. */
  release(deviceKey: string, owner: Pick<HidDeviceOwner, "installationId" | "windowId">): boolean {
    const current = this.owners.get(deviceKey);
    if (!current || !sameWindow(current, owner)) return false;
    this.owners.delete(deviceKey);
    return true;
  }

  /**
   * True when the sender is still the current owner WITH the same
   * version. Reads and writes that are not current never run.
   */
  isCurrent(deviceKey: string, owner: HidDeviceOwner): boolean {
    const current = this.owners.get(deviceKey);
    return current !== undefined && sameWindow(current, owner) && current.version === owner.version;
  }

  /** Drops every claim held by the given window (teardown, close). */
  releaseWindow(windowId: string): string[] {
    const released: string[] = [];
    for (const [deviceKey, owner] of this.owners) {
      if (owner.windowId === windowId) {
        this.owners.delete(deviceKey);
        released.push(deviceKey);
      }
    }
    return released;
  }

  clear(): void {
    this.owners.clear();
  }
}
