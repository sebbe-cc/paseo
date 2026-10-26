import { readFile } from "node:fs/promises";
import type { Command } from "commander";
import type { CommandOptions, ListResult, OutputSchema, SingleResult } from "../../output/index.js";
import { withPluginManagementClient } from "./shared.js";

export interface PluginToolsOptions extends CommandOptions {
  inputFile?: string;
}

export interface PluginToolRow {
  pluginId: string;
  method: string;
  description: string;
  inputSchema: unknown;
}

export interface PluginCallResult {
  pluginId: string;
  method: string;
  output: unknown;
}

const toolSchema: OutputSchema<PluginToolRow> = {
  idField: (tool) => `${tool.pluginId} ${tool.method}`,
  columns: [
    { header: "PLUGIN", field: "pluginId", width: 22 },
    { header: "METHOD", field: "method", width: 26 },
    { header: "DESCRIPTION", field: "description", width: 80 },
  ],
};

const callSchema: OutputSchema<PluginCallResult> = {
  idField: "method",
  columns: [],
  renderHuman: (result) =>
    `${JSON.stringify(result.type === "single" ? result.data.output : result.data, null, 2)}\n`,
};

export async function runPluginToolsCommand(
  pluginId: string | undefined,
  options: PluginToolsOptions,
  _command: Command,
): Promise<ListResult<PluginToolRow>> {
  const plugins = await withPluginManagementClient(options.daemonTarget, (client) =>
    client.listPlugins(),
  );
  const data = plugins
    .filter((plugin) => !pluginId || plugin.id === pluginId)
    .flatMap((plugin) =>
      (plugin.agentTools ?? []).map((tool) => ({
        pluginId: plugin.id,
        method: tool.method,
        description: tool.description,
        inputSchema: tool.inputSchema,
      })),
    );
  return { type: "list", data, schema: toolSchema };
}

async function readInput(raw: string | undefined, file: string | undefined): Promise<unknown> {
  if (raw !== undefined && file !== undefined) {
    throw new Error("Pass the input as an argument or with --input-file, not both");
  }
  let text = raw;
  if (file !== undefined) text = await readFile(file, "utf8");
  else if (raw === "-") text = await readStdin();
  if (text === undefined || text.trim() === "") return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Plugin tool input must be a JSON object");
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

export async function runPluginCallCommand(
  pluginId: string,
  method: string,
  rawInput: string | undefined,
  options: PluginToolsOptions,
  _command: Command,
): Promise<SingleResult<PluginCallResult>> {
  const input = await readInput(rawInput, options.inputFile);
  const output = await withPluginManagementClient(options.daemonTarget, async (client) => {
    const plugin = (await client.listPlugins()).find((item) => item.id === pluginId);
    if (!plugin) throw new Error(`Plugin is not configured: ${pluginId}`);
    if (!plugin.agentTools?.some((tool) => tool.method === method)) {
      throw new Error(`Plugin ${pluginId} does not expose ${method} as an agent tool`);
    }
    return client.invokePluginRpc(pluginId, method, input);
  });
  return { type: "single", data: { pluginId, method, output }, schema: callSchema };
}
