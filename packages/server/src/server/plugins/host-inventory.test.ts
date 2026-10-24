import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, onTestFinished, vi } from "vitest";
import { AgentStorage } from "../agent/agent-storage.js";
import { AdmissionJournal } from "./admission-journal.js";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { HostInventoryClock } from "./host-inventory-clock.js";
import { HostInventory } from "./host-inventory.js";

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "host-inventory-"));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const clock = new HostInventoryClock(path.join(directory, "watermark"));
  const storage = new AgentStorage(path.join(directory, "agents"), createTestLogger(), clock);
  const journal = new AdmissionJournal(path.join(directory, "admissions"), 14, clock);
  await storage.upsert({
    id: "agent",
    provider: "claude",
    cwd: directory,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    labels: {},
    lastStatus: "closed",
    persistence: { provider: "claude", sessionId: "original" },
  });
  await storage.setBinding("agent", "gc", { identity: "original" }, null);
  return {
    directory,
    storage,
    journal,
    clock,
    inventory: new HostInventory(storage, journal, clock),
  };
}

test("a binding change between native reads cannot be reported as a coherent old binding", async () => {
  const { storage, journal, inventory } = await fixture();
  const initialize = journal.initialize.bind(journal);
  vi.spyOn(journal, "initialize").mockImplementationOnce(async () => {
    await storage.setBinding("agent", "gc", { identity: "replacement" }, 1);
    await initialize();
  });
  const result = await inventory.read("gc");
  expect(result.agents[0].binding).toMatchObject({
    revision: 2,
    data: { identity: "replacement" },
  });
});

test("pages enumerate closed/marker-free agents and all retained admissions beyond the old cap", async () => {
  const { directory, storage, clock } = await fixture();
  const { mkdir, writeFile } = await import("node:fs/promises");
  const journalDirectory = path.join(directory, "large-admissions");
  await mkdir(journalDirectory);
  const now = new Date().toISOString();
  const rows = Array.from({ length: 10001 }, (_, index) => ({
    id: `operation-${index}`,
    agentId: "agent",
    reason: "resume",
    attempt: index + 1,
    supersedes: null,
    startedAt: now,
    status: "opened",
    finishedAt: now,
    effect: {
      persistence: { provider: "claude", sessionId: "original" },
      historyEpoch: "history",
    },
    error: null,
    origin: { kind: "daemon", source: "restore" },
    undeliveredTo: [],
    agent: {
      id: "agent",
      provider: "claude",
      cwd: directory,
      workspaceId: null,
      parentAgentId: null,
      title: null,
    },
    previousEpoch: null,
  }));
  await writeFile(
    path.join(journalDirectory, now.slice(0, 10) + ".jsonl"),
    rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
  );
  const journal = new AdmissionJournal(journalDirectory, 14, clock);
  const inventory = new HostInventory(storage, journal, clock);
  let page = await inventory.read("gc", { limit: 37 });
  const first = page.watermark;
  const agents = [...page.agents];
  const admissions = [...page.admissions];
  while (!page.complete) {
    expect(page.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(page.limits.bytes);
    page = await inventory.read("gc", { cursor: page.nextCursor!, limit: 100 });
    expect(page.watermark).toEqual(first);
    agents.push(...page.agents);
    admissions.push(...page.admissions);
  }
  expect(page.truncated).toBe(false);
  expect(page.nextCursor).toBeNull();
  expect(page.recordsRead).toBe(10002);
  expect(agents).toMatchObject([
    {
      agentId: "agent",
      status: "closed",
      persistence: { sessionId: "original" },
    },
  ]);
  expect(admissions).toHaveLength(10001);
  expect(new Set(admissions.map((row) => row.id)).size).toBe(10001);
  expect(first.productionFence).toBe(false);
  expect(first.excluded).toContain("cross-process-publication-locks");
});

async function addAgent(storage: AgentStorage, id: string, cwd = "/tmp/project") {
  await storage.upsert({
    id,
    provider: "claude",
    cwd,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    labels: {},
    lastStatus: "closed",
  });
}

test("binding/provider identity changes invalidate cursors and a fresh read includes the change", async () => {
  const { storage, inventory } = await fixture();
  await addAgent(storage, "second");
  const page = await inventory.read("gc", { limit: 1 });
  await storage.clearBinding("agent", "gc", 1);
  await expect(inventory.read("gc", { cursor: page.nextCursor! })).rejects.toMatchObject({
    code: "HOST_INVENTORY_STALE",
  });
  const fresh = await inventory.read("gc");
  expect(fresh.agents[0].binding).toBeNull();
  expect(fresh.watermark.sequence).toBeGreaterThan(page.watermark.sequence);
  await storage.remove("second");
  expect((await inventory.read("gc")).agents).toHaveLength(1);
});

test("cursors are single-use, plugin-scoped, bounded and expire", async () => {
  const { storage, inventory } = await fixture();
  await addAgent(storage, "second");
  await addAgent(storage, "third");
  const first = await inventory.read("gc", { limit: 1 });
  await expect(inventory.read("foreign", { cursor: first.nextCursor! })).rejects.toMatchObject({
    code: "HOST_INVENTORY_STALE",
  });
  const second = await inventory.read("gc", {
    cursor: first.nextCursor!,
    limit: 1,
  });
  expect(second.agents[0].agentId).toBe("second");
  await expect(inventory.read("gc", { cursor: first.nextCursor! })).rejects.toMatchObject({
    code: "HOST_INVENTORY_STALE",
  });
  await expect(inventory.read("gc", { limit: 101 })).rejects.toThrow();
  const expiring = await inventory.read("gc", { limit: 1 });
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    vi.setSystemTime(Date.now() + 10001);
    await expect(inventory.read("gc", { cursor: expiring.nextCursor! })).rejects.toMatchObject({
      code: "HOST_INVENTORY_STALE",
    });
  } finally {
    vi.useRealTimers();
  }
  const foreign = await inventory.read("foreign");
  expect(foreign.agents.every((agent) => agent.binding === null)).toBe(true);
});

test("an in-flight durable binding mutation marks the local watermark busy before rename", async () => {
  const { storage, inventory, clock } = await fixture();
  await inventory.read("gc");
  const before = inventory.watermark();
  const { promises: fs } = await import("node:fs");
  const rename = fs.rename.bind(fs);
  let release!: () => void;
  let entered!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reached = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const spy = vi.spyOn(fs, "rename").mockImplementationOnce(async (...args) => {
    entered();
    await held;
    await rename(...args);
  });
  const write = storage.setBinding("agent", "gc", { identity: "next" }, 1);
  await reached;
  try {
    const local = JSON.parse(await fs.readFile(before.local!.path, "utf8"));
    expect(local.watermark.activeWriters).toBeGreaterThan(0);
    await expect(inventory.read("gc")).rejects.toMatchObject({
      code: "HOST_INVENTORY_BUSY",
    });
  } finally {
    release();
    spy.mockRestore();
  }
  await write;
  expect(clock.snapshot().activeWriters).toBe(0);
  expect(clock.snapshot().sequence).toBeGreaterThan(before.watermark.sequence);
  expect((await inventory.read("gc")).agents[0].binding?.revision).toBe(2);
});

test("unreadable/corrupt stored records never produce a complete inventory", async () => {
  const { directory, clock, journal } = await fixture();
  const { mkdir, writeFile } = await import("node:fs/promises");
  const root = path.join(directory, "corrupt");
  await mkdir(root);
  await writeFile(path.join(root, "bad.json"), "{broken");
  const storage = new AgentStorage(root, createTestLogger(), clock);
  await expect(new HostInventory(storage, journal, clock).read("gc")).rejects.toMatchObject({
    code: "HOST_INVENTORY_INCOMPLETE",
  });
});

test("oversized rows fail explicitly instead of silently completing a partial inventory", async () => {
  const { storage, inventory } = await fixture();
  // The host can have arbitrary historical cwd text. Avoid creating that path by
  // using the in-memory inventory iterator, while exercising the actual encoder.
  const original = storage.inventoryRecords.bind(storage);
  vi.spyOn(storage, "inventoryRecords").mockImplementation(function* () {
    for (const record of original()) yield { ...record, cwd: "x".repeat(262144) };
  });
  await expect(inventory.read("gc")).rejects.toMatchObject({
    code: "HOST_INVENTORY_ROW_TOO_LARGE",
  });
});

test("watermarks change on live history updates, bound their suffix and rotate epoch on restart", async () => {
  const { directory, inventory, clock } = await fixture();
  const { InMemoryAgentTimelineStore } = await import("../agent/agent-timeline-store.js");
  const history = new InMemoryAgentTimelineStore(clock);
  const before = clock.snapshot();
  history.initialize("agent", { epoch: "original" });
  history.append("agent", { type: "assistant_message", text: "answer" });
  history.delete("agent");
  for (let i = 0; i < 40; i++) clock.run("provider-registry", () => {});
  const after = inventory.watermark();
  expect(after.watermark.sequence).toBeGreaterThan(before.sequence);
  expect(after.watermark.changes).toHaveLength(64);
  expect(after.watermark.oldestSequence).toBeGreaterThan(1);
  const { readFile, stat } = await import("node:fs/promises");
  const bytes = await readFile(after.local!.path);
  expect(bytes.length).toBeLessThan(16384);
  expect((await stat(after.local!.path)).mode & 0o777).toBe(0o600);
  expect(new HostInventoryClock(path.join(directory, "watermark")).snapshot().epoch).not.toBe(
    before.epoch,
  );
});

test("local publication failure rejects a writer before changing its durable binding", async () => {
  const { storage, inventory, clock } = await fixture();
  await inventory.read("gc");
  const local = inventory.watermark().local!;
  const { chmod } = await import("node:fs/promises");
  await chmod(path.dirname(local.path), 0o755);
  await expect(storage.setBinding("agent", "gc", { changed: true }, 1)).rejects.toThrow();
  expect((await storage.getBinding("agent", "gc"))?.revision).toBe(1);
  expect(() => clock.snapshot()).toThrow("publication failed");
});

test("admission begin, finish and acknowledgement advance the same generation without changing original ids", async () => {
  const { journal, inventory, clock } = await fixture();
  await inventory.read("gc");
  const first = clock.snapshot();
  const operation = await journal.begin({
    agent: {
      id: "agent",
      provider: "claude",
      cwd: "/tmp/project",
      workspaceId: null,
      parentAgentId: null,
      title: null,
    },
    reason: "resume",
    origin: { kind: "daemon", source: "restore" },
    previousEpoch: "old",
    recipients: ["gc"],
  });
  const begun = clock.snapshot();
  expect(begun.sequence).toBeGreaterThan(first.sequence);
  await journal.finish(operation.id, {
    status: "opened",
    effect: {
      persistence: { provider: "claude", sessionId: "native" },
      historyEpoch: "old",
    },
    error: null,
  });
  const finished = clock.snapshot();
  expect(finished.sequence).toBeGreaterThan(begun.sequence);
  await journal.ack(operation.id, "gc");
  const page = await inventory.read("gc");
  expect(page.watermark.sequence).toBeGreaterThan(finished.sequence);
  expect(page.admissions).toMatchObject([
    {
      id: operation.id,
      undeliveredTo: [],
      effect: { persistence: { sessionId: "native" } },
    },
  ]);
});
