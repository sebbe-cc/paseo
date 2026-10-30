/**
 * pa-bhkn0 integration proof: a workspace service script and a persistent
 * terminal in an ISOLATED test daemon (own PASEO_HOME under a temp dir, own
 * listen port — never production) survive a graceful daemon stop/start with
 * the SAME PIDs, show as running again, and leave no agent hosts behind.
 *
 * Unlike the pa-0f75q proof (restart-once + recreate), nothing is restarted
 * here: the tmux sessions outlive the daemon and the new daemon reattaches
 * to them. The script's node process keeps its PID and its port listener;
 * the terminal's shell keeps its PID and its output.
 *
 * Run: npx vitest run src/server/daemon-e2e/persistent-restart.e2e.test.ts
 * Needs: tmux on PATH (skipped without it), a free loopback service port.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { createTestAgentClients } from "../test-utils/fake-agent-client.js";
import { resolveTmuxBinary } from "../../terminal/tmux.js";
import { listPersistentTerminals } from "../persistent-terminals.js";
import { tmuxPanePid, tmuxSessionAlive, tmuxSocketPath } from "../../terminal/tmux.js";

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

async function waitFor<T>(label: string, fn: () => Promise<T | null>, timeoutMs = 90_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = await fn().catch(() => null);
    if (value) return value;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

function scriptLifecycle(scripts: Array<{ scriptName?: string; lifecycle?: string }>): string | null {
  return scripts.find((s) => s.scriptName === "lab")?.lifecycle ?? null;
}

suite("persistent terminals survive a graceful daemon restart with the same PIDs", () => {
  let base = "";
  let daemons: TestPaseoDaemon[] = [];
  let clients: DaemonClient[] = [];
  let lastPaseoHome: string | null = null;

  beforeEach(() => {
    base = tmpDir("pa-bhkn0-persist-");
    daemons = [];
    clients = [];
    lastPaseoHome = null;
  });

  afterEach(async () => {
    for (const client of clients) await client.close().catch(() => undefined);
    for (const daemon of daemons) await daemon.close().catch(() => undefined);
    // The test tmux server is external to the daemons: shut it down so no
    // sessions or server processes leak between runs.
    if (lastPaseoHome && tmuxBin) {
      const { tmuxInvoke } = await import("../../terminal/tmux.js");
      tmuxInvoke(
        { tmuxBin: tmuxBin as string, socketPath: tmuxSocketPath(lastPaseoHome) },
        ["kill-server"],
      );
    }
    if (base) rmSync(base, { recursive: true, force: true });
  });

  it("reattaches the script and the terminal without restarting either", async () => {
    const homeRoot = join(base, "home-root");
    const lab = join(base, "lab");
    const servicePort = await freePort();
    mkdirSync(lab, { recursive: true });
    mkdirSync(homeRoot, { recursive: true });

    writeFileSync(
      join(lab, "paseo.json"),
      JSON.stringify({ scripts: { lab: { type: "service", command: "node server.mjs", port: servicePort } } }),
    );
    // The lab process records its own PID: the proof compares it across the
    // restart, so "same PID" is the lab's own words, not the test's inference.
    writeFileSync(
      join(lab, "server.mjs"),
      `import http from "node:http";\n` +
        `import { writeFileSync } from "node:fs";\n` +
        `writeFileSync(${JSON.stringify(join(lab, "lab.pid"))}, String(process.pid));\n` +
        `http.createServer((_, res) => res.end("lab")).listen(${servicePort}, "127.0.0.1");\n`,
    );

    let clientSeq = 0;
    const connectClient = async (port: number): Promise<DaemonClient> => {
      clientSeq += 1;
      const client = new DaemonClient({
        url: `ws://127.0.0.1:${port}/ws`,
        clientId: `persist-proof-${clientSeq}`,
        reconnect: { enabled: false },
      });
      await client.connect();
      await client.fetchAgents({ subscribe: {} });
      clients.push(client);
      return client;
    };

    // --- daemon A ---------------------------------------------------------
    const daemonA = await createTestPaseoDaemon({
      paseoHomeRoot: homeRoot,
      listenPort: 0,
      cleanup: false,
      agentClients: createTestAgentClients(),
    });
    daemons.push(daemonA);
    const paseoHome = daemonA.paseoHome;
    lastPaseoHome = paseoHome;
    const clientA = await connectClient(daemonA.port);

    const opened = await clientA.openProject(lab);
    const workspaceId = opened.workspace?.id;
    expect(workspaceId, "openProject returns a workspace").toBeTruthy();

    const started = await clientA.startWorkspaceScript(workspaceId as string, "lab");
    expect(started.error, `script start error: ${started.error}`).toBeNull();

    await waitFor("service running", async () => {
      const listed = await clientA.listWorkspaceScripts(workspaceId as string);
      return scriptLifecycle(listed.scripts ?? []) === "running" ? true : null;
    });
    await waitFor("service port listening", () => portOpen(servicePort));
    const scriptPidBefore = await waitFor("lab pid file", async () => {
      try {
        const pid = Number(readFileSync(join(lab, "lab.pid"), "utf8").trim());
        return Number.isInteger(pid) && pid > 0 ? pid : null;
      } catch {
        return null;
      }
    });
    expect(process.kill.bind(process, scriptPidBefore, 0), "lab process alive").not.toThrow();

    const created = await clientA.createTerminal(lab, "labterm", undefined, {
      workspaceId: workspaceId as string,
      persistent: true,
    });
    expect(created.error, `terminal create error: ${created.error}`).toBeNull();
    const terminalId = created.terminal?.id;
    expect(terminalId, "persistent terminal id").toBeTruthy();

    // Drive the terminal once so the PTY path is proven live before restart.
    clientA.sendTerminalInput(terminalId as string, { type: "input", data: "echo persist-marker-1\r" });
    await waitFor("terminal output", async () => {
      const captured = await clientA.captureTerminal(terminalId as string, { stripAnsi: true });
      const text = (captured.lines ?? []).join("\n");
      return text.includes("persist-marker-1") ? true : null;
    });

    const journal = listPersistentTerminals(paseoHome);
    expect(journal.map((r) => r.id).sort()).toContain(terminalId as string);
    const termRecord = journal.find((r) => r.id === terminalId);
    const binding = {
      tmuxBin: tmuxBin as string,
      socketPath: tmuxSocketPath(paseoHome),
      sessionName: termRecord?.sessionName ?? "",
    };
    expect(tmuxSessionAlive(binding), "tmux session alive before restart").toBe(true);
    const panePidBefore = tmuxPanePid(binding);
    expect(panePidBefore, "terminal shell PID before restart").toBeGreaterThan(0);

    expect(
      daemonA.daemon.agentManager.listAgents({ includeInternal: true }),
      "zero agents before restart",
    ).toHaveLength(0);

    // --- graceful restart: full stop, then a new daemon on the same home ---
    await clientA.close();
    clients = [];
    await daemonA.close();

    expect(tmuxSessionAlive(binding), "tmux session survives the graceful stop").toBe(true);
    expect(tmuxPanePid(binding), "same shell PID across the stop").toBe(panePidBefore);

    const daemonB = await createTestPaseoDaemon({
      paseoHomeRoot: homeRoot,
      listenPort: 0,
      cleanup: false,
      agentClients: createTestAgentClients(),
    });
    daemons.push(daemonB);
    const clientB = await connectClient(daemonB.port);

    // The script is running again WITHOUT a start: same PID, same listener.
    await waitFor("service running after restart", async () => {
      const listed = await clientB.listWorkspaceScripts(workspaceId as string);
      return scriptLifecycle(listed.scripts ?? []) === "running" ? true : null;
    });
    const scriptPidAfter = Number(readFileSync(join(lab, "lab.pid"), "utf8").trim());
    expect(scriptPidAfter, "same lab PID after restart").toBe(scriptPidBefore);
    expect(await portOpen(servicePort), "service port still listening").toBe(true);

    // The terminal is back under the same id with the same shell PID.
    await waitFor("terminal back", async () => {
      const listed = await clientB.listTerminals(undefined, undefined, {
        workspaceId: workspaceId as string,
      });
      return listed.terminals.some((t) => t.id === terminalId) ? true : null;
    });
    expect(tmuxPanePid(binding), "same terminal shell PID after restart").toBe(panePidBefore);

    // Old output is still there: capture shows the pre-restart marker.
    const recaptured = await clientB.captureTerminal(terminalId as string, { stripAnsi: true });
    const recapturedText = (recaptured.lines ?? []).join("\n");
    expect(recapturedText, "pre-restart output survives").toContain("persist-marker-1");

    // No agent hosts leaked across the restart.
    expect(
      daemonB.daemon.agentManager.listAgents({ includeInternal: true }),
      "zero agents after restart",
    ).toHaveLength(0);
    const agents = await clientB.fetchAgents();
    expect(agents.agents ?? [], "zero agents via client").toHaveLength(0);
  }, 240_000);
});
