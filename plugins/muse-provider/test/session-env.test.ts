import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { installSessionEnvScripts, sessionEnvDir, writeSessionEnv } from "../server/session-env.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function tempDir(tag: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), `session-env-${tag}-`));
  roots.push(root);
  return root;
}
function exec(argv: string[], input = "", env: Record<string, string> = {}) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(argv[0]!, argv.slice(1), { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}
// Runs the hook the way the Muse daemon does, then the rewritten command under /bin/sh.
async function daemonRuns(dir: string, sessionId: string, command: string) {
  const hook = await exec(
    [process.execPath, path.join(dir, "hook.cjs")],
    JSON.stringify({
      session_id: sessionId,
      tool_name: "bash",
      tool_input: { command, workdir: "/" },
    }),
  );
  expect(hook.code).toBe(0);
  const rewritten = hook.stdout
    ? (JSON.parse(hook.stdout).hookSpecificOutput.updatedInput.command as string)
    : command;
  const daemonEnv = { PATH: process.env.PATH ?? "", DAEMON_ONLY: "d" };
  return { hook: hook.stdout, ...(await exec(["/bin/sh", "-c", rewritten], "", daemonEnv)) };
}

test("the env dir follows the override, then XDG_RUNTIME_DIR, then HOME", () => {
  expect(sessionEnvDir({ PASEO_MUSE_SESSION_ENV_DIR: "/x" })).toBe("/x");
  expect(sessionEnvDir({ XDG_RUNTIME_DIR: "/run/user/1" })).toBe(
    "/run/user/1/paseo-muse-session-env",
  );
  expect(sessionEnvDir({ HOME: "/h" })).toBe("/h/.local/state/paseo-muse-session-env");
});

test("two sessions' commands run with their own env, not the daemon's", async () => {
  const dir = await installSessionEnvScripts({ PASEO_MUSE_SESSION_ENV_DIR: await tempDir("dir") });
  const ids = {
    a: "01a1c7f0-98bc-7e92-93ef-05c3e1ff9452",
    b: "01a1c7f0-98bc-7e92-93ef-05c3e1ff9453",
  };
  for (const tag of ["a", "b"] as const) {
    const bin = await tempDir(`bin-${tag}`);
    await mkdir(bin, { recursive: true });
    await writeFile(path.join(bin, `marker-${tag}`), `#!/bin/sh\necho marker-${tag}\n`);
    await chmod(path.join(bin, `marker-${tag}`), 0o755);
    await writeSessionEnv(dir, ids[tag], {
      PATH: `${bin}:${process.env.PATH}`,
      ORBIT_BEAD: `bead-${tag}`,
      BEADS_DIR: `/beads/${tag}`,
    });
  }
  const [a, b] = await Promise.all(
    (["a", "b"] as const).map((tag) =>
      daemonRuns(
        dir,
        ids[tag],
        `echo $ORBIT_BEAD $BEADS_DIR d=$DAEMON_ONLY; marker-${tag}; echo "it's ok"`,
      ),
    ),
  );
  expect(a.stdout).toBe("bead-a /beads/a d=\nmarker-a\nit's ok\n");
  expect(b.stdout).toBe("bead-b /beads/b d=\nmarker-b\nit's ok\n");
});

test("exit codes pass through and a session without an env file is left alone", async () => {
  const dir = await installSessionEnvScripts({ PASEO_MUSE_SESSION_ENV_DIR: await tempDir("dir") });
  const id = "01a1c7f0-98bc-7e92-93ef-05c3e1ff9454";
  await writeSessionEnv(dir, id, { PATH: process.env.PATH ?? "" });
  expect((await daemonRuns(dir, id, "exit 7")).code).toBe(7);
  const other = await daemonRuns(
    dir,
    "01a1c7f0-98bc-7e92-93ef-05c3e1ff9455",
    "echo d=$DAEMON_ONLY",
  );
  expect(other.hook).toBe("");
  expect(other.stdout).toBe("d=d\n");
});
