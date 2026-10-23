import { promises as fs } from "node:fs";
import { mkdtemp, rm, appendFile, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, onTestFinished, vi } from "vitest";
import { AdmissionJournal } from "./admission-journal.js";

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "admission-journal-"));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  return { directory, journal: new AdmissionJournal(directory) };
}
const input = {
  agent: {
    id: "agent",
    workspaceId: "workspace",
    parentAgentId: null,
    provider: "claude",
    cwd: "/project",
    title: null,
  },
  reason: "resume" as const,
  origin: { kind: "daemon" as const, source: "restore" as const },
  previousEpoch: null,
  recipients: ["one", "two"],
};

test("journal records before returning, recovers interrupted operations and isolates acknowledgements", async () => {
  const { directory, journal } = await fixture();
  const operation = await journal.begin(input);
  const file = path.join(directory, (await readdir(directory))[0]);
  expect(JSON.parse((await readFile(file, "utf8")).trim())).toMatchObject({
    id: operation.id,
    status: "pending",
  });
  await appendFile(file, '{"incomplete":');
  const restarted = new AdmissionJournal(directory);
  expect(await restarted.get(operation.id)).toMatchObject({
    status: "interrupted",
    error: { stage: "interrupted" },
    undeliveredTo: ["one", "two"],
  });
  await restarted.ack(operation.id, "one");
  const again = new AdmissionJournal(directory);
  expect(await again.query({ agentId: "agent", status: ["interrupted"] })).toMatchObject([
    { id: operation.id, undeliveredTo: ["two"] },
  ]);
  expect(await again.query({ status: ["pending"] })).toEqual([]);
});

test("refresh supersedes the last opened operation, keeps its effect and counts attempts", async () => {
  const { journal } = await fixture();
  const first = await journal.begin(input);
  const effect = {
    persistence: { provider: "claude", sessionId: "native" },
    historyEpoch: "epoch",
  };
  await journal.finish(first.id, { status: "opened", effect, error: null });
  const refresh = await journal.begin({ ...input, reason: "refresh" });
  expect(refresh).toMatchObject({ supersedes: first.id, attempt: 2 });
  expect(refresh.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  expect(await journal.get(first.id)).toMatchObject({ effect });
  await expect(journal.ack(refresh.id, "one")).rejects.toThrow("unavailable");
});

test("retention removes old segments after checkpointing retained operations", async () => {
  const { directory, journal } = await fixture();
  const first = await journal.begin(input);
  await journal.finish(first.id, {
    status: "opened",
    effect: { persistence: null, historyEpoch: null },
    error: null,
  });
  const file = path.join(directory, (await readdir(directory))[0]);
  await rename(file, path.join(directory, "2000-01-01.jsonl"));
  const restarted = new AdmissionJournal(directory);
  expect(await restarted.get(first.id)).toMatchObject({ status: "opened" });
  expect(await readdir(directory)).not.toContain("2000-01-01.jsonl");
});

test("outcomes replay in transition order rather than operation start order", async () => {
  const { directory, journal } = await fixture();
  const first = await journal.begin(input);
  const second = await journal.begin(input);
  const outcome = {
    status: "opened" as const,
    effect: { persistence: null, historyEpoch: null },
    error: null,
  };
  await journal.finish(second.id, outcome);
  await journal.finish(first.id, outcome);
  await journal.ack(second.id, "two");
  const restarted = new AdmissionJournal(directory);
  expect((await restarted.undelivered("one")).map((record) => record.id)).toEqual([
    second.id,
    first.id,
  ]);
  expect((await restarted.undelivered("two")).map((record) => record.id)).toEqual([first.id]);
});

test("expired completed records are pruned while current records remain queryable", async () => {
  const { directory, journal } = await fixture();
  const first = await journal.begin({ ...input, recipients: [] });
  const old = await journal.finish(first.id, {
    status: "opened",
    effect: { persistence: null, historyEpoch: null },
    error: null,
  });
  const file = path.join(directory, (await readdir(directory))[0]);
  await rm(file);
  await writeFile(
    path.join(directory, "2000-01-01.jsonl"),
    JSON.stringify({
      ...old,
      startedAt: "2000-01-01T00:00:00Z",
      finishedAt: "2000-01-01T00:00:01Z",
    }) + "\n",
  );
  const restarted = new AdmissionJournal(directory);
  expect(await restarted.get(first.id)).toBeNull();
  expect(await restarted.query({})).toEqual([]);
  expect(await readdir(directory)).not.toContain("2000-01-01.jsonl");
});

test("begin fsyncs the real journal before acknowledging the operation", async () => {
  const { directory, journal } = await fixture();
  const probe = await fs.open(path.join(directory, "probe"), "w");
  const sync = vi.spyOn(Object.getPrototypeOf(probe), "sync");
  onTestFinished(() => {
    sync.mockRestore();
  });
  await probe.close();
  const operation = await journal.begin(input);
  expect(sync).toHaveBeenCalledTimes(process.platform === "win32" ? 1 : 2);
  const content = await readFile(
    path.join(directory, new Date().toISOString().slice(0, 10) + ".jsonl"),
    "utf8",
  );
  expect(JSON.parse(content)).toMatchObject({ id: operation.id, status: "pending" });
});

test("retention also runs on journal rotation without a daemon restart", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  onTestFinished(() => {
    vi.useRealTimers();
  });
  vi.setSystemTime(new Date("2026-10-01T12:00:00Z"));
  const { directory, journal } = await fixture();
  const old = await journal.begin({ ...input, recipients: [] });
  await journal.finish(old.id, {
    status: "opened",
    effect: { persistence: null, historyEpoch: null },
    error: null,
  });
  vi.setSystemTime(new Date("2026-10-17T12:00:00Z"));
  const current = await journal.begin(input);
  expect(await journal.get(old.id)).toBeNull();
  expect(await journal.get(current.id)).toMatchObject({ status: "pending" });
  expect(await readdir(directory)).toEqual(["2026-10-17.jsonl"]);
});

test("a permanently failing history session keeps delivered failures and disk rows bounded", async () => {
  const { directory, journal } = await fixture();
  const pending = await journal.begin(input);
  const replayable = await journal.begin(input);
  const failure = {
    status: "failed" as const,
    effect: null,
    error: {
      code: "SESSION_OPEN_FAILED",
      message: "history unavailable",
      stage: "provider" as const,
    },
  };
  await journal.finish(replayable.id, failure);
  for (let attempt = 0; attempt < 300; attempt++) {
    const operation = await journal.begin({ ...input, recipients: [] });
    await journal.finish(operation.id, failure);
  }
  expect((await journal.query({ status: ["failed"] })).length).toBeLessThanOrEqual(65);
  expect(await journal.get(pending.id)).toMatchObject({ status: "pending" });
  expect((await journal.undelivered("one")).map((row) => row.id)).toContain(replayable.id);
  const rows = (
    await Promise.all(
      (
        await readdir(directory)
      )
        .filter((name) => name.endsWith(".jsonl"))
        .map((name) => readFile(path.join(directory, name), "utf8")),
    )
  )
    .join("")
    .trim()
    .split("\n");
  expect(rows.length).toBeLessThan(256);
  const restarted = new AdmissionJournal(directory);
  expect((await restarted.query({ status: ["failed"] })).length).toBeLessThanOrEqual(65);
  expect(await restarted.get(pending.id)).toMatchObject({ status: "interrupted" });
  expect((await restarted.undelivered("two")).map((row) => row.id)).toContain(replayable.id);
});

test("expired undelivered outcomes survive rotation and only the final ack makes failures eligible", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  onTestFinished(() => vi.useRealTimers());
  vi.setSystemTime(new Date("2026-10-01T12:00:00Z"));
  const { directory, journal } = await fixture();
  const operation = await journal.begin(input);
  const failed = {
    status: "failed" as const,
    effect: null,
    error: { code: "SESSION_OPEN_FAILED", message: "failed", stage: "provider" as const },
  };
  await journal.finish(operation.id, failed);
  vi.setSystemTime(new Date("2026-10-20T12:00:00Z"));
  for (let i = 0; i < 130; i++) {
    const next = await journal.begin({ ...input, recipients: [] });
    await journal.finish(next.id, failed);
  }
  expect(await journal.get(operation.id)).toMatchObject({ undeliveredTo: ["one", "two"] });
  await journal.ack(operation.id, "one");
  expect(await journal.get(operation.id)).toMatchObject({ undeliveredTo: ["two"] });
  const restarted = new AdmissionJournal(directory);
  expect((await restarted.undelivered("two")).map((row) => row.id)).toEqual([operation.id]);
  await restarted.ack(operation.id, "two");
  expect((await restarted.query({ status: ["failed"] })).length).toBeLessThanOrEqual(64);
});

test("startup compacts an existing 34006-operation failure storm before exposing inventory", async () => {
  const { directory, journal } = await fixture();
  const operation = await journal.begin({ ...input, recipients: [] });
  const failed = await journal.finish(operation.id, {
    status: "failed",
    effect: null,
    error: { code: "SESSION_OPEN_FAILED", message: "history failed", stage: "provider" },
  });
  const file = path.join(directory, (await readdir(directory))[0]);
  await writeFile(
    file,
    Array.from({ length: 34006 }, (_, index) =>
      JSON.stringify({ ...failed, id: `storm-${index}`, attempt: index + 1 }),
    ).join("\n") + "\n",
  );
  const restarted = new AdmissionJournal(directory);
  await restarted.initialize();
  expect([...restarted.inventoryRecords()]).toHaveLength(64);
  expect(await restarted.get("storm-34005")).toMatchObject({ status: "failed" });
  expect((await readFile(file, "utf8")).trim().split("\n")).toHaveLength(64);
});

test("a crash after checkpoint rename cannot resurrect replay from an undeleted old segment", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  onTestFinished(() => vi.useRealTimers());
  vi.setSystemTime(new Date("2026-10-01T12:00:00Z"));
  const { directory, journal } = await fixture();
  const operation = await journal.begin(input);
  await journal.finish(operation.id, {
    status: "failed",
    effect: null,
    error: { code: "SESSION_OPEN_FAILED", message: "failed", stage: "provider" },
  });
  const oldFile = path.join(directory, "2026-10-01.jsonl");
  const oldContents = await readFile(oldFile, "utf8");
  await journal.ack(operation.id, "one");
  await journal.ack(operation.id, "two");
  vi.setSystemTime(new Date("2026-10-20T12:00:00Z"));
  await journal.begin({ ...input, recipients: [] });
  // Simulate interruption after the new checkpoint is durable, before unlink.
  await writeFile(oldFile, oldContents);
  const restarted = new AdmissionJournal(directory);
  expect(await restarted.get(operation.id)).toBeNull();
  expect(await restarted.undelivered("one")).toEqual([]);
});
