import { beforeEach, describe, expect, it, vi } from "vitest";

const daemonTarget = { kind: "endpoint" as const, host: "example.test:12345" };

const listPlugins = vi.fn(async () => [
  {
    id: "workflows",
    path: "/plugins/workflows",
    enabled: true,
    status: "running" as const,
    rpcMethods: ["runs.start", "runs.status"],
  },
  {
    id: "stale-plugin",
    path: "/plugins/stale-plugin",
    enabled: false,
    status: "disabled" as const,
  },
]);
const invokePluginRpc = vi.fn(async () => ({ ok: true }));
const close = vi.fn(async () => undefined);
const features: { pluginManagement?: boolean } = {};

vi.mock("../../utils/client.js", () => ({
  connectToDaemon: vi.fn(async () => ({
    getLastServerInfoMessage: () => ({ features }),
    listPlugins,
    invokePluginRpc,
    close,
  })),
}));

import { render } from "../../output/index.js";
import {
  createPluginRpcCommand,
  parseRpcPayloadInput,
  runPluginRpcCommand,
  runPluginRpcListCommand,
} from "./rpc.js";

describe("plugin rpc payload parsing", () => {
  it("parses inline JSON and treats missing input as undefined", () => {
    expect(parseRpcPayloadInput('{"a":1}')).toEqual({ a: 1 });
    expect(parseRpcPayloadInput(undefined)).toBeUndefined();
    expect(parseRpcPayloadInput("   ")).toBeUndefined();
  });

  it("reads the payload from stdin with -", () => {
    expect(parseRpcPayloadInput("-", () => '{"b":2}')).toEqual({ b: 2 });
  });

  it("rejects invalid JSON", () => {
    expect(() => parseRpcPayloadInput("{nope")).toThrowError(
      expect.objectContaining({ code: "INVALID_PAYLOAD" }),
    );
  });
});

describe("paseo plugin rpc", () => {
  beforeEach(() => {
    features.pluginManagement = false;
    vi.clearAllMocks();
  });

  it("requires host support before invoking", async () => {
    await expect(
      runPluginRpcCommand("workflows", "runs.start", undefined, { daemonTarget }, {} as never),
    ).rejects.toMatchObject({
      code: "DAEMON_UPDATE_REQUIRED",
      message: "Update the host to use plugin management.",
    });
    expect(invokePluginRpc).not.toHaveBeenCalled();
  });

  it("invokes with parsed input and renders the raw response as JSON", async () => {
    features.pluginManagement = true;
    const result = await runPluginRpcCommand(
      "workflows",
      "runs.start",
      '{"workflow":"do-work"}',
      { daemonTarget },
      {} as never,
    );
    expect(invokePluginRpc).toHaveBeenCalledWith("workflows", "runs.start", {
      workflow: "do-work",
    });
    expect(JSON.parse(render(result, { format: "json" }))).toEqual({ ok: true });
    expect(render(result, { format: "table", noColor: true })).toContain('"ok": true');
  });

  it("rejects an unknown plugin with a clear error", async () => {
    features.pluginManagement = true;
    await expect(
      runPluginRpcCommand("missing", "runs.start", undefined, { daemonTarget }, {} as never),
    ).rejects.toMatchObject({
      code: "PLUGIN_NOT_CONFIGURED",
      message: "Plugin is not configured: missing",
    });
    expect(invokePluginRpc).not.toHaveBeenCalled();
  });

  it("rejects a disabled plugin with an enable hint", async () => {
    features.pluginManagement = true;
    await expect(
      runPluginRpcCommand("stale-plugin", "runs.start", undefined, { daemonTarget }, {} as never),
    ).rejects.toMatchObject({
      code: "PLUGIN_DISABLED",
      message: "Plugin stale-plugin is disabled: paseo plugin enable stale-plugin",
    });
    expect(invokePluginRpc).not.toHaveBeenCalled();
  });

  it("lists RPC methods from the daemon runtime", async () => {
    features.pluginManagement = true;
    const result = await runPluginRpcListCommand("workflows", { daemonTarget }, {} as never);
    expect(JSON.parse(render(result, { format: "json" }))).toEqual(["runs.start", "runs.status"]);
    expect(render(result, { format: "table", noColor: true })).toContain("runs.start");
  });

  it("reports a plugin that is not running for --list", async () => {
    features.pluginManagement = true;
    await expect(
      runPluginRpcListCommand("stale-plugin", { daemonTarget }, {} as never),
    ).rejects.toMatchObject({ code: "PLUGIN_DISABLED" });
  });

  it("wires the rpc subcommand with --list", async () => {
    features.pluginManagement = true;
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const command = createPluginRpcCommand();
    await command.parseAsync(["workflows", "--list"], { from: "user" });
    expect(listPlugins).toHaveBeenCalled();
    expect(stdout).toHaveBeenCalledWith(expect.stringContaining("runs.start"));
    stdout.mockRestore();
  });
});
