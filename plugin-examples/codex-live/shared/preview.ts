import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { VoiceSchema } from "./preferences";

export const previewText = "Hej! Så här låter min röst. Vilken röst tycker du bäst om?";

export const previewUnavailableMessage =
  "Rösttjänsten tillåter inte provlyssning av den här rösten.";

export const previewVoice = defineRpc({
  name: "voice.preview",
  input: z.object({ voice: VoiceSchema }),
  output: z.union([
    z.object({
      base64: z.string().min(1).max(256_000),
      mimeType: z.literal("audio/mpeg"),
    }),
    z.object({ unavailable: z.literal(true) }),
  ]),
});
