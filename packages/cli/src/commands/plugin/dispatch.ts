import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import {
  PluginCliSchema,
  type PluginCli,
  type PluginCliCommand,
  type PluginListItem,
} from "@getpaseo/protocol/messages";
import { renderError, toCommandError } from "../../output/index.js";
import { selectDaemonTarget, type DaemonTarget } from "../../utils/daemon-target.js";
import { connectToDaemon, tryConnectToDaemon } from "../../utils/client.js";

export interface PluginCliEntry {
  pluginId: string;
  cli: PluginCli;
}

export interface PluginCliCatalog {
  entries: Map<string, PluginCliEntry>;
  collisions: Array<{ pluginId: string; name: string }>;
}

type CliCapableClient = Pick<
  DaemonClient,
  "listPlugins" | "invokePluginRpc" | "close" | "getLastServerInfoMessage"
>;

/**
 * Load plugin CLI contributions from the daemon. A descriptor whose name
 * collides with a built-in command is rejected, never shadowing it.
 */
export async function loadPluginCliCatalog(
  listPlugins: () => Promise<PluginListItem[]>,
  builtInNames: ReadonlySet<string>,
): Promise<PluginCliCatalog> {
  const plugins = await listPlugins();
  const entries = new Map<string, PluginCliEntry>();
  const collisions: Array<{ pluginId: string; name: string }> = [];
  for (const plugin of plugins) {
    if (!plugin.enabled || !plugin.cli) continue;
    const parsed = PluginCliSchema.safeParse(plugin.cli);
    if (!parsed.success) continue;
    if (builtInNames.has(parsed.data.name)) {
      collisions.push({ pluginId: plugin.id, name: parsed.data.name });
      continue;
    }
    if (!entries.has(parsed.data.name))
      entries.set(parsed.data.name, { pluginId: plugin.id, cli: parsed.data });
  }
  return { entries, collisions };
}

export interface StrippedGlobals {
  argv: string[];
  host?: string;
  home?: string;
  json: boolean;
  help: boolean;
}

/**
 * Pull the CLI-level flags out of a plugin invocation. --host/--home select
 * the daemon like everywhere else, --json prints the raw RPC response, and
 * -h/--help prints plugin help. Everything else belongs to the plugin command.
 */
export function extractPluginGlobals(argv: string[]): StrippedGlobals {
  const kept: string[] = [];
  let host: string | undefined;
  let home: string | undefined;
  let json = false;
  let help = false;
  const takeValue = (flag: string, value: string | undefined, take: (v: string) => void) => {
    if (value === undefined || value === "")
      throw { code: "MISSING_OPTION_VALUE", message: `${flag} requires a value.` };
    take(value);
  };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token === "--host" || token === "--home") {
      const flag = token;
      takeValue(flag, argv[i + 1], (v) => (flag === "--host" ? (host = v) : (home = v)));
      i++;
    } else if (token.startsWith("--host=")) takeValue("--host", token.slice(7), (v) => (host = v));
    else if (token.startsWith("--home=")) takeValue("--home", token.slice(7), (v) => (home = v));
    else if (token === "--json") json = true;
    else if (token === "--format" || token.startsWith("--format=")) {
      const value = token === "--format" ? argv[++i] : token.slice("--format=".length);
      const normalized = value?.trim().toLowerCase();
      if (normalized === "json") json = true;
      else if (normalized !== "table" && normalized !== "cli")
        throw {
          code: "INVALID_FORMAT",
          message: `Unsupported output format for plugin commands: ${String(value)}. Use --json.`,
        };
    } else if (token === "--help" || token === "-h") help = true;
    else if (token === "--") {
      kept.push("--", ...argv.slice(i + 1));
      break;
    } else kept.push(token);
  }
  if (host !== undefined && home !== undefined)
    throw { code: "TARGET_AMBIGUOUS", message: "Choose either --home or --host, not both." };
  return { argv: kept, host, home, json, help };
}

function usageLine(cliName: string, command: PluginCliCommand): string {
  const args = command.args.map((arg) => `<${arg.name}>`).join(" ");
  const options = command.options.length > 0 ? "[options]" : "";
  return [`paseo ${cliName} ${command.name}`, args, options].filter(Boolean).join(" ");
}

/**
 * Map positionals and --options onto the RPC payload fields with the same
 * names. Everything after `--` is positional, and a trailing option without a
 * value reads as `true`.
 */
export function parsePluginCommandArgs(
  cliName: string,
  command: PluginCliCommand,
  argv: string[],
): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  const positionals: string[] = [];
  const declaredOptions = new Set(command.options.map((option) => option.name));
  let endOfOptions = false;
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (endOfOptions || !token.startsWith("-") || token === "-") {
      positionals.push(token);
      continue;
    }
    if (token === "--") {
      endOfOptions = true;
      continue;
    }
    const bare = token.startsWith("--") ? token.slice(2) : token.slice(1);
    const equals = bare.indexOf("=");
    const name = equals === -1 ? bare : bare.slice(0, equals);
    if (!declaredOptions.has(name))
      throw {
        code: "UNKNOWN_OPTION",
        message: `Unknown option --${name} for \`${usageLine(cliName, command)}\`.`,
      };
    if (equals !== -1) {
      fields[name] = bare.slice(equals + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("-") || endOfOptions) fields[name] = true;
    else {
      fields[name] = next;
      i++;
    }
  }
  if (positionals.length > command.args.length)
    throw {
      code: "TOO_MANY_ARGUMENTS",
      message: `Too many arguments for \`${usageLine(cliName, command)}\`.`,
    };
  command.args.forEach((arg, index) => {
    const value = positionals[index];
    if (value === undefined)
      throw {
        code: "MISSING_ARGUMENT",
        message: `Missing argument <${arg.name}> for \`${usageLine(cliName, command)}\`.`,
      };
    fields[arg.name] = value;
  });
  return fields;
}

export function formatPluginCliHelp(pluginId: string, cli: PluginCli): string {
  const lines = [
    `Usage: paseo ${cli.name} <command> [arguments] [options]`,
    "",
    `Plugin ${pluginId} commands:`,
  ];
  for (const command of cli.commands) {
    lines.push(
      `  ${usageLine(cli.name, command)}${command.description ? ` - ${command.description}` : ""}`,
    );
  }
  lines.push("", "Flags: --json prints the raw RPC response, --host/--home select the daemon.");
  return lines.join("\n");
}

export function formatPluginCliOverview(catalog: PluginCliCatalog): string {
  const lines = ["", "Plugin commands:"];
  for (const [name, entry] of [...catalog.entries.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const detail = entry.cli.description ?? `plugin ${entry.pluginId}`;
    lines.push(`  paseo ${name} <command> - ${detail}`);
  }
  for (const collision of catalog.collisions) {
    lines.push(
      `  (plugin ${collision.pluginId} declares CLI name "${collision.name}", which collides with a built-in command and is ignored)`,
    );
  }
  if (catalog.entries.size === 0 && catalog.collisions.length === 0)
    lines.push("  (no installed plugin contributes CLI commands)");
  return lines.join("\n");
}

function formatPluginOutput(output: unknown, json: boolean): string {
  if (json) return JSON.stringify(output ?? null, null, 2);
  if (typeof output === "string") return output;
  return JSON.stringify(output ?? null, null, 2);
}

export interface PluginDispatchResult {
  handled: boolean;
  exitCode: number;
}

/**
 * Run `paseo <plugin-cli> <command> ...` without a static commander
 * registration. Returns handled:false when the name belongs to no plugin, so
 * the caller falls through to the regular CLI parsing.
 */
export async function dispatchPluginCommand(input: {
  name: string;
  argv: string[];
  cwd: string;
  builtInNames: ReadonlySet<string>;
}): Promise<PluginDispatchResult> {
  const globals = extractPluginGlobals(input.argv);
  const finish = (exitCode: number): PluginDispatchResult => ({ handled: true, exitCode });
  const fail = (error: unknown): PluginDispatchResult => {
    process.stderr.write(
      renderError(toCommandError(error), { format: globals.json ? "json" : "table" }) + "\n",
    );
    return finish(1);
  };
  let target: DaemonTarget;
  try {
    target = selectDaemonTarget({ host: globals.host, home: globals.home });
  } catch (error) {
    return fail(error);
  }
  let client: CliCapableClient;
  try {
    client = await connectToDaemon({ target });
  } catch (error) {
    return fail(error);
  }
  try {
    if (client.getLastServerInfoMessage?.()?.features?.pluginManagement !== true)
      return { handled: false, exitCode: 0 };
    const plugins = await client.listPlugins();
    const catalog = await loadPluginCliCatalog(() => Promise.resolve(plugins), input.builtInNames);
    const entry = catalog.entries.get(input.name);
    if (!entry) {
      // A plugin name that the daemon knows deserves a clear error instead of
      // the generic unknown-command message.
      const plugin = plugins.find(
        (candidate) => candidate.id === input.name || candidate.cli?.name === input.name,
      );
      if (plugin && !plugin.enabled)
        return fail({
          code: "PLUGIN_DISABLED",
          message: `Plugin ${plugin.id} is disabled: paseo plugin enable ${plugin.id}`,
        });
      if (plugin?.cli)
        return fail({
          code: "PLUGIN_CLI_COLLISION",
          message: `Plugin ${plugin.id} declares CLI name "${plugin.cli.name}", which collides with a built-in command and is ignored.`,
        });
      if (plugin)
        return fail({
          code: "PLUGIN_NO_CLI",
          message: `Plugin ${plugin.id} contributes no CLI commands.`,
        });
      return { handled: false, exitCode: 0 };
    }
    if (globals.help || globals.argv.length === 0) {
      process.stdout.write(formatPluginCliHelp(entry.pluginId, entry.cli) + "\n");
      return finish(0);
    }
    const command = entry.cli.commands.find((candidate) => candidate.name === globals.argv[0]);
    if (!command) {
      return fail({
        code: "UNKNOWN_PLUGIN_COMMAND",
        message: `Unknown command "${globals.argv[0]}" for \`paseo ${input.name}\`. Run \`paseo ${input.name} --help\`.`,
      });
    }
    if (globals.argv.includes("--help") || globals.argv.includes("-h")) {
      process.stdout.write(formatPluginCliHelp(entry.pluginId, entry.cli) + "\n");
      return finish(0);
    }
    let fields: Record<string, unknown>;
    try {
      fields = parsePluginCommandArgs(input.name, command, globals.argv.slice(1));
    } catch (error) {
      return fail(error);
    }
    const output = await client.invokePluginRpc(entry.pluginId, command.rpc, {
      cwd: input.cwd,
      ...fields,
    });
    process.stdout.write(formatPluginOutput(output, globals.json) + "\n");
    return finish(0);
  } catch (error) {
    return fail(error);
  } finally {
    await client.close().catch(() => undefined);
  }
}

/**
 * Print top-level help with the installed plugins' CLI commands appended.
 * Best effort: without a reachable daemon the static help stands alone.
 */
export async function printTopLevelHelp(input: {
  helpText: string;
  argv: string[];
  builtInNames: ReadonlySet<string>;
}): Promise<number> {
  let section = "";
  try {
    const globals = extractPluginGlobals(input.argv);
    const target = selectDaemonTarget({ host: globals.host, home: globals.home });
    const client = await tryConnectToDaemon({ target });
    if (client) {
      try {
        if (client.getLastServerInfoMessage?.()?.features?.pluginManagement === true) {
          section = formatPluginCliOverview(
            await loadPluginCliCatalog(() => client.listPlugins(), input.builtInNames),
          );
        }
      } finally {
        await client.close().catch(() => undefined);
      }
    }
  } catch {
    section = "";
  }
  process.stdout.write(input.helpText + section + (section.endsWith("\n") ? "" : "\n"));
  return 0;
}
