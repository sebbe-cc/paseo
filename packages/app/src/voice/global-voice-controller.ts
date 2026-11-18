import type { VoiceRuntime } from "./voice-runtime";
import type { VoiceTarget } from "./voice-target-store";

/** Selecting an idle recipient never opens the microphone; a live call switches immediately. */
export async function selectVoiceTarget(
  runtime: VoiceRuntime,
  target: VoiceTarget,
  save: (target: VoiceTarget) => void,
): Promise<void> {
  if (runtime.getSnapshot().isVoiceSwitching) return;
  save(target);
  if (
    runtime.getSnapshot().isVoiceMode &&
    !runtime.isVoiceModeForAgent(target.serverId, target.agentId)
  ) {
    await runtime.startVoice(target.serverId, target.agentId);
  }
}

export async function toggleGlobalVoice(
  runtime: VoiceRuntime,
  target: VoiceTarget | null,
): Promise<void> {
  if (runtime.getSnapshot().isVoiceSwitching) return;
  if (runtime.getSnapshot().isVoiceMode) await runtime.stopVoice();
  else if (target) await runtime.startVoice(target.serverId, target.agentId);
}
