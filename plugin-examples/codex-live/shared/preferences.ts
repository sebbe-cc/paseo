import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

// Codex rust-v0.163.0 RealtimeVoicesList.v3 (FramelessBidi), not Realtime V2.
export const VoiceSchema = z.enum([
  "juniper",
  "maple",
  "spruce",
  "ember",
  "vale",
  "breeze",
  "arbor",
  "sol",
  "cove",
  "aube",
  "bubbie",
  "haetsal",
  "hanul",
  "himari",
  "leher",
  "miko",
  "neer",
  "porto",
  "rindo",
  "rio",
  "rivage",
  "selva",
  "sonna",
  "tinta",
  "viola",
]);

export const voices = VoiceSchema.options.map((value) => ({
  value,
  label: value.charAt(0).toUpperCase() + value.slice(1),
}));

export const preferences = defineSettings({
  id: "voice",
  scope: "host",
  version: 1,
  schema: z.object({ voice: VoiceSchema.default("cove") }),
});
