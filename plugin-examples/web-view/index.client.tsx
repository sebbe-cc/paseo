import type { PluginClientContext } from "@getpaseo/plugin/client";
import { WebViewExample } from "./client/example";

export default function contribute(plugin: PluginClientContext) {
  plugin.addSurface("main", WebViewExample);
  plugin.addSidebarItem({
    id: "main",
    title: "Web view example",
    icon: "AppWindow",
    surface: "main",
  });
  return () => {};
}
