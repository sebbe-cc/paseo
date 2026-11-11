import { setTimeout as delay } from "node:timers/promises";
import { execCommand } from "../utils/spawn.js";
import {
  listTerminalWorkerRecords,
  type TerminalWorkerTerminalEntry,
} from "./terminal-worker-record.js";
import { classifyTerminalProgramProcess } from "./terminal-worker-ownership.js";
import type { TerminalWorkerProcessInspector } from "./terminal-worker-processes.js";

interface ProcessEntry {
  pid: number;
  ppid: number;
  group: number;
  session: number | null;
  state: string;
  startedAt: string;
}
interface StopState {
  program: TerminalWorkerTerminalEntry;
  tracked: Map<number, string>;
  groups: Set<number>;
}
export interface TerminalStopOptions {
  gracefulTimeoutMs?: number;
  forceTimeoutMs?: number;
}

async function processTable(): Promise<ProcessEntry[]> {
  const linux = process.platform === "linux";
  const columns = linux ? "pid=,ppid=,pgid=,sid=,stat=,lstart=" : "pid=,ppid=,pgid=,stat=,lstart=";
  const { stdout } = await execCommand("ps", ["-A", "-o", columns], {
    envMode: "internal",
    envOverlay: { LC_ALL: "C" },
    timeout: 15000,
  });
  const result: ProcessEntry[] = [];
  for (const line of String(stdout).split("\n")) {
    const m = line.match(
      linux
        ? /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/
        : /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/,
    );
    if (!m) continue;
    result.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      group: Number(m[3]),
      session: linux ? Number(m[4]) : null,
      state: m[linux ? 5 : 4],
      startedAt: m[linux ? 6 : 5],
    });
  }
  if (result.length === 0)
    throw new Error("Cannot inspect terminal process groups: empty process table");
  return result;
}

/** Controller-side cleanup also covers workers adopted from an older installation. */
export function createTerminalProgramStopper(options: {
  paseoHome: string;
  recordId: string;
  inspector: TerminalWorkerProcessInspector;
}): (id: string, stopOptions?: TerminalStopOptions) => Promise<void> {
  const pending = new Map<string, StopState>();
  const { inspector } = options;

  async function capture(id: string): Promise<StopState> {
    const existing = pending.get(id);
    if (existing) return existing;
    for (const file of await listTerminalWorkerRecords(options.paseoHome)) {
      if ("error" in file || file.record.recordId !== options.recordId) continue;
      const program = file.record.terminals.find((entry) => entry.id === id);
      // A program recorded without a birth time cannot be identified, and 0.16 never
      // signals what it cannot identify (#8818): refuse like an unknown program.
      if (!program || program.startedAt === null) break;
      const state: StopState = {
        program,
        tracked: new Map([[program.pid, program.startedAt]]),
        groups: new Set(),
      };
      pending.set(id, state);
      return state;
    }
    throw new Error(`Cannot confirm process identity for terminal ${id}`);
  }

  async function remaining(state: StopState): Promise<ProcessEntry[]> {
    const table = (await processTable()).filter(
      (p) => !p.state.startsWith("Z") && !p.state.startsWith("X"),
    );
    const owned = new Map(
      table.filter((p) => state.tracked.get(p.pid) === p.startedAt).map((p) => [p.pid, p]),
    );
    const root = owned.get(state.program.pid);
    const reused = table.some(
      (p) => p.pid === state.program.pid && p.startedAt !== state.program.startedAt,
    );
    // A shell may exit before its HUP-ignoring job. Its session is still owned only
    // when the program remains identified, or the child carries this terminal's marker.
    for (const p of table) {
      if (
        reused ||
        p.pid === state.program.pid ||
        p.session !== state.program.pid ||
        owned.has(p.pid)
      )
        continue;
      if (
        root ||
        (await inspector.readEnvironment(p.pid))?.includes(`PASEO_TERMINAL_ID=${state.program.id}`)
      )
        owned.set(p.pid, p);
    }
    let changed = true;
    while (changed) {
      changed = false;
      for (const p of table) {
        if (!owned.has(p.pid) && owned.has(p.ppid)) {
          owned.set(p.pid, p);
          changed = true;
        }
      }
    }
    for (const p of owned.values()) state.tracked.set(p.pid, p.startedAt);
    for (const group of new Set([...owned.values()].map((p) => p.group))) {
      if (table.filter((p) => p.group === group).every((p) => owned.has(p.pid)))
        state.groups.add(group);
    }
    for (const group of state.groups) {
      if (table.some((p) => p.group === group && !owned.has(p.pid))) {
        throw new Error(`Cannot confirm ownership of every member of terminal group ${group}`);
      }
    }
    return [...owned.values()];
  }

  async function signal(targets: ProcessEntry[], signalName: NodeJS.Signals): Promise<void> {
    // Signal a group only if this snapshot identifies every active member as ours.
    const table = (await processTable()).filter(
      (p) => !p.state.startsWith("Z") && !p.state.startsWith("X"),
    );
    const identities = new Map(targets.map((p) => [p.pid, p.startedAt]));
    const groups = new Set(targets.map((p) => p.group));
    for (const group of groups) {
      const members = table.filter((p) => p.group === group);
      if (members.length && members.every((p) => identities.get(p.pid) === p.startedAt)) {
        sendSignal(-group, signalName);
      }
    }
    for (const p of targets) {
      const ownership = classifyTerminalProgramProcess(p, await inspector.inspect(p.pid));
      if (ownership.status === "unknown") throw new Error(ownership.reason);
      if (ownership.status === "owned") sendSignal(p.pid, signalName);
    }
  }

  return async (id, stopOptions = {}) => {
    const state = await capture(id);
    const gracefulDeadline = Date.now() + (stopOptions.gracefulTimeoutMs ?? 2000);
    const signaled = new Set<string>();
    let targets = await remaining(state);
    while (targets.length) {
      const fresh = targets.filter((p) => !signaled.has(`${p.pid}:${p.startedAt}`));
      if (fresh.length) {
        await signal(fresh, "SIGHUP");
        await signal(fresh, "SIGTERM");
        for (const p of fresh) signaled.add(`${p.pid}:${p.startedAt}`);
      }
      if (Date.now() >= gracefulDeadline) break;
      await delay(100);
      targets = await remaining(state);
    }
    const forceDeadline = Date.now() + (stopOptions.forceTimeoutMs ?? 3000);
    targets = await remaining(state);
    while (targets.length) {
      await signal(targets, "SIGKILL");
      await delay(100);
      targets = await remaining(state);
      if (targets.length && Date.now() >= forceDeadline)
        throw new Error(`Terminal ${id} process group did not stop`);
    }
    pending.delete(id);
  };
}

function sendSignal(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}
