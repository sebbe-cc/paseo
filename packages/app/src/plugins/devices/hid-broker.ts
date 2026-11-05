// App-side device (HID) broker (pa-yi0bsm). Wraps the Electron
// preload bridge (`paseoDesktop.hid`) in the generic plugin broker
// shape. Null when the capability is missing (browser, mobile) — the
// plugin then reports "unsupported" and stays a no-op.
//
// Claims are explicit per device (never auto-claimed): the plugin
// passes its vendor usage filter before claiming, so the broker
// never opens keyboards or mice just by existing. Control decoding
// is vendor-specific and lives in the plugin; this broker forwards
// raw reports only.

import type {
  PluginHidBroker,
  PluginHidBrokerState,
  PluginHidDeviceInfo,
  PluginHidRawReport,
} from "@getpaseo/plugin/client";
import type { DesktopHidBridge, DesktopHidSnapshot, DesktopHostBridge } from "@/desktop/host";

export interface HidBrokerOwnerSource {
  getOwner(): { installationId: string; windowId: string; version: number } | null;
}

export type HidBrokerHost = Pick<DesktopHostBridge, "hid">;

function isValidDevice(value: unknown): value is PluginHidDeviceInfo {
  if (typeof value !== "object" || value === null) return false;
  const device = value as Record<string, unknown>;
  return (
    typeof device.deviceKey === "string" &&
    device.deviceKey.length > 0 &&
    (typeof device.serial === "string" || device.serial === null) &&
    typeof device.vendorId === "number" &&
    typeof device.productId === "number" &&
    Array.isArray(device.usagePairs) &&
    typeof device.reportInputBytes === "number" &&
    typeof device.reportOutputBytes === "number"
  );
}

/** Honest Swedish diagnosis for a main-side broker issue. */
export function hidIssueDiagnosis(issue: {
  kind: "permission" | "packaging" | "other";
  message: string;
}): string {
  if (issue.kind === "permission") {
    return (
      `Operativsystemet nekade HID-åtkomst (${issue.message}). Ge Paseo "Input Monitoring" ` +
      `i Systeminställningar → Integritet och säkerhet och anslut enheten igen. ` +
      `Inga knapptryck är lästa.`
    );
  }
  if (issue.kind === "packaging") {
    return (
      `Native HID-modulen kunde inte laddas i den paketerade appen (${issue.message}). ` +
      `Kontrollera att Paseo är installerat från den signerade releasen (Electron ABI, ` +
      `signering, asar-unpacked) och rapportera appversionen. Inga knapptryck är lästa.`
    );
  }
  return (
    `HID-brokern är otillgänglig (${issue.message}). Anslut enheten igen; ` +
    `kvarstår felet behövs forkbygge/deploy via mayorn. Inga knapptryck är lästa.`
  );
}

export function hidUnsupportedState(context: string): PluginHidBrokerState {
  return {
    status: "unsupported",
    context: `${context}: denna appversion saknar HID-capability. Inga knapptryck eller ljus är fysiskt bevisade.`,
  };
}

function snapshotOf(snapshot: DesktopHidSnapshot): PluginHidBrokerState {
  if (snapshot.status === "ready") {
    return { status: "ready", devices: snapshot.devices.filter(isValidDevice) };
  }
  if (snapshot.status === "denied") {
    return {
      status: "denied",
      diagnosis: hidIssueDiagnosis(snapshot.issue ?? { kind: "permission", message: "okänd" }),
    };
  }
  return {
    status: "unavailable",
    diagnosis: hidIssueDiagnosis(snapshot.issue ?? { kind: "other", message: "okänd" }),
  };
}

/**
 * App-owned broker with cleanup. Null when the host has no HID
 * capability (browser, mobile) — the plugin then reports
 * "unsupported" and stays a no-op. Hand `handle.broker` to the
 * plugin in contribute() and call `handle.dispose()` in the entry
 * cleanup: it releases every device this broker claimed and removes
 * all host subscriptions.
 */
export function createHidBrokerHandle(
  host: HidBrokerHost | null | undefined,
  owners: HidBrokerOwnerSource,
): HidBrokerHandle | null {
  const bridge: DesktopHidBridge | undefined = host?.hid;
  if (!bridge?.enumerate || !bridge.claim || !bridge.release || !bridge.onDevicesChanged) {
    return null;
  }
  const enumerate = bridge.enumerate;
  const claimDevice = bridge.claim;
  const releaseDevice = bridge.release;
  const writeDevice = bridge.write;
  const onDevicesChanged = bridge.onDevicesChanged;
  const onInput = bridge.onInput;

  let disposed = false;
  let state: PluginHidBrokerState = {
    status: "unavailable",
    diagnosis: "HID-brokern startar. Inga knapptryck är lästa.",
  };
  const listeners = new Set<(state: PluginHidBrokerState) => void>();
  const rawListeners = new Set<(report: PluginHidRawReport) => void>();
  const claimed = new Set<string>();

  const emit = () => {
    for (const listener of listeners) listener(state);
  };

  const refresh = async (): Promise<void> => {
    if (disposed) return;
    let snapshot: DesktopHidSnapshot;
    try {
      snapshot = await enumerate();
    } catch (error) {
      state = {
        status: "unavailable",
        diagnosis: hidIssueDiagnosis({
          kind: "other",
          message: error instanceof Error ? error.message : String(error),
        }),
      };
      emit();
      return;
    }
    if (disposed) return;
    state = snapshotOf(snapshot);
    emit();
  };

  const stopDevices = onDevicesChanged(() => {
    void refresh();
  });
  const stopInput = onInput
    ? onInput((report) => {
        if (disposed) return;
        const raw: PluginHidRawReport = {
          deviceKey: report.deviceKey,
          reportId: report.reportId,
          data: [...report.data],
          atMs: report.atMs,
        };
        for (const listener of rawListeners) listener(raw);
      })
    : undefined;

  void refresh();

  const broker: PluginHidBroker = {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    enumerate: async () => {
      await refresh();
      return state.status === "ready" ? state.devices : [];
    },
    // Control decoding is vendor-specific (plugin decoder, pa-el0pt);
    // the generic broker forwards raw reports only.
    onRawReport: onInput
      ? (listener) => {
          rawListeners.add(listener);
          return () => {
            rawListeners.delete(listener);
          };
        }
      : undefined,
    write: writeDevice
      ? async (deviceKey, data) => {
          const owner = owners.getOwner();
          if (!owner) throw new Error("HID-brokern är inte redo: ingen ägaridentitet");
          const result = await writeDevice({ ...owner, deviceKey, data: [...data] });
          if (!result.ok) {
            throw new Error(`HID-skrivning misslyckades (${result.reason ?? "okänt fel"})`);
          }
        }
      : undefined,
    claim: async (deviceKey) => {
      const owner = owners.getOwner();
      if (!owner || disposed) return false;
      const result = await claimDevice({ ...owner, deviceKey });
      if (result.ok) claimed.add(deviceKey);
      return result.ok;
    },
    release: async (deviceKey) => {
      const owner = owners.getOwner();
      claimed.delete(deviceKey);
      if (!owner || disposed) return;
      await releaseDevice({ ...owner, deviceKey });
    },
  };

  return {
    broker,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      stopDevices();
      stopInput?.();
      listeners.clear();
      rawListeners.clear();
      const owner = owners.getOwner();
      const releases = [...claimed];
      claimed.clear();
      if (!owner) return;
      void (async () => {
        for (const deviceKey of releases) {
          try {
            await releaseDevice({ ...owner, deviceKey });
          } catch {
            // Teardown releases best-effort; the window close drops the rest.
          }
        }
      })();
    },
  };
}

export interface HidBrokerHandle {
  broker: PluginHidBroker;
  /** Releases every own claim and removes all subscriptions. */
  dispose(): void;
}
