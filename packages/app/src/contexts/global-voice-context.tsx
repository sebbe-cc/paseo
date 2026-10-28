import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { useVoice, useVoiceRuntimeOptional } from "./voice-context";
import { useToast } from "./toast-context";
import { useSessionStore } from "@/stores/session-store";
import { useKeyboardActionDispatcher } from "@/keyboard/keyboard-action-dispatcher-context";
import { selectVoiceTarget, toggleGlobalVoice } from "@/voice/global-voice-controller";
import { useVoiceTargetStore, type VoiceTarget } from "@/voice/voice-target-store";

interface GlobalVoiceValue {
  active: boolean;
  busy: boolean;
  muted: boolean;
  hasTarget: boolean;
  label: string;
  toggle(): void;
}
const GlobalVoiceContext = createContext<GlobalVoiceValue | null>(null);
const SelectVoiceTargetContext = createContext<((target: VoiceTarget) => Promise<void>) | null>(
  null,
);
export function useGlobalVoice() {
  return useContext(GlobalVoiceContext);
}
export function useSelectVoiceTarget() {
  return useContext(SelectVoiceTargetContext);
}

export function GlobalVoiceProvider({ children }: { children: ReactNode }) {
  const voice = useVoice();
  const runtime = useVoiceRuntimeOptional()!;
  const toast = useToast();
  const { t } = useTranslation();
  const target = useVoiceTargetStore((state) => state.target);
  const activeName = useSessionStore((state) => {
    const session = voice.activeServerId ? state.sessions[voice.activeServerId] : null;
    const agent = voice.activeAgentId
      ? (session?.agents.get(voice.activeAgentId) ?? session?.agentDetails.get(voice.activeAgentId))
      : null;
    return agent?.title ?? null;
  });
  const reportError = useCallback(
    (error: unknown) => toast.error(error instanceof Error ? error.message : String(error)),
    [toast],
  );
  const choose = useCallback(
    async (recipient: VoiceTarget) => {
      try {
        await selectVoiceTarget(runtime, recipient, useVoiceTargetStore.getState().setTarget);
      } catch (error) {
        reportError(error);
      }
    },
    [runtime, reportError],
  );
  const toggle = useCallback(() => {
    void toggleGlobalVoice(runtime, useVoiceTargetStore.getState().target).catch(reportError);
  }, [runtime, reportError]);
  const matchesTarget =
    target?.serverId === voice.activeServerId && target?.agentId === voice.activeAgentId;
  let name = target?.title ?? "";
  if (voice.isVoiceMode) name = activeName || (matchesTarget ? name : t("globalVoice.agent"));
  let label = t("globalVoice.choose");
  if (target || voice.isVoiceMode) {
    label = t("globalVoice.off", { name });
    if (voice.isVoiceMode)
      label = t(voice.isMuted ? "globalVoice.muted" : "globalVoice.active", { name });
    if (voice.isVoiceSwitching) label = t("globalVoice.connecting", { name });
  }
  const value = useMemo<GlobalVoiceValue>(
    () => ({
      active: voice.isVoiceMode,
      busy: voice.isVoiceSwitching,
      muted: voice.isMuted,
      hasTarget: Boolean(target),
      label,
      toggle,
    }),
    [voice.isVoiceMode, voice.isVoiceSwitching, voice.isMuted, target, label, toggle],
  );
  const valueRef = useRef(value);
  valueRef.current = value;
  const dispatcher = useKeyboardActionDispatcher();
  useEffect(
    () =>
      dispatcher.registerHandler({
        handlerId: "global-voice",
        actions: ["voice.global.toggle"],
        enabled: true,
        priority: 10,
        handle() {
          const current = valueRef.current;
          if (!current.hasTarget && !current.active) return false;
          current.toggle();
          return true;
        },
      }),
    [dispatcher],
  );
  return (
    <SelectVoiceTargetContext.Provider value={choose}>
      <GlobalVoiceContext.Provider value={value}>{children}</GlobalVoiceContext.Provider>
    </SelectVoiceTargetContext.Provider>
  );
}

/** Stable action shared by tab menus and /voice-target, independent of composer busy state. */
export function useMakeVoiceTarget(serverId: string) {
  const choose = useSelectVoiceTarget();
  const makeTarget = useCallback(
    async (agentId: string) => {
      if (!choose) throw new Error("Global voice is unavailable");
      const session = useSessionStore.getState().getSession(serverId);
      const agent = session?.agents.get(agentId) ?? session?.agentDetails.get(agentId);
      await choose({ serverId, agentId, title: agent?.title || agentId });
    },
    [choose, serverId],
  );
  return choose ? makeTarget : null;
}
