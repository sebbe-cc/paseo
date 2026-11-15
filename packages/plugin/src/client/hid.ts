// Generic desktop device (HID) broker capability (pa-yi0bsm). Types only:
// no Node or React Native imports here, so the client boundary
// (boundaries.test.ts) holds and the client bundle never imports node:.
//
// This is the host half of the plugin's broker contract
// (plugins/creator-micro/shared/hid-broker.ts in fleet/paseo): same
// field names and shapes, so a plugin can consume an app-provided
// broker structurally. No vendor rules here — no VID/PID, report
// codes or LED policies. Those belong to the plugin.

/** One USB usage pair, e.g. the vendor page 0xFF00/0x01. */
export interface PluginHidUsagePair {
  usagePage: number;
  usage: number;
}

/**
 * Generic device identity from the broker. `deviceKey` is the
 * broker's session-stable identity (serial when present, otherwise
 * the OS path — a path may change across reconnects).
 */
export interface PluginHidDeviceInfo {
  deviceKey: string;
  serial: string | null;
  vendorId: number;
  productId: number;
  usagePairs: PluginHidUsagePair[];
  reportInputBytes: number;
  reportOutputBytes: number;
}

export type PluginHidBrokerState =
  | { status: "unsupported"; context: string }
  | { status: "denied"; diagnosis: string }
  | { status: "unavailable"; diagnosis: string }
  | { status: "ready"; devices: PluginHidDeviceInfo[] };

/** Decoded control event from the physical layer. */
export interface PluginHidControlEvent {
  deviceKey: string;
  code: string;
  pressed: boolean;
  atMs: number;
}

/**
 * A raw HID report from the broker. Raw decoding lives in the
 * plugin — the broker stays generic and only carries bytes.
 */
export interface PluginHidRawReport {
  deviceKey: string;
  reportId: number;
  data: readonly number[];
  atMs: number;
}

/**
 * Minimal broker surface the host exposes. `enumerate`/`onControl`/
 * `onRawReport`/`write` exist only where the capability exists
 * (desktop); everywhere else the capability itself is absent and the
 * plugin treats the broker as null ("unsupported").
 */
export interface PluginHidBroker {
  getState(): PluginHidBrokerState;
  subscribe(listener: (state: PluginHidBrokerState) => void): () => void;
  enumerate?(): Promise<PluginHidDeviceInfo[]>;
  onControl?(listener: (event: PluginHidControlEvent) => void): () => void;
  /**
   * Raw reports for plugins that decode themselves. Absent until
   * the host forwards them; the plugin decoder then stays idle.
   */
  onRawReport?(listener: (report: PluginHidRawReport) => void): () => void;
  /** Output reports (e.g. LEDs). Absent where the host cannot write. */
  write?(deviceKey: string, data: readonly number[]): Promise<void>;
  /**
   * Explicit per-device claim with the app's owner identity. Never
   * auto-claimed: the plugin passes its vendor usage filter before
   * claiming, so the broker never opens keyboards or mice just by
   * existing. Absent where the host cannot claim.
   */
  claim?(deviceKey: string): Promise<boolean>;
  /** Releases an own claim; safe to call without one. */
  release?(deviceKey: string): Promise<void>;
}

/** One owner (installation + window) per device. */
export interface PluginDeviceOwner {
  installationId: string;
  windowId: string;
  version: number;
}

/**
 * Trusted device capability on the client context. Present only on
 * clients with a local broker (desktop); undefined on browser and
 * mobile, where the plugin must report "unsupported" instead of
 * failing. The broker is app-owned with app lifetime: the plugin
 * subscribes in contribute() and releases everything in its cleanup.
 */
export interface PluginHidCapability {
  /** Null while the broker is unavailable; subscribe for readiness. */
  getBroker(): PluginHidBroker | null;
  subscribe(listener: (broker: PluginHidBroker | null) => void): () => void;
}
