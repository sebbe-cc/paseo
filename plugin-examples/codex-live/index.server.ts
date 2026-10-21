import type { PluginServerContext } from "@getpaseo/plugin/server";
import { startCodexLive } from "./server/session";
import { preferences } from "./shared/preferences";
import { previewVoice } from "./shared/preview";
import previews from "./server/previews.json";

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(preferences);
  server.handle(previewVoice, ({ voice }) => {
    const base64 = previews.clips[voice];
    return base64 ? { base64, mimeType: "audio/mpeg" as const } : { unavailable: true as const };
  });
  server.registerVoiceProvider({
    id: "live",
    label: "Codex Live",
    async start(context) {
      const current = await settings.read();
      if (current.status !== "ready")
        throw new Error("Invalid Codex Live settings. Reset them in Settings → Codex Live.");
      return startCodexLive(context, current.values.voice);
    },
  });
  return () => {};
}
