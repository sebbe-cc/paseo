import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as pty from "node-pty";
import {
  ensureTmuxServer,
  ensureTmuxServerStable,
  exactSessionTarget,
  persistentSessionName,
  persistentSpawnArgs,
  requireTmuxSession,
  resolveTmuxBinary,
  tmuxInvoke,
  tmuxKillSession,
  tmuxPanePid,
  tmuxSessionAlive,
  tmuxSessionId,
  tmuxSocketPath,
  type PersistentTerminalBinding,
} from "./tmux.js";

const tmuxBin = resolveTmuxBinary();
// Live-tmux tests are skipped where tmux is missing (desvio gate builders).
const tmuxIt = tmuxBin ? it : it.skip;

function tempBinding(sessionName: string): { dir: string; binding: PersistentTerminalBinding } {
  const dir = mkdtempSync(join(tmpdir(), "tmux-unit-"));
  return {
    dir,
    binding: { tmuxBin: tmuxBin as string, socketPath: join(dir, "tmux.sock"), sessionName },
  };
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("tmux persistence helpers", () => {
  it("derives stable socket paths and session names", () => {
    expect(tmuxSocketPath("/home/seb/.paseo")).toBe("/home/seb/.paseo/terminals/tmux.sock");
    expect(persistentSessionName("abc-123")).toBe("paseo-abc-123");
    expect(persistentSessionName("abc-123")).toBe(persistentSessionName("abc-123"));
  });

  it("sanitizes hostile terminal ids into session names", () => {
    expect(persistentSessionName("a/b;c$d")).toBe("paseo-a-b-c-d");
  });

  it("builds an attach-or-create spawn for the daemon PTY", () => {
    const binding = { tmuxBin: "/usr/bin/tmux", socketPath: "/h/tmux.sock", sessionName: "paseo-x" };
    const spawn = persistentSpawnArgs({
      binding,
      cwd: "/work",
      shell: "/bin/bash",
      cols: 80,
      rows: 24,
    });
    expect(spawn.command).toBe("/usr/bin/tmux");
    expect(spawn.args).toEqual([
      "-S",
      "/h/tmux.sock",
      "new-session",
      "-A",
      "-s",
      "paseo-x",
      "-c",
      "/work",
      "-x",
      "80",
      "-y",
      "24",
      "/bin/bash",
    ]);
  });

  tmuxIt("a killed PTY client leaves the session and its PIDs alive", async () => {
    const { dir, binding } = tempBinding("paseo-client-death");
    try {
      const spawn = persistentSpawnArgs({
        binding,
        cwd: dir,
        shell: "/bin/bash",
        cols: 80,
        rows: 24,
      });
      // First client: creates the session (the daemon's PTY on boot).
      const client = pty.spawn(spawn.command, spawn.args, {
        name: "xterm-256color",
        cols: 80,
        rows: 24,
        cwd: dir,
      });
      await delay(1500);
      expect(tmuxSessionAlive(binding)).toBe(true);
      const before = tmuxPanePid(binding);
      expect(before).toBeGreaterThan(0);

      // The daemon (and its worker) dies: the PTY master goes away, which is
      // exactly what killAll({sparePersistent:true}) plus the worker kill do.
      client.kill("SIGKILL");
      await delay(1000);
      expect(tmuxSessionAlive(binding)).toBe(true);
      expect(tmuxPanePid(binding)).toBe(before);

      // A fresh daemon PTY attaches to the same session (reattach path).
      const client2 = pty.spawn(spawn.command, spawn.args, {
        name: "xterm-256color",
        cols: 80,
        rows: 24,
        cwd: dir,
      });
      await delay(1500);
      expect(tmuxPanePid(binding)).toBe(before);
      client2.kill();

      // Explicit kills end the session (script stop / terminal kill).
      tmuxKillSession(binding);
      expect(tmuxSessionAlive(binding)).toBe(false);
    } finally {
      tmuxInvoke(binding, ["kill-server"]);
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  tmuxIt("exact targets never resolve a missing session to another one", async () => {
    // pa-vbhcu: bare `-t <name>` prefix-matches, so a missing session once
    // read another session's pane (and kills could hit it). Every helper
    // below must address exactly its own session or fail clearly. The missing
    // name here is a strict prefix of the live sibling: the dangerous
    // direction for tmux's fallback.
    const { dir, binding } = tempBinding("paseo-exact-target");
    const sibling = tempBinding("paseo-exact-target-sibling");
    sibling.binding.socketPath = binding.socketPath;
    const spawnClient = (target: PersistentTerminalBinding) => {
      const spawn = persistentSpawnArgs({
        binding: target,
        cwd: dir,
        shell: "/bin/sh",
        cols: 80,
        rows: 24,
      });
      return pty.spawn(spawn.command, spawn.args, {
        name: "xterm-256color",
        cols: 80,
        rows: 24,
        cwd: dir,
      });
    };
    try {
      const siblingClient = spawnClient(sibling.binding);
      await delay(1500);
      expect(tmuxSessionAlive(sibling.binding)).toBe(true);
      const siblingPid = tmuxPanePid(sibling.binding);
      expect(siblingPid).toBeGreaterThan(0);

      const missing: PersistentTerminalBinding = { ...binding };
      // Liveness and pane identity never fall back to the prefixed sibling.
      expect(tmuxSessionAlive(missing)).toBe(false);
      expect(tmuxSessionId(missing)).toBeNull();
      expect(tmuxPanePid(missing)).toBeNull();
      expect(() => requireTmuxSession(missing)).toThrow(/not found/);

      // An exact kill of the missing name touches nothing; the sibling lives.
      tmuxKillSession(missing);
      expect(tmuxSessionAlive(sibling.binding)).toBe(true);
      expect(tmuxPanePid(sibling.binding)).toBe(siblingPid);

      // The exact session itself resolves to its own `$id` once it exists.
      const client = spawnClient(binding);
      await delay(1500);
      expect(tmuxSessionAlive(binding)).toBe(true);
      const selfId = tmuxSessionId(binding);
      expect(selfId).toMatch(/^\$\d+$/);
      expect(selfId).not.toBe(tmuxSessionId(sibling.binding));
      expect(requireTmuxSession(binding)).toBe(selfId);
      expect(exactSessionTarget(binding.sessionName)).toBe(`=${binding.sessionName}`);

      client.kill();
      siblingClient.kill();
    } finally {
      tmuxInvoke(binding, ["kill-server"]);
      rmSync(dir, { recursive: true, force: true });
      rmSync(sibling.dir, { recursive: true, force: true });
    }
  }, 60_000);

  tmuxIt("ensureTmuxServer detaches orphaned clients instead of moving them", async () => {
    // pa-vbhcu: without detach-on-destroy, killing a session moves its
    // attached clients to another session (dead terminals serving another
    // session's output, input misdelivered). The behavioral proof lives in
    // the persistent-script-verify e2e; here we pin the mechanism.
    const { dir, binding } = tempBinding("paseo-dod-probe");
    try {
      // No server yet: best-effort, never throws.
      ensureTmuxServer(binding);
      expect(await ensureTmuxServerStable(binding, 300)).toBe(false);
      // Once a session (and its server) exists the option sticks, and fresh
      // sessions inherit the global value.
      const spawn = persistentSpawnArgs({
        binding,
        cwd: dir,
        shell: "/bin/sh",
        cols: 80,
        rows: 24,
      });
      const client = pty.spawn(spawn.command, spawn.args, {
        name: "xterm-256color",
        cols: 80,
        rows: 24,
        cwd: dir,
      });
      await delay(1500);
      try {
        ensureTmuxServer(binding);
        const show = tmuxInvoke(binding, ["show-options", "-gv", "detach-on-destroy"]);
        expect(show.code).toBe(0);
        expect(show.stdout.trim()).toBe("on");
      } finally {
        client.kill();
      }
    } finally {
      tmuxInvoke(binding, ["kill-server"]);
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
