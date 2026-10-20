import type { PluginClientContext } from "@getpaseo/plugin/client";
import { LiveSettings } from "./client/settings";

export default function contribute(client: PluginClientContext) {
  client.addScreen({ id: "main", title: "Codex Live", Component: LiveSettings });
  client.addSettingsScreen({
    id: "voice",
    title: "Codex Live",
    icon: "AudioLines",
    Component: LiveSettings,
  });
  client.addCommandCenterItem({
    id: "voice-settings",
    title: "Codex Live: voice and King",
    icon: "AudioLines",
    keywords: ["voice", "king", "mayor", "gascity"],
    context: "global",
    onSelect({ openScreen }) {
      openScreen({ screenId: "main" });
    },
  });
  return () => {};
}
