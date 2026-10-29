import { expect, test } from "vitest";
import { createTerminalActions } from "./index.js";

test("an older host rejects terminal operations before sending requests", async () => {
  const unexpectedRequest = () => {
    throw new Error("Unexpected daemon request");
  };
  const terminals = createTerminalActions(
    {
      ensureConnected: () => {},
      getLastServerInfoMessage: () => ({
        status: "server_info",
        serverId: "older-host",
        hostname: null,
        version: null,
        features: {},
      }),
      createTerminal: unexpectedRequest,
      listTerminals: unexpectedRequest,
      sendTerminalInput: unexpectedRequest,
      captureTerminal: unexpectedRequest,
      killTerminal: unexpectedRequest,
    },
    unexpectedRequest,
  );

  await expect(terminals.create({ workspaceId: "wks_existing" })).rejects.toThrow(
    "Update the host",
  );
  await expect(terminals.list({ workspaceId: "wks_existing" })).rejects.toThrow("Update the host");
  const terminal = terminals.ref("terminal-existing");
  expect(terminal.current()).toBeNull();
  expect(() => terminal.write("text")).toThrow("Update the host");
  expect(() => terminal.sendKeys(["Enter"])).toThrow("Update the host");
  expect(() => terminal.capture()).toThrow("Update the host");
  await expect(terminal.kill()).rejects.toThrow("Update the host");
});

test("capture fails loudly when the daemon reports an error (pa-vbhcu)", async () => {
  const terminals = createTerminalActions(
    {
      ensureConnected: () => {},
      getLastServerInfoMessage: () => ({
        status: "server_info",
        serverId: "new-host",
        hostname: null,
        version: null,
        features: { workspaceTerminals: true },
      }),
      createTerminal: () => {
        throw new Error("Unexpected daemon request");
      },
      listTerminals: () => {
        throw new Error("Unexpected daemon request");
      },
      sendTerminalInput: () => {},
      captureTerminal: async (terminalId: string) => ({
        terminalId,
        lines: [] as string[],
        totalLines: 0,
        error: `Terminal ${terminalId} not found`,
        requestId: "req-1",
      }),
      killTerminal: () => {
        throw new Error("Unexpected daemon request");
      },
    },
    async () => "/work",
  );

  await expect(terminals.ref("terminal-missing").capture()).rejects.toThrow(
    "Terminal terminal-missing not found",
  );
});

test("capture passes successful output through untouched (pa-vbhcu)", async () => {
  const terminals = createTerminalActions(
    {
      ensureConnected: () => {},
      getLastServerInfoMessage: () => ({
        status: "server_info",
        serverId: "new-host",
        hostname: null,
        version: null,
        features: { workspaceTerminals: true },
      }),
      createTerminal: () => {
        throw new Error("Unexpected daemon request");
      },
      listTerminals: () => {
        throw new Error("Unexpected daemon request");
      },
      sendTerminalInput: () => {},
      captureTerminal: async (terminalId: string) => ({
        terminalId,
        lines: ["live"],
        totalLines: 1,
        error: null,
        requestId: "req-1",
      }),
      killTerminal: () => {
        throw new Error("Unexpected daemon request");
      },
    },
    async () => "/work",
  );

  await expect(terminals.ref("terminal-live").capture()).resolves.toEqual({
    terminalId: "terminal-live",
    lines: ["live"],
    totalLines: 1,
    error: null,
    requestId: "req-1",
  });
});
