// node-hid driver (pa-yi0bsm). Main-side only: lazy native load, so a
// missing or unloadable module degrades to an "unavailable" broker
// state instead of crashing startup. N-API prebuilds load under both
// Node and Electron, so no Electron ABI rebuild is needed; the only
// packaged-app requirements are the asar-unpacked .node binary and a
// valid signature (see electron-builder.yml + after-sign).

import type { HidBrokerIssue, HidBrokerIssueKind, HidDeviceInfo, HidUsagePair } from "./types.js";

export interface HidNativeDevice {
  vendorId?: unknown;
  productId?: unknown;
  path?: unknown;
  serialNumber?: unknown;
  usagePage?: unknown;
  usage?: unknown;
}

export interface HidNativeHandle {
  on(event: "data", listener: (data: number[]) => void): void;
  on(event: "error", listener: (error: Error) => void): void;
  write(data: number[]): number;
  close(): void;
}

export interface HidNativeModule {
  devices(): HidNativeDevice[];
  HID: new (path: string, options?: { nonExclusive?: boolean }) => HidNativeHandle;
}

export class HidDriverError extends Error {
  readonly kind: HidBrokerIssueKind;

  constructor(kind: HidBrokerIssueKind, message: string) {
    super(message);
    this.name = "HidDriverError";
    this.kind = kind;
  }

  toIssue(): HidBrokerIssue {
    return { kind: this.kind, message: this.message };
  }
}

const PERMISSION_PATTERN =
  /kIOReturnNotPermitted|not permitted|EPERM|EACCES|access denied|permission|Input Monitoring/i;
const PACKAGING_PATTERN =
  /Cannot find module|MODULE_NOT_FOUND|was compiled against|NODE_MODULE_VERSION|code signature|not signed|asar|Invalid ELF|libusb|libudev/i;

/** Maps a native failure to a concrete diagnosis instead of a vague "could not open". */
export function classifyHidError(error: unknown): HidBrokerIssueKind {
  const message = error instanceof Error ? error.message : String(error);
  if (PERMISSION_PATTERN.test(message)) return "permission";
  if (PACKAGING_PATTERN.test(message)) return "packaging";
  return "other";
}

export function toHidDriverError(error: unknown): HidDriverError {
  if (error instanceof HidDriverError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new HidDriverError(classifyHidError(error), message);
}

function toUsagePairs(device: HidNativeDevice): HidUsagePair[] {
  if (typeof device.usagePage !== "number" || typeof device.usage !== "number") return [];
  if (!Number.isInteger(device.usagePage) || !Number.isInteger(device.usage)) return [];
  if (device.usagePage < 0 || device.usage < 0) return [];
  return [{ usagePage: device.usagePage, usage: device.usage }];
}

function toDeviceKey(device: HidNativeDevice, vendorId: number, productId: number): string | null {
  if (typeof device.serialNumber === "string" && device.serialNumber.length > 0) {
    return device.serialNumber;
  }
  if (typeof device.path === "string" && device.path.length > 0) {
    return device.path;
  }
  return `vid:${vendorId}/pid:${productId}`;
}

export interface HidDriverDevice {
  info: HidDeviceInfo;
  /** OS path for open(); devices without one are never listed. */
  path: string;
}

export interface HidDriver {
  enumerate(): HidDriverDevice[];
  open(path: string, opts: { nonExclusive: boolean }): HidNativeHandle;
}

export interface NodeHidDriverDeps {
  loadModule?: () => unknown;
  platform?: NodeJS.Platform;
}

function readNativeModule(loadModule: (() => unknown) | undefined): HidNativeModule {
  const load =
    loadModule ??
    (() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const req = typeof require === "function" ? require : null;
      if (!req) throw new Error("Cannot find module 'node-hid' (no require in this runtime)");
      return req("node-hid") as unknown;
    });
  let loaded: unknown;
  try {
    loaded = load();
  } catch (error) {
    throw new HidDriverError("packaging", error instanceof Error ? error.message : String(error));
  }
  if (
    typeof loaded !== "object" ||
    loaded === null ||
    typeof (loaded as { devices?: unknown }).devices !== "function" ||
    typeof (loaded as { HID?: unknown }).HID !== "function"
  ) {
    throw new HidDriverError("packaging", "node-hid module has no devices()/HID API");
  }
  return loaded as HidNativeModule;
}

/**
 * Driver backed by node-hid, loaded lazily on first use. Throws
 * HidDriverError with kind "packaging" when the native module cannot
 * load, "permission" when the OS denies access, and "other" for the
 * rest (busy device, unplugged mid-open, ...).
 */
export function createNodeHidDriver(deps?: NodeHidDriverDeps): HidDriver {
  let cached: HidNativeModule | null = null;
  const module = (): HidNativeModule => {
    if (!cached) cached = readNativeModule(deps?.loadModule);
    return cached;
  };

  return {
    enumerate(): HidDriverDevice[] {
      let native: HidNativeDevice[];
      try {
        native = module().devices();
      } catch (error) {
        throw toHidDriverError(error);
      }
      const found: HidDriverDevice[] = [];
      for (const device of native) {
        if (typeof device.vendorId !== "number" || typeof device.productId !== "number") continue;
        if (typeof device.path !== "string" || device.path.length === 0) continue;
        const key = toDeviceKey(device, device.vendorId, device.productId);
        if (!key) continue;
        found.push({
          info: {
            deviceKey: key,
            serial: typeof device.serialNumber === "string" ? device.serialNumber : null,
            vendorId: device.vendorId,
            productId: device.productId,
            usagePairs: toUsagePairs(device),
            reportInputBytes: 0,
            reportOutputBytes: 0,
          },
          path: device.path,
        });
      }
      return found;
    },

    open(path: string, opts: { nonExclusive: boolean }): HidNativeHandle {
      try {
        const Handle = module().HID;
        return new Handle(path, { nonExclusive: opts.nonExclusive });
      } catch (error) {
        throw toHidDriverError(error);
      }
    },
  };
}

/** Nonexclusive open policy: shared access on macOS, exclusive elsewhere. */
export function nonExclusiveForPlatform(platform: NodeJS.Platform): boolean {
  return platform === "darwin";
}
