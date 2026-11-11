// Generic device (HID) broker wire types (pa-yi0bsm). Main-side only:
// plain data, no Electron or native imports, so the app and preload
// can share these shapes through `paseoDesktop.hid`.
//
// No vendor rules here — no VID/PID allowlists, report codes or LED
// policies. Those belong to the plugin.

/** One USB usage pair, e.g. the vendor page 0xFF00/0x01. */
export interface HidUsagePair {
  usagePage: number;
  usage: number;
}

/**
 * Generic device identity from the broker. `deviceKey` is the
 * broker's session-stable identity: the serial when present,
 * otherwise the OS path (a path may change across reconnects).
 */
export interface HidDeviceInfo {
  deviceKey: string;
  serial: string | null;
  vendorId: number;
  productId: number;
  usagePairs: HidUsagePair[];
  /** Largest input report seen, 0 before the first report. */
  reportInputBytes: number;
  /** Largest output report written, 0 before the first write. */
  reportOutputBytes: number;
}

/** Why the broker cannot serve devices right now. */
export type HidBrokerIssueKind = "permission" | "packaging" | "other";

export interface HidBrokerIssue {
  kind: HidBrokerIssueKind;
  /** Raw native message for the app's diagnosis mapper. */
  message: string;
}

export type HidBrokerStatus = "ready" | "denied" | "unavailable";

export interface HidBrokerSnapshot {
  status: HidBrokerStatus;
  devices: HidDeviceInfo[];
  /** Present when status is not "ready". */
  issue?: HidBrokerIssue;
}

/** One owner (installation + window) per device. */
export interface HidDeviceOwner {
  installationId: string;
  windowId: string;
  version: number;
}

export interface HidClaimResult {
  ok: boolean;
  /** Machine-readable reason when the claim is refused. */
  reason?: "owned-by-other" | "unknown-device" | "open-failed" | "invalid-claim";
  issue?: HidBrokerIssue;
}

export interface HidWriteResult {
  ok: boolean;
  reason?: "not-owner" | "unknown-device" | "write-failed" | "invalid-write";
  issue?: HidBrokerIssue;
}

/** Raw input report forwarded to the owning window only. */
export interface HidInputReport {
  deviceKey: string;
  reportId: number;
  data: number[];
  atMs: number;
}

export const HID_IPC = {
  enumerate: "paseo:hid:enumerate",
  identity: "paseo:hid:identity",
  claim: "paseo:hid:claim",
  release: "paseo:hid:release",
  write: "paseo:hid:write",
  devicesChanged: "paseo:hid:devices-changed",
  input: "paseo:hid:input",
} as const;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function parseHidOwner(value: unknown): HidDeviceOwner | null {
  if (!isRecord(value)) return null;
  const { installationId, windowId, version } = value;
  if (!isNonEmptyString(installationId) || !isNonEmptyString(windowId)) return null;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) return null;
  return { installationId, windowId, version };
}

export function parseHidClaim(value: unknown): (HidDeviceOwner & { deviceKey: string }) | null {
  if (!isRecord(value)) return null;
  const owner = parseHidOwner(value);
  if (!owner) return null;
  if (!isNonEmptyString(value.deviceKey)) return null;
  return { ...owner, deviceKey: value.deviceKey };
}

export function parseHidWrite(
  value: unknown,
): (HidDeviceOwner & { deviceKey: string; data: number[] }) | null {
  const claim = parseHidClaim(value);
  if (!claim) return null;
  const raw = (value as Record<string, unknown>).data;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 64) return null;
  const isByte = (entry: unknown): entry is number =>
    typeof entry === "number" && Number.isInteger(entry) && entry >= 0 && entry <= 255;
  if (!raw.every(isByte)) return null;
  return { ...claim, data: [...raw] };
}
