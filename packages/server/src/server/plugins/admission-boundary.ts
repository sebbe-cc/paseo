import { createHash } from "node:crypto";
import type { HostInventoryClock } from "./host-inventory-clock.js";
import { PluginAdmissionError } from "./lifecycle/index.js";

export type AdmissionPermit = <T>(effect: () => T) => T;
export interface AdmissionObservation {
  value: unknown;
  busy: boolean;
}

function retry(): never {
  throw new PluginAdmissionError(
    "ADMISSION_RETRY",
    "Host state changed during admission; retry before starting a provider effect",
    "fence",
  );
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** No lock spans a plugin callback. Synchronous observations of the committed
 * operation/binding and their pending mutations are coherent on the host event
 * loop. Never compare a host-wide sequence across an await: another admission
 * or timeline writer does not change this operation's authority. Recheck the
 * same observation under SH at one-use dispatch, before any provider effect.
 */
export async function admissionBoundary(
  clock: HostInventoryClock | undefined,
  read: () => AdmissionObservation,
): Promise<() => Promise<AdmissionPermit>> {
  const observe = () => {
    const observation = read();
    if (observation.busy) retry();
    return digest(observation.value);
  };
  const guarded = <T>(action: () => T): T => {
    try {
      return clock ? clock.admission(action) : action();
    } catch (error) {
      if ((error as { code?: string }).code === "HOST_FENCE_BUSY")
        throw new PluginAdmissionError(
          "HOST_FENCE_BUSY",
          "Publication is in progress; retry admission",
          "fence",
        );
      throw error;
    }
  };
  const original = guarded(observe);
  const check = () => {
    if (observe() !== original) retry();
  };
  return async () => {
    guarded(check);
    let used = false;
    return (effect) =>
      guarded(() => {
        if (used) retry();
        check();
        used = true;
        return effect();
      });
  };
}
