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

const inputSchema = z
  .object({ account: z.string(), generation: z.number().int().optional() })
  .strict();
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
    // A new host can change the served context — a silent second host makes
    // the account ambiguous, a first host makes it live — so every attach
    // invalidates; the registry re-reads only already-awake hosts.
    for (const listener of this.changeListeners) listener(account);
    return { account, generation };
  }
  detach(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    // Detach keeps the snapshot: at idle/close the card serves the last
    // observed values with age/stale instead of waking a host.
    this.sessions.delete(id);
    // Detaching the host that served the shown values changes the card —
    // including when another host stays live, since the remaining context
    // may be silent, ambiguous, or a different quota. Every detach of a
    // known session therefore invalidates; unknown ids stay silent.
    for (const listener of this.changeListeners) listener(session.account);
  }
  /**
   * Store a validated observation under its delivering host's generation.
   * Older or out-of-order arrivals never overwrite newer ones for the same
   * generation, observations from generations this process never attached
   * are rejected, and invalid observations are rejected — never stored,
   * never read as zero quota. Returns true when the snapshot changed.
   */
  observe(account: string, generation: number, raw: unknown): boolean {
    if (!Number.isInteger(generation) || generation < 1 || generation > this.attachSeq)
      return false;
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
    // Only a live context's observation changes the shown card: a retired
    // context's late event is kept as that context's history but never
    // invalidates the live cards.
    const live = [...this.sessions.values()].some(
      (session) => session.account === account && session.generation === generation,
    );
    if (live) for (const listener of this.changeListeners) listener(account);
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
  private newestLiveSnapshot(
    account: string,
    only?: ReadonlySet<number>,
  ): SubscriptionUsage | undefined {
    const live = new Set(this.liveSessions(account).map((session) => session.generation));
    const generations = this.snapshots.get(account);
    if (!generations) return undefined;
    return newestOf(
      (function* () {
        for (const [generation, usage] of generations) {
          if (live.has(generation) && (!only || only.has(generation))) yield usage;
        }
      })(),
    );
  }
  /**
   * Reads the given live hosts and serves the newest accepted observation
   * for them — never a raw older read that resolves after a newer event
   * was already stored. Results from generations that detached while
   * reading are dropped, never stored and never served: a retired host's
   * late read must not overwrite or win over live observations. One
   * failing reader cannot fail the whole read: its error is skipped and
   * the remaining observations and live snapshots still serve with their
   * true age.
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
    const stillLive = new Set(
      [...this.sessions.values()]
        .filter((session) => session.account === account)
        .map((session) => session.generation),
    );
    const candidates: SubscriptionUsage[] = [];
    for (const result of settled) {
      if (result.usage && stillLive.has(result.generation)) {
        this.observe(account, result.generation, result.usage);
        candidates.push(result.usage);
      }
    }
    const stored = this.newestLiveSnapshot(
      account,
      new Set(live.map((session) => session.generation)),
    );
    if (stored) candidates.push(stored);
    candidates.sort((a, b) => b.observedAtMs - a.observedAtMs);
    return candidates.length > 0 ? { usage: candidates[0] } : {};
  }

  /**
   * Builds the available card for one accepted observation. `stale`
   * marks history served without a live host for its context; live
   * contexts carry no staleness marker.
   */
  private availableReport(account: string, usage: SubscriptionUsage, stale: boolean) {
    return {
      status: "available" as const,
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
        ...(stale || this.liveReaders(account).length === 0
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
  }

  /**
   * Serves exactly one host context. A live generation reads only its own
   * host and its own stored observation; a detached generation with a
   * stored observation serves that history stale for its own context. A
   * generation that never reported is honestly unavailable — never another
   * context's quota, never zero quota from thin air.
   */
  private async reportForGeneration(
    account: string,
    generation: number,
    live: Array<{ generation: number; read: () => Promise<Observation> }>,
  ) {
    const session = live.find((entry) => entry.generation === generation);
    if (session) {
      const usage = (await this.readLive(account, [session])).usage;
      if (usage) return this.availableReport(account, usage, false);
      return unavailable({ kind: "no_quota", detail: "No usage quota reported" });
    }
    const stored = this.snapshots.get(account)?.get(generation);
    if (!stored) return unavailable({ kind: "no_quota", detail: "No usage quota reported" });
    // A retired context never poses as current while another host is live:
    // only a fully idle account serves detached history stale. A silent
    // replacement host is honestly unavailable, never the closed host's
    // quota and never zero quota from thin air.
    if (live.length > 0)
      return unavailable({ kind: "no_quota", detail: "No usage quota reported" });
    return this.availableReport(account, stored, true);
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
        // The input pins the host context whenever exactly one host is
        // live: same-home replacement and concurrent hosts then get
        // distinct fetch identities, so the registry cache and last-success
        // can never replay one context's quota as another's. With zero or
        // several live hosts the input stays account-wide and fetch fails
        // closed (stale history or ambiguity) instead of merging.
        return accounts.map((account) => {
          const live = this.liveSessions(account);
          const single = live.length === 1 ? live[0]! : undefined;
          return {
            key: account,
            label: "Muse Code",
            input: {
              account,
              ...(single ? { generation: single.generation } : {}),
            },
          };
        });
      },
      fetch: async (input) => {
        const { account, generation } = inputSchema.parse(input);
        const launch = this.launches.get(account);
        if (!launch) throw new Error("Muse login no longer exists");
        try {
          // Only already-awake hosts, their events and their seeds fill the
          // snapshot. A cold account with no observation is honestly
          // unavailable — usage never starts or wakes a host, not even a
          // transient one, and an empty or invalid observation is never
          // presented as zero quota.
          const live = this.liveSessions(account);
          if (generation !== undefined) return this.reportForGeneration(account, generation, live);
          if (live.length === 1)
            return this.reportForGeneration(account, live[0]!.generation, live);
          if (live.length === 0) {
            const usage = this.snapshot(account);
            if (!usage) return unavailable({ kind: "no_quota", detail: "No usage quota reported" });
            return this.availableReport(account, usage, true);
          }
          // Several live hosts share one config home and the event carries
          // no account id, so no session/quota context can be proven: fail
          // closed rather than merging unidentified hosts by timestamp.
          return unavailable({
            kind: "no_quota",
            detail:
              "Multiple live Muse sessions share this config home; quota attribution is ambiguous",
          });
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
