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
