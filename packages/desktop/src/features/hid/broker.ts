// Local HID device broker (pa-yi0bsm). Main-side only: owns one native
// handle per device, enforces per-device ownership (installation +
// window, see ownership.ts), polls for hotplug, and forwards raw
// input reports to the owning window only. No vendor rules here —
// the broker carries bytes; decoding lives in the plugin.
//
// Teardown: removeWindow() releases a closed window's claims and
// closes its handles (wired to window "closed" in main.ts);
// dispose() stops the hotplug poll and closes everything.

import { HidDeviceOwnership } from "./ownership.js";
import {
  HidDriverError,
  createNodeHidDriver,
  nonExclusiveForPlatform,
  type HidDriver,
  type HidDriverDevice,
  type HidNativeHandle,
} from "./driver.js";
import type {
  HidBrokerIssue,
  HidBrokerSnapshot,
  HidClaimResult,
  HidDeviceInfo,
  HidDeviceOwner,
  HidInputReport,
  HidWriteResult,
} from "./types.js";

export interface HidBrokerDeps {
  loadDriver?: () => HidDriver;
  platform?: NodeJS.Platform;
  /** Hotplug poll interval; 0 disables polling (tests). */
  pollIntervalMs?: number;
  now?: () => number;
  /** Forwards an IPC event to one renderer (injected for tests). */
  sendToWindow?: (webContentsId: number, channel: string, payload: unknown) => void;
}

export interface HidBrokerEvent {
  snapshot: HidBrokerSnapshot;
  /** True when the device list changed (hotplug). */
  devicesChanged: boolean;
}

interface OpenDevice {
  device: HidDriverDevice;
  handle: HidNativeHandle;
  webContentsId: number;
}

function sameKeys(a: readonly HidDeviceInfo[], b: readonly HidDeviceInfo[]): boolean {
  if (a.length !== b.length) return false;
  const keys = new Set(a.map((device) => device.deviceKey));
  return b.every((device) => keys.has(device.deviceKey));
}

export class HidDeviceBroker {
  private readonly ownership = new HidDeviceOwnership();
  private readonly listeners = new Set<(event: HidBrokerEvent) => void>();
  private readonly openByDevice = new Map<string, OpenDevice>();
  private readonly claimsByWindow = new Map<number, Map<string, HidDeviceOwner>>();
  private devices: HidDeviceInfo[] = [];
  private pathsByDevice = new Map<string, string>();
  private issue: HidBrokerIssue | null = null;
  private driver: HidDriver | null = null;
  private readonly loadDriver: () => HidDriver;
  private readonly platform: NodeJS.Platform;
  private readonly pollIntervalMs: number;
  private readonly now: () => number;
  private readonly sendToWindow: (webContentsId: number, channel: string, payload: unknown) => void;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;

  constructor(deps?: HidBrokerDeps) {
    this.loadDriver = deps?.loadDriver ?? (() => createNodeHidDriver({ platform: deps?.platform }));
    this.platform = deps?.platform ?? process.platform;
    this.pollIntervalMs = deps?.pollIntervalMs ?? 2000;
    this.now = deps?.now ?? (() => Date.now());
    this.sendToWindow = deps?.sendToWindow ?? (() => undefined);
  }

  /** Starts hotplug polling. Safe to call once; dispose() stops it. */
  start(): void {
    if (this.disposed || this.pollTimer || this.pollIntervalMs <= 0) return;
    this.pollTimer = setInterval(() => {
      this.refresh();
    }, this.pollIntervalMs);
    if (typeof (this.pollTimer as unknown as { unref?: unknown }).unref === "function") {
      (this.pollTimer as unknown as { unref: () => void }).unref();
    }
  }

  getSnapshot(): HidBrokerSnapshot {
    if (this.issue) {
      const status = this.issue.kind === "permission" ? "denied" : "unavailable";
      return { status, devices: status === "denied" ? [] : this.devices, issue: this.issue };
    }
    return { status: "ready", devices: [...this.devices] };
  }

  subscribe(listener: (event: HidBrokerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Re-enumerates, drops removed devices, and publishes when changed. */
  refresh(): HidBrokerSnapshot {
    if (this.disposed) return this.getSnapshot();
    let found: HidDriverDevice[] | null = null;
    let failure: HidBrokerIssue | null = null;
    try {
      if (!this.driver) this.driver = this.loadDriver();
      found = this.driver.enumerate();
    } catch (error) {
      failure =
        error instanceof HidDriverError
          ? error.toIssue()
          : { kind: "other" as const, message: String(error) };
    }
    if (failure) {
      this.issue = failure;
      this.emit(false);
      return this.getSnapshot();
    }
    this.issue = null;
    const infos: HidDeviceInfo[] = [];
    for (const entry of found ?? []) {
      const seen = this.openByDevice.get(entry.info.deviceKey);
      const inputBytes = seen ? seen.device.info.reportInputBytes : entry.info.reportInputBytes;
      const outputBytes = seen ? seen.device.info.reportOutputBytes : entry.info.reportOutputBytes;
      infos.push({ ...entry.info, reportInputBytes: inputBytes, reportOutputBytes: outputBytes });
    }
    const changed = !sameKeys(this.devices, infos);
    this.devices = infos;
    this.pathsByDevice = new Map((found ?? []).map((entry) => [entry.info.deviceKey, entry.path]));
    // Removed devices release their claim immediately: no stale owner
    // blocks a reconnect (which may arrive under a new deviceKey).
    // dropClaim deletes the current entry, which is safe during Map iteration.
    for (const open of this.openByDevice.values()) {
      if (!infos.some((info) => info.deviceKey === open.device.info.deviceKey)) {
        const owner = this.ownership.get(open.device.info.deviceKey);
        if (owner) {
          this.ownership.release(open.device.info.deviceKey, owner);
        }
        this.dropClaim(open.device.info.deviceKey);
      }
    }
    this.emit(changed);
    return this.getSnapshot();
  }

  claim(owner: HidDeviceOwner, deviceKey: string, webContentsId: number): HidClaimResult {
    if (this.disposed)
      return {
        ok: false,
        reason: "open-failed",
        issue: { kind: "other", message: "broker disposed" },
      };
    this.refresh();
    if (this.issue) {
      return { ok: false, reason: "open-failed", issue: this.issue };
    }
    const path = this.pathsByDevice.get(deviceKey);
    if (!path || !this.devices.some((device) => device.deviceKey === deviceKey)) {
      return { ok: false, reason: "unknown-device" };
    }
    if (!this.ownership.claim(deviceKey, owner)) {
      return { ok: false, reason: "owned-by-other" };
    }
    if (!this.driver) {
      this.ownership.release(deviceKey, owner);
      return {
        ok: false,
        reason: "open-failed",
        issue: { kind: "other", message: "driver unavailable" },
      };
    }
    const existing = this.openByDevice.get(deviceKey);
    if (existing) {
      if (existing.webContentsId !== webContentsId) {
        // Ownership moved with a higher version, but the old window
        // still held the handle. Drop the stale handle and reopen.
        this.dropClaim(deviceKey);
      } else {
        return { ok: true };
      }
    }
    try {
      const handle = this.driver.open(path, {
        nonExclusive: nonExclusiveForPlatform(this.platform),
      });
      const entry = this.devices.find((device) => device.deviceKey === deviceKey);
      if (entry) {
        const open: OpenDevice = {
          device: { info: entry, path },
          handle,
          webContentsId,
        };
        this.openByDevice.set(deviceKey, open);
        this.trackClaim(webContentsId, deviceKey, owner);
        this.attachInput(deviceKey, open);
      }
    } catch (error) {
      this.ownership.release(deviceKey, owner);
      const issue =
        error instanceof HidDriverError
          ? error.toIssue()
          : { kind: "other" as const, message: String(error) };
      return { ok: false, reason: "open-failed", issue };
    }
    return { ok: true };
  }

  release(owner: Pick<HidDeviceOwner, "installationId" | "windowId">, deviceKey: string): boolean {
    const released = this.ownership.release(deviceKey, owner);
    if (released) this.dropClaim(deviceKey);
    return released;
  }

  write(owner: HidDeviceOwner, deviceKey: string, data: number[]): HidWriteResult {
    if (this.disposed) return { ok: false, reason: "write-failed" };
    if (!this.ownership.isCurrent(deviceKey, owner)) {
      return { ok: false, reason: "not-owner" };
    }
    const open = this.openByDevice.get(deviceKey);
    if (!open) return { ok: false, reason: "unknown-device" };
    try {
      open.handle.write(data);
    } catch (error) {
      const issue =
        error instanceof HidDriverError
          ? error.toIssue()
          : { kind: "other" as const, message: String(error) };
      return { ok: false, reason: "write-failed", issue };
    }
    open.device.info = {
      ...open.device.info,
      reportOutputBytes: Math.max(open.device.info.reportOutputBytes, data.length),
    };
    return { ok: true };
  }

  /** Teardown for one window: releases its claims and closes its handles. */
  removeWindow(webContentsId: number): void {
    const claimed = this.claimsByWindow.get(webContentsId);
    if (!claimed) return;
    this.claimsByWindow.delete(webContentsId);
    for (const [deviceKey, owner] of claimed) {
      this.ownership.release(deviceKey, owner);
      this.closeDevice(deviceKey);
    }
  }

  ownedBy(webContentsId: number): string[] {
    return [...this.openByDevice]
      .filter(([, open]) => open.webContentsId === webContentsId)
      .map(([deviceKey]) => deviceKey);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    // Closing deletes from the map under iteration, which is safe.
    for (const deviceKey of this.openByDevice.keys()) {
      this.closeDevice(deviceKey);
    }
    this.ownership.clear();
    this.listeners.clear();
  }

  private trackClaim(webContentsId: number, deviceKey: string, owner: HidDeviceOwner): void {
    let claimed = this.claimsByWindow.get(webContentsId);
    if (!claimed) {
      claimed = new Map();
      this.claimsByWindow.set(webContentsId, claimed);
    }
    claimed.set(deviceKey, { ...owner });
  }

  /** Drops a claim and its handle without touching ownership. */
  private dropClaim(deviceKey: string): void {
    this.closeDevice(deviceKey);
    for (const claimed of this.claimsByWindow.values()) {
      claimed.delete(deviceKey);
    }
  }

  private closeDevice(deviceKey: string): void {
    const open = this.openByDevice.get(deviceKey);
    if (!open) return;
    this.openByDevice.delete(deviceKey);
    try {
      open.handle.close();
    } catch {
      // Closing a dead handle must never break teardown.
    }
  }

  private attachInput(deviceKey: string, open: OpenDevice): void {
    open.handle.on("data", (data: number[]) => this.handleInput(deviceKey, data));
    // A device error (unplug, sleep) re-enumerates: the removed
    // device releases its claim immediately instead of lingering.
    open.handle.on("error", () => {
      this.refresh();
    });
  }

  /** Called by the driver's data listener (wired in ipc/register). */
  handleInput(deviceKey: string, data: number[]): void {
    if (this.disposed) return;
    const open = this.openByDevice.get(deviceKey);
    if (!open || !Array.isArray(data)) return;
    const owner = this.ownership.get(deviceKey);
    if (!owner) return;
    const bytes = data.filter((entry) => typeof entry === "number");
    open.device.info = {
      ...open.device.info,
      reportInputBytes: Math.max(open.device.info.reportInputBytes, bytes.length),
    };
    const report: HidInputReport = {
      deviceKey,
      reportId: bytes.length > 0 ? bytes[0] : 0,
      data: bytes,
      atMs: this.now(),
    };
    this.sendToWindow(open.webContentsId, "paseo:hid:input", report);
  }

  private emit(devicesChanged: boolean): void {
    if (this.listeners.size === 0) return;
    const event: HidBrokerEvent = { snapshot: this.getSnapshot(), devicesChanged };
    for (const listener of this.listeners) listener(event);
  }
}
