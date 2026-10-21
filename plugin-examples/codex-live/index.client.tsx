import React from "react";
import type { PluginClientContext, PluginSurfaceProps } from "@getpaseo/plugin/client";
import { LiveSettings } from "./client/settings";

export default function contribute(client: PluginClientContext) {
  function Settings(props: PluginSurfaceProps) {
    return <LiveSettings {...props} playAudio={client.playAudio} />;
  }
  client.addScreen({ id: "main", title: "Codex Live", Component: Settings });
  client.addSettingsScreen({
    id: "voice",
    title: "Codex Live",
    icon: "AudioLines",
    Component: Settings,
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
