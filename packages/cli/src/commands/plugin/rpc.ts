import { readFileSync } from "node:fs";
import { Command } from "commander";
import type { PluginListItem } from "@getpaseo/protocol/messages";
import type { CommandOptions, ListResult, OutputSchema, SingleResult } from "../../output/index.js";
import { render, renderError, toCommandError } from "../../output/index.js";
import { addJsonAndDaemonHostOptions, withGlobalOptions } from "../../utils/command-options.js";
import { withPluginManagementClient } from "./shared.js";

export interface PluginRpcOptions extends CommandOptions {
  list?: boolean;
}

export function readStdinText(): string {
  return readFileSync(0, "utf8");
}

/**
 * Resolve the RPC input from the command line. The payload argument carries
 * JSON; `-` reads it from stdin instead. Empty input means no input.
 */
export function parseRpcPayloadInput(
  raw: string | undefined,
  readStdin: () => string = readStdinText,
): unknown {
  const text = raw === "-" ? readStdin() : raw;
  if (text === undefined || text.trim() === "") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw {
      code: "INVALID_PAYLOAD",
      message: "Payload is not valid JSON.",
    };
  }
}

export function requireConfiguredPlugin(
  plugins: PluginListItem[],
  pluginId: string,
): PluginListItem {
  const plugin = plugins.find((candidate) => candidate.id === pluginId);
  if (!plugin)
    throw { code: "PLUGIN_NOT_CONFIGURED", message: `Plugin is not configured: ${pluginId}` };
  return plugin;
}

export function requireEnabledPlugin(plugins: PluginListItem[], pluginId: string): PluginListItem {
  const plugin = requireConfiguredPlugin(plugins, pluginId);
  if (!plugin.enabled)
    throw {
      code: "PLUGIN_DISABLED",
      message: `Plugin ${pluginId} is disabled: paseo plugin enable ${pluginId}`,
    };
  return plugin;
}

const pluginRpcSchema: OutputSchema<{ output: unknown }> = {
  idField: () => "rpc",
  columns: [
    {
      header: "OUTPUT",
      field: (item) => JSON.stringify(item.output ?? null),
      width: 80,
    },
  ],
  serialize: (data) => data.output ?? null,
  renderHuman: (result) =>
    result.type === "single" ? JSON.stringify(result.data.output ?? null, null, 2) : "",
};

const pluginRpcListSchema: OutputSchema<{ method: string }> = {
  idField: "method",
  columns: [{ header: "METHOD", field: "method", width: 60 }],
  serialize: (data) => data.method,
};

export async function runPluginRpcListCommand(
  pluginId: string,
  options: PluginRpcOptions,
  _command: Command,
): Promise<ListResult<{ method: string }>> {
  const plugins = await withPluginManagementClient(options.daemonTarget, (client) =>
    client.listPlugins(),
  );
  const plugin = requireEnabledPlugin(plugins, pluginId);
  if (!plugin.rpcMethods)
    throw {
      code: "PLUGIN_NOT_RUNNING",
      message: `Plugin ${pluginId} is not running (status: ${plugin.status}).`,
    };
  return {
    type: "list",
    data: plugin.rpcMethods.map((method) => ({ method })),
    schema: pluginRpcListSchema,
  };
}

export async function runPluginRpcInvokeCommand(
  pluginId: string,
  method: string | undefined,
  payloadRaw: string | undefined,
  options: PluginRpcOptions,
  deps: { readStdin?: () => string } = {},
): Promise<SingleResult<{ output: unknown }>> {
  if (!method || method.trim() === "")
    throw {
      code: "MISSING_METHOD",
      message: "Usage: paseo plugin rpc <plugin-id> <method> [payload-json]",
    };
  const input = parseRpcPayloadInput(payloadRaw, deps.readStdin);
  const output = await withPluginManagementClient(options.daemonTarget, async (client) => {
    const plugins = await client.listPlugins();
    requireEnabledPlugin(plugins, pluginId);
    return client.invokePluginRpc(pluginId, method, input);
  });
  return { type: "single", data: { output }, schema: pluginRpcSchema };
}

export async function runPluginRpcCommand(
  pluginId: string,
  method: string | undefined,
  payloadRaw: string | undefined,
  options: PluginRpcOptions,
  command: Command,
  deps: { readStdin?: () => string } = {},
): Promise<SingleResult<{ output: unknown }> | ListResult<{ method: string }>> {
  if (options.list) return runPluginRpcListCommand(pluginId, options, command);
  return runPluginRpcInvokeCommand(pluginId, method, payloadRaw, options, deps);
}

export function createPluginRpcCommand(): Command {
  return addJsonAndDaemonHostOptions(
    new Command("rpc")
      .description("Invoke a plugin RPC method (low-level fallback)")
      .argument("<id>", "Runtime plugin ID")
      .argument("[method]", "RPC method name (for example runs.start)")
      .argument("[payload]", "JSON payload, or - to read it from stdin")
      .option("--list", "List the plugin's RPC methods"),
  ).action(
    withGlobalOptions(
      async (
        id: string,
        method: string | undefined,
        payload: string | undefined,
        options: PluginRpcOptions,
        _command: Command,
      ) => {
        try {
          if (options.list) {
            const result = await runPluginRpcListCommand(id, options, _command);
            process.stdout.write(render(result, { format: "json" }) + "\n");
          } else {
            const result = await runPluginRpcInvokeCommand(id, method, payload, options);
            process.stdout.write(render(result, { format: "json" }) + "\n");
          }
        } catch (error) {
          process.stderr.write(renderError(toCommandError(error), { format: "json" }) + "\n");
          process.exit(1);
        }
      },
    ),
  );
}
