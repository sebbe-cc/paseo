import { once } from "node:events";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { createSshTunnel } from "./ssh-tunnel.js";

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
