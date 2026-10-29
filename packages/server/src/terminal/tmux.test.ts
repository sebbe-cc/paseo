import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as pty from "node-pty";
import {
  persistentSessionName,
  persistentSpawnArgs,
  resolveTmuxBinary,
  tmuxInvoke,
  tmuxKillSession,
  tmuxPanePid,
  tmuxSessionAlive,
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
});
