import { describe, expect, it, vi } from "vitest";
import { HidDeviceBroker } from "./broker.js";
import { HidDriverError } from "./driver.js";
import type { HidDriver, HidDriverDevice } from "./driver.js";
import type { HidDeviceOwner } from "./types.js";

interface FakeHandle {
  written: number[][];
  closed: boolean;
  openOpts: { nonExclusive: boolean } | null;
  emitData(data: number[]): void;
  emitError(error: Error): void;
  on(event: "data", listener: (data: number[]) => void): void;
  on(event: "error", listener: (error: Error) => void): void;
  write(data: number[]): number;
  close(): void;
}

function createFakeHandle(): FakeHandle {
  const dataListeners: Array<(data: number[]) => void> = [];
  const errorListeners: Array<(error: Error) => void> = [];
  const handle: FakeHandle = {
    written: [],
    closed: false,
    openOpts: null,
    on(event: "data" | "error", listener: (arg: never) => void): void {
      if (event === "data") dataListeners.push(listener as (data: number[]) => void);
      else errorListeners.push(listener as (error: Error) => void);
    },
    write(data: number[]): number {
      handle.written.push([...data]);
      return data.length;
    },
    close(): void {
      handle.closed = true;
    },
    emitData(data: number[]): void {
      for (const listener of dataListeners) listener(data);
    },
    emitError(error: Error): void {
      for (const listener of errorListeners) listener(error);
    },
  };
  return handle;
}

interface FakeDevice {
  key: string;
  path: string;
}

function deviceEntry(key: string, path: string): HidDriverDevice {
  return {
    info: {
      deviceKey: key,
      serial: key,
      vendorId: 0x303a,
      productId: 0x8298,
      usagePairs: [{ usagePage: 0xff00, usage: 0x01 }],
      reportInputBytes: 0,
      reportOutputBytes: 0,
    },
    path,
  };
}

function createFakeDriver(
  initialDevices: FakeDevice[] = [],
  hooks: { onOpen?: (path: string, opts: { nonExclusive: boolean }) => void } = {},
): {
  driver: HidDriver;
  handles: FakeHandle[];
  setDevices(devices: FakeDevice[]): void;
  failEnumerate(error: unknown): void;
} {
  let current = initialDevices;
  let enumerateFailure: unknown = null;
  const handles: FakeHandle[] = [];
  const driver: HidDriver = {
    enumerate(): HidDriverDevice[] {
      if (enumerateFailure) throw enumerateFailure;
      return current.map((device) => deviceEntry(device.key, device.path));
    },
    open(path: string, opts: { nonExclusive: boolean }) {
      hooks.onOpen?.(path, opts);
      const handle = createFakeHandle();
      handle.openOpts = opts;
      handles.push(handle);
      return handle;
    },
  };
  return {
    driver,
    handles,
    setDevices(next: FakeDevice[]): void {
      current = next;
    },
    failEnumerate(error: unknown): void {
      enumerateFailure = error;
    },
  };
}

function keysOf(devices: HidDriverDevice["info"][]): string {
  return devices.map((device) => device.deviceKey).join(",");
}

const OWNER_A: HidDeviceOwner = { installationId: "install-1", windowId: "w1", version: 1 };
const OWNER_B: HidDeviceOwner = { installationId: "install-1", windowId: "w2", version: 2 };

function sentTo(received: Array<{ id: number; channel: string; payload: unknown }>, id: number) {
  return received.filter((entry) => entry.id === id);
}

describe("hid device broker", () => {
  it("enumerates, opens, forwards input, writes output, and closes", () => {
    const fake = createFakeDriver([{ key: "serial-1", path: "/dev/hid-1" }]);
    const received: Array<{ id: number; channel: string; payload: unknown }> = [];
    const broker = new HidDeviceBroker({
      loadDriver: () => fake.driver,
      platform: "darwin",
      pollIntervalMs: 0,
      now: () => 1234,
      sendToWindow: (id, channel, payload) => {
        received.push({ id, channel, payload });
      },
    });

    expect(broker.refresh().status).toBe("ready");
    expect(broker.claim(OWNER_A, "serial-1", 11)).toEqual({ ok: true });
    expect(fake.handles).toHaveLength(1);

    fake.handles[0].emitData([6, 1, 2, 3]);
    const input = sentTo(received, 11);
    expect(input).toHaveLength(1);
    expect(input[0].channel).toBe("paseo:hid:input");
    expect(input[0].payload).toMatchObject({ deviceKey: "serial-1", reportId: 6, atMs: 1234 });

    expect(broker.write(OWNER_A, "serial-1", [0, 9, 9])).toEqual({ ok: true });
    expect(fake.handles[0].written).toEqual([[0, 9, 9]]);

    expect(broker.release(OWNER_A, "serial-1")).toBe(true);
    expect(fake.handles[0].closed).toBe(true);
    broker.dispose();
  });

  it("opens nonexclusive on darwin and exclusive elsewhere", () => {
    const seen: Array<{ nonExclusive: boolean }> = [];
    const fake = createFakeDriver([{ key: "s", path: "/p" }], {
      onOpen: (_path, opts) => {
        seen.push(opts);
      },
    });
    const mac = new HidDeviceBroker({
      loadDriver: () => fake.driver,
      platform: "darwin",
      pollIntervalMs: 0,
    });
    mac.refresh();
    expect(mac.claim(OWNER_A, "s", 1)).toEqual({ ok: true });
    const linux = new HidDeviceBroker({
      loadDriver: () => fake.driver,
      platform: "linux",
      pollIntervalMs: 0,
    });
    linux.refresh();
    expect(linux.claim(OWNER_A, "s", 2)).toEqual({ ok: true });
    expect(seen).toEqual([{ nonExclusive: true }, { nonExclusive: false }]);
    mac.dispose();
    linux.dispose();
  });

  it("emits hotplug changes and releases removed devices immediately", () => {
    const fake = createFakeDriver([{ key: "s-1", path: "/p1" }]);
    const snapshots: string[] = [];
    const broker = new HidDeviceBroker({ loadDriver: () => fake.driver, pollIntervalMs: 0 });
    broker.subscribe((event) => {
      if (event.devicesChanged) snapshots.push(keysOf(event.snapshot.devices));
    });
    broker.refresh();
    expect(broker.claim(OWNER_A, "s-1", 1)).toEqual({ ok: true });

    fake.setDevices([
      { key: "s-1", path: "/p1" },
      { key: "s-2", path: "/p2" },
    ]);
    broker.refresh();
    expect(snapshots.at(-1)).toBe("s-1,s-2");

    // Unplug while owned: the claim is released at once, the handle closed.
    fake.setDevices([]);
    broker.refresh();
    expect(snapshots.at(-1)).toBe("");
    expect(fake.handles[0].closed).toBe(true);
    // Reconnect under a new key can be claimed without a stale blocker.
    fake.setDevices([{ key: "s-1b", path: "/p1" }]);
    broker.refresh();
    expect(broker.claim(OWNER_A, "s-1b", 1)).toEqual({ ok: true });
    broker.dispose();
  });

  it("maps permission failures to denied and packaging failures to unavailable", () => {
    const denied = createFakeDriver();
    denied.failEnumerate(new HidDriverError("permission", "kIOReturnNotPermitted"));
    const deniedBroker = new HidDeviceBroker({
      loadDriver: () => denied.driver,
      pollIntervalMs: 0,
    });
    const deniedSnapshot = deniedBroker.refresh();
    expect(deniedSnapshot.status).toBe("denied");
    expect(deniedSnapshot.issue?.kind).toBe("permission");
    expect(deniedBroker.claim(OWNER_A, "x", 1).reason).toBe("open-failed");
    deniedBroker.dispose();

    const missing = new HidDeviceBroker({
      loadDriver: () => {
        throw new HidDriverError("packaging", "Cannot find module 'node-hid'");
      },
      pollIntervalMs: 0,
    });
    const missingSnapshot = missing.refresh();
    expect(missingSnapshot.status).toBe("unavailable");
    expect(missingSnapshot.issue?.kind).toBe("packaging");
    missing.dispose();
  });

  it("lets the same window reclaim after reload but refuses stale versions", () => {
    const fake = createFakeDriver([{ key: "s", path: "/p" }]);
    const broker = new HidDeviceBroker({ loadDriver: () => fake.driver, pollIntervalMs: 0 });
    broker.refresh();
    expect(broker.claim(OWNER_A, "s", 7)).toEqual({ ok: true });
    // Reload: same installation + window, new version.
    expect(broker.claim({ ...OWNER_A, version: 5 }, "s", 7)).toEqual({ ok: true });
    expect(fake.handles).toHaveLength(1);
    // Another window with an equal version is refused.
    expect(broker.claim(OWNER_B, "s", 8)).toEqual({ ok: false, reason: "owned-by-other" });
    broker.dispose();
  });

  it("moves ownership to a higher version and drops stale writes", () => {
    const fake = createFakeDriver([{ key: "s", path: "/p" }]);
    const received: Array<{ id: number; channel: string; payload: unknown }> = [];
    const broker = new HidDeviceBroker({
      loadDriver: () => fake.driver,
      platform: "linux",
      pollIntervalMs: 0,
      sendToWindow: (id, channel, payload) => {
        received.push({ id, channel, payload });
      },
    });
    broker.refresh();
    expect(broker.claim(OWNER_A, "s", 1)).toEqual({ ok: true });
    // Focus moved: window 2 claims with a higher version and wins.
    expect(broker.claim(OWNER_B, "s", 2)).toEqual({ ok: true });
    // The old owner is stale now: writes are refused, input goes to window 2.
    expect(broker.write(OWNER_A, "s", [1])).toEqual({ ok: false, reason: "not-owner" });
    expect(broker.write(OWNER_B, "s", [2])).toEqual({ ok: true });
    fake.handles.at(-1)?.emitData([6, 0]);
    expect(sentTo(received, 1)).toHaveLength(0);
    expect(sentTo(received, 2)).toHaveLength(1);
    broker.dispose();
  });

  it("keeps two devices on two windows independent", () => {
    const fake = createFakeDriver([
      { key: "s-1", path: "/p1" },
      { key: "s-2", path: "/p2" },
    ]);
    const received: Array<{ id: number; channel: string; payload: unknown }> = [];
    const broker = new HidDeviceBroker({
      loadDriver: () => fake.driver,
      pollIntervalMs: 0,
      sendToWindow: (id, channel, payload) => {
        received.push({ id, channel, payload });
      },
    });
    broker.refresh();
    expect(broker.claim(OWNER_A, "s-1", 1)).toEqual({ ok: true });
    expect(broker.claim(OWNER_B, "s-2", 2)).toEqual({ ok: true });
    fake.handles[0].emitData([1]);
    fake.handles[1].emitData([2]);
    expect(sentTo(received, 1)[0].payload).toMatchObject({ deviceKey: "s-1" });
    expect(sentTo(received, 2)[0].payload).toMatchObject({ deviceKey: "s-2" });
    expect(broker.ownedBy(1)).toEqual(["s-1"]);
    expect(broker.ownedBy(2)).toEqual(["s-2"]);
    // Closing window 1 releases only its own device.
    broker.removeWindow(1);
    expect(fake.handles[0].closed).toBe(true);
    expect(fake.handles[1].closed).toBe(false);
    expect(broker.ownedBy(2)).toEqual(["s-2"]);
    broker.dispose();
  });

  it("teardown closes every handle and stops polling", () => {
    vi.useFakeTimers();
    try {
      const fake = createFakeDriver([{ key: "s", path: "/p" }]);
      const enumerate = vi.spyOn(fake.driver, "enumerate");
      const broker = new HidDeviceBroker({ loadDriver: () => fake.driver, pollIntervalMs: 1000 });
      broker.start();
      broker.refresh();
      expect(broker.claim(OWNER_A, "s", 1)).toEqual({ ok: true });
      const calls = enumerate.mock.calls.length;
      broker.dispose();
      expect(fake.handles[0].closed).toBe(true);
      vi.advanceTimersByTime(5000);
      expect(enumerate.mock.calls.length).toBe(calls);
    } finally {
      vi.useRealTimers();
    }
  });
});
