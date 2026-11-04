import { expect, test } from "vitest";
import { Usage } from "../server/usage.js";
import type { ProviderLaunch } from "@getpaseo/plugin/server/provider";

function launch(env: Record<string, string>): ProviderLaunch {
  return { command: "muse", args: [], env };
}

function observation(overrides: Record<string, unknown> = {}) {
  return {
    observedAtMs: 1700000000000,
    tier: "Pro",
    window: { usedPercent: 75, resetsAtMs: 1700018000000, windowDurationMins: 300 },
    weekly: { usedPercent: 105, resetsAtMs: 1700604800000 },
    ...overrides,
  };
}

async function fetchReport(usage: Usage, account: string) {
  return usage.registration().fetch({ account });
}

test("recordObservation stores the latest observation and rejects older or equal ones", () => {
  const usage = new Usage();
  const { account } = usage.remember(launch({ HOME: "/usage/home" }));
  expect(usage.recordObservation(account, observation())).toBe(true);
  expect(usage.latest(account)?.window.usedPercent).toBe(75);
  expect(usage.recordObservation(account, observation({ observedAtMs: 1699999999999 }))).toBe(
    false,
  );
  expect(usage.recordObservation(account, observation({ observedAtMs: 1700000000000 }))).toBe(
    false,
  );
  expect(usage.recordObservation(account, observation({ observedAtMs: 1700000000001 }))).toBe(true);
  expect(usage.latest(account)?.observedAtMs).toBe(1700000000001);
});

test("recordObservation drops invalid observations without touching the store", () => {
  const usage = new Usage();
  const { account } = usage.remember(launch({ HOME: "/usage/home" }));
  expect(
    usage.recordObservation(account, observation({ window: { ...observation().window } })),
  ).toBe(true);
  for (const invalid of [
    observation({ tier: "" }),
    observation({ window: { usedPercent: -1, resetsAtMs: 1, windowDurationMins: 300 } }),
    observation({ window: { usedPercent: 1, resetsAtMs: 1, windowDurationMins: 0 } }),
    observation({ observedAtMs: Number.NaN }),
  ]) {
    expect(usage.recordObservation(account, invalid)).toBe(false);
  }
  expect(usage.latest(account)?.window.usedPercent).toBe(75);
});

test("recordObservation notifies only on a strictly newer stored observation", () => {
  const usage = new Usage();
  const seen: string[] = [];
  usage.onDidChange = (account) => seen.push(account);
  const { account } = usage.remember(launch({ HOME: "/usage/home" }));
  expect(usage.recordObservation(account, observation())).toBe(true);
  expect(seen).toEqual([account]);
  expect(usage.recordObservation(account, observation())).toBe(false);
  expect(usage.recordObservation(account, observation({ observedAtMs: 1699999999999 }))).toBe(
    false,
  );
  expect(usage.recordObservation(account, observation({ tier: "" }))).toBe(false);
  expect(seen).toEqual([account]);
  expect(usage.recordObservation(account, observation({ observedAtMs: 1700000000001 }))).toBe(true);
  expect(seen).toEqual([account, account]);
});

test("observations from one account never touch another account", () => {
  const usage = new Usage();
  const home = usage.remember(launch({ HOME: "/usage/home" }));
  const work = usage.remember(launch({ HOME: "/usage/home", XDG_CONFIG_HOME: "/usage/work" }));
  expect(home.account).not.toBe(work.account);
  usage.recordObservation(home.account, observation({ tier: "Pro" }));
  usage.recordObservation(work.account, observation({ tier: "Team" }));
  expect(usage.latest(home.account)?.tier).toBe("Pro");
  expect(usage.latest(work.account)?.tier).toBe("Team");
});

test("detach keeps the retained observation and fetch serves it without a host", async () => {
  const usage = new Usage();
  const env = { HOME: "/usage/home" };
  const { account } = usage.remember(launch(env));
  usage.attach("session-1", launch(env), async () => ({ usage: observation() }));
  const live = await fetchReport(usage, account);
  expect(live.status).toBe("available");
  usage.detach("session-1");
  // No live readers and a launch whose host cannot start: a retained value must
  // still serve without waking anything.
  const retained = await fetchReport(usage, account);
  expect(retained).toMatchObject({ status: "available", planLabel: "Pro" });
});

test("fetch prefers the newest of stored and live observations", async () => {
  const usage = new Usage();
  const env = { HOME: "/usage/home" };
  const { account } = usage.remember(launch(env));
  usage.recordObservation(account, observation({ observedAtMs: 1700000000002 }));
  usage.attach("session-1", launch(env), async () => ({
    usage: observation({ observedAtMs: 1700000000001 }),
  }));
  const first = await fetchReport(usage, account);
  expect(first).toMatchObject({ status: "available" });
  if (first.status === "available")
    expect(first.details?.find((detail) => detail.id === "observed")?.value).toBe(
      new Date(1700000000002).toISOString(),
    );
  usage.attach("session-2", launch(env), async () => ({
    usage: observation({ observedAtMs: 1700000000003 }),
  }));
  const second = await fetchReport(usage, account);
  if (second.status === "available")
    expect(second.details?.find((detail) => detail.id === "observed")?.value).toBe(
      new Date(1700000000003).toISOString(),
    );
  // The newer live read feeds the store, so it survives detach.
  usage.detach("session-1");
  usage.detach("session-2");
  expect(usage.latest(account)?.observedAtMs).toBe(1700000000003);
});

test("an account never observed reports no quota, not zero usage", async () => {
  const usage = new Usage();
  const env = { HOME: "/usage/empty" };
  const { account } = usage.remember(launch(env));
  usage.attach("session-1", launch(env), async () => ({}));
  expect(await fetchReport(usage, account)).toEqual({
    status: "unavailable",
    problem: { kind: "no_quota", detail: "No usage quota reported" },
  });
});

test("a newer-but-invalid live observation is dropped, never served", async () => {
  const usage = new Usage();
  const env = { HOME: "/usage/home" };
  const { account } = usage.remember(launch(env));
  usage.recordObservation(account, observation({ observedAtMs: 1700000000000 }));
  usage.attach("session-1", launch(env), async () => ({
    usage: {
      ...observation({ observedAtMs: 1700000000001 }),
      window: { usedPercent: -5, resetsAtMs: 1700018000000, windowDurationMins: 300 },
    },
  }));
  const report = await fetchReport(usage, account);
  expect(report).toMatchObject({ status: "available", planLabel: "Pro" });
  if (report.status === "available")
    expect(report.details?.find((detail) => detail.id === "observed")?.value).toBe(
      new Date(1700000000000).toISOString(),
    );
  expect(usage.latest(account)?.observedAtMs).toBe(1700000000000);
});

test("an invalid-only live read reports no quota, not the invalid values", async () => {
  const usage = new Usage();
  const env = { HOME: "/usage/invalid" };
  const { account } = usage.remember(launch(env));
  usage.attach("session-1", launch(env), async () => ({
    usage: { ...observation(), tier: "" },
  }));
  expect(await fetchReport(usage, account)).toEqual({
    status: "unavailable",
    problem: { kind: "no_quota", detail: "No usage quota reported" },
  });
  expect(usage.latest(account)).toBeUndefined();
});
