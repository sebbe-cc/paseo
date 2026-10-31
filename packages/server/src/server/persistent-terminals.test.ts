import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TerminalManager } from "../terminal/terminal-manager.js";
import {
  ensureTmuxSocketDir,
  persistentSessionName,
  resolveTmuxBinary,
  tmuxInvoke,
  tmuxSocketPath,
} from "../terminal/tmux.js";
import { WorkspaceScriptRuntimeStore } from "./workspace-script-runtime-store.js";
import {
  listPersistentTerminals,
  reattachPersistentTerminals,
  recordPersistentTerminal,
  removePersistentTerminal,
  type PersistentTerminalRecord,
} from "./persistent-terminals.js";

const tmuxBin = resolveTmuxBinary();
const tmuxIt = tmuxBin ? it : it.skip;

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "persist-home-"));
}

function record(overrides: Partial<PersistentTerminalRecord> = {}): PersistentTerminalRecord {
  return {
    id: "term-1",
    name: "lab",
    cwd: "/work",
    workspaceId: "wks-1",
    sessionName: persistentSessionName("term-1"),
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function fakeManager(seen: string[]): TerminalManager {
  return {
    getTerminals: async () => [],
    createTerminal: async (options) => {
      seen.push(options.id ?? "?");
      return { id: options.id ?? "?", name: options.name ?? "t" } as never;
    },
    registerCwdEnv: () => {},
    validateTerminalActivityToken: () => "unknown",
    getTerminal: () => undefined,
    getTerminalState: async () => null,
    setTerminalTitle: () => false,
    setTerminalActivity: async () => false,
    clearTerminalAttention: async () => false,
    killTerminal: () => {},
    killTerminalAndWait: async () => {},
    captureTerminal: async () => ({ lines: [], totalLines: 0 }),
    listDirectories: () => [],
    killAll: () => {},
    subscribeTerminalsChanged: () => () => {},
    subscribeTerminalActivity: () => () => {},
    subscribeTerminalWorkspaceContributionChanged: () => () => {},
  };
}

describe("persistent terminal journal", () => {
  it("records, lists and removes terminals", () => {
    const home = tempHome();
    try {
      expect(listPersistentTerminals(home)).toEqual([]);
      recordPersistentTerminal(home, record());
      recordPersistentTerminal(home, record({ id: "term-2", sessionName: "paseo-term-2" }));
      expect(listPersistentTerminals(home).map((r) => r.id).sort()).toEqual(["term-1", "term-2"]);
      removePersistentTerminal(home, "term-1");
      expect(listPersistentTerminals(home).map((r) => r.id)).toEqual(["term-2"]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("ignores corrupt records instead of blocking its siblings", () => {
    const home = tempHome();
    try {
      recordPersistentTerminal(home, record());
      writeFileSync(join(home, "terminals", "persistent", "broken.json"), "{nope");
      expect(listPersistentTerminals(home).map((r) => r.id)).toEqual(["term-1"]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  tmuxIt("reattaches a live session under the same id and restores the script", async () => {
    const home = tempHome();
    const binding = {
      tmuxBin: tmuxBin as string,
      socketPath: tmuxSocketPath(home),
      sessionName: persistentSessionName("term-1"),
    };
    ensureTmuxSocketDir(binding.socketPath);
    try {
      expect(
        tmuxInvoke(binding, ["new-session", "-d", "-s", binding.sessionName, "bash"]).code,
      ).toBe(0);
      recordPersistentTerminal(
        home,
        record({
          scriptName: "lab",
          scriptType: "service",
          servicePort: 18099,
          projectSlug: "proj",
          branchName: null,
          command: "node server.mjs",
        }),
      );
      const seen: string[] = [];
      const runtimeStore = new WorkspaceScriptRuntimeStore();
      const registered: unknown[] = [];
      const result = await reattachPersistentTerminals({
        paseoHome: home,
        terminalManager: fakeManager(seen),
        runtimeStore,
        serviceProxy: {
          registerWorkspaceService: (input: never) => {
            registered.push(input);
            return { hostname: "h", port: 1 } as never;
          },
        },
        serviceProxyPublicBaseUrl: null,
      });
      expect(result.attached).toEqual(["term-1"]);
      expect(seen).toEqual(["term-1"]);
      expect(runtimeStore.get({ workspaceId: "wks-1", scriptName: "lab" })?.lifecycle).toBe(
        "running",
      );
      expect(registered).toHaveLength(1);
    } finally {
      tmuxInvoke(binding, ["kill-server"]);
      rmSync(home, { recursive: true, force: true });
    }
  });

  tmuxIt("drops journal entries whose session is gone and terminal has no command", async () => {
    const home = tempHome();
    try {
      recordPersistentTerminal(home, record());
      const seen: string[] = [];
      const result = await reattachPersistentTerminals({
        paseoHome: home,
        terminalManager: fakeManager(seen),
        runtimeStore: new WorkspaceScriptRuntimeStore(),
        serviceProxy: null,
        serviceProxyPublicBaseUrl: null,
      });
      expect(result.dropped.map((d) => d.id)).toEqual(["term-1"]);
      expect(seen).toEqual([]);
      expect(listPersistentTerminals(home)).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
