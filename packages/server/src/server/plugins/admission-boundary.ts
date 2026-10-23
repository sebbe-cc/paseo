import { createHash } from "node:crypto";
import type { HostInventoryClock } from "./host-inventory-clock.js";
import type { HostWatermark } from "@getpaseo/plugin/server";
import { PluginAdmissionError } from "./lifecycle/index.js";

export type AdmissionPermit = <T>(effect: () => T) => T;

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

/** No lock spans a plugin callback. The read is bracketed by native generation
 * checks, then checked again at the synchronous provider dispatch point. The
 * original pending journal entry makes any in-flight effect visible to census.
 */
export async function admissionBoundary(
  clock: HostInventoryClock | undefined,
  read: () => Promise<unknown>,
): Promise<() => Promise<AdmissionPermit>> {
  const generation: HostWatermark | undefined = clock?.snapshot();
  const check = () => {
    if (!clock || !generation) return;
    const now = clock.snapshot();
    if (
      generation.activeWriters ||
      now.activeWriters ||
      generation.epoch !== now.epoch ||
      generation.sequence !== now.sequence
    )
      retry();
  };
  const original = digest(await read());
  check();
  return async () => {
    const current = digest(await read());
    if (original !== current) retry();
    check();
    let used = false;
    return (effect) => {
      const dispatch = () => {
        if (used) retry();
        check();
        used = true;
        return effect();
      };
      // Only the synchronous dispatch is protected, never the returned promise.
      try {
        return clock && generation ? clock.compare(generation, dispatch) : dispatch();
      } catch (error) {
        if ((error as { code?: string }).code === "ADMISSION_RETRY") retry();
        if ((error as { code?: string }).code === "HOST_FENCE_BUSY")
          throw new PluginAdmissionError(
            "HOST_FENCE_BUSY",
            "Publication is in progress; retry admission",
            "fence",
          );
        throw error;
      }
    };
  };
}
