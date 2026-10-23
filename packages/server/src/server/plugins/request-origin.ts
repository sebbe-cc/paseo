import { AsyncLocalStorage } from "node:async_hooks";
import type { PluginRequestOrigin } from "@getpaseo/plugin/server";

// Only host entry points enter this scope; origin is never read from request JSON.
export const requestOrigin = new AsyncLocalStorage<PluginRequestOrigin>();
export function currentRequestOrigin(): PluginRequestOrigin {
  return requestOrigin.getStore() ?? { kind: "daemon", source: "restore" };
}
