import type { AgentSkillSelection } from "@getpaseo/protocol/messages";
import type { Logger } from "pino";

import type { DaemonConfigStore } from "../daemon-config-store.js";
import {
  createSkillsController,
  type SkillsController,
  type SkillsSaveResult,
  type SkillsSnapshot,
} from "./internal/controller.js";
import { resolveSkillTargets } from "./internal/paths.js";
import { createSkillSelectionStore } from "./internal/selection-store.js";
import { isSkillTargetReadOnlyError } from "./internal/sync.js";

export interface OrchestrationSkills {
  getStatus(): Promise<SkillsSnapshot>;
  reconcile(): Promise<SkillsSnapshot>;
  uninstall(): Promise<SkillsSnapshot>;
  saveSelection(
    selection: AgentSkillSelection,
    confirmedRemovals?: readonly string[],
  ): Promise<SkillsSaveResult>;
  importLegacySelectionIfUnset(selection: AgentSkillSelection): Promise<{
    imported: boolean;
    selection: AgentSkillSelection;
  }>;
  autoUpdate(): Promise<SkillsSnapshot>;
}

export function createOrchestrationSkills(
  configStore: DaemonConfigStore,
  resolveTargets = resolveSkillTargets,
): OrchestrationSkills {
  const controller: SkillsController = createSkillsController({
    resolveTargets,
    selectionStore: createSkillSelectionStore(configStore),
  });
  return {
    getStatus: () => controller.status(),
    reconcile: () => controller.update(),
    uninstall: () => controller.uninstall(),
    saveSelection: (selection, confirmedRemovals = []) =>
      controller.save({ ...selection, confirmedRemovals }),
    importLegacySelectionIfUnset: (selection) => controller.importLegacySelectionIfUnset(selection),
    autoUpdate: () => controller.autoUpdate(),
  };
}

export type { SkillsSaveResult, SkillsSnapshot } from "./internal/controller.js";
export {
  isSkillTargetReadOnlyError,
  SkillTargetReadOnlyError,
  type ReadOnlySkillTarget,
} from "./internal/sync.js";

/**
 * Startup maintenance failure reporting: a read-only skill catalog (for
 * example the home-manager-owned ~/.agents/skills symlinked into the nix
 * store) is an expected fleet state, so it logs at info level instead of the
 * error that trips the deploy check. Anything else still logs as an error.
 */
export function reportSkillsMaintenanceFailure(
  logger: Pick<Logger, "info" | "error">,
  error: unknown,
): void {
  if (isSkillTargetReadOnlyError(error)) {
    const detail = error.targets.map((t) => `${t.skillName} in ${t.targetDir}`).join("; ");
    logger.info(
      { err: error },
      `Skipping orchestration skills maintenance: read-only skill targets (${detail})`,
    );
    return;
  }
  logger.error({ err: error }, "Failed to maintain orchestration skills at startup");
}
