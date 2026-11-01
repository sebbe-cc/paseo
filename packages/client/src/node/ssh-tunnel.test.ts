import { execFile, spawnSync } from "node:child_process";
import { once } from "node:events";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test, vi } from "vitest";
import { createSshTunnel } from "./ssh-tunnel.js";

const run = promisify(execFile);
const hasSsh = !spawnSync("ssh", ["-V"]).error;

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0).toReversed()) close();
  vi.restoreAllMocks();
});

// An ssh that closes its stdin but stays alive: writes into the tunnel then fail with EPIPE.
function fakeSshClosingStdin(): void {
  const dir = mkdtempSync(join(tmpdir(), "paseo-fake-ssh-"));
  writeFileSync(join(dir, "ssh"), "#!/bin/sh\nexec 0<&-\nexec sleep 30\n");
  chmodSync(join(dir, "ssh"), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${dir}:${path ?? ""}`;
  cleanup.push(() => {
    process.env.PATH = path;
    rmSync(dir, { recursive: true, force: true });
  });
}

test.skipIf(!hasSsh)(
  "an SSH peer abort during a pending write closes the tunnel without crashing its caller",
  async () => {
    // Isolate the caller so an unhandled stream error fails this assertion instead
    // of crashing the test worker. Both the TCP peer and OpenSSH are real.
    const { stdout } = await run(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        `
        import { createServer, createConnection } from 'node:net';
        import { once } from 'node:events';
        import { createSshTunnel } from ${JSON.stringify(new URL("./ssh-tunnel.ts", import.meta.url).href)};

        const remote = createServer(socket => socket.destroy());
        remote.listen(0, '127.0.0.1');
        await once(remote, 'listening');
        const tunnel = await createSshTunnel({
          host: '127.0.0.1', sshPort: remote.address().port, daemonPort: 6767,
        });
        const [host, port] = tunnel.endpoint.split(':');
        const client = createConnection({ host, port: Number(port) });
        client.on('error', () => undefined);
        try {
          const closed = new Promise(resolve => client.once('close', resolve));
          await once(client, 'connect');
          client.write(Buffer.alloc(8 * 1024 * 1024, 65));
          await closed;
          console.log(JSON.stringify({ closed: client.destroyed, failure: tunnel.failureDetail() }));
        } finally {
          client.destroy();
          tunnel.close();
          await new Promise(resolve => remote.close(resolve));
        }
      `,
      ],
      { timeout: 10_000 },
    );
    expect(JSON.parse(stdout)).toEqual({
      closed: true,
      failure: expect.any(String),
    });
    expect(JSON.parse(stdout).failure).not.toBe("");
  },
);

test("a closed ssh stdin logs and closes the tunnel instead of throwing EPIPE", async () => {
  fakeSshClosingStdin();
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const uncaught = vi.fn();
  process.on("uncaughtException", uncaught);
  cleanup.push(() => process.off("uncaughtException", uncaught));

  const tunnel = await createSshTunnel({ host: "example", daemonPort: 6767 });
  cleanup.push(() => tunnel.close());
  const [host, port] = tunnel.endpoint.split(":");
  const client = connect(Number(port), host);
  client.on("error", () => undefined);
  await once(client, "connect");
  const chunk = Buffer.alloc(64 * 1024, 1);
  const writer = setInterval(() => {
    if (!client.destroyed) client.write(chunk);
  }, 5);
  cleanup.push(() => clearInterval(writer));

  await once(client, "close");
  expect(uncaught).not.toHaveBeenCalled();
  expect(warn).toHaveBeenCalledWith(
    "SSH tunnel stdin failed",
    expect.objectContaining({ code: "EPIPE" }),
  );
});
