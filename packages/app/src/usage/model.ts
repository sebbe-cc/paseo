import type { TFunction } from "i18next";
import { i18n } from "@/i18n/i18next";
import { usageCopy } from "./copy";
import type { UsageDisplayAs } from "./preferences";
import type { UsageReport, UsageReportEntry, UsageView, UsageWindow } from "./types";

export function usedPercent(window: UsageWindow): number | null {
  if (window.usedPct != null) return window.usedPct;
  if (window.remainingPct != null) return 100 - window.remainingPct;
  return null;
}

/** The percent a window shows under the user's used/remaining preference. */
export function displayPercent(window: UsageWindow, displayAs: UsageDisplayAs): number | null {
  if (displayAs === "used") return usedPercent(window);
  if (window.remainingPct != null) return window.remainingPct;
  const used = usedPercent(window);
  return used == null ? null : 100 - used;
}

/**
 * A window row's accessible label: what pinning it pins, then what the row shows. The row is a
 * checkbox, so its checked state says whether it is pinned: "Pin Claude Session, 31% · resets in
 * 2h", checked.
 */
export function usageWindowRowLabel(input: {
  pinLabel: string;
  value: string;
  trailing: string | null | undefined;
}): string {
  const summary = input.trailing ? `${input.value} · ${input.trailing}` : input.value;
  return `${input.pinLabel}, ${summary}`;
}

/** A user-requested refresh of one report. The previous report stays on screen throughout. */
export type UsageRefresh = "idle" | "pending" | "failed";

export function resolveUsageRefresh(mutation: {
  isPending: boolean;
  error: unknown;
}): UsageRefresh {
  if (mutation.isPending) return "pending";
  if (mutation.error) return "failed";
  return "idle";
}

/**
 * A host's report list with one report swapped for its refreshed copy, in place.
 * `null` means the daemon no longer knows the ID, so the report leaves the list.
 */
export function replaceReport(
  reports: readonly UsageReportEntry[],
  reportId: string,
  refreshed: UsageReportEntry | null,
): UsageReportEntry[] {
  if (!refreshed) return reports.filter((report) => report.id !== reportId);
  return reports.map((report) => (report.id === reportId ? refreshed : report));
}

/**
 * The later-fetched of two copies of one report. A list request's copies were fetched when it
 * started, so a Refresh that lands while it streams is newer than what the request still delivers.
 */
function laterFetched(shown: UsageReportEntry, arriving: UsageReportEntry): UsageReportEntry {
  return Date.parse(shown.fetchedAt) > Date.parse(arriving.fetchedAt) ? shown : arriving;
}

/**
 * A report list with one streamed report in place of its previous copy, or appended if new. A
 * copy fetched after the streamed one stays.
 */
export function upsertReport(
  reports: readonly UsageReportEntry[] | undefined,
  report: UsageReportEntry,
): UsageReportEntry[] {
  if (!reports?.some((entry) => entry.id === report.id)) return [...(reports ?? []), report];
  return reports.map((entry) => (entry.id === report.id ? laterFetched(entry, report) : entry));
}

/**
 * Keep displayed reports in place: the finished list is in fetch-completion order, which can
 * change on every refresh. Drop missing reports, append new ones, and keep newer fetched copies.
 */
export function settleReports(
  shown: readonly UsageReportEntry[] | undefined,
  finished: readonly UsageReportEntry[],
): UsageReportEntry[] {
  const remaining = new Map(finished.map((report) => [report.id, report]));
  const settled: UsageReportEntry[] = [];
  for (const report of shown ?? []) {
    const arriving = remaining.get(report.id);
    if (!arriving) {
      continue;
    }
    settled.push(laterFetched(report, arriving));
    remaining.delete(report.id);
  }
  return [...settled, ...remaining.values()];
}

export interface UsageQueryState {
  data: UsageReportEntry[] | undefined;
  error: unknown;
  isFetching: boolean;
}

export function resolveUsageView(
  input: {
    hostLabel: string;
    isConnected: boolean;
    supportsUsage: boolean;
    query: UsageQueryState | undefined;
  },
  t: TFunction = i18n.t,
): UsageView {
  const { hostLabel, isConnected, supportsUsage, query } = input;
  if (!isConnected)
    return {
      kind: "unavailable",
      message: t("providerUsage.hostUnavailable", { host: hostLabel }),
    };
  if (!supportsUsage) {
    return {
      kind: "unavailable",
      message: t("providerUsage.hostUpgradeRequired", { host: hostLabel }),
    };
  }
  if (query?.data) {
    return { kind: "ready", reports: query.data, isRefreshing: query.isFetching };
  }
  if (query?.error) {
    return {
      kind: "error",
      message: query.error instanceof Error ? query.error.message : String(query.error),
    };
  }
  return { kind: "loading" };
}

/** What a meter popover shows of its agent's usage: nothing while the host cannot say. */
export type AgentUsageView =
  | { kind: "none" }
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; reports: UsageReportEntry[] };

export function resolveAgentUsageView(
  input: {
    canReport: boolean;
    query: UsageQueryState;
  },
  t: TFunction = i18n.t,
): AgentUsageView {
  const { canReport, query } = input;
  if (!canReport) return { kind: "none" };
  // A failed request keeps the reports from before it, or those that streamed in before it failed;
  // shown alone they would pass for the agent's complete, current usage.
  if (query.error) {
    const reason = query.error instanceof Error ? query.error.message : String(query.error);
    return { kind: "error", message: t("providerUsage.agentError", { reason }) };
  }
  if (query.data) {
    return query.data.length === 0 ? { kind: "none" } : { kind: "ready", reports: query.data };
  }
  return { kind: "loading" };
}

export interface UsageHost {
  serverId: string;
  label: string;
  isConnected: boolean;
  supportsUsage: boolean;
}

/** Where usage looks for its host: the user's saved pick, then the workspace they are in. */
export interface UsageHostChoice {
  pickedServerId: string | null;
  activeServerId: string | null;
  hosts: readonly UsageHost[];
}

/**
 * The host the sidebar Usage row reads: the picked host, else the active workspace's host, else the
 * first host. Each only while it is connected and reports usage.
 */
export function resolveUsageHostId(choice: UsageHostChoice): string | null {
  const reporting = choice.hosts.filter((host) => host.isConnected && host.supportsUsage);
  const find = (serverId: string | null) => reporting.find((host) => host.serverId === serverId);
  return (
    (find(choice.pickedServerId) ?? find(choice.activeServerId) ?? reporting[0])?.serverId ?? null
  );
}

/**
 * The host the Usage modal shows: the picked host while it is connected, even one that cannot
 * report usage so the modal says to update it; else the sidebar row's host; else the first
 * connected host.
 */
export function resolveUsageModalHostId(choice: UsageHostChoice): string | null {
  const connected = choice.hosts.filter((host) => host.isConnected);
  const picked = connected.find((host) => host.serverId === choice.pickedServerId);
  return picked?.serverId ?? resolveUsageHostId(choice) ?? connected[0]?.serverId ?? null;
}

/**
 * Age ceiling for source-owned observations (pa-vtgw9). Matches the
 * daemon's MAX_OBSERVED_AGE_MS; quota observed longer ago is never shown
 * as quota, however fresh the poll is.
 */
export const MAX_OBSERVED_AGE_MS = 1_800_000;

/** Source-owned observation time of a report, or null when unclaimed. */
function observedAtOf(report: UsageReport): number | null {
  if (report.status !== "available" || !report.observedAt) return null;
  const at = Date.parse(report.observedAt);
  return Number.isNaN(at) ? null : at;
}

function isFreshObservation(observedAt: number | null, now: number): boolean {
  // R2: a future observation is never fresh. Clamping it to "just now" would
  // keep quota alive past its real observation on skewed clocks.
  return observedAt === null || (observedAt <= now && now - observedAt <= MAX_OBSERVED_AGE_MS);
}

/**
 * Retained history stays servable only while its own observation is fresh.
 * A snapshot whose observation aged past the ceiling is not history — it is
 * expired quota. Dropped, so repeated failures can never reintroduce it,
 * even when an older daemon served it.
 */
function pickSnapshot(
  entry: UsageReportEntry,
  available: boolean,
  now: number,
): UsageReportEntry["lastSuccessful"] {
  // COMPAT(usageLastSuccessful): added in v0.12.0, remove after 2027-04-17 once daemon floor >= v0.12.0.
  // Older daemons cannot provide history; a failed attempt is never a successful update.
  if (available) return null;
  const snapshot = entry.lastSuccessful ?? null;
  if (snapshot && !isFreshObservation(observedAtOf(snapshot.report), now)) return null;
  return snapshot;
}

function pickObservedAgeText(
  liveObservedAt: number | null,
  snapshotObservedAt: number | null,
  entry: UsageReportEntry,
  available: boolean,
  snapshot: UsageReportEntry["lastSuccessful"],
): string | null {
  // Source-owned observation time is the truth for freshness displays;
  // poll/attempt time is only a fallback for sources that omit it.
  if (liveObservedAt !== null) return new Date(liveObservedAt).toISOString();
  if (snapshotObservedAt !== null) return new Date(snapshotObservedAt).toISOString();
  // COMPAT(usageSuccessfulAt): added in v0.12.0, remove after 2027-04-17 once daemon floor >= v0.12.0.
  // Old daemons expose only attempt time for available reports, never for failures.
  if (available) return entry.successfulAt ?? entry.fetchedAt;
  return snapshot?.fetchedAt ?? null;
}

/** Current outcome owns messages; only a successful poll owns values and freshness. */
export function resolveUsageReport(entry: UsageReportEntry, t: TFunction) {
  const available = entry.report.status === "available";
  const now = Date.now();
  const snapshot = pickSnapshot(entry, available, now);
  const liveObservedAt = entry.report.status === "available" ? observedAtOf(entry.report) : null;
  const liveFresh = entry.report.status === "available" && isFreshObservation(liveObservedAt, now);
  let content: UsageReportEntry["report"] | null = null;
  if (entry.report.status === "available") {
    if (liveFresh) content = entry.report;
  } else if (snapshot) {
    content = snapshot.report;
  }
  const messages: string[] = [];
  if (!available) {
    if (entry.loginErrors)
      messages.push(
        ...entry.loginErrors.map(
          (login) => `${login.harness}: ${usageProblemText(login.report, t)}`,
        ),
      );
    // COMPAT(usageLoginErrors): added in v0.11.0, remove after 2027-04-05 once daemon floor >= v0.11.0.
    else messages.push(usageProblemText(entry.report, t));
  }
  if (available && !liveFresh) {
    messages.push("Quota data is stale and no longer shown.");
  }
  return {
    windows: content?.windows ?? [],
    balances: content?.balances ?? [],
    details: content?.details ?? [],
    planLabel: content?.planLabel ?? null,
    successfulAt: pickObservedAgeText(
      liveObservedAt,
      snapshot ? observedAtOf(snapshot.report) : null,
      entry,
      available,
      snapshot,
    ),
    retained: snapshot !== null,
    messages,
    observedAt: resolveObservedAt(liveObservedAt, snapshot),
  };
}

/**
 * R4: the source-owned observation as render input. Non-null only when a
 * source actually sent one (live or retained); legacy poll-time entries
 * stay null so the card never invents an expiry for them.
 */
function resolveObservedAt(
  liveObservedAt: number | null,
  snapshot: UsageReportEntry["lastSuccessful"],
): string | null {
  if (liveObservedAt !== null) return new Date(liveObservedAt).toISOString();
  if (!snapshot) return null;
  const snapshotObservedAt = observedAtOf(snapshot.report);
  if (snapshotObservedAt === null) return null;
  return new Date(snapshotObservedAt).toISOString();
}

function usageProblemText(report: UsageReport, t: TFunction): string {
  if (report.status === "error") return report.error;
  if (report.status === "unavailable") return usageCopy.problem(report.problem, new Date(), t);
  return "";
}
