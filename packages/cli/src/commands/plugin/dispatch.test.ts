import { beforeEach, describe, expect, it, vi } from "vitest";

let plugins: Array<Record<string, unknown>> = [];
const invokePluginRpc = vi.fn(async () => ({ started: true }));
const close = vi.fn(async () => undefined);
const features: { pluginManagement?: boolean } = { pluginManagement: true };

vi.mock("../../utils/client.js", () => ({
  connectToDaemon: vi.fn(async () => ({
    getLastServerInfoMessage: () => ({ features }),
    listPlugins: async () => plugins,
    invokePluginRpc,
    close,
  })),
  tryConnectToDaemon: vi.fn(async () => ({
    getLastServerInfoMessage: () => ({ features }),
    listPlugins: async () => plugins,
    invokePluginRpc,
    close,
  })),
}));

import { createCli } from "../../cli.js";
import { getTopLevelCommandNames } from "../../run.js";
import {
  dispatchPluginCommand,
  extractPluginGlobals,
  formatPluginCliHelp,
  formatPluginCliOverview,
  loadPluginCliCatalog,
  parsePluginCommandArgs,
  printTopLevelHelp,
} from "./dispatch.js";

const wfCli = {
  name: "wf",
  description: "Run workflows",
  commands: [
    {
      name: "start",
      rpc: "runs.start",
      description: "Start a workflow run",
      args: [{ name: "workflow" }, { name: "bead" }],
      options: [{ name: "provider" }],
    },
  ],
};

const builtIns = new Set(["agent", "plugin", "workspace", "run", "ls", "daemon"]);

function stdoutSpy() {
  return vi.spyOn(process.stdout, "write").mockImplementation(() => true);
}

function stderrSpy() {
  return vi.spyOn(process.stderr, "write").mockImplementation(() => true);
}

describe("plugin globals extraction", () => {
  it("splits daemon selectors, json, and help from plugin args", () => {
    expect(extractPluginGlobals(["start", "a", "--provider", "claude", "--json"])).toEqual({
      argv: ["start", "a", "--provider", "claude"],
      host: undefined,
      home: undefined,
      json: true,
      help: false,
    });
    expect(extractPluginGlobals(["start", "--host", "h:1", "--help"])).toMatchObject({
      argv: ["start"],
      host: "h:1",
      help: true,
    });
    expect(extractPluginGlobals(["start", "--home=/tmp/x"])).toMatchObject({
      argv: ["start"],
      home: "/tmp/x",
    });
    expect(extractPluginGlobals(["start", "--format", "json"])).toMatchObject({ json: true });
  });

  it("keeps everything after -- for the plugin command", () => {
    expect(extractPluginGlobals(["start", "--", "--json"])).toMatchObject({
      argv: ["start", "--", "--json"],
      json: false,
    });
  });

  it("rejects ambiguous daemon selectors and bad formats", () => {
    expect(() => extractPluginGlobals(["--host", "a", "--home", "b"])).toThrowError(
      expect.objectContaining({ code: "TARGET_AMBIGUOUS" }),
    );
    expect(() => extractPluginGlobals(["--format", "yaml"])).toThrowError(
      expect.objectContaining({ code: "INVALID_FORMAT" }),
    );
    expect(() => extractPluginGlobals(["--host"])).toThrowError(
      expect.objectContaining({ code: "MISSING_OPTION_VALUE" }),
    );
  });
});

describe("plugin command argument mapping", () => {
  const command = wfCli.commands[0]!;

  it("maps positionals and options onto payload fields", () => {
    expect(
      parsePluginCommandArgs("wf", command, ["do-work", "sb-1", "--provider", "claude"]),
    ).toEqual({ workflow: "do-work", bead: "sb-1", provider: "claude" });
    expect(parsePluginCommandArgs("wf", command, ["do-work", "sb-1", "--provider=codex"])).toEqual({
      workflow: "do-work",
      bead: "sb-1",
      provider: "codex",
    });
  });

  it("reads a trailing option without value as true", () => {
    const withFlag = { ...command, options: [...command.options, { name: "wait" }] };
    expect(parsePluginCommandArgs("wf", withFlag, ["do-work", "sb-1", "--wait"])).toEqual({
      workflow: "do-work",
      bead: "sb-1",
      wait: true,
    });
  });

  it("rejects missing, extra, and unknown inputs", () => {
    expect(() => parsePluginCommandArgs("wf", command, ["do-work"])).toThrowError(
      expect.objectContaining({ code: "MISSING_ARGUMENT" }),
    );
    expect(() => parsePluginCommandArgs("wf", command, ["a", "b", "c"])).toThrowError(
      expect.objectContaining({ code: "TOO_MANY_ARGUMENTS" }),
    );
    expect(() => parsePluginCommandArgs("wf", command, ["a", "b", "--nope", "x"])).toThrowError(
      expect.objectContaining({ code: "UNKNOWN_OPTION" }),
    );
  });
});

describe("plugin CLI catalog", () => {
  it("loads enabled descriptors and rejects collisions", async () => {
    const catalog = await loadPluginCliCatalog(
      async () => [
        { id: "paseo-workflows", path: "/p", enabled: true, status: "running", cli: wfCli },
        { id: "off", path: "/o", enabled: false, status: "disabled", cli: wfCli },
        { id: "broken", path: "/b", enabled: true, status: "running", cli: { name: "??" } },
        {
          id: "greedy",
          path: "/g",
          enabled: true,
          status: "running",
          cli: { ...wfCli, name: "agent" },
        },
      ],
      new Set(["agent", "plugin"]),
    );
    expect([...catalog.entries.keys()]).toEqual(["wf"]);
    expect(catalog.entries.get("wf")).toMatchObject({ pluginId: "paseo-workflows" });
    expect(catalog.collisions).toEqual([{ pluginId: "greedy", name: "agent" }]);
  });

  it("renders plugin help and the top-level overview", () => {
    const help = formatPluginCliHelp("paseo-workflows", wfCli);
    expect(help).toContain("paseo wf start <workflow> <bead> [options]");
    expect(help).toContain("Start a workflow run");
    const overview = formatPluginCliOverview({
      entries: new Map([["wf", { pluginId: "paseo-workflows", cli: wfCli }]]),
      collisions: [{ pluginId: "greedy", name: "agent" }],
    });
    expect(overview).toContain("paseo wf <command>");
    expect(overview).toContain("collides with a built-in command and is ignored");
  });
});

describe("short CLI names do not collide with built-ins", () => {
  it("leaves wf free for the first plugin CLI", () => {
    const names = getTopLevelCommandNames(createCli());
    expect(names.has("wf")).toBe(false);
    for (const builtIn of ["agent", "plugin", "workspace", "run", "ls", "daemon"]) {
      expect(names.has(builtIn)).toBe(true);
    }
  });
});

describe("paseo <plugin> dispatch", () => {
  beforeEach(() => {
    plugins = [];
    features.pluginManagement = true;
    vi.clearAllMocks();
  });

  function enabledWf() {
    plugins = [{ id: "paseo-workflows", path: "/p", enabled: true, status: "running", cli: wfCli }];
  }

  it("invokes the mapped RPC with args, options, and cwd", async () => {
    enabledWf();
    const out = stdoutSpy();
    const result = await dispatchPluginCommand({
      name: "wf",
      argv: ["start", "do-work", "sb-1", "--provider", "claude"],
      cwd: "/tmp/ws",
      builtInNames: builtIns,
    });
    expect(result).toEqual({ handled: true, exitCode: 0 });
    expect(invokePluginRpc).toHaveBeenCalledWith("paseo-workflows", "runs.start", {
      cwd: "/tmp/ws",
      workflow: "do-work",
      bead: "sb-1",
      provider: "claude",
    });
    expect(out).toHaveBeenCalledWith(expect.stringContaining("started"));
    out.mockRestore();
  });

  it("prints plugin help instead of dispatching", async () => {
    enabledWf();
    const out = stdoutSpy();
    const result = await dispatchPluginCommand({
      name: "wf",
      argv: [],
      cwd: "/tmp/ws",
      builtInNames: builtIns,
    });
    expect(result).toEqual({ handled: true, exitCode: 0 });
    expect(invokePluginRpc).not.toHaveBeenCalled();
    expect(out).toHaveBeenCalledWith(expect.stringContaining("paseo wf start"));
    out.mockRestore();
  });

  it("passes the raw RPC response through with --json", async () => {
    enabledWf();
    invokePluginRpc.mockResolvedValueOnce({ nested: { n: 1 } });
    const out = stdoutSpy();
    await dispatchPluginCommand({
      name: "wf",
      argv: ["start", "do-work", "sb-1", "--json"],
      cwd: "/tmp/ws",
      builtInNames: builtIns,
    });
    expect(JSON.parse(String(out.mock.calls[0]?.[0]))).toEqual({ nested: { n: 1 } });
    out.mockRestore();
  });

  it("fails unknown plugin commands with help hint and exit 1", async () => {
    enabledWf();
    const err = stderrSpy();
    const result = await dispatchPluginCommand({
      name: "wf",
      argv: ["bogus"],
      cwd: "/tmp/ws",
      builtInNames: builtIns,
    });
    expect(result).toEqual({ handled: true, exitCode: 1 });
    expect(err).toHaveBeenCalledWith(expect.stringContaining("paseo wf --help"));
    err.mockRestore();
  });

  it("reports a disabled plugin CLI with an enable hint", async () => {
    plugins = [
      { id: "paseo-workflows", path: "/p", enabled: false, status: "disabled", cli: wfCli },
    ];
    const err = stderrSpy();
    const result = await dispatchPluginCommand({
      name: "wf",
      argv: ["start"],
      cwd: "/tmp/ws",
      builtInNames: builtIns,
    });
    expect(result).toEqual({ handled: true, exitCode: 1 });
    expect(err).toHaveBeenCalledWith(
      expect.stringContaining("paseo plugin enable paseo-workflows"),
    );
    err.mockRestore();
  });

  it("leaves unknown names to the regular CLI", async () => {
    enabledWf();
    const result = await dispatchPluginCommand({
      name: "nope",
      argv: [],
      cwd: "/tmp/ws",
      builtInNames: builtIns,
    });
    expect(result).toEqual({ handled: false, exitCode: 0 });
    expect(close).toHaveBeenCalled();
  });

  it("leaves dispatch alone on hosts without plugin management", async () => {
    enabledWf();
    features.pluginManagement = false;
    const result = await dispatchPluginCommand({
      name: "wf",
      argv: ["start"],
      cwd: "/tmp/ws",
      builtInNames: builtIns,
    });
    expect(result).toEqual({ handled: false, exitCode: 0 });
    expect(invokePluginRpc).not.toHaveBeenCalled();
  });

  it("returns exit 1 when the RPC fails", async () => {
    enabledWf();
    invokePluginRpc.mockRejectedValueOnce(new Error("boom"));
    const err = stderrSpy();
    const out = stdoutSpy();
    const result = await dispatchPluginCommand({
      name: "wf",
      argv: ["start", "do-work", "sb-1"],
      cwd: "/tmp/ws",
      builtInNames: builtIns,
    });
    expect(result).toEqual({ handled: true, exitCode: 1 });
    expect(err).toHaveBeenCalledWith(expect.stringContaining("boom"));
    expect(out).not.toHaveBeenCalled();
    err.mockRestore();
    out.mockRestore();
  });
});

describe("top-level help with plugin commands", () => {
  beforeEach(() => {
    plugins = [{ id: "paseo-workflows", path: "/p", enabled: true, status: "running", cli: wfCli }];
    features.pluginManagement = true;
    vi.clearAllMocks();
  });

  it("appends installed plugin commands", async () => {
    const out = stdoutSpy();
    const code = await printTopLevelHelp({
      helpText: "Usage: paseo [options]\n",
      argv: ["--help"],
      builtInNames: builtIns,
    });
    expect(code).toBe(0);
    const text = String(out.mock.calls.map((call) => call[0]).join(""));
    expect(text).toContain("Usage: paseo [options]");
    expect(text).toContain("paseo wf <command>");
    out.mockRestore();
  });
});
