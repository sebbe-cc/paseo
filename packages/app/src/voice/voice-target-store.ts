import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { z } from "zod";
import { createValidatedPersistStorage } from "@/storage/validated-persist-storage";

export const VoiceTargetSchema = z.object({
  serverId: z.string().min(1),
  agentId: z.string().min(1),
  title: z.string().min(1),
});
export type VoiceTarget = z.infer<typeof VoiceTargetSchema>;
interface VoiceTargetState {
  target: VoiceTarget | null;
  setTarget(target: VoiceTarget): void;
}

/** Only the recipient is persisted. Microphone activation always requires a user action. */
export const useVoiceTargetStore = create<VoiceTargetState>()(
  persist((set) => ({ target: null, setTarget: (target) => set({ target }) }), {
    name: "global-voice-target",
    storage: createValidatedPersistStorage(
      AsyncStorage,
      z.object({ target: VoiceTargetSchema.nullable() }),
    ),
    partialize: (state) => ({ target: state.target }),
  }),
);
