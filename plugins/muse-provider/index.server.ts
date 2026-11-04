import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createMuseProvider } from "./server/provider.js";

import { Usage } from "./server/usage.js";

export default function contribute(
  server: Pick<PluginServerContext, "registerProvider" | "registerUsageSource" | "invalidateUsage">,
) {
  const usage = new Usage();
  const registration = usage.registration();
  usage.onDidChange = (account) => {
    // Registry report ids are `${sourceId}:${accountKey}` (see UsageSourceRegistry discovery).
    server.invalidateUsage(registration.id, `${registration.id}:${account}`);
  };
  server.registerUsageSource(registration);
  server.registerProvider(createMuseProvider(usage));
  return () => {};
}
