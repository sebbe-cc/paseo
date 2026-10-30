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

import { MspConnection } from "./connection.js";
import { subscriptionUsageSchema, usageSchema } from "./wire.js";

const inputSchema = z.object({ account: z.string() }).strict();
type Observation = z.infer<typeof usageSchema>;
export type SubscriptionUsage = z.infer<typeof subscriptionUsageSchema>;

/** One verified quota card's scope: MSP 1.4.1 has no stable account ID, and two
 * config homes are not two proven subscriptions, so a host event without an
 * account id must never merge accounts — snapshots stay keyed by the launch
 * env that produced them, the same key `attach` files readers under. */
export function accountForEnv(env: ProviderLaunch["env"]): string {
  // MSP 1.4.1 has no stable account ID; swapping accounts in one config directory shares a report ID.
  const configHome = env.XDG_CONFIG_HOME ?? path.join(env.HOME ?? homedir(), ".config");
  return hashAccountKey(path.resolve(configHome, "muse"));
}

export class Usage {
  private readonly launches = new Map<string, ProviderLaunch>();
  private readonly sessions = new Map<
    string,
    { account: string; read: () => Promise<Observation> }
  >();
  /** Latest validated observation per account, from events, seeds or live reads. */
  private readonly snapshots = new Map<string, SubscriptionUsage>();
  private readonly changeListeners = new Set<(account: string) => void>();
  remember(launch: ProviderLaunch): { account: string } {
    const key = accountForEnv(launch.env);
    this.launches.set(key, launch);
    return { account: key };
  }
  attach(
    id: string,
    launch: ProviderLaunch,
    read: () => Promise<Observation>,
  ): { account: string } {
    const { account } = this.remember(launch);
    this.sessions.set(id, { account, read });
    return { account };
  }
  detach(id: string): void {
    // Detach keeps the snapshot: at idle/close the card serves the last
    // observed values with age/stale instead of waking a host.
    this.sessions.delete(id);
  }
  /**
   * Store a validated observation for its account. Older or out-of-order
   * arrivals never overwrite newer ones, and invalid observations are
   * rejected — never stored, never read as zero quota. Returns true when the
   * snapshot changed.
   */
  observe(account: string, raw: unknown): boolean {
    const parsed = subscriptionUsageSchema.safeParse(raw);
    if (!parsed.success) return false;
    const usage = parsed.data;
    const current = this.snapshots.get(account);
    if (current && usage.observedAtMs <= current.observedAtMs) return false;
    this.snapshots.set(account, usage);
    for (const listener of this.changeListeners) listener(account);
    return true;
  }
  snapshot(account: string): SubscriptionUsage | undefined {
    return this.snapshots.get(account);
  }
  onChanged(listener: (account: string) => void): () => void {
    this.changeListeners.add(listener);
    return () => {
      this.changeListeners.delete(listener);
    };
  }
  private liveReaders(account: string): Array<() => Promise<Observation>> {
    return [...this.sessions.values()]
      .filter((session) => session.account === account)
      .map((session) => session.read);
  }
  private async read(account: string, launch: ProviderLaunch): Promise<Observation> {
    const readers = this.liveReaders(account).map((read) => read());
    if (readers.length > 0) {
      const observations = await Promise.all(readers);
      const usages = observations.flatMap((observation) =>
        observation.usage ? [observation.usage] : [],
      );
      usages.sort((a, b) => b.observedAtMs - a.observedAtMs);
      if (usages.length > 0) {
        for (const observed of usages) this.observe(account, observed);
        return { usage: usages[0] };
      }
      // Live hosts observed nothing: a stored snapshot still beats absence.
      const snapshot = this.snapshots.get(account);
      if (snapshot) return { usage: snapshot };
      return {};
    }
    const snapshot = this.snapshots.get(account);
    if (snapshot) return { usage: snapshot };
    const host = new MspConnection({ launch });
    try {
      await host.initialize();
      const observation = await host.request("usage/read", {}, usageSchema);
      if (observation.usage) this.observe(account, observation.usage);
      return observation;
    } finally {
      await host.close();
    }
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
          const { usage } = await this.read(account, launch);
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
