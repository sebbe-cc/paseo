import type { PluginServerContext } from "@getpaseo/plugin/server";
import { startCodexLive } from "./server/session";

export default function contribute(server: PluginServerContext) {
  server.registerVoiceProvider({ id: "live", label: "Codex Live", start: startCodexLive });
  return () => {};
}
