import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { i18n } from "@/i18n/i18next";
import { UsageCard } from "./card";
import type { UsageDisplay } from "./display";
import type { UsageReportEntry } from "./types";

/**
 * R4: a mounted UsageCard expires its quota when the source-owned
 * observation ages past the ceiling, without any new poll or server event.
 * The same entry object stays mounted the whole time; only the card's own
 * expiry timer re-renders it.
 */
const display: UsageDisplay = {
  displayAs: "used",
  setDisplayAs: () => {},
  isPinned: () => false,
  togglePin: () => {},
};

function entryWithObservedAt(observedAt: string): UsageReportEntry {
  return {
    id: "claude:quota-v1-test",
    account: {},
    fetchedAt: new Date(Date.parse(observedAt) + 60_000).toISOString(),
    sourceId: "claude",
    sourceLabel: "Claude",
    report: {
      status: "available",
      windows: [{ id: "five_hour", label: "5-hour", usedPct: 34 }],
      observedAt,
    },
  } as UsageReportEntry;
}

function retainedEntryWithObservedAt(observedAt: string): UsageReportEntry {
  return {
    id: "codex:quota-v1-test",
    account: {},
    fetchedAt: new Date(Date.parse(observedAt) + 60_000).toISOString(),
    sourceId: "codex",
    sourceLabel: "Codex",
    report: { status: "error", error: "quota rate limited" },
    lastSuccessful: {
      fetchedAt: new Date(Date.parse(observedAt) + 60_000).toISOString(),
      report: {
        status: "available",
        windows: [{ id: "primary", label: "Primary", usedPct: 61 }],
        observedAt,
      },
    },
  } as UsageReportEntry;
}

let root: Root;
let container: HTMLDivElement;
let queryClient: QueryClient;

function renderCard(entry: UsageReportEntry): void {
  act(() =>
    root.render(
      <QueryClientProvider client={queryClient}>
        <UsageCard
          serverId="test"
          entry={entry}
          display={display}
          pinnable={false}
          refreshable={false}
          compact
        />
      </QueryClientProvider>,
    ),
  );
}

beforeEach(async () => {
  vi.stubGlobal("React", React);
  await i18n.changeLanguage("en");
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  queryClient = new QueryClient();
});

afterEach(async () => {
  act(() => root.unmount());
  container.remove();
  await queryClient.clear();
  await i18n.changeLanguage("en");
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("expires mounted quota at the observation ceiling without a new poll", () => {
  vi.useFakeTimers();
  const now = Date.parse("2026-10-30T12:00:00.000Z");
  vi.setSystemTime(now);
  // Observed 29 minutes ago: fresh now, expired 60 seconds from now.
  renderCard(entryWithObservedAt(new Date(now - 29 * 60_000).toISOString()));
  expect(container.textContent).toContain("5-hour");
  expect(container.textContent).toContain("34%");
  expect(container.textContent).not.toContain("no longer shown");

  // The same mounted card, no new entry and no fetch: crossing the 30-minute
  // observation ceiling removes the quota and shows the stale message.
  act(() => {
    vi.advanceTimersByTime(61_000);
  });
  expect(container.textContent).not.toContain("5-hour");
  expect(container.textContent).toContain("Quota data is stale and no longer shown.");
});

it("invalidates exactly past the boundary in separate renders, never stuck", () => {
  vi.useFakeTimers();
  const now = Date.parse("2026-10-30T12:00:00.000Z");
  vi.setSystemTime(now);
  // Observed 29 minutes ago: fresh now, boundary 60 seconds out.
  renderCard(entryWithObservedAt(new Date(now - 29 * 60_000).toISOString()));
  expect(container.textContent).toContain("5-hour");
  // Exactly on the boundary in its own render: still fresh under the
  // inclusive ceiling, and the one-shot timer from mount has not fired yet.
  act(() => {
    vi.advanceTimersByTime(60_000);
  });
  expect(container.textContent).toContain("5-hour");
  expect(container.textContent).not.toContain("no longer shown");
  // 1ms past the boundary: the timer fires and the same mounted card drops
  // the quota with no new entry and no fetch.
  act(() => {
    vi.advanceTimersByTime(1);
  });
  expect(container.textContent).not.toContain("5-hour");
  expect(container.textContent).toContain("Quota data is stale and no longer shown.");
  // Advancing further never brings the quota back.
  act(() => {
    vi.advanceTimersByTime(3_600_000);
  });
  expect(container.textContent).not.toContain("5-hour");
  expect(container.textContent).toContain("Quota data is stale and no longer shown.");
});

it("mounting exactly on the boundary still expires 1ms later", () => {
  vi.useFakeTimers();
  const now = Date.parse("2026-10-30T12:00:00.000Z");
  vi.setSystemTime(now);
  // Mount with the observation exactly at the ceiling: the inclusive model
  // still renders quota, but the mount schedules the +1ms invalidation
  // instead of no timer at all.
  renderCard(entryWithObservedAt(new Date(now - 30 * 60_000).toISOString()));
  expect(container.textContent).toContain("5-hour");
  act(() => {
    vi.advanceTimersByTime(1);
  });
  expect(container.textContent).not.toContain("5-hour");
  expect(container.textContent).toContain("Quota data is stale and no longer shown.");
});

it("drops quota when the effect runs just past a boundary-fresh render", async () => {
  // R4 render→effect race (ft-d8vx): the initial commit is synchronous, so
  // the render below commits fresh windows at exactly the ceiling while the
  // passive expiry effect only flushes on the next act boundary — by which
  // the clock has moved 1ms past it. The old effect returned there without
  // a timer or an invalidation and the quota stayed stuck; the fixed effect
  // invalidates once so the same mounted entry drops its quota with no new
  // entry and no fetch.
  vi.useFakeTimers();
  const boundary = Date.parse("2026-10-30T12:00:00.000Z");
  vi.setSystemTime(boundary);
  root.render(
    <QueryClientProvider client={queryClient}>
      <UsageCard
        serverId="test"
        entry={entryWithObservedAt(new Date(boundary - 30 * 60_000).toISOString())}
        display={display}
        pinnable={false}
        refreshable={false}
        compact
      />
    </QueryClientProvider>,
  );
  // Committed exactly on the inclusive ceiling: quota still renders.
  expect(container.textContent).toContain("5-hour");
  vi.setSystemTime(boundary + 1);
  await act(async () => {});
  expect(container.textContent).not.toContain("5-hour");
  expect(container.textContent).toContain("Quota data is stale and no longer shown.");
});

it("drops retained quota when the effect runs just past a boundary-fresh render", async () => {
  // Same race for the retained path: error stays visible, retained quota
  // disappears, no poll involved.
  vi.useFakeTimers();
  const boundary = Date.parse("2026-10-30T12:00:00.000Z");
  vi.setSystemTime(boundary);
  root.render(
    <QueryClientProvider client={queryClient}>
      <UsageCard
        serverId="test"
        entry={retainedEntryWithObservedAt(new Date(boundary - 30 * 60_000).toISOString())}
        display={display}
        pinnable={false}
        refreshable={false}
        compact
      />
    </QueryClientProvider>,
  );
  expect(container.textContent).toContain("Primary");
  vi.setSystemTime(boundary + 1);
  await act(async () => {});
  expect(container.textContent).not.toContain("Primary");
  expect(container.textContent).toContain("quota rate limited");
});

it("expires retained history on the mounted card without a new poll", () => {
  vi.useFakeTimers();
  const now = Date.parse("2026-10-30T12:00:00.000Z");
  vi.setSystemTime(now);
  // Error with a fresh retained snapshot: the card shows the retained
  // quota alongside the visible error.
  renderCard(retainedEntryWithObservedAt(new Date(now - 29 * 60_000).toISOString()));
  expect(container.textContent).toContain("Primary");
  expect(container.textContent).toContain("quota rate limited");
  // Exactly on the boundary in its own render: retained quota still shown.
  act(() => {
    vi.advanceTimersByTime(60_000);
  });
  expect(container.textContent).toContain("Primary");
  // 1ms past the boundary: the retained quota disappears, the error stays,
  // and no poll or server event was involved.
  act(() => {
    vi.advanceTimersByTime(1);
  });
  expect(container.textContent).not.toContain("Primary");
  expect(container.textContent).toContain("quota rate limited");
});

it("schedules no expiry for legacy entries without an observation", () => {
  vi.useFakeTimers();
  const now = Date.parse("2026-10-30T12:00:00.000Z");
  vi.setSystemTime(now);
  renderCard({
    id: "claude:quota-v1-legacy",
    account: {},
    fetchedAt: new Date(now - 60_000).toISOString(),
    sourceId: "claude",
    sourceLabel: "Claude",
    report: {
      status: "available",
      windows: [{ id: "five_hour", label: "5-hour", usedPct: 34 }],
    },
  });
  expect(container.textContent).toContain("5-hour");
  // No expiry timer for observation-less entries: advancing a full day
  // leaves the legacy quota untouched.
  act(() => {
    vi.advanceTimersByTime(24 * 3_600_000);
  });
  expect(container.textContent).toContain("5-hour");
});
