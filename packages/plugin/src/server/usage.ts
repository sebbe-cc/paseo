import { createHash } from "node:crypto";
import { z, type ZodType } from "zod";
import type { JsonValue } from "@getpaseo/protocol/agent-types";

export interface UsageWindow {
  id: string;
  label: string;
  /**
   * A few characters naming the window where space is tight, e.g. "5h" or "wk". An empty string
   * shows the percent alone; leaving it out shows `label`.
   */
  shortLabel?: string;
  /** Shown in the usage summary until the user pins windows of their own. */
  summary?: boolean;
  usedPct?: number | null;
  remainingPct?: number | null;
  resetsAt?: string | null;
  runsOutAt?: string | null;
  shortfallPct?: number | null;
  tone?: "default" | "ok" | "warning" | "danger";
}

export interface UsageBalance {
  id: string;
  label: string;
  used?: number | null;
  remaining?: number | null;
  limit?: number | null;
  unit: "usd" | "credits" | "requests" | "tokens";
  resetsAt?: string | null;
  tone?: UsageWindow["tone"];
}

export interface UsageDetail {
  id: string;
  label: string;
  value: string;
  tone?: UsageWindow["tone"];
}

export type UsageProblem =
  | { kind: "expired"; expiresAt: string; refreshedBy?: string }
  | { kind: "rejected"; status: number; refreshedBy?: string }
  | { kind: "no_quota"; detail: string };

export type UsageReport =
  | {
      status: "available";
      planLabel?: string;
      windows: UsageWindow[];
      balances?: UsageBalance[];
      details?: UsageDetail[];
      /**
       * Verified account identity whose credentials were actually read for
       * this quota response, `vendor:rest` (e.g. `claude:{account}.{org}`).
       * The daemon only serves a taken-over card from a native login whose
       * attested identity equals the expected one; an available report
       * without a matching attestation is discarded, never shown under
       * another account's card. Omit when the credentials carry no verified
       * identity (locator-only logins never attest).
       */
      accountIdentity?: string;
    }
  | { status: "unavailable"; problem: UsageProblem }
  | { status: "error"; error: string };

/**
 * Builds a vendor-scoped verified account identity for `UsageAccount.identity`
 * and available-report `accountIdentity`. The namespace (`claude:`, `codex:`)
 * keeps one vendor's ids from ever matching another's; the daemon compares
 * these strings for exact equality and treats a missing identity as
 * unverified (fail closed). Never build one from a locator hash or any
 * other unverified value.
 */
export function verifiedAccountIdentity(vendor: string, id: string): string {
  return `${vendor}:${id}`;
}

export interface UsageAccount {
  /** Stable across token rotation; [A-Za-z0-9._-]{1,128}. Never a credential or raw email. */
  key: string;
  label?: string;
  /**
   * Verified account identity, `vendor:rest` (see `verifiedAccountIdentity`),
   * proven at discovery time (e.g. Claude OAuth profile account+org, Codex
   * account id or JWT claim). Only accounts carrying an explicitly verified
   * identity may serve a taken-over card as native fallback, and only when
   * the override account carries the exact same string. A locator hash or
   * any unverified value must never appear here: omitting it fails closed
   * and keeps the override's own error (or its last successful snapshot).
   * The card key stays separate and keeps grouping cards; identity decides
   * whether quota may move between accounts.
   */
  identity?: string;
  /** Harness owning this login, e.g. Codex, OpenCode, Pi or OMP. */
  harness?: string;
  /** Store locator, opaque to the daemon. */
  input: JsonValue;
}

export const UsageScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("global") }),
  z.object({
    kind: z.literal("session"),
    provider: z.string(),
    model: z.string().optional(),
    env: z.record(z.string(), z.string()),
  }),
]);
export type UsageScope = z.infer<typeof UsageScopeSchema>;

export interface UsageSourceRegistration {
  id: string;
  label: string;
  icon?: string;
  input: ZodType;
  /**
   * Source ids this registration takes over, e.g. `["codex"]`. The daemon
   * runs this source's `discover`/`fetch` instead of the named built-in
   * sources and shows the results on their native cards (same id prefix,
   * windows and summary). First claimant wins on conflict; a failing
   * override falls back to the built-in source with its errors retained.
   * A source that wins at least one takeover publishes only through the
   * taken-over cards, never under its own id.
   */
  replaces?: string[];
  /**
   * Skip the taken-over sources' discovery/fetch fallback. Set this when
   * this source's account keys can never match the native identities, or
   * when a native fetch would start a host just to fail (e.g. a CPA-backed
   * Muse source avoiding a transient `muse serve`). The daemon then never
   * calls the taken-over sources' `discover`/`fetch` for this takeover,
   * and a failing override reports its own error instead of native values.
   * Without it, fallback still needs a proven match: both sides must carry
   * the same explicitly verified `UsageAccount.identity`, and each native
   * quota read must attest it back. Key equality alone never authorizes
   * fallback.
   */
  skipNativeFallback?: boolean;
  /** Accounts for this scope only. The same key in any scope identifies the same account. */
  discover(scope: UsageScope): Promise<UsageAccount[]>;
  /** Re-reads the login store; never writes it. */
  fetch(input: unknown): Promise<UsageReport>;
}

export function windowFromUsedPct(input: {
  id: string;
  label: string;
  shortLabel?: string;
  summary?: boolean;
  utilizationPct: number | null | undefined;
  resetsAt?: string | null;
  tone?: UsageWindow["tone"];
}): UsageWindow {
  const usedPct = typeof input.utilizationPct === "number" ? input.utilizationPct : null;
  const window: UsageWindow = {
    id: input.id,
    label: input.label,
    usedPct,
    remainingPct: usedPct === null ? null : Math.max(0, 100 - usedPct),
    resetsAt: input.resetsAt ?? null,
  };
  if (input.shortLabel !== undefined) window.shortLabel = input.shortLabel;
  if (input.summary) window.summary = true;
  if (input.tone) window.tone = input.tone;
  return window;
}

/**
 * Numeric provider windows have one identity and vocabulary, independent of response slots.
 * Pass null when the provider omits the duration; reset countdowns are not window lengths.
 * Named API fields (weekly, monthly, etc.) use windowFromUsedPct instead.
 */
export function windowFromReportedDuration(input: {
  durationSeconds: number | null;
  /** Stable quota identity and provider name for a model- or feature-scoped limit. */
  scope?: { id: string; label: string };
  /** Neutral identity and names when the provider does not report a positive duration. */
  unknown: { id: string; label: string; shortLabel: string };
  utilizationPct: number | null | undefined;
  resetsAt?: string | null;
  summary?: boolean;
  tone?: UsageWindow["tone"];
}): UsageWindow {
  const duration = input.durationSeconds;
  const name =
    duration !== null && Number.isFinite(duration) && duration > 0
      ? durationWindowName(duration)
      : input.unknown;
  const scope = input.scope;
  return windowFromUsedPct({
    id: scope ? `${scope.id}:${name.id}` : name.id,
    label: scope ? `${scope.label} · ${name.label}` : name.label,
    shortLabel: scope
      ? `${scope.label}${name.shortLabel ? ` ${name.shortLabel}` : ""}`
      : name.shortLabel,
    utilizationPct: input.utilizationPct,
    resetsAt: input.resetsAt,
    summary: input.summary,
    tone: input.tone,
  });
}

function durationWindowName(seconds: number): { id: string; label: string; shortLabel: string } {
  if (seconds === 604800) return { id: "weekly", label: "Weekly", shortLabel: "wk" };
  const id = seconds === 18000 ? "five_hour" : `${seconds}s`;
  const units = [
    [86400, "day", "d"],
    [3600, "hour", "h"],
    [60, "minute", "m"],
    [1, "second", "s"],
  ] as const;
  const unit = units.find(([size]) => seconds % size === 0) ?? units[units.length - 1]!;
  const amount = seconds / unit[0];
  return { id, label: `${amount}-${unit[1]}`, shortLabel: `${amount}${unit[2]}` };
}

/**
 * The tone scale for anything measured against a known limit, windows and balances alike.
 *
 * Thresholds match `deriveTone` in the app's provider-usage/tone.ts, which is what the
 * client falls back to when a window arrives without a tone. Healthy is "ok" rather than
 * "default" because that is what every provider setting a tone has always sent, and it is
 * what the bars render today below their thresholds.
 */
export function toneFromUsedPct(usedPct: number | null | undefined): UsageWindow["tone"] {
  if (typeof usedPct !== "number") return "default";
  if (usedPct > 90) return "danger";
  if (usedPct >= 70) return "warning";
  return "ok";
}

/**
 * Tone for a balance with no known limit, where a percentage cannot be computed and the
 * only signal is whether anything is left. Prefer `toneFromUsedPct` when a limit exists:
 * this one stays "ok" until the balance is completely spent.
 */
export function balanceToneFromRemaining(
  remaining: number | null | undefined,
): UsageBalance["tone"] {
  if (typeof remaining !== "number") return "default";
  if (remaining <= 0) return "danger";
  return "ok";
}

/** Percentage of a limit consumed, or null when either side is unknown. */
export function usedPctOf(
  used: number | null | undefined,
  limit: number | null | undefined,
): number | null {
  if (typeof used !== "number" || typeof limit !== "number" || limit <= 0) return null;
  return (used / limit) * 100;
}

export function hashAccountKey(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function unavailable(problem: UsageProblem): UsageReport {
  return { status: "unavailable", problem };
}
