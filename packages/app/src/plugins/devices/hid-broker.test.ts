import { describe, expect, it, vi } from "vitest";
import { createHidBrokerHandle, hidIssueDiagnosis, hidUnsupportedState } from "./hid-broker";
import type { DesktopHidBridge, DesktopHidSnapshot } from "@/desktop/host";

function validDevice(deviceKey = "serial-1") {
  return {
    deviceKey,
    serial: deviceKey,
    vendorId: 0x303a,
    productId: 0x8298,
    usagePairs: [{ usagePage: 0xff00, usage: 0x01 }],
    reportInputBytes: 0,
    reportOutputBytes: 0,
  };
}

interface FakeBridge extends DesktopHidBridge {
  devicesChanged: Array<(snapshot: DesktopHidSnapshot) => void>;
  inputListeners: Array<
    (report: { deviceKey: string; reportId: number; data: number[]; atMs: number }) => void
  >;
  claimed: string[];
  released: string[];
  writes: Array<{ deviceKey: string; data: number[] }>;
  snapshot: DesktopHidSnapshot;
  failEnumerateWith: unknown;
}

function createFakeBridge(snapshot?: Partial<DesktopHidSnapshot>): FakeBridge {
  const bridge = {
    devicesChanged: [],
    inputListeners: [],
    claimed: [],
    released: [],
    writes: [],
    snapshot: {
      status: "ready",
      devices: [validDevice()],
      ...snapshot,
    } as DesktopHidSnapshot,
    failEnumerateWith: null as unknown,
    identity: async () => ({ windowId: "w1" }),
    enumerate: async function (this: FakeBridge) {
      if (this.failEnumerateWith) throw this.failEnumerateWith;
      return this.snapshot;
    },
    claim: async function (this: FakeBridge, input: { deviceKey: string }) {
      this.claimed.push(input.deviceKey);
      return { ok: true as const };
    },
    release: async function (this: FakeBridge, input: { deviceKey: string }) {
      this.released.push(input.deviceKey);
      return true;
    },
    write: async function (this: FakeBridge, input: { deviceKey: string; data: number[] }) {
      this.writes.push({ deviceKey: input.deviceKey, data: input.data });
      return { ok: true as const };
    },
    onDevicesChanged: function (this: FakeBridge, handler: (snapshot: DesktopHidSnapshot) => void) {
      this.devicesChanged.push(handler);
      return () => {
        this.devicesChanged = this.devicesChanged.filter((entry) => entry !== handler);
      };
    },
    onInput: function (
      this: FakeBridge,
      handler: (report: {
        deviceKey: string;
        reportId: number;
        data: number[];
        atMs: number;
      }) => void,
    ) {
      this.inputListeners.push(handler);
      return () => {
        this.inputListeners = this.inputListeners.filter((entry) => entry !== handler);
      };
    },
  } as unknown as FakeBridge;
  bridge.enumerate = bridge.enumerate!.bind(bridge);
  bridge.claim = bridge.claim!.bind(bridge);
  bridge.release = bridge.release!.bind(bridge);
  bridge.write = bridge.write!.bind(bridge);
  bridge.onDevicesChanged = bridge.onDevicesChanged!.bind(bridge);
  bridge.onInput = bridge.onInput!.bind(bridge);
  return bridge;
}

const OWNER = { installationId: "install-1", windowId: "w1", version: 1 };
const owners = (owner: typeof OWNER | null = OWNER) => ({ getOwner: () => owner });

async function settled() {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("app hid broker", () => {
  it("is null without the capability (browser, mobile)", () => {
    expect(createHidBrokerHandle(null, owners())).toBeNull();
    expect(createHidBrokerHandle(undefined, owners())).toBeNull();
    expect(createHidBrokerHandle({}, owners())).toBeNull();
    expect(createHidBrokerHandle({ hid: {} }, owners())).toBeNull();
  });

  it("reports ready with validated devices and drops invalid entries", async () => {
    const bridge = createFakeBridge({
      status: "ready",
      devices: [validDevice("good"), { bogus: true }, { ...validDevice("bad"), vendorId: "x" }],
    } as unknown as DesktopHidSnapshot);
    const handle = createHidBrokerHandle({ hid: bridge }, owners());
    expect(handle).not.toBeNull();
    const devices = await handle!.broker.enumerate!();
    expect(devices.map((device) => device.deviceKey)).toEqual(["good"]);
    expect(handle!.broker.getState()).toMatchObject({ status: "ready" });
    // Control decoding is vendor-specific: the generic broker has no onControl.
    expect(handle!.broker.onControl).toBeUndefined();
    expect(handle!.broker.onRawReport).toBeDefined();
    handle!.dispose();
  });

  it("maps denial and packaging failures to honest Swedish diagnoses", async () => {
    const denied = createFakeBridge({
      status: "denied",
      devices: [],
      issue: { kind: "permission", message: "kIOReturnNotPermitted" },
    });
    const deniedHandle = createHidBrokerHandle({ hid: denied }, owners());
    await deniedHandle!.broker.enumerate!();
    const deniedState = deniedHandle!.broker.getState();
    expect(deniedState.status).toBe("denied");
    if (deniedState.status === "denied") {
      expect(deniedState.diagnosis).toContain("Input Monitoring");
      expect(deniedState.diagnosis).toContain("Inga knapptryck är lästa");
    }
    deniedHandle!.dispose();

    // The main side classifies native load failures as packaging issues.
    const broken = createFakeBridge({
      status: "unavailable",
      devices: [],
      issue: { kind: "packaging", message: "Cannot find module 'node-hid'" },
    });
    const brokenHandle = createHidBrokerHandle({ hid: broken }, owners());
    await brokenHandle!.broker.enumerate!();
    const brokenState = brokenHandle!.broker.getState();
    expect(brokenState.status).toBe("unavailable");
    if (brokenState.status === "unavailable") {
      expect(brokenState.diagnosis).toContain("asar-unpacked");
    }
    brokenHandle!.dispose();

    // A transport-level enumerate failure stays an honest "other".
    const dropped = createFakeBridge();
    dropped.failEnumerateWith = new Error("IPC timeout");
    const droppedHandle = createHidBrokerHandle({ hid: dropped }, owners());
    await droppedHandle!.broker.enumerate!();
    expect(droppedHandle!.broker.getState()).toMatchObject({ status: "unavailable" });
    droppedHandle!.dispose();

    expect(hidUnsupportedState("test").status).toBe("unsupported");
    expect(hidIssueDiagnosis({ kind: "other", message: "x" })).toContain("mayorn");
  });

  it("claims and releases with the app owner, and writes through", async () => {
    const bridge = createFakeBridge();
    const handle = createHidBrokerHandle({ hid: bridge }, owners());
    await handle!.broker.enumerate!();
    expect(await handle!.broker.claim!("serial-1")).toBe(true);
    expect(bridge.claimed).toEqual(["serial-1"]);
    await handle!.broker.write!("serial-1", [0, 1, 2]);
    expect(bridge.writes).toEqual([{ deviceKey: "serial-1", data: [0, 1, 2] }]);
    await handle!.broker.release!("serial-1");
    expect(bridge.released).toEqual(["serial-1"]);
    handle!.dispose();
  });

  it("refuses claims without an owner identity and throws on refused writes", async () => {
    const bridge = createFakeBridge();
    const handle = createHidBrokerHandle({ hid: bridge }, owners(null));
    expect(await handle!.broker.claim!("serial-1")).toBe(false);
    await expect(handle!.broker.write!("serial-1", [0])).rejects.toThrow("ägaridentitet");
    handle!.dispose();

    const refusing = createFakeBridge();
    refusing.claim = (async () => ({ ok: false as const, reason: "owned-by-other" })) as never;
    const refusingHandle = createHidBrokerHandle({ hid: refusing }, owners());
    expect(await refusingHandle!.broker.claim!("serial-1")).toBe(false);
    refusingHandle!.dispose();
  });

  it("forwards raw input reports to plugin subscribers", async () => {
    const bridge = createFakeBridge();
    const handle = createHidBrokerHandle({ hid: bridge }, owners());
    const seen: Array<{ deviceKey: string; reportId: number }> = [];
    const stop = handle!.broker.onRawReport!((report) => {
      seen.push({ deviceKey: report.deviceKey, reportId: report.reportId });
    });
    await handle!.broker.enumerate!();
    for (const listener of bridge.inputListeners) {
      listener({ deviceKey: "serial-1", reportId: 6, data: [6, 9], atMs: 42 });
    }
    expect(seen).toEqual([{ deviceKey: "serial-1", reportId: 6 }]);
    stop();
    handle!.dispose();
  });

  it("reloads the device list on host hotplug events", async () => {
    const bridge = createFakeBridge();
    const handle = createHidBrokerHandle({ hid: bridge }, owners());
    await handle!.broker.enumerate!();
    const states: string[] = [];
    handle!.broker.subscribe((state) => states.push(state.status));
    bridge.snapshot = {
      status: "ready",
      devices: [validDevice("serial-1"), validDevice("serial-2")],
    };
    for (const listener of bridge.devicesChanged) listener(bridge.snapshot);
    await settled();
    expect(handle!.broker.getState()).toMatchObject({ status: "ready" });
    const state = handle!.broker.getState();
    if (state.status === "ready") {
      expect(state.devices).toHaveLength(2);
    }
    expect(states).toContain("ready");
    handle!.dispose();
  });

  it("teardown releases claimed devices and removes host subscriptions", async () => {
    const bridge = createFakeBridge();
    const handle = createHidBrokerHandle({ hid: bridge }, owners());
    await handle!.broker.enumerate!();
    await handle!.broker.claim!("serial-1");
    const listenersBefore = bridge.devicesChanged.length;
    expect(listenersBefore).toBeGreaterThan(0);
    handle!.dispose();
    await settled();
    expect(bridge.released).toEqual(["serial-1"]);
    expect(bridge.devicesChanged).toHaveLength(0);
    expect(bridge.inputListeners).toHaveLength(0);
  });

  it("keeps two broker instances independent", async () => {
    const first = createFakeBridge();
    const second = createFakeBridge();
    const firstHandle = createHidBrokerHandle({ hid: first }, owners());
    const secondHandle = createHidBrokerHandle(
      { hid: second },
      owners({ installationId: "install-1", windowId: "w2", version: 2 }),
    );
    await firstHandle!.broker.enumerate!();
    await secondHandle!.broker.enumerate!();
    await firstHandle!.broker.claim!("serial-1");
    expect(first.claimed).toEqual(["serial-1"]);
    expect(second.claimed).toEqual([]);
    firstHandle!.dispose();
    secondHandle!.dispose();
    expect(first.released).toEqual(["serial-1"]);
    expect(second.released).toEqual([]);
  });

  it("supports spies on the broker surface", () => {
    const bridge = createFakeBridge();
    const handle = createHidBrokerHandle({ hid: bridge }, owners());
    const spy = vi.fn();
    const stop = handle!.broker.subscribe(spy);
    stop();
    handle!.dispose();
  });
});
