import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";
import type { UsageSourceRegistration } from "@getpaseo/plugin/server";
import type { ProviderLaunch } from "@getpaseo/plugin/server/provider";
import {
  hashAccountKey,
  unavailable,
  windowFromUsedPct,
  windowFromReportedDuration,
  toneFromUsedPct,
} from "@getpaseo/plugin/server/usage";

import { subscriptionUsageSchema, usageSchema } from "./wire.js";

const inputSchema = z.object({ account: z.string() }).strict();
type Observation = z.infer<typeof usageSchema>;
export type SubscriptionUsage = z.infer<typeof subscriptionUsageSchema>;

/** One verified quota card's scope: MSP 1.4.1 has no stable account ID, and two
 * config homes are not two proven subscriptions, so a host event without an
 * account id must never merge accounts — snapshots stay keyed by the launch
 * env that produced them, the same key `attach` files readers under. */
/** Newest observation by arrival stamp; empty input yields undefined. */
function newestOf(usages: Iterable<SubscriptionUsage> | undefined): SubscriptionUsage | undefined {
  let newest: SubscriptionUsage | undefined;
  for (const usage of usages ?? []) {
    if (!newest || usage.observedAtMs > newest.observedAtMs) newest = usage;
  }
  return newest;
}

export function accountForEnv(env: ProviderLaunch["env"]): string {
  // MSP 1.4.1 has no stable account ID; swapping accounts in one config directory shares a report ID.
  const configHome = env.XDG_CONFIG_HOME ?? path.join(env.HOME ?? homedir(), ".config");
  return hashAccountKey(path.resolve(configHome, "muse"));
}

export class Usage {
  private readonly launches = new Map<string, ProviderLaunch>();
  private readonly sessions = new Map<
    string,
    { account: string; generation: number; read: () => Promise<Observation> }
  >();
  /**
   * Latest validated observations, keyed by account and then by the
   * host/session generation that produced them. A host event without an
   * account id is only ever stored under its own delivering host's
   * generation: after host A closes and host B opens in the same config
   * home, A's snapshot is history for A's context, never B's current quota.
   */
  private readonly snapshots = new Map<string, Map<number, SubscriptionUsage>>();
  private readonly changeListeners = new Set<(account: string) => void>();
  private attachSeq = 0;
  remember(launch: ProviderLaunch): { account: string } {
    const key = accountForEnv(launch.env);
    this.launches.set(key, launch);
    return { account: key };
  }
  attach(
    id: string,
    launch: ProviderLaunch,
    read: () => Promise<Observation>,
  ): { account: string; generation: number } {
    const { account } = this.remember(launch);
    const generation = ++this.attachSeq;
    this.sessions.set(id, { account, generation, read });
    return { account, generation };
  }
  detach(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    // Detach keeps the snapshot: at idle/close the card serves the last
    // observed values with age/stale instead of waking a host.
    this.sessions.delete(id);
    // A live-to-stale transition changes what the card shows, so listeners
    // must invalidate; while another host for the account stays live the
    // card content is unchanged and no push is needed.
    if (![...this.sessions.values()].some((live) => live.account === session.account)) {
      for (const listener of this.changeListeners) listener(session.account);
    }
  }
  /**
   * Store a validated observation under its delivering host's generation.
   * Older or out-of-order arrivals never overwrite newer ones for the same
   * generation, and invalid observations are rejected — never stored, never
   * read as zero quota. Returns true when the snapshot changed.
   */
  observe(account: string, generation: number, raw: unknown): boolean {
    const parsed = subscriptionUsageSchema.safeParse(raw);
    if (!parsed.success) return false;
    const usage = parsed.data;
    let generations = this.snapshots.get(account);
    if (!generations) {
      generations = new Map();
      this.snapshots.set(account, generations);
    }
    const current = generations.get(generation);
    if (current && usage.observedAtMs <= current.observedAtMs) return false;
    generations.set(generation, usage);
    for (const listener of this.changeListeners) listener(account);
    return true;
  }
  /** Newest stored observation for the account across all generations. */
  snapshot(account: string): SubscriptionUsage | undefined {
    return newestOf(this.snapshots.get(account)?.values());
  }
  onChanged(listener: (account: string) => void): () => void {
    this.changeListeners.add(listener);
    return () => {
      this.changeListeners.delete(listener);
    };
  }
  private liveSessions(
    account: string,
  ): Array<{ generation: number; read: () => Promise<Observation> }> {
    return [...this.sessions.values()].filter((session) => session.account === account);
  }
  private liveReaders(account: string): Array<() => Promise<Observation>> {
    return this.liveSessions(account).map((session) => session.read);
  }
  /** Newest stored observation from generations that still have a live host. */
  private newestLiveSnapshot(account: string): SubscriptionUsage | undefined {
    const live = new Set(this.liveSessions(account).map((session) => session.generation));
    const generations = this.snapshots.get(account);
    if (!generations) return undefined;
    return newestOf(
      (function* () {
        for (const [generation, usage] of generations) if (live.has(generation)) yield usage;
      })(),
    );
  }
  /**
   * Reads every live host for the account and serves the newest accepted
   * observation — never a raw older read that resolves after a newer event
   * was already stored. One failing reader cannot fail the whole read: its
   * error is skipped and the remaining observations and live snapshots
   * still serve with their true age.
   */
  private async readLive(
    account: string,
    live: Array<{ generation: number; read: () => Promise<Observation> }>,
  ): Promise<Observation> {
    const settled = await Promise.all(
      live.map(async (session) => {
        try {
          return { generation: session.generation, usage: (await session.read()).usage };
        } catch {
          return { generation: session.generation, usage: undefined };
        }
      }),
    );
    const candidates: SubscriptionUsage[] = [];
    for (const result of settled) {
      if (result.usage) {
        this.observe(account, result.generation, result.usage);
        candidates.push(result.usage);
      }
    }
    const stored = this.newestLiveSnapshot(account);
    if (stored) candidates.push(stored);
    candidates.sort((a, b) => b.observedAtMs - a.observedAtMs);
    return candidates.length > 0 ? { usage: candidates[0] } : {};
  }
  registration(): UsageSourceRegistration {
    return {
      id: "muse",
      label: "Muse Code",
      icon: "icon.svg",
      input: inputSchema,
      subscribeChanged: (listener: () => void) => this.onChanged(() => listener()),
      discover: async (scope) => {
        let accounts: string[];
        if (scope.kind === "global") {
          accounts = [...this.launches.keys()];
        } else {
          if (scope.provider !== "muse") return [];
          const account = accountForEnv(scope.env);
          accounts = this.launches.has(account) ? [account] : [];
        }
        return accounts.map((account) => ({
          key: account,
          label: "Muse Code",
          input: { account },
        }));
      },
      fetch: async (input) => {
        const { account } = inputSchema.parse(input);
        const launch = this.launches.get(account);
        if (!launch) throw new Error("Muse login no longer exists");
        try {
          // Only already-awake hosts, their events and their seeds fill the
          // snapshot. A cold account with no observation is honestly
          // unavailable — usage never starts or wakes a host, not even a
          // transient one, and an empty or invalid observation is never
          // presented as zero quota.
          const live = this.liveSessions(account);
          const usage =
            live.length > 0 ? (await this.readLive(account, live)).usage : this.snapshot(account);
          if (!usage) return unavailable({ kind: "no_quota", detail: "No usage quota reported" });
          return {
            status: "available",
            planLabel: usage.tier,
            windows: [
              windowFromReportedDuration({
                durationSeconds: usage.window.windowDurationMins * 60,
                unknown: { id: "window", label: "Current window", shortLabel: "" },
                summary: true,
                utilizationPct: usage.window.usedPercent,
                resetsAt: new Date(usage.window.resetsAtMs).toISOString(),
                tone: toneFromUsedPct(usage.window.usedPercent),
              }),
              windowFromUsedPct({
                id: "weekly",
                label: "Weekly",
                shortLabel: "wk",
                summary: true,
                utilizationPct: usage.weekly.usedPercent,
                resetsAt: new Date(usage.weekly.resetsAtMs).toISOString(),
                tone: toneFromUsedPct(usage.weekly.usedPercent),
              }),
            ],
            details: [
              {
                id: "observed",
                label: "Observed",
                value: new Date(usage.observedAtMs).toISOString(),
              },
              ...(this.liveReaders(account).length === 0
                ? [
                    {
                      id: "staleness",
                      label: "Stale",
                      value: "No live session; serving the last observed values",
                    },
                  ]
                : []),
            ],
          };
        } catch (error) {
          return {
            status: "error",
            error: error instanceof Error ? error.message : String(error),
          };
        }
      },
    };
  }
}
