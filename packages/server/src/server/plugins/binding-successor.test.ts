import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { expect, onTestFinished, test, vi } from "vitest";
import { AgentStorage } from "../agent/agent-storage.js";
import { HostInventoryClock } from "./host-inventory-clock.js";
import { createTestLogger } from "../../test-utils/test-logger.js";

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "binding-successor-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const clock = new HostInventoryClock(path.join(root, "inventory"));
  const storage = new AgentStorage(path.join(root, "agents"), createTestLogger(), clock);
  await storage.upsert({
    id: "agent",
    provider: "claude",
    cwd: root,
    labels: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastStatus: "closed",
  });
  return { storage, clock };
}

test("binding CAS returns the exact predecessor/successor and lost ACK replays without a second write", async () => {
  const { storage, clock } = await fixture();
  const observed = await storage.observeBinding("agent", "gc");
  const input = { expectRevision: null, expected: observed.state, operationKey: "a".repeat(64) };
  const result = await storage.setBindingWithProof("agent", "gc", { original: true }, input);
  expect(result.proof.predecessor).toEqual(observed.state);
  expect(result.proof.successor.epoch).toBe(observed.state.epoch);
  expect(result.proof.successor.sequence).toBe(observed.state.sequence + 2);
  const after = await storage.observeBinding("agent", "gc");
  expect(after.state).toEqual(result.proof.successor);
  expect(after.binding).toEqual(result.binding);
  const sequence = clock.snapshot().sequence;
  expect(await storage.setBindingWithProof("agent", "gc", { original: true }, input)).toEqual(
    result,
  );
  expect(clock.snapshot().sequence).toBe(sequence);
  await expect(
    storage.setBindingWithProof("agent", "gc", { original: false }, input),
  ).rejects.toMatchObject({ code: "PLUGIN_BINDING_CONFLICT" });
});

test("a stale generation or changed record cannot authorize a binding CAS", async () => {
  const { storage } = await fixture();
  const observed = await storage.observeBinding("agent", "gc");
  await storage.setTitle("agent", "concurrent native writer");
  await expect(
    storage.setBindingWithProof(
      "agent",
      "gc",
      {},
      {
        expectRevision: null,
        expected: observed.state,
        operationKey: "b".repeat(64),
      },
    ),
  ).rejects.toMatchObject({ code: "PLUGIN_BINDING_CONFLICT" });
  expect(await storage.getBinding("agent", "gc")).toBeNull();
});

test("an interleaved native writer never receives an exact successor certificate", async () => {
  const { storage, clock } = await fixture();
  const observed = await storage.observeBinding("agent", "gc");
  const write = (
    storage as unknown as { writeRecord: (record: unknown) => Promise<void> }
  ).writeRecord.bind(storage);
  vi.spyOn(
    storage as unknown as { writeRecord: (record: unknown) => Promise<void> },
    "writeRecord",
  ).mockImplementationOnce(async (record) => {
    clock.run("provider-registry", () => {});
    await write(record);
  });
  const input = { expectRevision: null, expected: observed.state, operationKey: "d".repeat(64) };
  await expect(storage.setBindingWithProof("agent", "gc", {}, input)).rejects.toMatchObject({
    code: "BINDING_SUCCESSOR_UNCERTAIN",
  });
  expect((await storage.getBinding("agent", "gc"))?.revision).toBe(1);
  const sequence = clock.snapshot().sequence;
  await expect(storage.setBindingWithProof("agent", "gc", {}, input)).rejects.toMatchObject({
    code: "PLUGIN_BINDING_CONFLICT",
  });
  expect(clock.snapshot().sequence).toBe(sequence);
});
