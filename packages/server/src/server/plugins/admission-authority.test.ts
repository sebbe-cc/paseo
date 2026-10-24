import { promises as fs } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import pino from "pino";
import { expect, test, onTestFinished, vi } from "vitest";
import { AgentStorage } from "../agent/agent-storage.js";
import { AdmissionJournal } from "./admission-journal.js";
import { HostInventoryClock } from "./host-inventory-clock.js";
import { admissionBoundary } from "./admission-boundary.js";

async function fixture() {
  const root = await fs.mkdtemp(path.join(tmpdir(), "admission-authority-"));
  onTestFinished(() => fs.rm(root, { recursive: true, force: true }));
  const clock = new HostInventoryClock(path.join(root, "inventory"));
  const storage = new AgentStorage(path.join(root, "agents"), pino({ level: "silent" }), clock);
  const journal = new AdmissionJournal(path.join(root, "admissions"), 14, clock);
  await storage.upsert({
    id: "original",
    provider: "codex",
    cwd: root,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    labels: {},
    lastStatus: "closed",
  });
  const input = {
    agent: {
      id: "original",
      provider: "codex",
      cwd: root,
      title: null,
      workspaceId: null,
      parentAgentId: null,
    },
    reason: "resume" as const,
    origin: { kind: "daemon" as const, source: "restore" as const },
    previousEpoch: null,
    recipients: [],
  };
  const operation = await journal.begin(input);
  const read = () => {
    const op = journal.observeAdmission(operation.id);
    const agent = storage.observeAdmission("original");
    return { busy: op.busy || agent.busy, value: { operation: op.record, agent: agent.value } };
  };
  return { root, clock, storage, journal, operation, input, read };
}

test("queued binding writes block dispatch before the durable rename; ABA stays invalid", async () => {
  const { clock, storage, read } = await fixture();
  const validate = await admissionBoundary(clock, read);
  const permit = await validate();
  const rename = fs.rename.bind(fs);
  let release!: () => void;
  const stalled = new Promise<void>((resolve) => {
    release = resolve;
  });
  const spy = vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
    await stalled;
    return rename(...args);
  });
  const binding = storage.setBinding("original", "gc", { owner: "new" }, null);
  try {
    await vi.waitFor(() => expect(spy).toHaveBeenCalled());
    expect(storage.observeAdmission("original").value.bindings).toEqual({});
    expect(storage.observeAdmission("original").busy).toBe(true);
    let effects = 0;
    expect(() => permit(() => ++effects)).toThrowError(/Host state changed/);
    expect(effects).toBe(0);
  } finally {
    release();
    await binding;
    spy.mockRestore();
  }
  await storage.clearBinding("original", "gc", 1);
  expect(storage.observeAdmission("original").value.bindings).toEqual({});
  await expect(validate()).rejects.toMatchObject({ code: "ADMISSION_RETRY" });
});

test("metadata publication in flight does not invalidate this agent's binding authority", async () => {
  const { clock, storage, read } = await fixture();
  const validate = await admissionBoundary(clock, read);
  const rename = fs.rename.bind(fs);
  let release!: () => void;
  const stalled = new Promise<void>((resolve) => {
    release = resolve;
  });
  const spy = vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
    await stalled;
    return rename(...args);
  });
  const writing = storage.setTitle("original", "New display title");
  try {
    await vi.waitFor(() => expect(spy).toHaveBeenCalled());
    expect(clock.snapshot().activeWriters).toBeGreaterThan(0);
    const permit = await validate();
    expect(permit(() => "opened")).toBe("opened");
  } finally {
    release();
    await writing;
    spy.mockRestore();
  }
});

test("queued mutation of the original journal operation blocks an effect, unrelated ACK does not", async () => {
  const { clock, journal, operation, input, read } = await fixture();
  const other = await journal.begin(input);
  const outcome = {
    status: "opened" as const,
    effect: { persistence: null, historyEpoch: null },
    error: null,
  };
  await journal.finish(other.id, outcome);
  const validate = await admissionBoundary(clock, read);
  const ack = journal.ack(other.id, "unrelated");
  const permit = await validate();
  expect(permit(() => "opened")).toBe("opened");
  await ack;
  const finishing = journal.finish(operation.id, outcome);
  expect(journal.observeAdmission(operation.id).busy).toBe(true);
  await expect(validate()).rejects.toMatchObject({ code: "ADMISSION_RETRY" });
  await finishing;
  await expect(validate()).rejects.toMatchObject({ code: "ADMISSION_RETRY" });
});

test("deletion invalidates a captured binding before the record disappears", async () => {
  const { clock, storage, read } = await fixture();
  const validate = await admissionBoundary(clock, read);
  const permit = await validate();
  storage.beginDelete("original");
  expect(() => permit(() => "must not run")).toThrowError(/Host state changed/);
});
