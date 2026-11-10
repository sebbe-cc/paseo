import { createRequire } from "node:module";
import path from "node:path";
import * as pluginSharedRuntime from "@getpaseo/plugin";
import * as pluginProviderRuntime from "@getpaseo/plugin/server/provider";
import * as pluginAcpRuntime from "@getpaseo/plugin/server/acp";
import * as pluginUsageRuntime from "@getpaseo/plugin/server/usage";
import * as pluginServerRuntime from "@getpaseo/plugin/server";
import type { PluginServerContribution } from "@getpaseo/plugin/server";
import * as zod from "zod";
import { isPluginClientOnlySdkSpecifier } from "./plugin-sdk-specifiers.js";
import { matchesRuntimeExternal } from "./runtime-externals.js";

const nodeRequire = createRequire(import.meta.url);

export interface PluginBundleRuntime {
  pluginDirectory: string;
  runtimeExternals?: readonly string[];
}

function hostRequire(name: string): unknown {
  if (isPluginClientOnlySdkSpecifier(name)) {
    throw new Error(`${name} is available only in plugin client code`);
  }
  if (name === "@getpaseo/plugin") return pluginSharedRuntime;
  if (name === "@getpaseo/plugin/server") return pluginServerRuntime;
  if (name === "@getpaseo/plugin/server/provider") return pluginProviderRuntime;
  if (name === "@getpaseo/plugin/server/acp") return pluginAcpRuntime;
  if (name === "@getpaseo/plugin/server/usage") return pluginUsageRuntime;
  if (name === "zod") return zod;
  if (name === "@getpaseo/plugin/client/host")
    throw new Error(`${name} is private to the app host`);
  return nodeRequire(name);
}

function createRuntimeRequire(runtime: PluginBundleRuntime | undefined): (name: string) => unknown {
  const runtimeExternals = runtime?.runtimeExternals ?? [];
  if (!runtime || runtimeExternals.length === 0) return hostRequire;
  // Resolve declared externals as the plugin's own modules would, so a missing optional
  // package fails its lazy require with Node's usual MODULE_NOT_FOUND.
  const pluginRequire = createRequire(path.join(runtime.pluginDirectory, "package.json"));
  return (name) =>
    matchesRuntimeExternal(name, runtimeExternals) ? pluginRequire(name) : hostRequire(name);
}

export function evaluateBundle(
  bundle: string,
  runtime?: PluginBundleRuntime,
): PluginServerContribution {
  const evaluate: (source: string) => unknown = globalThis.eval;
  const factory = evaluate(bundle);
  if (typeof factory !== "function") throw new Error("Plugin server bundle is not executable");
  const exports = factory(createRuntimeRequire(runtime));
  const setup =
    exports !== null && typeof exports === "object" ? Reflect.get(exports, "default") : undefined;
  if (typeof setup !== "function") {
    throw new Error("Plugin server bundle must default export a function");
  }
  return setup as PluginServerContribution;
}
