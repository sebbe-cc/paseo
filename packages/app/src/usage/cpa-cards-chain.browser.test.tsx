import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { i18n } from "@/i18n/i18next";
import { UsageCard } from "./card";
import type { UsageDisplay } from "./display";
import type { UsageReportEntry } from "./types";
import chainEntries from "./fixtures/chain-entries.fixture.json";
import chainManifest from "./fixtures/chain-manifest.json";

/**
 * H2: the native UsageCard renders entries from the same real
 * fake-plugin/RPC chain the server e2e proves (CPA_CHAIN_DUMP): two
 * accounts per provider with scoped/duration labels, vendor overdraw,
 * a visible error with fresh history, and an expired grant with fresh
 * history — then the same mounted entries age past the ceiling with no
 * new observation. The checked-in fixture is a byte copy of one such
 * dump (see chain-manifest.json); the remote QA workflow regenerates it
 * from a live chain run before this test, so CI always renders the
 * same-run payload.
 */

const entries = chainEntries as unknown as UsageReportEntry[];

const display: UsageDisplay = {
  displayAs: "used",
  setDisplayAs: () => {},
  isPinned: () => false,
  togglePin: () => {},
};

function observedAts(): number[] {
  const ats: number[] = [];
  for (const entry of entries) {
    const candidates = [
      entry.report.status === "available" ? entry.report.observedAt : undefined,
      entry.lastSuccessful?.report.status === "available"
        ? entry.lastSuccessful.report.observedAt
        : undefined,
    ];
    for (const candidate of candidates) {
      if (candidate) ats.push(Date.parse(candidate));
    }
  }
  return ats;
}

let root: Root;
let container: HTMLDivElement;
let queryClient: QueryClient;

function renderAll(): void {
  act(() =>
    root.render(
      <QueryClientProvider client={queryClient}>
        {entries.map((entry) => (
          <UsageCard
            key={entry.id}
            serverId="test"
            entry={entry}
            display={display}
            pinnable={false}
            refreshable={false}
            compact
          />
        ))}
      </QueryClientProvider>,
    ),
  );
}

function cardEl(id: string): Element | null {
  return container.querySelector(`[data-testid="${CSS.escape(`usage-report-${id}`)}"]`);
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

it("renders the real chain entries and expires them without a new observation", async () => {
  // Provenance for the raw log: which artifact this payload came from.
  console.log(
    `[cpa-qa] chain fixture: plugin_fleet_commit=${(chainManifest as { plugin_fleet_commit: string }).plugin_fleet_commit} core_commit=${(chainManifest as { core_commit: string }).core_commit} entries=${entries.length}`,
  );
  // Two accounts per provider from the same chain run.
  const byProvider = new Map<string, number>();
  for (const entry of entries)
    byProvider.set(entry.sourceId, (byProvider.get(entry.sourceId) ?? 0) + 1);
  expect(byProvider.get("claude")).toBe(2);
  expect(byProvider.get("codex")).toBe(3);
  // Vendor overdraw survives into the payload the card renders.
  const overdrawn = entries.flatMap((entry) =>
    entry.report.status === "available" ? entry.report.windows : [],
  );
  expect(overdrawn.map((window) => window.usedPct)).toContain(150.75);

  const t0 = Math.max(...observedAts());
  vi.useFakeTimers();
  vi.setSystemTime(t0 + 25 * 60_000);
  renderAll();

  // Every chain card mounts: available quota, error + fresh history, and
  // the expired grant with its retained history.
  for (const entry of entries) expect(cardEl(entry.id)).not.toBeNull();
  expect(container.textContent).toContain("5-hour");
  expect(container.textContent).toContain("7-day · opus");
  expect(container.textContent).toContain("7-day");
  expect(container.textContent).toContain("quota rate limited");
  await page.screenshot({ path: ".vitest-screenshots/cpa-chain/t25.png" });

  // The same mounted entries age past the ceiling with no new entry and
  // no fetch: quota disappears, errors stay visible.
  act(() => {
    vi.advanceTimersByTime(6 * 60_000 + 5_000);
  });
  expect(container.textContent).not.toContain("5-hour");
  expect(container.textContent).not.toContain("7-day · opus");
  expect(container.textContent).not.toContain("7-day");
  expect(container.textContent).toContain("quota rate limited");
  await page.screenshot({ path: ".vitest-screenshots/cpa-chain/t31.png" });
});
