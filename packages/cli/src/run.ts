import type { Command } from "commander";
import { renderError, toCommandError, defaultOutputOptions } from "./output/render.js";
import { createCli } from "./cli.js";
import { classifyInvocation } from "./classify.js";
import { openDesktopWithProject } from "./commands/open.js";
import { dispatchPluginCommand, printTopLevelHelp } from "./commands/plugin/dispatch.js";

/** Built-in top-level command names and aliases. Anything else may be a plugin CLI. */
export function getTopLevelCommandNames(program: Command): Set<string> {
  const names = new Set<string>();
  for (const command of program.commands) {
    names.add(command.name());
    const alias = command.alias();
    if (alias) names.add(alias);
  }
  return names;
}

export interface RunCliOptions {
  cwd?: string;
  nodeArgv?: [string, string];
}

export function createCliParseArgv(input: {
  argv: string[];
  cwd: string;
  nodeArgv?: [string, string];
}): string[] | { kind: "open-project"; resolvedPath: string } {
  const program = createCli();
  const knownCommands = new Set(program.commands.map((command) => command.name()));
  const invocation = classifyInvocation({
    argv: input.argv,
    knownCommands,
    cwd: input.cwd,
  });

  if (invocation.kind === "open-project") {
    return invocation;
  }

  const nodeArgv = input.nodeArgv ?? ["paseo", "paseo"];
  const isOnboardRootFlag = invocation.argv[0] === "--relay" || invocation.argv[0] === "--no-relay";
  let cliArgv = invocation.argv;
  if (invocation.argv.length === 0) {
    cliArgv = ["onboard"];
  } else if (isOnboardRootFlag) {
    cliArgv = ["onboard", ...invocation.argv];
  }
  return [...nodeArgv, ...cliArgv];
}

// The program that started the CLI can close its end of stdout before the output
// is written, as `paseo ls | head -1` or a launcher that discards output does.
// Drop the output nobody reads and let the command finish, instead of surfacing
// the failed write as an uncaught error.
function ignoreClosedStdout(error: NodeJS.ErrnoException): void {
  if (error.code !== "EPIPE") {
    throw error;
  }
}

export async function runCli(argv: string[], options: RunCliOptions = {}): Promise<number> {
  if (!process.stdout.listeners("error").includes(ignoreClosedStdout)) {
    process.stdout.on("error", ignoreClosedStdout);
  }

  const parseArgv = createCliParseArgv({
    argv,
    cwd: options.cwd ?? process.cwd(),
    nodeArgv: options.nodeArgv,
  });

  if (!Array.isArray(parseArgv)) {
    await openDesktopWithProject(parseArgv.resolvedPath);
    return typeof process.exitCode === "number" ? process.exitCode : 0;
  }

  const program = createCli();
  const cliArgs = parseArgv.slice(2);
  const builtInNames = getTopLevelCommandNames(program);
  if (cliArgs.length > 0 && cliArgs[0]!.startsWith("-")) {
    const [first] = cliArgs;
    if (first === "--help" || first === "-h") {
      return printTopLevelHelp({
        helpText: program.helpInformation(),
        argv: cliArgs,
        builtInNames,
      });
    }
  } else if (cliArgs.length > 0 && !builtInNames.has(cliArgs[0]!)) {
    const dispatch = await dispatchPluginCommand({
      name: cliArgs[0]!,
      argv: cliArgs.slice(1),
      cwd: options.cwd ?? process.cwd(),
      builtInNames,
    });
    if (dispatch.handled) return dispatch.exitCode;
  }
  try {
    await program.parseAsync(parseArgv, { from: "node" });
  } catch (error) {
    process.stderr.write(
      renderError(toCommandError(error), {
        ...defaultOutputOptions,
        format: argv.includes("--json") ? "json" : "table",
      }) + "\n",
    );
    return 1;
  }
  return typeof process.exitCode === "number" ? process.exitCode : 0;
}
