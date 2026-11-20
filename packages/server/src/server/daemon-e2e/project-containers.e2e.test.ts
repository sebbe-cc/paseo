import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import type { SessionOutboundMessage } from "@getpaseo/protocol/messages";

import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "../test-utils/paseo-daemon.js";

let paseoHomeRoot: string;
let repoRoot: string;
let daemon: TestPaseoDaemon;
let clients: DaemonClient[];

async function connect(): Promise<DaemonClient> {
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  clients.push(client);
  await client.connect();
  return client;
}

async function addRepository(client: DaemonClient, name: string): Promise<string> {
  const dir = path.join(repoRoot, name);
  mkdirSync(dir);
  const added = await client.addProject(dir);
  expect(added.error).toBeNull();
  return added.project!.projectId;
}

beforeEach(async () => {
  clients = [];
  paseoHomeRoot = realpathSync(mkdtempSync(path.join(os.tmpdir(), "paseo-containers-home-")));
  repoRoot = realpathSync(mkdtempSync(path.join(os.tmpdir(), "paseo-containers-repos-")));
  daemon = await createTestPaseoDaemon({ paseoHomeRoot, cleanup: false });
});

afterEach(async () => {
  await Promise.all(clients.map((client) => client.close().catch(() => undefined)));
  await daemon.close().catch(() => undefined);
  await rm(paseoHomeRoot, { recursive: true, force: true });
  await rm(repoRoot, { recursive: true, force: true });
});

test("advertises the capability and round-trips every RPC", async () => {
  const client = await connect();
  expect(client.getLastServerInfoMessage()?.features?.projectContainers).toBe(true);
  const alpha = await addRepository(client, "alpha");
  const beta = await addRepository(client, "beta");

  const { container: heads } = await client.createProjectContainer({
    name: "Heads",
    projectIds: [alpha],
  });
  const { container: fleet } = await client.createProjectContainer({ name: "Fleet" });
  await expect(client.createProjectContainer({ name: "heads" })).rejects.toThrow(
    "code=project_container_name_taken",
  );
  expect(
    await client.assignProjectContainer({ projectIds: [beta], containerId: heads.id, index: 0 }),
  ).toMatchObject({ projectIds: [beta], containerId: heads.id });
  expect(
    (await client.renameProjectContainer({ containerId: fleet.id, name: "Ops" })).container.name,
  ).toBe("Ops");
  await client.reorderProjectContainers({ containerIds: [fleet.id, heads.id] });

  const listed = await client.listProjectContainers();
  expect(listed.containers.map((c) => [c.name, c.projectIds])).toEqual([
    ["Ops", []],
    ["Heads", [beta, alpha]],
  ]);
  expect(await client.deleteProjectContainer({ containerId: heads.id })).toMatchObject({
    detachedProjectIds: [beta, alpha],
  });

  const file = JSON.parse(
    await readFile(path.join(daemon.paseoHome, "projects", "containers.json"), "utf8"),
  );
  expect(file.containers.map((c: { name: string }) => c.name)).toEqual(["Ops"]);
});

test("pushes catalog updates to subscribers and detaches removed repositories", async () => {
  const writer = await connect();
  const watcher = await connect();
  const alpha = await addRepository(writer, "alpha");

  const subscription = watcher.observeProjectContainers();
  const snapshot = await subscription.ready;
  expect(snapshot).toMatchObject({ containers: [], revision: 0 });
  const updates: Extract<SessionOutboundMessage, { type: "project.container.update" }>[] = [];
  let notify: () => void = () => undefined;
  subscription.subscribe({
    snapshot: () => undefined,
    update: (message) => {
      if (message.type !== "project.container.update") return;
      updates.push(message);
      notify();
    },
  });
  const nextUpdate = (): Promise<void> =>
    new Promise((resolve) => {
      notify = resolve;
    });

  let pushed = nextUpdate();
  await writer.createProjectContainer({ name: "Heads", projectIds: [alpha] });
  await pushed;
  expect(updates.at(-1)?.payload).toMatchObject({ revision: 1, containers: [{ name: "Heads" }] });

  pushed = nextUpdate();
  await writer.removeProject(alpha);
  await pushed;
  expect(updates.at(-1)?.payload.containers[0]?.projectIds).toEqual([]);
  await subscription.release();
});
