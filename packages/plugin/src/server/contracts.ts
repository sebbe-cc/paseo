import type { PaseoApi } from "@getpaseo/client";
import type { ZodType, input as ZodInput, output as ZodOutput } from "zod";
import type { PluginRpcContract } from "../rpc.js";
import type { PluginCleanup } from "../contracts.js";
import type { ProviderRegistration } from "./provider.js";
import type { UsageSourceRegistration } from "./usage.js";
import type { PluginLifecycleRegistration } from "./lifecycle.js";

export interface PluginHandlerContext {
  paseo: PaseoApi;
}

export type PluginSettingsState<Schema extends ZodType> =
  | {
      status: "ready";
      revision: string;
      values: ZodOutput<Schema>;
    }
  | {
      status: "invalid";
      revision: string;
      error: string;
    };

export interface PluginSettings<Schema extends ZodType> {
  read(): Promise<PluginSettingsState<Schema>>;
  subscribe(listener: (state: PluginSettingsState<Schema>) => void | Promise<void>): PluginCleanup;
}

/**
 * Daemon-advertised usage capabilities (pa-vtgw9 core support). Present only
 * on daemons that implement the CPA provenance contract: `usageObservedAt`
 * means the registry and app honor `observedAt` on available reports (and
 * enforce the 1800 s ceiling on observation age instead of poll time), and
 * `usageSkipNativeFallback` means `skipNativeFallback: true` on a takeover
 * registration is honored. Plugins that need either must stay dormant
 * (register nothing) when the flag they need is absent: an older daemon
 * would otherwise run the takeover without the safety the flag promises.
 */
export interface DaemonUsageCapabilities {
  usageObservedAt?: boolean;
  usageSkipNativeFallback?: boolean;
}

export interface PluginServerContext extends PluginLifecycleRegistration {
  /** Absent on daemons older than the capability contract; fail closed. */
  readonly daemonCapabilities?: DaemonUsageCapabilities;
  registerSettings<Schema extends ZodType>(
    definition: import("../settings.js").SettingsDefinition<Schema>,
  ): PluginSettings<Schema>;
  handle<InputSchema extends ZodType, OutputSchema extends ZodType>(
    contract: PluginRpcContract<InputSchema, OutputSchema>,
    handler: (
      input: ZodOutput<InputSchema>,
      context: PluginHandlerContext,
    ) => ZodInput<OutputSchema> | Promise<ZodInput<OutputSchema>>,
  ): void;
  registerProvider(provider: ProviderRegistration): void;
  registerUsageSource(source: UsageSourceRegistration): void;
  /**
   * Hides a built-in usage source without replacing it; its cards disappear
   * until the plugin unloads. A later `replaces` takeover of the same id
   * re-enables it through the override. Unknown ids are kept and warn.
   */
  disableUsageSource(sourceId: string): void;
}

export type PluginServerContribution = (server: PluginServerContext) => PluginCleanup;
