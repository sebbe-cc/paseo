import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, onTestFinished, vi } from "vitest";
import { AgentStorage } from "../agent/agent-storage.js";
import { AdmissionJournal } from "./admission-journal.js";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { HostInventoryClock } from "./host-inventory-clock.js";
import { HostInventory } from "./host-inventory.js";
import { AgentStreamCoalescer } from "../agent/agent-stream-coalescer.js";
import { InMemoryAgentTimelineStore } from "../agent/agent-timeline-store.js";

const nativeFenceTest = test.skipIf(process.platform !== "linux" && process.platform !== "darwin");

nativeFenceTest(
  "coalescer timer retains ordered timeline through a short native publication",
  async () => {
    const { directory, clock, inventory } = await fixture();
    vi.stubEnv("PASEO_HOME", directory);
    vi.stubEnv("FLEET_TOWN_STATE_DIR", path.join(directory, "town"));
    onTestFinished(() => vi.unstubAllEnvs());
    const store = new InMemoryAgentTimelineStore(clock);
    store.initialize("agent");
    let tick: (() => void) | undefined;
    const delivered: string[] = [];
    const coalescer = new AgentStreamCoalescer({
      timers: {
        setTimeout: (callback) => {
          tick = callback;
          return setTimeout(() => {}, 60_000);
        },
        clearTimeout,
      },
      onFlush: ({ item }) => {
        store.append("agent", item);
        delivered.push(item.type === "assistant_message" ? item.text : item.type);
      },
    });
    const emit = (text: string) =>
      coalescer.handle("agent", {
        type: "timeline",
        provider: "claude",
        item: { type: "assistant_message", text, messageId: text },
      });
    emit("first");
    emit("second");
    const before = clock.snapshot();
    const { child, exited } = await nativeWriter(
      path.join(directory, "watermark"),
      `
const fd = openSync(clock.fence().lock.path, "r+");
flockSync(fd, "exnb");
process.stdout.write("locked\\n");
process.stdin.resume();
process.stdin.on("end", () => closeSync(fd));
`,
    );
    try {
      expect(() => tick!()).not.toThrow();
      emit("third");
      expect(delivered).toEqual(["first"]);
      expect(clock.snapshot()).toEqual(before);
    } finally {
      child.stdin.end();
      await exited;
    }
    tick!();
    coalescer.flushAndDiscard("agent");
    expect(delivered).toEqual(["first", "second", "third"]);
    expect(store.fetch("agent").window).toEqual({ minSeq: 1, maxSeq: 3, nextSeq: 4 });
    expect(clock.snapshot().activeWriters).toBe(0);
    expect(clock.snapshot().sequence).toBe(before.sequence + 4);
    expect((await inventory.read("gc")).agents.map((row) => row.agentId)).toEqual(["agent"]);
  },
);

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "host-inventory-"));
  vi.stubEnv("PASEO_HOME", directory);
  vi.stubEnv("FLEET_TOWN_STATE_DIR", path.join(directory, "town"));
  onTestFinished(() => vi.unstubAllEnvs());
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

nativeFenceTest(
  "async host writers wait before mutation and do not retry a failed action",
  async () => {
    const { directory, clock } = await fixture();
    const { child, exited } = await nativeWriter(
      path.join(directory, "watermark"),
      `
const fd = openSync(clock.fence().lock.path, "r+");
flockSync(fd, "exnb");
process.stdout.write("locked\\n");
process.stdin.resume();
process.stdin.on("end", () => closeSync(fd));
`,
    );
    const before = clock.snapshot();
    const writes: number[] = [];
    const first = clock.track("agent-records", async () => {
      writes.push(1);
    });
    const second = clock.track("admissions", async () => {
      writes.push(2);
      throw new Error("mutation failure");
    });
    const failed = expect(second).rejects.toThrow("mutation failure");
    const third = clock.track("plugin-lifecycle", async () => {
      writes.push(3);
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 75));
      expect(writes).toEqual([]);
      expect(clock.snapshot()).toEqual(before);
    } finally {
      child.stdin.end();
      await exited;
    }
    await Promise.all([first, failed, third]);
    expect(writes).toEqual([1, 2, 3]);
    expect(clock.snapshot().sequence).toBe(before.sequence + 6);
    expect(clock.snapshot().activeWriters).toBe(0);
  },
);

nativeFenceTest("async host queue warns once and rejects after its bounded wait", async () => {
  const { directory } = await fixture();
  const warn = vi.fn();
  const clock = new HostInventoryClock(path.join(directory, "retry"), warn);
  clock.fence();
  const { child, exited } = await nativeWriter(
    path.join(directory, "retry"),
    `
const fd = openSync(clock.fence().lock.path, "r+");
flockSync(fd, "exnb");
process.stdout.write("locked\\n");
process.stdin.resume();
process.stdin.on("end", () => closeSync(fd));
`,
  );
  const mutation = vi.fn(async () => {});
  vi.useFakeTimers();
  try {
    const waiting = expect(clock.track("agent-records", mutation)).rejects.toMatchObject({
      code: "HOST_FENCE_SATURATED",
    });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(warn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(25_000);
    await waiting;
    expect(warn).toHaveBeenCalledTimes(1);
    expect(mutation).not.toHaveBeenCalled();
    expect(clock.snapshot().activeWriters).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
    child.stdin.end();
    await exited;
  }
  await clock.track("agent-records", mutation);
  expect(mutation).toHaveBeenCalledTimes(1);
});

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
  const { mkdir } = await import("node:fs/promises");
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
  const { mkdir } = await import("node:fs/promises");
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

nativeFenceTest(
  "a publisher holds the checked host generation until publication finishes",
  async () => {
    const { directory, storage, inventory, clock } = await fixture();
    await inventory.read("gc");
    const before = inventory.watermark();
    const lockPath = path.join(directory, "watermark", "host-fence.lock");
    await writeFile(lockPath, "", { flag: "a", mode: 0o600 });
    const publisher = spawn(process.execPath, [
      "-e",
      `
const { openSync, closeSync } = require("node:fs");
const { flockSync } = require("fs-ext");
const fds = process.argv.slice(1).map(name => {
  const fd = openSync(name, "a+", 0o600);
  flockSync(fd, "exnb");
  return fd;
});
process.stdout.write("locked\\n");
process.stdin.resume();
process.stdin.on("end", () => fds.forEach(closeSync));
`,
      path.join(directory, "admission.lock"),
      path.join(directory, "registry.json.lock"),
      lockPath,
    ]);
    const exited = once(publisher, "exit");
    let racing: ReturnType<AgentStorage["setBinding"]> | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        publisher.stdout.once("data", () => resolve());
        publisher.once("error", reject);
        publisher.once("exit", () => reject(new Error("Publisher exited before acquiring locks")));
      });
      // This is the publication window after the last local generation check.
      racing = storage.setBinding("agent", "gc", { identity: "racing" }, 1);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(clock.snapshot()).toEqual(before.watermark);
      expect((await storage.getBinding("agent", "gc"))?.revision).toBe(1);
    } finally {
      publisher.stdin.end();
      await exited;
    }
    await racing;
    expect((await storage.getBinding("agent", "gc"))?.revision).toBe(2);
    await storage.setBinding("agent", "gc", { identity: "after-publication" }, 2);
    expect((await storage.getBinding("agent", "gc"))?.revision).toBe(3);
  },
);

async function nativeWriter(directory: string, action: string) {
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `
import { HostInventoryClock } from ${JSON.stringify(new URL("./host-inventory-clock.ts", import.meta.url).href)};
import { createRequire } from "node:module";
import { openSync, closeSync } from "node:fs";
const { flockSync } = createRequire(import.meta.url)("fs-ext");
const clock = new HostInventoryClock(process.argv[1]);
${action}
`,
      directory,
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  const exited = once(child, "exit");
  onTestFinished(async () => {
    child.kill("SIGKILL");
    await exited;
  });
  await new Promise<void>((resolve, reject) => {
    child.stdout.once("data", () => resolve());
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`Native writer exited: ${code}`)));
  });
  return { child, exited };
}

nativeFenceTest(
  "continuous SH writer forces bounded publisher BUSY and process death releases SH",
  async () => {
    const { directory, clock } = await fixture();
    const token = clock.fence();
    const { child, exited } = await nativeWriter(
      path.join(directory, "watermark"),
      `
const finish = clock.begin("admissions");
process.stdout.write("holding");
process.stdin.resume();
process.stdin.on("end", finish);
`,
    );
    const { openSync, closeSync } = await import("node:fs");
    const { flockSync } = await import("fs-ext");
    const started = performance.now();
    let attempts = 0;
    async function boundedPublisher() {
      for (let attempt = 0; attempt < 3; attempt++) {
        const fds: number[] = [];
        attempts++;
        try {
          for (const name of [
            path.join(directory, "admission.lock"),
            path.join(directory, "registry.json.lock"),
            token.lock.path,
          ]) {
            const fd = openSync(name, "a+", 0o600);
            fds.push(fd);
            flockSync(fd, "exnb");
          }
          return "published";
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "EAGAIN")) throw error;
        } finally {
          fds.toReversed().forEach(closeSync);
        }
        await new Promise((resolve) => setTimeout(resolve, 5 * (attempt + 1) + Math.random() * 5));
      }
      return "HOST_FENCE_BUSY";
    }
    expect(await boundedPublisher()).toBe("HOST_FENCE_BUSY");
    expect(attempts).toBe(3);
    expect(performance.now() - started).toBeLessThan(1000);
    child.kill("SIGKILL");
    await exited;
    const fd = openSync(token.lock.path, "r+");
    try {
      expect(() => flockSync(fd, "exnb")).not.toThrow();
    } finally {
      closeSync(fd);
    }
  },
);

nativeFenceTest(
  "provider hook acquires admission after publisher drops all locks on host BUSY",
  async () => {
    const { directory, clock } = await fixture();
    const token = clock.fence();
    const { openSync, closeSync } = await import("node:fs");
    const { flockSync } = await import("fs-ext");
    const admissionPath = path.join(directory, "admission.lock");
    const admission = openSync(admissionPath, "a+", 0o600);
    const registry = openSync(path.join(directory, "registry.json.lock"), "a+", 0o600);
    const host = openSync(token.lock.path, "r+");
    flockSync(admission, "exnb");
    flockSync(registry, "exnb");
    const { child, exited } = await nativeWriter(
      path.join(directory, "watermark"),
      `
await clock.track("admissions", async () => {
  process.stdout.write("entered-provider-hook");
  const admission = openSync(${JSON.stringify(admissionPath)}, "r+");
  flockSync(admission, "ex");
  closeSync(admission);
});
`,
    );
    try {
      expect(() => flockSync(host, "exnb")).toThrow();
    } finally {
      closeSync(host);
      closeSync(registry);
      closeSync(admission);
    }
    expect(await exited).toEqual([0, null]);
    expect(child.exitCode).toBe(0);
  },
);

nativeFenceTest(
  "fence token pins a permanent inode; replacement rejects writers and stale tokens",
  async () => {
    const { clock, storage } = await fixture();
    const token = clock.fence();
    const { rename, stat } = await import("node:fs/promises");
    await rename(token.lock.path, `${token.lock.path}.replaced`);
    await writeFile(token.lock.path, "", { mode: 0o600 });
    expect(String((await stat(token.lock.path, { bigint: true })).ino)).not.toBe(token.lock.inode);
    await expect(storage.setBinding("agent", "gc", { bad: true }, 1)).rejects.toMatchObject({
      code: "HOST_FENCE_UNAVAILABLE",
    });
    expect((await storage.getBinding("agent", "gc"))?.revision).toBe(1);
    expect(() => clock.fence()).toThrow();
  },
);

nativeFenceTest(
  "all clock domains, nested writers and restarted hosts respect the publication lock",
  async () => {
    const { directory, clock } = await fixture();
    const token = clock.fence();
    const { openSync, closeSync } = await import("node:fs");
    const { flockSync } = await import("fs-ext");
    const fd = openSync(token.lock.path, "r+");
    const first = clock.begin("admissions");
    const second = clock.begin("live-history");
    first();
    first();
    expect(() => flockSync(fd, "exnb")).toThrow();
    expect(() => clock.fence()).toThrow();
    second();
    flockSync(fd, "exnb");
    try {
      for (const domain of token.watermark.covered) {
        expect(() =>
          clock.run(domain, () => {
            throw new Error("Unfenced mutation executed");
          }),
        ).toThrow("Host publication in progress");
      }
      const restarted = new HostInventoryClock(path.join(directory, "watermark"));
      expect(() => restarted.begin("agent-records")).toThrow("Host publication in progress");
      expect(() => restarted.export()).toThrow("Host publication in progress");
    } finally {
      closeSync(fd);
    }
    expect(clock.fence().watermark.sequence).toBeGreaterThan(token.watermark.sequence);
  },
);
