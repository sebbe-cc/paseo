// HID broker IPC (pa-yi0bsm). Main-side only: validates every
// renderer payload, runs claims/writes against the broker, and fans
// hotplug + input events out to renderers. Input goes to the owning
// window only; every other window just sees the device list.

import { HidDeviceBroker } from "./broker.js";
import { HID_IPC, parseHidClaim, parseHidOwner, parseHidWrite } from "./types.js";

export interface HidIpcTransport {
  handle(channel: string, listener: (senderId: number, payload: unknown) => unknown): void;
  broadcast(channel: string, payload: unknown): void;
  removeAll?(): void;
}

export interface HidIpcResult {
  /** Stops hotplug fan-out; call on app teardown. */
  dispose(): void;
}

/** Renderer window identity: stable per window for its lifetime. */
export function windowIdForWebContents(webContentsId: number): string {
  return `w${webContentsId}`;
}

export function registerHidIpc(transport: HidIpcTransport, broker: HidDeviceBroker): HidIpcResult {
  const unsubscribe = broker.subscribe((event) => {
    if (event.devicesChanged) {
      transport.broadcast(HID_IPC.devicesChanged, event.snapshot);
    }
  });

  transport.handle(HID_IPC.identity, (senderId) => ({
    windowId: windowIdForWebContents(senderId),
  }));

  transport.handle(HID_IPC.enumerate, () => broker.refresh());

  transport.handle(HID_IPC.claim, (senderId, payload) => {
    const claim = parseHidClaim(payload);
    if (!claim) return { ok: false as const, reason: "invalid-claim" as const };
    return broker.claim(claim, claim.deviceKey, senderId);
  });

  transport.handle(HID_IPC.release, (_senderId, payload) => {
    if (typeof payload !== "object" || payload === null) return false;
    const owner = parseHidOwner(payload);
    const record = payload as Record<string, unknown>;
    if (!owner || typeof record.deviceKey !== "string") return false;
    return broker.release(owner, record.deviceKey);
  });

  transport.handle(HID_IPC.write, (_senderId, payload) => {
    const write = parseHidWrite(payload);
    if (!write) return { ok: false as const, reason: "invalid-write" as const };
    return broker.write(write, write.deviceKey, write.data);
  });

  return {
    dispose: () => {
      unsubscribe();
      transport.removeAll?.();
    },
  };
}
