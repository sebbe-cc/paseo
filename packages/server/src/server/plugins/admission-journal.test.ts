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
  const first = await journal.begin(input);
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
  const old = await journal.begin(input);
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
