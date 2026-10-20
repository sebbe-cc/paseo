import type { PluginServerContext } from "@getpaseo/plugin/server";
import { startCodexLive } from "./server/session";
import { preferences } from "./shared/preferences";

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(preferences);
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
