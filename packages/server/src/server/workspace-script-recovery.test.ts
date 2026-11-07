import { afterEach, expect, test, vi } from "vitest";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import pino from "pino";
import { WorkspaceScriptRuntimeStore } from "./workspace-script-runtime-store.js";
import { restoreWorkspaceScripts } from "./workspace-script-recovery.js";
import { createServiceProxySubsystem } from "./service-proxy.js";
import {
  ensureWorkspaceServicePortPlan,
  releaseWorkspaceServicePortPlan,
} from "./workspace-service-port-registry.js";
import type {
  TerminalCommandFinishedInfo,
  TerminalSession,
  TerminalExitInfo,
} from "../terminal/terminal.js";
import type { TerminalManager } from "../terminal/terminal-manager.js";
import type { WorkspaceRegistry } from "./workspace-registry.js";
const logger = pino({ level: "silent" });
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const f of cleanups.splice(0).toReversed()) await f();
});
async function setup(options?: {
  type?: "service" | "script";
  commandSeq?: number;
  lastCompletion?: { seq: number; exitCode: number | null } | null;
}) {
  const directory = await mkdtemp(join(tmpdir(), "script-journal-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const workspaceId = randomUUID();
  cleanups.push(() => releaseWorkspaceServicePortPlan(workspaceId));
  const persistence = { path: join(directory, "runtime.json"), logger };
  const entry = {
    workspaceId,
    scriptName: "web",
    type: options?.type ?? ("service" as const),
    lifecycle: "running" as const,
    terminalId: randomUUID(),
    exitCode: null,
    cwd: directory,
    port: 47931,
    projectSlug: "test-project",
    branchName: "main",
    ...(options?.commandSeq !== undefined ? { commandSeq: options.commandSeq } : {}),
  };
  const initial = await WorkspaceScriptRuntimeStore.open(persistence);
  initial.set(entry);
  await initial.flush();
  const store = await WorkspaceScriptRuntimeStore.open(persistence);
  const exits = new Set<(info: TerminalExitInfo) => void>();
  const commands = new Set<(info: TerminalCommandFinishedInfo) => void>();
  // Mirrors the worker: every completion updates the retained state first, then
  // reaches whoever listens. Firing without listeners models downtime.
  let lastCompletion = options?.lastCompletion ?? null;
  const completeCommand = (exitCode: number | null, seq: number) => {
    lastCompletion = { seq, exitCode };
    for (const fn of Array.from(commands)) fn({ exitCode });
  };
  const terminal = {
    id: entry.terminalId,
    cwd: directory,
    workspaceId,
    onExit: (fn: (info: TerminalExitInfo) => void) => {
      exits.add(fn);
      return () => exits.delete(fn);
    },
    onCommandFinished: (fn: (info: TerminalCommandFinishedInfo) => void) => {
      commands.add(fn);
      return () => commands.delete(fn);
    },
    getLastCommandFinished: () => lastCompletion,
  } as unknown as TerminalSession;
  const terminals = {
    getTerminal: (id: string) => (id === terminal.id ? terminal : undefined),
  } as TerminalManager;
  const workspaces = {
    get: async () => ({ workspaceId, cwd: directory, branch: "main", archivedAt: null }),
  } as unknown as Pick<WorkspaceRegistry, "get">;
  const serviceProxy = createServiceProxySubsystem({ logger });
  const restore = () =>
    restoreWorkspaceScripts({
      runtimeStore: store,
      terminalManager: terminals,
      workspaceRegistry: workspaces,
      serviceProxy,
      publicBaseUrl: "https://example.test",
    });
  return {
    entry,
    persistence,
    store,
    terminal,
    terminals,
    workspaces,
    serviceProxy,
    restore,
    exits,
    commands,
    completeCommand,
  };
}
test("a new daemon restores status, exact terminal identity, route and reserved port", async () => {
  const s = await setup();
  await s.restore();
  expect(s.store.get(s.entry)).toEqual(s.entry);
  expect(s.serviceProxy.getWorkspaceHealthTargets(s.entry.workspaceId)).toEqual([
    expect.objectContaining({ scriptName: "web", port: s.entry.port }),
  ]);
  const allocate = vi.fn(async ({ reservedPorts }: { reservedPorts: ReadonlySet<number> }) => {
    expect(reservedPorts.has(s.entry.port)).toBe(true);
    return s.entry.port + 1;
  });
  const plan = await ensureWorkspaceServicePortPlan({
    workspaceId: s.entry.workspaceId,
    services: [{ scriptName: "web" }, { scriptName: "api" }],
    allocatePort: allocate,
  });
  expect(plan.get("web")).toBe(s.entry.port);
  expect(allocate).toHaveBeenCalledTimes(1);
  if (process.platform !== "win32")
    expect((await stat(s.persistence.path)).mode & 0o777).toBe(0o600);
});
test("an adopted script exit removes the route and durably records stopped", async () => {
  const s = await setup();
  await s.restore();
  for (const fn of s.exits) fn({ exitCode: 0, signal: null, lastOutputLines: [] });
  await s.store.flush();
  expect(s.serviceProxy.getWorkspaceHealthTargets(s.entry.workspaceId)).toEqual([]);
  expect((await WorkspaceScriptRuntimeStore.open(s.persistence)).get(s.entry)).toMatchObject({
    lifecycle: "stopped",
    exitCode: 0,
  });
});
test.each(["missing", "different-workspace", "different-directory", "archived"])(
  "does not revive %s terminal metadata",
  async (kind) => {
    const s = await setup();
    if (kind === "missing") s.terminals.getTerminal = () => undefined;
    if (kind === "different-workspace") Object.assign(s.terminal, { workspaceId: "other" });
    if (kind === "different-directory") Object.assign(s.terminal, { cwd: "/another-checkout" });
    if (kind === "archived")
      s.workspaces.get = async () =>
        ({ workspaceId: s.entry.workspaceId, cwd: s.entry.cwd, archivedAt: "now" }) as never;
    await s.restore();
    expect(s.store.get(s.entry)?.lifecycle).toBe("stopped");
    expect(s.serviceProxy.getWorkspaceHealthTargets(s.entry.workspaceId)).toEqual([]);
  },
);
test("concurrent starts serialize and the second caller sees the first running entry", async () => {
  const s = await setup();
  s.store.remove(s.entry);
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = s.store.withScriptLock(s.entry, async () => {
    await gate;
    s.store.set(s.entry);
  });
  const second = s.store.withScriptLock(s.entry, async () => {
    if (s.store.isRunning(s.entry)) throw new Error("already running");
  });
  const rejected = expect(second).rejects.toThrow("already running");
  release();
  await first;
  await rejected;
  await s.store.flush();
});
test("malformed journals log a warning without reviving arbitrary terminal names", async () => {
  const s = await setup();
  await writeFile(s.persistence.path, "{bad json");
  const warn = vi.fn();
  expect(
    (await WorkspaceScriptRuntimeStore.open({ path: s.persistence.path, logger: { warn } })).list(),
  ).toEqual([]);
  expect(warn).toHaveBeenCalledTimes(1);
  expect(await readFile(s.persistence.path, "utf8")).toBe("{bad json");
});
test("a plain script that completed while detached is marked stopped and restartable", async () => {
  const s = await setup({ type: "script", commandSeq: 0, lastCompletion: { seq: 1, exitCode: 3 } });
  await s.restore();
  expect(s.store.get(s.entry)).toMatchObject({ lifecycle: "stopped", exitCode: 3 });
  expect(s.store.isRunning(s.entry)).toBe(false);
});
test("a completion missed between adoption and listener install is still reconciled", async () => {
  const s = await setup({ type: "script", commandSeq: 0 });
  // The completion lands after the adopted terminal is validated but before the
  // watcher is installed, so no listener sees it; only the retained state does.
  const innerGet = s.workspaces.get;
  let fired = false;
  s.workspaces.get = (async (...args: []) => {
    if (!fired) {
      fired = true;
      s.completeCommand(5, 1);
    }
    return innerGet(...args);
  }) as typeof innerGet;
  await s.restore();
  expect(fired).toBe(true);
  expect(s.store.get(s.entry)).toMatchObject({ lifecycle: "stopped", exitCode: 5 });
  // A late duplicate of the same completion is a no-op, not a second transition.
  s.completeCommand(5, 1);
  expect(s.store.get(s.entry)).toMatchObject({ lifecycle: "stopped", exitCode: 5 });
});
test("a script entry without a completion baseline stays running", async () => {
  const s = await setup({ type: "script", lastCompletion: { seq: 4, exitCode: 0 } });
  await s.restore();
  expect(s.store.get(s.entry)?.lifecycle).toBe("running");
});
test("one entry with missing recovery metadata does not abort the other restores", async () => {
  const s = await setup();
  const bad = {
    ...s.entry,
    scriptName: "broken",
    terminalId: randomUUID(),
    port: undefined,
    projectSlug: undefined,
  };
  s.store.set(bad);
  const badTerminal = {
    id: bad.terminalId,
    cwd: s.entry.cwd,
    workspaceId: s.entry.workspaceId,
    onExit: () => () => {},
    onCommandFinished: () => () => {},
  } as unknown as TerminalSession;
  const getTerminal = s.terminals.getTerminal;
  s.terminals.getTerminal = ((id: string) =>
    id === badTerminal.id ? badTerminal : getTerminal(id)) as typeof getTerminal;
  const warn = vi.fn();
  await expect(
    restoreWorkspaceScripts({
      runtimeStore: s.store,
      terminalManager: s.terminals,
      workspaceRegistry: s.workspaces,
      serviceProxy: s.serviceProxy,
      publicBaseUrl: "https://example.test",
      logger: { warn },
    }),
  ).resolves.toBeUndefined();
  expect(warn).toHaveBeenCalledTimes(1);
  expect(s.store.get(bad)?.lifecycle).toBe("stopped");
  expect(s.store.get(s.entry)?.lifecycle).toBe("running");
  expect(s.serviceProxy.getWorkspaceHealthTargets(s.entry.workspaceId)).toEqual([
    expect.objectContaining({ scriptName: "web", port: s.entry.port }),
  ]);
});
