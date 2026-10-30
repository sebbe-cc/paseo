import { afterEach, describe, expect, it } from "vitest";
import { i18n } from "@/i18n/i18next";
import {
  MAX_OBSERVED_AGE_MS,
  resolveObservationExpiry,
  resolveUsageReport,
  displayPercent,
  resolveAgentUsageView,
  replaceReport,
  resolveUsageRefresh,
  resolveUsageHostId,
  resolveUsageModalHostId,
  resolveUsageView,
  settleReports,
  upsertReport,
  usageWindowRowLabel,
  type UsageHost,
  type UsageQueryState,
} from "./model";
import type { UsageReportEntry, UsageWindow } from "./types";

function entry(input: {
  windows?: UsageWindow[];
  planLabel?: string;
  icon?: string;
  sourceId?: string;
}): UsageReportEntry {
  return {
    id: `${input.sourceId ?? "fixture"}:account-1`,
    account: {},
    fetchedAt: "2026-01-01T00:00:00.000Z",
    sourceId: input.sourceId ?? "fixture",
    sourceLabel: "Fixture source",
    ...(input.icon ? { icon: input.icon } : {}),
    report: {
      status: "available",
      ...(input.planLabel ? { planLabel: input.planLabel } : {}),
      windows: input.windows ?? [],
    },
  };
}

function ready(data: UsageReportEntry[]): UsageQueryState {
  return { data, error: null, isFetching: false };
}

describe("resolveUsageView", () => {
  it("asks for a host update when the host lacks usage sources", () => {
    expect(
      resolveUsageView({
        hostLabel: "Laptop",
        isConnected: true,
        supportsUsage: false,
        query: ready([entry({})]),
      }),
    ).toEqual({ kind: "unavailable", message: "Update Laptop to see usage" });
  });

  it("asks for a connection before anything else", () => {
    expect(
      resolveUsageView({
        hostLabel: "Laptop",
        isConnected: false,
        supportsUsage: false,
        query: undefined,
      }),
    ).toEqual({ kind: "unavailable", message: "Connect to Laptop to see usage" });
  });

  it("localizes unavailable host messages while retaining the host name", async () => {
    await i18n.changeLanguage("ko");
    expect(
      resolveUsageView({
        hostLabel: "Laptop",
        isConnected: false,
        supportsUsage: false,
        query: undefined,
      }),
    ).toEqual({ kind: "unavailable", message: "Laptop에 연결하여 제공업체 사용량을 확인하세요" });
  });

  it("moves from loading to ready to error", () => {
    const base = { hostLabel: "Laptop", isConnected: true, supportsUsage: true };
    expect(resolveUsageView({ ...base, query: undefined })).toEqual({ kind: "loading" });
    expect(
      resolveUsageView({ ...base, query: { data: [], error: null, isFetching: true } }),
    ).toEqual({ kind: "ready", reports: [], isRefreshing: true });
    expect(
      resolveUsageView({
        ...base,
        query: { data: undefined, error: new Error("boom"), isFetching: false },
      }),
    ).toEqual({ kind: "error", message: "boom" });
  });
});

afterEach(async () => {
  await i18n.changeLanguage("en");
});

const hosts: UsageHost[] = [
  { serverId: "offline", label: "Offline", isConnected: false, supportsUsage: true },
  { serverId: "old", label: "Old", isConnected: true, supportsUsage: false },
  { serverId: "a", label: "Alpha", isConnected: true, supportsUsage: true },
  { serverId: "b", label: "Beta", isConnected: true, supportsUsage: true },
];

describe("resolveUsageHostId", () => {
  const choose = (pickedServerId: string | null, activeServerId: string | null) =>
    resolveUsageHostId({ pickedServerId, activeServerId, hosts });

  it("reads the picked host over the active workspace's host", () => {
    expect(choose("a", "b")).toBe("a");
  });

  it("reads the active workspace's host when nothing usable is picked", () => {
    expect(choose(null, "b")).toBe("b");
    expect(choose("offline", "b")).toBe("b");
    expect(choose("old", "b")).toBe("b");
  });

  it("falls back to the first connected host that reports usage", () => {
    expect(choose(null, null)).toBe("a");
    expect(choose(null, "offline")).toBe("a");
    expect(choose(null, "old")).toBe("a");
  });

  it("has no host when none reports usage", () => {
    expect(
      resolveUsageHostId({
        pickedServerId: "old",
        activeServerId: "old",
        hosts: hosts.slice(0, 2),
      }),
    ).toBeNull();
  });
});

describe("resolveUsageModalHostId", () => {
  it("shows the picked host while it stays connected, even one that cannot report usage", () => {
    expect(resolveUsageModalHostId({ pickedServerId: "old", activeServerId: "b", hosts })).toBe(
      "old",
    );
    expect(resolveUsageModalHostId({ pickedServerId: "offline", activeServerId: "b", hosts })).toBe(
      "b",
    );
  });

  it("otherwise shows the host the sidebar row reads", () => {
    for (const pickedServerId of [null, "a", "offline"]) {
      for (const activeServerId of ["b", null, "old", "offline"]) {
        const choice = { pickedServerId, activeServerId, hosts };
        expect(resolveUsageModalHostId(choice)).toBe(resolveUsageHostId(choice));
      }
    }
  });

  it("shows the first connected host when none reports usage, so the modal says to update it", () => {
    expect(
      resolveUsageModalHostId({
        pickedServerId: null,
        activeServerId: null,
        hosts: hosts.slice(0, 2),
      }),
    ).toBe("old");
    expect(
      resolveUsageModalHostId({ pickedServerId: null, activeServerId: null, hosts: [] }),
    ).toBeNull();
  });
});

describe("usageWindowRowLabel", () => {
  it("names the window, its percent and its reset after what pinning it pins", () => {
    expect(
      usageWindowRowLabel({
        pinLabel: "Pin Claude Session",
        value: "31%",
        trailing: "resets in 2h",
      }),
    ).toBe("Pin Claude Session, 31% · resets in 2h");
    expect(usageWindowRowLabel({ pinLabel: "Pin Codex Weekly", value: "—", trailing: null })).toBe(
      "Pin Codex Weekly, —",
    );
  });
});

describe("displayPercent", () => {
  const window = (input: Partial<UsageWindow>): UsageWindow => ({
    id: "weekly",
    label: "Weekly",
    ...input,
  });

  it("reads the share used or the share left", () => {
    expect(displayPercent(window({ usedPct: 31 }), "used")).toBe(31);
    expect(displayPercent(window({ usedPct: 31 }), "remaining")).toBe(69);
    expect(displayPercent(window({ remainingPct: 40 }), "used")).toBe(60);
    expect(displayPercent(window({ usedPct: 50, remainingPct: 45 }), "remaining")).toBe(45);
  });

  it("has no percent when the window reports none", () => {
    expect(displayPercent(window({}), "remaining")).toBeNull();
  });
});

describe("resolveUsageRefresh", () => {
  it("is pending while a refresh runs, even after an earlier failure", () => {
    expect(resolveUsageRefresh({ isPending: true, error: new Error("boom") })).toBe("pending");
  });

  it("is failed after a refresh errors", () => {
    expect(resolveUsageRefresh({ isPending: false, error: new Error("boom") })).toBe("failed");
  });

  it("is idle before and after a successful refresh", () => {
    expect(resolveUsageRefresh({ isPending: false, error: null })).toBe("idle");
  });
});

describe("replaceReport", () => {
  const alpha = entry({ sourceId: "alpha", planLabel: "Old" });
  const beta = entry({ sourceId: "beta" });

  it("swaps only the refreshed report, in place", () => {
    const refreshed = entry({ sourceId: "alpha", planLabel: "New" });
    expect(replaceReport([alpha, beta], alpha.id, refreshed)).toEqual([refreshed, beta]);
  });

  it("drops a report the daemon no longer knows", () => {
    expect(replaceReport([alpha, beta], alpha.id, null)).toEqual([beta]);
  });
});

describe("upsertReport", () => {
  const alpha = entry({ sourceId: "alpha", planLabel: "Old" });
  const beta = entry({ sourceId: "beta" });

  it("starts a list from the first streamed report", () => {
    expect(upsertReport(undefined, alpha)).toEqual([alpha]);
  });

  it("appends a report the list does not have yet", () => {
    expect(upsertReport([alpha], beta)).toEqual([alpha, beta]);
  });

  it("replaces a report the list already has, in place", () => {
    const streamed = entry({ sourceId: "alpha", planLabel: "New" });
    expect(upsertReport([alpha, beta], streamed)).toEqual([streamed, beta]);
  });

  it("keeps a copy fetched after the streamed one, such as a Refresh that landed first", () => {
    const refreshed = { ...alpha, planLabel: "Refreshed", fetchedAt: "2026-01-01T00:05:00.000Z" };
    expect(upsertReport([refreshed, beta], alpha)).toEqual([refreshed, beta]);
  });
});

describe("settleReports", () => {
  const alpha = entry({ sourceId: "alpha", planLabel: "Old" });
  const beta = entry({ sourceId: "beta" });

  it("takes the finished list, dropping reports the host no longer has", () => {
    const streamed = entry({ sourceId: "alpha", planLabel: "New" });
    expect(settleReports([alpha, beta], [streamed])).toEqual([streamed]);
  });

  it("keeps a report refreshed while the list streamed over its older copy in the list", () => {
    const refreshed = { ...alpha, planLabel: "Refreshed", fetchedAt: "2026-01-01T00:05:00.000Z" };
    expect(settleReports([refreshed, beta], [alpha, beta])).toEqual([refreshed, beta]);
  });

  it("keeps the displayed order when providers finish a refresh in reverse order", () => {
    const refreshed = entry({ sourceId: "alpha", planLabel: "New" });
    const streamed = upsertReport(upsertReport([alpha, beta], beta), refreshed);
    expect(settleReports(streamed, [beta, refreshed])).toEqual([refreshed, beta]);
  });

  it("drops missing reports and appends new ones without moving surviving reports", () => {
    const gamma = entry({ sourceId: "gamma" });
    const delta = entry({ sourceId: "delta" });
    expect(settleReports([alpha, beta, gamma], [delta, gamma, alpha])).toEqual([
      alpha,
      gamma,
      delta,
    ]);
  });

  it("takes the finished list as is when nothing was shown yet", () => {
    expect(settleReports(undefined, [alpha, beta])).toEqual([alpha, beta]);
  });
});

describe("resolveAgentUsageView", () => {
  const report = entry({ sourceId: "claude" });
  const idle: UsageQueryState = { data: undefined, error: null, isFetching: false };

  it("shows nothing on a host that cannot report usage", () => {
    expect(resolveAgentUsageView({ canReport: false, query: idle })).toEqual({ kind: "none" });
  });

  it("loads until the first report streams in", () => {
    expect(
      resolveAgentUsageView({ canReport: true, query: { ...idle, isFetching: true } }),
    ).toEqual({ kind: "loading" });
  });

  it("shows each report as it streams in, before the request finishes", () => {
    expect(
      resolveAgentUsageView({
        canReport: true,
        query: { data: [report], error: null, isFetching: true },
      }),
    ).toEqual({ kind: "ready", reports: [report] });
  });

  it("shows nothing for an agent with no account to report", () => {
    expect(resolveAgentUsageView({ canReport: true, query: { ...idle, data: [] } })).toEqual({
      kind: "none",
    });
  });

  it("says why a failed request has nothing to show", () => {
    expect(
      resolveAgentUsageView({
        canReport: true,
        query: { ...idle, error: new Error("Unknown agent") },
      }),
    ).toEqual({ kind: "error", message: "Unable to load usage: Unknown agent" });
  });

  it("says the request failed instead of showing the reports from before it", () => {
    expect(
      resolveAgentUsageView({
        canReport: true,
        query: { data: [report], error: new Error("Unknown agent"), isFetching: false },
      }),
    ).toEqual({ kind: "error", message: "Unable to load usage: Unknown agent" });
  });
});

it("resolves retained usage and successful time without inventing old-daemon history", () => {
  const success = entry({ windows: [{ id: "weekly", label: "Weekly", usedPct: 42 }] });
  const failure: UsageReportEntry = {
    ...success,
    fetchedAt: "2026-01-01T00:06:00.000Z",
    report: { status: "error", error: "Rate limited" },
    lastSuccessful: {
      fetchedAt: success.fetchedAt,
      report: success.report as Extract<UsageReportEntry["report"], { status: "available" }>,
    },
  };
  expect(resolveUsageReport(failure, i18n.t)).toEqual({
    windows: success.report.status === "available" ? success.report.windows : [],
    balances: [],
    details: [],
    planLabel: null,
    successfulAt: success.fetchedAt,
    retained: true,
    messages: ["Rate limited"],
    // R4: legacy fixtures carry no source-owned observation, so the card
    // schedules no expiry for them.
    observedAt: null,
  });
  expect(resolveUsageReport({ ...failure, lastSuccessful: undefined }, i18n.t)).toEqual({
    windows: [],
    balances: [],
    details: [],
    planLabel: null,
    successfulAt: null,
    retained: false,
    messages: ["Rate limited"],
    observedAt: null,
  });
  expect(resolveUsageReport(success, i18n.t)).toEqual({
    windows: success.report.status === "available" ? success.report.windows : [],
    balances: [],
    details: [],
    planLabel: null,
    successfulAt: success.fetchedAt,
    retained: false,
    messages: [],
    observedAt: null,
  });
});

it("orders failed polls by attempt time even when successful data is older", () => {
  const success = entry({});
  if (success.report.status !== "available") throw new Error("fixture must be available");
  const failure: UsageReportEntry = {
    ...success,
    fetchedAt: "2026-01-01T00:06:00.000Z",
    report: { status: "error", error: "Rate limited" },
    lastSuccessful: { fetchedAt: success.fetchedAt, report: success.report },
  };
  expect(upsertReport([failure], success)).toEqual([failure]);
  expect(settleReports([failure], [success])).toEqual([failure]);
  expect(upsertReport([success], failure)).toEqual([failure]);
});

it("available and retained usage show the same successful completion time", () => {
  const success: UsageReportEntry = { ...entry({}), successfulAt: "2026-01-01T00:00:15.000Z" };
  if (success.report.status !== "available") throw new Error("fixture must be available");
  expect(resolveUsageReport(success, i18n.t).successfulAt).toBe("2026-01-01T00:00:15.000Z");
  const failure: UsageReportEntry = {
    ...success,
    successfulAt: undefined,
    fetchedAt: "2026-01-01T00:06:00.000Z",
    report: { status: "error", error: "Rate limited" },
    lastSuccessful: { fetchedAt: success.successfulAt!, report: success.report },
  };
  expect(resolveUsageReport(failure, i18n.t).successfulAt).toBe(
    resolveUsageReport(success, i18n.t).successfulAt,
  );
  expect(upsertReport([failure], success)).toEqual([failure]);
});

it("prefers source-owned observation time over poll time", () => {
  const observedAt = new Date(Date.now() - 60_000).toISOString();
  const live = entry({ windows: [{ id: "five_hour", label: "5-hour", usedPct: 34 }] });
  if (live.report.status !== "available") throw new Error("fixture must be available");
  const withObserved: UsageReportEntry = {
    ...live,
    fetchedAt: new Date().toISOString(),
    successfulAt: new Date().toISOString(),
    report: { ...live.report, observedAt },
  };
  const resolved = resolveUsageReport(withObserved, i18n.t);
  expect(resolved.successfulAt).toBe(observedAt);
  expect(resolved.windows).toHaveLength(1);
  expect(resolved.messages).toEqual([]);
});

it("hides quota observed past the ceiling even when the poll is fresh", () => {
  const observedAt = new Date(Date.now() - 45 * 60_000).toISOString();
  const live = entry({ windows: [{ id: "five_hour", label: "5-hour", usedPct: 34 }] });
  if (live.report.status !== "available") throw new Error("fixture must be available");
  const aged: UsageReportEntry = {
    ...live,
    fetchedAt: new Date().toISOString(),
    successfulAt: new Date().toISOString(),
    report: { ...live.report, observedAt },
  };
  const resolved = resolveUsageReport(aged, i18n.t);
  expect(resolved.windows).toEqual([]);
  expect(resolved.messages).toHaveLength(1);
});

it("R4: an observation exactly at the ceiling is still fresh; 1ms later it is not", () => {
  // Pins the inclusive boundary the mounted card timer relies on: quota at
  // exactly MAX_OBSERVED_AGE_MS renders, and the +1ms timer invalidation
  // lands provably past it. Both live and retained paths.
  const live = entry({ windows: [{ id: "five_hour", label: "5-hour", usedPct: 34 }] });
  if (live.report.status !== "available") throw new Error("fixture must be available");
  const atExactly = (ms: number): UsageReportEntry => ({
    ...live,
    fetchedAt: new Date().toISOString(),
    successfulAt: new Date().toISOString(),
    report: { ...live.report, observedAt: new Date(Date.now() - ms).toISOString() },
  });
  expect(resolveUsageReport(atExactly(1_800_000), i18n.t).windows).toHaveLength(1);
  const past = resolveUsageReport(atExactly(1_800_001), i18n.t);
  expect(past.windows).toEqual([]);
  expect(past.messages).toHaveLength(1);
  const base = entry({ windows: [{ id: "primary", label: "Primary", usedPct: 61 }] });
  if (base.report.status !== "available") throw new Error("fixture must be available");
  const retainedAt = (ms: number): UsageReportEntry => ({
    ...base,
    fetchedAt: new Date().toISOString(),
    report: { status: "error", error: "proxy down" },
    lastSuccessful: {
      fetchedAt: new Date().toISOString(),
      report: { ...base.report, observedAt: new Date(Date.now() - ms).toISOString() },
    },
  });
  expect(resolveUsageReport(retainedAt(1_800_000), i18n.t).windows).toHaveLength(1);
  expect(resolveUsageReport(retainedAt(1_800_001), i18n.t).windows).toEqual([]);
});

it("serves retained history only while its own observation is fresh", () => {
  const freshObservedAt = new Date(Date.now() - 120_000).toISOString();
  const staleObservedAt = new Date(Date.now() - 45 * 60_000).toISOString();
  const base = entry({ windows: [{ id: "primary", label: "Primary", usedPct: 61 }] });
  if (base.report.status !== "available") throw new Error("fixture must be available");
  const failureWith = (observedAt: string): UsageReportEntry => ({
    ...base,
    fetchedAt: new Date().toISOString(),
    report: { status: "error", error: "proxy down" },
    lastSuccessful: {
      fetchedAt: new Date().toISOString(),
      report: { ...base.report, observedAt },
    },
  });
  const fresh = resolveUsageReport(failureWith(freshObservedAt), i18n.t);
  expect(fresh.windows).toHaveLength(1);
  expect(fresh.successfulAt).toBe(freshObservedAt);
  expect(fresh.retained).toBe(true);
  const stale = resolveUsageReport(failureWith(staleObservedAt), i18n.t);
  expect(stale.windows).toEqual([]);
  expect(stale.retained).toBe(false);
});

it("R2: future observations never authorize quota, live or retained", () => {
  const futureObservedAt = new Date(Date.now() + 60_000).toISOString();
  const live = entry({ windows: [{ id: "five_hour", label: "5-hour", usedPct: 34 }] });
  if (live.report.status !== "available") throw new Error("fixture must be available");
  const futureLive: UsageReportEntry = {
    ...live,
    fetchedAt: new Date().toISOString(),
    report: { ...live.report, observedAt: futureObservedAt },
  };
  const resolved = resolveUsageReport(futureLive, i18n.t);
  expect(resolved.windows).toEqual([]);
  expect(resolved.messages).toHaveLength(1);

  const futureRetained: UsageReportEntry = {
    ...live,
    fetchedAt: new Date().toISOString(),
    report: { status: "error", error: "proxy down" },
    lastSuccessful: {
      fetchedAt: new Date().toISOString(),
      report: { ...live.report, observedAt: futureObservedAt },
    },
  };
  const retained = resolveUsageReport(futureRetained, i18n.t);
  expect(retained.windows).toEqual([]);
  expect(retained.retained).toBe(false);
});

it("R4: resolve exposes the source-owned observation as render input", () => {
  const freshObservedAt = new Date(Date.now() - 60_000).toISOString();
  const live = entry({ windows: [{ id: "five_hour", label: "5-hour", usedPct: 34 }] });
  if (live.report.status !== "available") throw new Error("fixture must be available");

  // Live source-owned observation passes through for the card expiry timer.
  const withObserved: UsageReportEntry = {
    ...live,
    report: { ...live.report, observedAt: freshObservedAt },
  };
  expect(resolveUsageReport(withObserved, i18n.t).observedAt).toBe(freshObservedAt);

  // Legacy entries without an observation expose null: the card schedules
  // no expiry for them.
  expect(resolveUsageReport(live, i18n.t).observedAt).toBeNull();

  // A retained snapshot's observation is exposed so the mounted card can
  // expire it without a new poll.
  const failure: UsageReportEntry = {
    ...live,
    fetchedAt: new Date().toISOString(),
    report: { status: "error", error: "proxy down" },
    lastSuccessful: {
      fetchedAt: new Date().toISOString(),
      report: { ...live.report, observedAt: freshObservedAt },
    },
  };
  const failed = resolveUsageReport(failure, i18n.t);
  expect(failed.retained).toBe(true);
  expect(failed.observedAt).toBe(freshObservedAt);
});

describe("resolveObservationExpiry", () => {
  const now = Date.parse("2026-10-30T12:00:00.000Z");
  const atAge = (ms: number): string => new Date(now - ms).toISOString();

  it("schedules nothing for legacy and future observations", () => {
    expect(resolveObservationExpiry(null, now)).toEqual({ kind: "none" });
    expect(resolveObservationExpiry("not-a-date", now)).toEqual({ kind: "none" });
    expect(resolveObservationExpiry(new Date(now + 60_000).toISOString(), now)).toEqual({
      kind: "none",
    });
  });

  it("times a fresh observation to fire 1ms past the inclusive ceiling", () => {
    expect(resolveObservationExpiry(atAge(60_000), now)).toEqual({
      kind: "timer",
      delayMs: MAX_OBSERVED_AGE_MS - 60_000 + 1,
    });
    // Exactly on the ceiling: the model still renders quota, so the effect
    // must still schedule the +1ms invalidation, never nothing.
    expect(resolveObservationExpiry(atAge(MAX_OBSERVED_AGE_MS), now)).toEqual({
      kind: "timer",
      delayMs: 1,
    });
  });

  it("invalidates immediately when the effect lands past a boundary-fresh render", () => {
    // The render→effect race from ft-d8vx R4: the render commits fresh
    // windows at exactly the ceiling (model age <= MAX is fresh) while the
    // effect runs 1ms later. Returning nothing there leaves the quota stuck;
    // only an immediate one-shot invalidation drops it without a poll.
    expect(resolveObservationExpiry(atAge(MAX_OBSERVED_AGE_MS), now + 1)).toEqual({
      kind: "invalidate",
    });
    expect(resolveObservationExpiry(atAge(MAX_OBSERVED_AGE_MS + 5_000), now)).toEqual({
      kind: "invalidate",
    });
  });
});
