/**
 * pa-vbhcu integration proof: workspace service scripts in persistent mode
 * report `running` only when the process lives (services: the port listens),
 * capture/send against a missing tmux session fail clearly without touching
 * any other session, and dead terminals are forgotten so later lookups fail
 * with "not found".
 *
 * Runs against an ISOLATED test daemon (own PASEO_HOME under a temp dir, own
 * listen port — never production). Needs tmux on PATH (skipped without it).
 *
 * Run: npx vitest run src/server/daemon-e2e/persistent-script-verify.e2e.test.ts
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { createTestAgentClients } from "../test-utils/fake-agent-client.js";
import {
  persistentSessionName,
  resolveTmuxBinary,
  tmuxInvoke,
  tmuxSessionAlive,
  tmuxSocketPath,
} from "../../terminal/tmux.js";
import { listPersistentTerminals } from "../persistent-terminals.js";

const tmuxBin = resolveTmuxBinary();
const posixOnly = process.platform === "win32" ? describe.skip : describe;
const suite = tmuxBin ? posixOnly : describe.skip;

function tmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

const portOpen = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.setTimeout(1500);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => resolve(false));
  });

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function waitFor<T>(
  label: string,
  fn: () => Promise<T | null>,
  timeoutMs = 30_000,
): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = await fn().catch(() => null);
    if (value) return value;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}

function scriptEntry(
  scripts: Array<{ scriptName?: string; lifecycle?: string; port?: number }>,
  name: string,
): { lifecycle?: string; port?: number } | undefined {
  return scripts.find((s) => s.scriptName === name);
}

async function victimForgotten(
  client: DaemonClient,
  workspaceId: string,
  victimId: string,
): Promise<true | null> {
  const listed = await client.listTerminals(undefined, undefined, { workspaceId });
  return listed.terminals.some((t) => t.id === victimId) ? null : true;
}

suite("persistent script start verification and missing-session failures", () => {
  let base = "";
  let daemons: TestPaseoDaemon[] = [];
  let clients: DaemonClient[] = [];
  let lastPaseoHome: string | null = null;

  const connectClient = async (port: number): Promise<DaemonClient> => {
    const client = new DaemonClient({
      url: `ws://127.0.0.1:${port}/ws`,
      clientId: `verify-${Date.now()}-${clients.length}`,
      reconnect: { enabled: false },
    });
    await client.connect();
    await client.fetchAgents({ subscribe: {} });
    clients.push(client);
    return client;
  };

  beforeEach(() => {
    base = tmpDir("pa-vbhcu-verify-");
    daemons = [];
    clients = [];
    lastPaseoHome = null;
  });

  afterEach(async () => {
    for (const client of clients) await client.close().catch(() => undefined);
    for (const daemon of daemons) await daemon.close().catch(() => undefined);
    if (lastPaseoHome && tmuxBin) {
      tmuxInvoke({ tmuxBin: tmuxBin as string, socketPath: tmuxSocketPath(lastPaseoHome) }, [
        "kill-server",
      ]);
    }
    if (base) rmSync(base, { recursive: true, force: true });
  });

  it("(a) a service script reports running only once its port listens", async () => {
    const homeRoot = join(base, "home-root");
    const lab = join(base, "lab");
    mkdirSync(lab, { recursive: true });
    mkdirSync(homeRoot, { recursive: true });

    // Mayor-shaped service: python http.server on the injected PASEO_PORT.
    writeFileSync(
      join(lab, "paseo.json"),
      JSON.stringify({
        scripts: {
          probe: {
            type: "service",
            command:
              'exec python3 -c \'import http.server,os; http.server.test(port=int(os.environ["PASEO_PORT"]), bind="127.0.0.1")\'',
          },
        },
      }),
    );

    const daemon = await createTestPaseoDaemon({
      paseoHomeRoot: homeRoot,
      listenPort: 0,
      cleanup: false,
      agentClients: createTestAgentClients(),
    });
    daemons.push(daemon);
    lastPaseoHome = daemon.paseoHome;
    const client = await connectClient(daemon.port);

    const opened = await client.openProject(lab);
    const workspaceId = opened.workspace?.id;
    expect(workspaceId, "openProject returns a workspace").toBeTruthy();

    const started = await client.startWorkspaceScript(workspaceId as string, "probe");
    expect(started.error, `script start must succeed, got: ${started.error}`).toBeNull();
    const terminalId = started.terminalId as string;
    expect(terminalId).toBeTruthy();

    // The daemon only reports running after the port listens: by the time the
    // start response is back, the service is reachable.
    const listed = await client.listWorkspaceScripts(workspaceId as string);
    const entry = scriptEntry(listed.scripts ?? [], "probe");
    expect(entry?.lifecycle).toBe("running");
    const port = entry?.port;
    expect(port).toBeGreaterThan(0);
    expect(await portOpen(port as number), "service port listens right after start").toBe(true);

    // The tmux session exists under exactly this terminal's name, with a live pane.
    const binding = {
      tmuxBin: tmuxBin as string,
      socketPath: tmuxSocketPath(daemon.paseoHome),
      sessionName: persistentSessionName(terminalId),
    };
    expect(tmuxSessionAlive(binding), "tmux session exists for the script terminal").toBe(true);

    // And the journal recorded it for restart reattach.
    expect(listPersistentTerminals(daemon.paseoHome).map((r) => r.id)).toContain(terminalId);
  }, 120_000);

  it("(a) a service whose process dies instantly reports an error, never running", async () => {
    const homeRoot = join(base, "home-root");
    const lab = join(base, "lab");
    mkdirSync(lab, { recursive: true });
    mkdirSync(homeRoot, { recursive: true });

    writeFileSync(
      join(lab, "paseo.json"),
      JSON.stringify({
        scripts: {
          // Exits before anything can listen: the shell is gone within a
          // fraction of a second, so the session never survives.
          quick: {
            type: "service",
            command: "exec python3 -c 'import sys; sys.exit(3)'",
          },
        },
      }),
    );

    const daemon = await createTestPaseoDaemon({
      paseoHomeRoot: homeRoot,
      listenPort: 0,
      cleanup: false,
      agentClients: createTestAgentClients(),
    });
    daemons.push(daemon);
    lastPaseoHome = daemon.paseoHome;
    const client = await connectClient(daemon.port);

    const opened = await client.openProject(lab);
    const workspaceId = opened.workspace?.id;
    expect(workspaceId, "openProject returns a workspace").toBeTruthy();

    const started = await client.startWorkspaceScript(workspaceId as string, "quick");
    expect(started.error, "dying service must fail the start").toMatch(
      /did not start|gone|listening/i,
    );
    expect(started.terminalId).toBeNull();

    // No phantom running state, no journal record, no lingering session.
    const listed = await client.listWorkspaceScripts(workspaceId as string);
    expect(scriptEntry(listed.scripts ?? [], "quick")?.lifecycle).not.toBe("running");
    expect(listPersistentTerminals(daemon.paseoHome).map((r) => r.scriptName)).not.toContain(
      "quick",
    );
  }, 120_000);

  it("(b) capture/send against a missing session fail and touch no other session", async () => {
    const homeRoot = join(base, "home-root");
    const lab = join(base, "lab");
    mkdirSync(lab, { recursive: true });
    mkdirSync(homeRoot, { recursive: true });

    const servicePort = await freePort();
    writeFileSync(
      join(lab, "paseo.json"),
      JSON.stringify({
        scripts: { lab: { type: "service", command: "node server.mjs", port: servicePort } },
      }),
    );
    writeFileSync(
      join(lab, "server.mjs"),
      `import http from "node:http";\nhttp.createServer((_, res) => res.end("lab")).listen(${servicePort}, "127.0.0.1");\n`,
    );

    const daemon = await createTestPaseoDaemon({
      paseoHomeRoot: homeRoot,
      listenPort: 0,
      cleanup: false,
      agentClients: createTestAgentClients(),
    });
    daemons.push(daemon);
    lastPaseoHome = daemon.paseoHome;
    const paseoHome = daemon.paseoHome;
    const socketPath = tmuxSocketPath(paseoHome);
    const client = await connectClient(daemon.port);

    const opened = await client.openProject(lab);
    const workspaceId = opened.workspace?.id;
    expect(workspaceId, "openProject returns a workspace").toBeTruthy();

    const started = await client.startWorkspaceScript(workspaceId as string, "lab");
    expect(started.error).toBeNull();
    const serviceTerminalId = started.terminalId as string;
    await waitFor("service port listening", () => portOpen(servicePort));

    // A second, ad-hoc persistent terminal with known output.
    const created = await client.createTerminal(lab, "victim", undefined, {
      workspaceId: workspaceId as string,
      persistent: true,
    });
    expect(created.error).toBeNull();
    const victimId = created.terminal?.id;
    expect(victimId).toBeTruthy();
    client.sendTerminalInput(victimId as string, { type: "input", data: "echo victim-marker-1\r" });
    await waitFor("victim output", async () => {
      const captured = await client.captureTerminal(victimId as string, { stripAnsi: true });
      return (captured.lines ?? []).join("\n").includes("victim-marker-1") ? true : null;
    });

    const victimBinding = {
      tmuxBin: tmuxBin as string,
      socketPath,
      sessionName: persistentSessionName(victimId as string),
    };
    expect(tmuxSessionAlive(victimBinding), "victim session alive before the kill").toBe(true);

    // External kill with an EXACT target (as a user would): the victim's
    // session dies. detach-on-destroy (set at every persistent spawn) makes
    // the orphaned client detach and exit instead of attaching to the service
    // session, so the daemon forgets the terminal through the normal exit
    // path and later capture/send/kill fail clearly with "not found".
    tmuxInvoke({ tmuxBin: tmuxBin as string, socketPath }, [
      "kill-session",
      "-t",
      `=${victimBinding.sessionName}`,
    ]);
    await waitFor("victim session gone", async () =>
      tmuxSessionAlive(victimBinding) ? null : true,
    );

    // Capture of the missing session fails loudly — never with the service
    // terminal's (or any other's) content. (DaemonClient returns the payload;
    // the throwing `terminals.ref(id).capture()` handle is covered by the
    // client unit tests.)
    const failure = await client.captureTerminal(victimId as string, { stripAnsi: true });
    expect(failure.lines, "no stale output for a missing session").toEqual([]);
    expect(failure.error, "capture of a missing session must fail").toMatch(/gone|not found/i);

    // The dead terminal is forgotten, so lookups fail with "not found".
    await waitFor("victim forgotten", () =>
      victimForgotten(client, workspaceId as string, victimId as string),
    );
    const secondFailure = await client.captureTerminal(victimId as string, { stripAnsi: true });
    expect(secondFailure.error, "second capture must fail with not-found").toMatch(/not found/i);

    // Nothing was written anywhere else: the service is untouched and the
    // victim marker never appears in its output.
    expect(await portOpen(servicePort), "service still listens").toBe(true);
    const serviceCapture = await client.captureTerminal(serviceTerminalId, { stripAnsi: true });
    const serviceText = (serviceCapture.lines ?? []).join("\n");
    expect(serviceText).not.toContain("victim-marker-1");

    // Sending input to the dead id is dropped, not delivered elsewhere.
    client.sendTerminalInput(victimId as string, { type: "input", data: "echo must-not-appear\r" });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const rechecked = await client.captureTerminal(serviceTerminalId, { stripAnsi: true });
    expect((rechecked.lines ?? []).join("\n")).not.toContain("must-not-appear");
  }, 180_000);
});
