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
type SubscriptionUsage = z.infer<typeof subscriptionUsageSchema>;

function accountKey(env: ProviderLaunch["env"]): string {
  // MSP 1.4.1 has no stable account ID; swapping accounts in one config directory shares a report ID.
  const configHome = env.XDG_CONFIG_HOME ?? path.join(env.HOME ?? homedir(), ".config");
  return hashAccountKey(path.resolve(configHome, "muse"));
}

/** Account identity for a session launch, including per-session env overrides. */
export function accountForLaunch(launch: ProviderLaunch): string {
  return accountKey(launch.env);
}

export class Usage {
  private readonly launches = new Map<string, ProviderLaunch>();
  private readonly sessions = new Map<
    string,
    { account: string; read: () => Promise<Observation> }
  >();
  /**
   * Called with the account key whenever a strictly newer observation is
   * stored. The subscriber invalidates the daemon's cached reports so the
   * next query refetches instead of waiting out the cache TTL.
   */
  onDidChange?: (account: string) => void;
  /**
   * Latest validated observation per account. Survives detach: an idle or closed
   * session keeps its last observed values with their age instead of waking a host.
   */
  private readonly observations = new Map<string, SubscriptionUsage>();
  remember(launch: ProviderLaunch): { account: string } {
    const key = accountKey(launch.env);
    this.launches.set(key, launch);
    return { account: key };
  }
  attach(id: string, launch: ProviderLaunch, read: () => Promise<Observation>): void {
    this.sessions.set(id, { ...this.remember(launch), read });
  }
  detach(id: string): void {
    // The live reader goes; the retained observation stays with its observedAt age.
    this.sessions.delete(id);
  }
  /**
   * Stores a `usage/changed` observation or `usage/read` seed for the session's
   * own account. Older or out-of-order observations never replace newer ones,
   * invalid observations are dropped (never a zero quota), and one account's
   * observation never touches another account.
   */
  recordObservation(account: string, usage: SubscriptionUsage): boolean {
    const parsed = subscriptionUsageSchema.safeParse(usage);
    if (!parsed.success) return false;
    const current = this.observations.get(account);
    if (current && parsed.data.observedAtMs <= current.observedAtMs) return false;
    this.observations.set(account, parsed.data);
    this.onDidChange?.(account);
    return true;
  }
  /** Latest stored observation for an account, if any host ever reported one. */
  latest(account: string): SubscriptionUsage | undefined {
    return this.observations.get(account);
  }
  private async read(account: string, launch: ProviderLaunch): Promise<Observation> {
    const readers = [...this.sessions.values()].filter((session) => session.account === account);
    if (readers.length > 0) {
      const observations = await Promise.all(readers.map((session) => session.read()));
      const usages = observations.flatMap((observation) =>
        observation.usage ? [observation.usage] : [],
      );
      // Record only the newest live usage, so one fetch fires onDidChange at
      // most once. The served value is always the validated store readback: a
      // newer-but-invalid live observation is dropped, never shown as quota.
      let newest: (typeof usages)[number] | undefined;
      for (const usage of usages) {
        if (!newest || usage.observedAtMs > newest.observedAtMs) newest = usage;
      }
      if (newest) this.recordObservation(account, newest);
    } else if (!this.observations.has(account)) {
      // No live session and nothing retained: fall through to a transient host.
      // A retained observation serves with its age instead of waking a host.
      const host = new MspConnection({ launch });
      try {
        const observation = await host.request("usage/read", {}, usageSchema);
        if (observation.usage) this.recordObservation(account, observation.usage);
      } finally {
        await host.close();
      }
    }
    const stored = this.observations.get(account);
    return stored ? { usage: stored } : {};
  }
  registration(): UsageSourceRegistration {
    return {
      id: "muse",
      label: "Muse Code",
      icon: "icon.svg",
      input: inputSchema,
      discover: async (scope) => {
        let accounts: string[];
        if (scope.kind === "global") {
          accounts = [...this.launches.keys()];
        } else {
          if (scope.provider !== "muse") return [];
          const account = accountKey(scope.env);
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
