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

/** No lock spans a plugin callback. Compare the original operation and binding,
 * not the host-wide sequence across the hook: hooks may acknowledge other
 * outcomes or refresh host metadata. Each read must itself be coherent, and the
 * final observation is checked again at synchronous provider dispatch. The
 * original pending journal entry keeps in-flight effects visible to census.
 */
export async function admissionBoundary(
  clock: HostInventoryClock | undefined,
  read: () => Promise<unknown>,
): Promise<() => Promise<AdmissionPermit>> {
  const check = (generation: HostWatermark | undefined) => {
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
  const originalGeneration = clock?.snapshot();
  const original = digest(await read());
  check(originalGeneration);
  return async () => {
    const generation = clock?.snapshot();
    if (originalGeneration?.epoch !== generation?.epoch) retry();
    const current = digest(await read());
    if (original !== current) retry();
    check(generation);
    let used = false;
    return (effect) => {
      const dispatch = () => {
        if (used) retry();
        check(generation);
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
