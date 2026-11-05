import { afterEach, expect, test } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import net from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { createTerminalProgramStopper } from "./terminal-program-stop.js";
import { createTerminalWorkerProcessInspector } from "./terminal-worker-processes.js";
import { writeTerminalWorkerRecord } from "./terminal-worker-record.js";

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).toReversed()) await f();
});
async function eventually<T>(read: () => Promise<T>): Promise<T> {
  let error: unknown;
  for (let n = 0; n < 100; n++) {
    try {
      return await read();
    } catch (e) {
      error = e;
      await delay(25);
    }
  }
  throw error;
}
function emergencyKill(child: ChildProcess) {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    /* already gone */
  }
}

test.skipIf(process.platform !== "linux")(
  "stops the whole terminal group after its shell exits, releasing the stubborn child's port",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "terminal-stop-"));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const childFile = join(directory, "child.mjs");
    const ready = join(directory, "ready.json");
    await writeFile(
      childFile,
      `import http from 'node:http'; import fs from 'node:fs';
process.on('SIGHUP',()=>{}); process.on('SIGTERM',()=>{});
const server=http.createServer((q,s)=>s.end('alive')); server.listen(0,'127.0.0.1',()=>fs.writeFileSync(process.argv[2],JSON.stringify({pid:process.pid,port:server.address().port})));`,
    );
    const parent = spawn(
      process.execPath,
      [
        "-e",
        `const {spawn}=require('node:child_process'); spawn(process.execPath,[${JSON.stringify(childFile)},${JSON.stringify(ready)}],{stdio:'ignore'}); setInterval(()=>{},1000);`,
      ],
      {
        detached: true,
        stdio: "ignore",
        env: { PATH: process.env.PATH, PASEO_TERMINAL_ID: "test-terminal" },
      },
    );
    cleanup.push(() => emergencyKill(parent));
    const info = await eventually(
      async () => JSON.parse(await readFile(ready, "utf8")) as { pid: number; port: number },
    );
    const inspector = createTerminalWorkerProcessInspector();
    const identity = await inspector.inspect(parent.pid!);
    expect(identity.status).toBe("alive");
    if (identity.status !== "alive" || !identity.snapshot.startedAt)
      throw new Error("missing process identity");
    const recordId = randomUUID();
    writeTerminalWorkerRecord(directory, {
      recordId,
      pid: process.pid,
      bootId: null,
      createdAt: new Date().toISOString(),
      identity: { startedAt: identity.snapshot.startedAt, commandLine: "test" },
      protocolVersion: 5,
      paseoVersion: "test",
      socketPath: "unused",
      secret: "unused",
      terminals: [
        { id: "test-terminal", pid: parent.pid!, startedAt: identity.snapshot.startedAt },
      ],
    });
    const stop = createTerminalProgramStopper({ paseoHome: directory, recordId, inspector });
    const started = Date.now();
    await stop("test-terminal", { gracefulTimeoutMs: 250, forceTimeoutMs: 3000 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    const replacement = net.createServer();
    await new Promise<void>((resolve, reject) => {
      replacement.once("error", reject);
      replacement.listen(info.port, "127.0.0.1", () => resolve());
    });
    await new Promise<void>((resolve) => replacement.close(() => resolve()));
    const status = await inspector.inspect(info.pid);
    expect(status.status).toBe("not-found");
  },
);

test.skipIf(process.platform !== "linux")(
  "a stale birth time never signals an unrelated process even with a matching terminal marker",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "terminal-reused-"));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const sentinel = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      detached: true,
      stdio: "ignore",
      env: { PASEO_TERMINAL_ID: "stale-id" },
    });
    cleanup.push(() => emergencyKill(sentinel));
    await delay(50);
    const recordId = randomUUID();
    writeTerminalWorkerRecord(directory, {
      recordId,
      pid: process.pid,
      bootId: null,
      createdAt: new Date().toISOString(),
      identity: { startedAt: "old", commandLine: "test" },
      protocolVersion: 5,
      paseoVersion: "test",
      socketPath: "unused",
      secret: "unused",
      terminals: [{ id: "stale-id", pid: sentinel.pid!, startedAt: "old" }],
    });
    await createTerminalProgramStopper({
      paseoHome: directory,
      recordId,
      inspector: createTerminalWorkerProcessInspector(),
    })("stale-id", { gracefulTimeoutMs: 10, forceTimeoutMs: 10 });
    expect(() => process.kill(sentinel.pid!, 0)).not.toThrow();
  },
);
