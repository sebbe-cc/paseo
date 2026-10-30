import { createHash } from "node:crypto";
import type { AgentUsageSession } from "../../agent/agent-sdk-types.js";
import type { UsageScope } from "@getpaseo/plugin/server/usage";
import { z } from "zod";
import type { Logger } from "pino";
import {
  UsageReportSchema,
  type ProviderUsage,
  type UsageReportEntry,
  type UsageProblem,
  type UsageReport,
} from "@getpaseo/protocol/messages";

export interface UsageSource {
  id: string;
  label: string;
  icon?: string;
  /**
   * Source ids this source takes over. While the takeover is active the
   * named sources' own discovery is replaced by this source's, and the
   * results publish under the taken-over id so cards keep their native
   * place. First claimant (by source id) wins; conflicts are logged.
   */
  replaces?: readonly string[];
  /**
   * Opt out of the built-in discovery/fetch fallback for taken-over
   * sources. With no provable same-account match the registry never shows
   * another account's quota under this source's cards, but a source whose
   * accounts cannot match native identities at all — or whose native fetch
   * would start a host just to fail, such as a CPA-backed Muse source —
   * sets this to skip the taken-over sources' discovery and fetch calls
   * entirely. A failing override then reports its own error (or its last
   * successful snapshot with its age) instead of built-in values.
   */
  skipNativeFallback?: boolean;
  discover(scope: UsageScope): Promise<unknown>;
  fetch(input: unknown): Promise<unknown>;
}

interface Login {
  input: unknown;
  harness: string;
  /** Verified account identity attested at discovery, if any. Never a locator hash. */
  identity?: string;
}

interface KnownReport {
  source: UsageSource;
  /** Taken-over source id when this report publishes under a native card. */
  overriddenId?: string;
  logins: [Login, ...Login[]];
  label?: string;
  /**
   * Built-in logins tried when the override yields nothing usable. `identity`
   * is the verified account identity both sides proved at discovery; a
   * fallback fetch only serves when it attests this exact string.
   */
  fallback?: { source: UsageSource; logins: [Login, ...Login[]]; identity: string };
}

export interface AgentUsageLookup {
  hasAgent(id: string): boolean;
  usageSession(id: string): AgentUsageSession | null;
}

export interface ListUsageReportsOptions {
  forceRefresh?: boolean;
  reportIds?: string[];
  agentId?: string;
  onReport?: (report: UsageReportEntry) => void;
}

interface AgentReports {
  provider: string;
  model?: string;
  sessionKey: string;
  reports: Map<string, KnownReport>;
}

export interface UsageSourceInvalidated {
  sourceId: string;
  reportIds: string[];
}

/**
 * Liveness proof for one in-flight or cached card: the shared structural
 * generation plus the per-source event epoch of every source this card
 * actually depends on (its owner, the taken-over id, and an allowed
 * fallback). A retire of any watched source — or any structural mutation —
 * moves the token, and the card must then publish nothing.
 */
interface LivenessToken {
  generation: number;
  epochs: Array<{ id: string; epoch: number }>;
}

/** Owns account identity, ordered logins for each account, and the five-minute fetch cache. */
export class UsageSourceRegistry {
  private readonly sources = new Map<string, UsageSource>();
  private readonly disabled = new Set<string>();
  private activeOverrides = new Map<string, string>();
  private warnedConflicts = new Set<string>();
  private readonly known = new Map<string, KnownReport>();
  private defaults = new Map<string, KnownReport>();
  private readonly byAgent = new Map<string, AgentReports>();
  private readonly cache = new Map<string, { at: number; entry: UsageReportEntry }>();
  private readonly successful = new Map<string, NonNullable<UsageReportEntry["lastSuccessful"]>>();
  // Pending values are nullable: a fetch retired while in flight resolves
  // null and is dropped by listReports before any callback or return.
  private readonly pending = new Map<
    string,
    Promise<{ entry: UsageReportEntry; token: LivenessToken } | null>
  >();
  /**
   * Bumped on every override/liveness mutation (register, unregister,
   * disable, enable). In-flight fetches capture it and refuse to publish
   * once it moved: a retired request must never start a native host,
   * overwrite an event's newer data, or publish a ghost card.
   */
  private generation = 0;
  /**
   * Per-source event epoch, bumped only by an authoritative
   * `invalidateSource` for that source. A card watches exactly the sources
   * it depends on (owner, taken-over id, allowed fallback), so an event for
   * one source retires only that source's cards — never an unrelated source's
   * pending fetch, and never an opted-out override's fetch via a
   * non-authoritative native event.
   */
  private readonly sourceEpoch = new Map<string, number>();

  private readonly invalidatedListeners = new Set<(event: UsageSourceInvalidated) => void>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs = 300_000,
    private readonly logger: Pick<Logger, "warn"> = { warn: console.warn },
    private readonly agents: AgentUsageLookup = { hasAgent: () => false, usageSession: () => null },
    private readonly deadlineMs = 20_000,
  ) {}

  /** Fires after a source's cached cards were dropped; clients re-read. */
  onInvalidated(listener: (event: UsageSourceInvalidated) => void): () => void {
    this.invalidatedListeners.add(listener);
    return () => {
      this.invalidatedListeners.delete(listener);
    };
  }

  /**
   * Drops a source's cached cards (five-minute freshness cache and retired
   * in-flight fetches) and reports the affected card ids. Called when the
   * source pushes a locally observed change — an event, never a poll — so
   * cards re-read instead of serving the evicted entries.
   *
   * Ownership follows the actual source object, never an id prefix: a card
   * a source took over (or one not yet discovered) keeps its own id shape,
   * and a card served from an allowed fallback also depends on that
   * fallback source's events. Last-good snapshots are deliberately kept — a
   * freshness invalidation must not destroy the same identity's valid
   * history, or the next read error would lose an already proven
   * observation. Listeners fire for every registered source, even with zero
   * known cards, so a first event after an empty discovery still triggers a
   * rediscovery.
   *
   * An event for a taken-over source whose winner opted out of the native
   * fallback (`skipNativeFallback`) is non-authoritative: it retires and
   * evicts nothing, but listeners still fire (possibly with an empty
   * inventory) so clients can rediscover.
   */
  invalidateSource(sourceId: string): string[] {
    const ownedIds = [...this.known]
      .filter(
        ([, report]) => report.source.id === sourceId || report.fallback?.source.id === sourceId,
      )
      .map(([id]) => id);
    const winnerId = this.activeOverrides.get(sourceId);
    const winner = winnerId !== undefined ? this.sources.get(winnerId) : undefined;
    if (winner !== undefined && winner.skipNativeFallback === true) {
      if (this.sources.has(sourceId)) {
        const event = { sourceId, reportIds: [...ownedIds] };
        for (const listener of this.invalidatedListeners) listener(event);
      }
      return ownedIds;
    }
    this.sourceEpoch.set(sourceId, this.epochOf(sourceId) + 1);
    const owned = new Set(ownedIds);
    const ownedKey = (key: string): boolean => {
      for (const id of owned) if (key === id || key.startsWith(`${id}:`)) return true;
      return false;
    };
    for (const key of this.cache.keys()) if (ownedKey(key)) this.cache.delete(key);
    for (const key of this.pending.keys()) if (ownedKey(key)) this.pending.delete(key);
    if (this.sources.has(sourceId)) {
      const event = { sourceId, reportIds: [...ownedIds] };
      for (const listener of this.invalidatedListeners) listener(event);
    }
    return ownedIds;
  }

  private epochOf(id: string): number {
    return this.sourceEpoch.get(id) ?? 0;
  }

  /**
   * Source ids whose events retire this card: its owner, the taken-over id
   * it publishes under, and an allowed fallback source. Anything else —
   * an unrelated source, or a non-authoritative native source under
   * opt-out — never appears here and can never retire this card.
   */
  private watchedSourceIds(known: KnownReport): string[] {
    const ids = [known.source.id];
    if (known.overriddenId !== undefined) ids.push(known.overriddenId);
    const fallback = known.fallback?.source.id;
    if (fallback !== undefined) ids.push(fallback);
    return [...new Set(ids)];
  }

  private captureToken(known: KnownReport): LivenessToken {
    return {
      generation: this.generation,
      epochs: this.watchedSourceIds(known).map((id) => ({ id, epoch: this.epochOf(id) })),
    };
  }

  /**
   * False once an override, disable, unregister, reload, opt-out, or
   * authoritative event retired this card. Time/expiry checks (pa-vtgw9)
   * apply separately alongside this liveness gate.
   */
  private tokenLive(token: LivenessToken, known: KnownReport): boolean {
    if (this.generation !== token.generation) return false;
    if (this.sources.get(known.source.id) !== known.source) return false;
    const watched = this.watchedSourceIds(known);
    if (watched.length !== token.epochs.length) return false;
    return watched.every((id, index) => {
      const snap = token.epochs[index]!;
      return snap.id === id && this.epochOf(id) === snap.epoch;
    });
  }

  register(source: UsageSource): void {
    if (this.sources.has(source.id)) throw new Error(`Duplicate usage source: ${source.id}`);
    const affected = [...(source.replaces ?? [])];
    this.sources.set(source.id, source);
    this.recomputeOverrides();
    // A new takeover must replace already-cached native cards at once.
    for (const store of [this.cache, this.successful, this.pending]) {
      for (const key of store.keys()) {
        if (affected.some((prefix) => key.startsWith(`${prefix}:`))) store.delete(key);
      }
    }
  }

  /** Hides a source without replacing it; an override of the same id re-enables it. */
  disable(id: string): void {
    const affected = this.mentionedTargets(id);
    if (!this.sources.has(id)) this.logger.warn({ sourceId: id }, "Disabling unknown usage source");
    this.disabled.add(id);
    this.recomputeOverrides();
    this.evictSourceKeys(id, affected);
  }

  enable(id: string): void {
    if (!this.disabled.delete(id)) return;
    const affected = this.mentionedTargets(id);
    this.recomputeOverrides();
    this.evictSourceKeys(id, affected);
  }

  /** Active takeovers: taken-over source id -> winning override source id. */
  overrides(): ReadonlyMap<string, string> {
    return this.activeOverrides;
  }

  private recomputeOverrides(): void {
    const claimants = new Map<string, string[]>();
    for (const source of this.sources.values()) {
      if (this.disabled.has(source.id)) continue;
      for (const target of source.replaces ?? []) {
        if (target === source.id) continue;
        const list = claimants.get(target) ?? [];
        list.push(source.id);
        claimants.set(target, list);
      }
    }
    const next = new Map<string, string>();
    this.generation++;
    for (const [target, ids] of claimants) {
      if (!this.sources.has(target)) continue;
      const sorted = [...ids].sort((a, b) => a.localeCompare(b));
      const winner = sorted[0]!;
      next.set(target, winner);
      if (sorted.length > 1) {
        const key = `${target}:${sorted.join(",")}`;
        if (!this.warnedConflicts.has(key)) {
          this.warnedConflicts.add(key);
          this.logger.warn(
            { target, winner, ignored: sorted.filter((id) => id !== winner) },
            "Usage source takeover conflict; first source wins",
          );
        }
      }
    }
    this.activeOverrides = next;
  }

  /** Every taken-over id that mentions `id`, before or after a mutation. */
  private mentionedTargets(id: string): string[] {
    const targets = new Set<string>();
    for (const [target, winner] of this.activeOverrides) {
      if (winner === id || target === id) targets.add(target);
    }
    for (const source of this.sources.values()) {
      for (const target of source.replaces ?? []) {
        if (source.id === id || target === id) targets.add(target);
      }
    }
    return [...targets];
  }

  private evictSourceKeys(id: string, extraPrefixes: string[] = []): void {
    const prefixes = [id, ...extraPrefixes];
    const matches = (key: string, report?: KnownReport) =>
      prefixes.some((prefix) => key.startsWith(`${prefix}:`)) ||
      report?.source.id === id ||
      report?.overriddenId === id ||
      report?.fallback?.source.id === id;
    for (const [key, report] of this.known) if (matches(key, report)) this.known.delete(key);
    for (const key of this.defaults.keys()) {
      const report = this.defaults.get(key);
      if (matches(key, report)) this.defaults.delete(key);
    }
    for (const [agentId, mapping] of this.byAgent) {
      if (
        [...mapping.reports.values()].some(
          (report) => report.source.id === id || report.overriddenId === id,
        )
      )
        this.byAgent.delete(agentId);
    }
    // Fetch freshness expires independently of successful snapshots. Retain only live identities.
    for (const store of [this.cache, this.successful, this.pending]) {
      for (const key of store.keys()) {
        if (prefixes.some((prefix) => key.startsWith(`${prefix}:`))) store.delete(key);
      }
    }
  }

  unregister(id: string): void {
    const affected = this.mentionedTargets(id);
    this.sources.delete(id);
    this.disabled.delete(id);
    this.recomputeOverrides();
    this.evictSourceKeys(id, affected);
  }

  async listReports(options: ListUsageReportsOptions = {}): Promise<UsageReportEntry[]> {
    if (options.agentId !== undefined && options.reportIds !== undefined)
      throw new Error("agentId and reportIds cannot be combined");
    this.pruneAgents();
    let ids: string[];
    let reports = this.known;
    if (options.agentId !== undefined) {
      ids = await this.discoverAgent(options.agentId);
      reports = this.byAgent.get(options.agentId)?.reports ?? new Map();
    } else if (options.reportIds !== undefined) {
      ids = options.reportIds;
    } else {
      this.defaults = await this.discover({ kind: "global" }, this.defaults);
      this.mergeKnown();
      ids = [...this.known.keys()];
    }
    // A fetch retired while in flight resolves null and is dropped here:
    // retired entries reach neither the per-report callback nor the returned
    // list, so a reload, disable, opt-out, or event can never publish a
    // ghost card or an older quota. The same liveness token travels with a
    // warm cache hit and with every finished result, and is rechecked just
    // before the callback and again before the final return: a retire
    // between a fast card's completion and a slow card's completion still
    // filters the fast card out of the returned list (a callback that fired
    // before the retire stays allowed).
    return Promise.all(
      [...new Set(ids)].flatMap((id) => {
        const known = reports.get(id);
        if (!known) return [];
        return [
          this.fetchId(id, known, options.forceRefresh).then((result) => {
            if (result === null) return null;
            if (!this.tokenLive(result.token, known)) return null;
            options.onReport?.(result.entry);
            return { entry: result.entry, token: result.token, known };
          }),
        ];
      }),
    ).then((results) =>
      results
        .filter(
          (
            result,
          ): result is { entry: UsageReportEntry; token: LivenessToken; known: KnownReport } =>
            result !== null && this.tokenLive(result.token, result.known),
        )
        .map((result) => result.entry),
    );
  }

  private pruneAgents(): void {
    for (const id of this.byAgent.keys()) {
      if (!this.agents.hasAgent(id)) this.byAgent.delete(id);
    }
    this.mergeKnown();
  }

  private async discoverAgent(agentId: string): Promise<string[]> {
    if (!this.agents.hasAgent(agentId)) throw new Error(`Unknown agent: ${agentId}`);
    const session = this.agents.usageSession(agentId);
    if (!session) {
      this.byAgent.delete(agentId);
      this.mergeKnown();
      return [];
    }
    const previous = this.byAgent.get(agentId);
    const sameScope =
      previous?.sessionKey === session.sessionKey &&
      previous.provider === session.provider &&
      previous.model === session.model;
    if (sameScope) return [...previous.reports.keys()];
    const reports = await this.discover({
      kind: "session",
      provider: session.provider,
      model: session.model,
      env: session.env,
    });
    // A query that finishes after a resume must not publish the previous launch's mapping.
    if (this.agents.usageSession(agentId)?.sessionKey !== session.sessionKey) return [];
    this.byAgent.set(agentId, {
      sessionKey: session.sessionKey,
      provider: session.provider,
      model: session.model,
      reports,
    });
    this.mergeKnown();
    return [...reports.keys()];
  }

  private mergeKnown(): void {
    this.known.clear();
    for (const reports of [
      this.defaults,
      ...[...this.byAgent.values()].map((agent) => agent.reports),
    ]) {
      for (const [id, report] of reports) {
        if (this.sources.get(report.source.id) !== report.source) continue;
        if (!this.reportStillLive(id, report)) continue;
        const known = this.known.get(id);
        if (!known) {
          this.known.set(id, { ...report, logins: [...report.logins] });
          continue;
        }
        mergeLogins(known, report.logins);
        if (report.fallback) mergeFallback(known, report.fallback);
      }
    }
    // Fetch freshness expires independently of successful snapshots. Retain only live identities.
    const active = this.activeCacheKeys();
    for (const key of this.successful.keys()) if (!active.has(key)) this.successful.delete(key);
    for (const key of this.cache.keys()) if (!active.has(key)) this.cache.delete(key);
  }

  private activeCacheKeys(): Set<string> {
    return new Set(
      [
        this.known,
        this.defaults,
        ...[...this.byAgent.values()].map((agent) => agent.reports),
      ].flatMap((reports) => [...reports].map(([id, report]) => cacheIdentity(id, report))),
    );
  }

  /** False when an override or disable has retired this card since discovery. */
  private reportStillLive(id: string, report: KnownReport): boolean {
    const prefix = id.split(":")[0]!;
    const winner = this.activeOverrides.get(prefix);
    if (winner !== undefined) {
      if (report.overriddenId === prefix) return report.source.id === winner;
      // A failed takeover falls back to plain built-in cards for the same prefix.
      return report.source.id === prefix && this.sources.get(prefix) === report.source;
    }
    if (this.disabled.has(prefix)) return false;
    return report.overriddenId === undefined;
  }

  private parseAccounts(raw: unknown) {
    return z
      .array(
        z.object({
          key: z.string().regex(/^[A-Za-z0-9._-]{1,128}$/),
          label: z.string().optional(),
          // Vendor-scoped verified account identity (`vendor:rest`). Only an
          // explicitly verified identity may appear here; a locator hash or
          // unknown identity omits the field and fails closed at match time.
          identity: z
            .string()
            .regex(/^[a-z0-9-]{1,32}:\S{1,200}$/)
            .optional(),
          harness: z.string().min(1).optional(),
          input: z.json(),
        }),
      )
      .parse(raw);
  }

  private addAccount(
    reports: Map<string, KnownReport>,
    id: string,
    account: {
      key: string;
      label?: string;
      identity?: string;
      harness?: string;
      input: unknown;
    },
    source: UsageSource,
    overriddenId?: string,
    fallback?: KnownReport["fallback"],
  ): void {
    const reportId = `${id}:${account.key}`;
    // COMPAT(usageLoginHarness): added in v0.11.0, remove after 2027-04-05 once plugin floor >= v0.11.0.
    const login: Login = {
      input: account.input,
      harness: account.harness ?? source.label,
      ...(account.identity !== undefined ? { identity: account.identity } : {}),
    };
    const known = reports.get(reportId);
    if (known) {
      mergeLogins(known, [login]);
      if (fallback) {
        // Logins from different scopes must prove the same identity; a
        // conflicting match fails closed instead of mixing quotas.
        const current = known.fallback;
        if (!current) known.fallback = fallback;
        else if (current.source === fallback.source && current.identity === fallback.identity) {
          mergeLogins(current, fallback.logins);
        } else if (current.identity !== fallback.identity) {
          known.fallback = undefined;
        }
      }
    } else {
      reports.set(reportId, {
        source,
        overriddenId,
        logins: [login],
        label: account.label,
        fallback,
      });
    }
  }

  private previousFor(
    reports: Map<string, KnownReport>,
    previous: ReadonlyMap<string, KnownReport>,
    predicate: (report: KnownReport) => boolean,
  ): void {
    for (const [id, report] of previous) {
      if (predicate(report) && this.reportStillLive(id, report)) reports.set(id, report);
    }
  }

  private async discover(
    scope: UsageScope,
    previous: ReadonlyMap<string, KnownReport> = new Map(),
  ): Promise<Map<string, KnownReport>> {
    const winners = new Set(this.activeOverrides.values());
    const overridden = new Set(this.activeOverrides.keys());
    const ordinary = [...this.sources.values()].filter(
      (source) =>
        !winners.has(source.id) && !overridden.has(source.id) && !this.disabled.has(source.id),
    );
    const discovered = await Promise.all(
      ordinary.map(async (source) => {
        const reports = new Map<string, KnownReport>();
        try {
          const accounts = this.parseAccounts(await source.discover(scope));
          for (const account of accounts) this.addAccount(reports, source.id, account, source);
        } catch (error) {
          this.logger.warn({ sourceId: source.id, err: error }, "Usage source discovery failed");
          // A failed store read does not confirm removal. Session discovery has no previous
          // mapping because a resumed agent may use a different launch environment.
          this.previousFor(reports, previous, (report) => report.source === source);
        }
        return reports;
      }),
    );
    const takeovers = await Promise.all(
      [...this.activeOverrides].map(async ([targetId, winnerId]) => {
        const reports = new Map<string, KnownReport>();
        const winner = this.sources.get(winnerId)!;
        const target = this.sources.get(targetId)!;
        // An opted-out winner never touches the taken-over source: no
        // discovery call (which a native source could answer with another
        // account's identity) and no fetch call (which could start a host
        // just to fail, e.g. a transient muse serve).
        const skipNative = winner.skipNativeFallback === true;
        const [winnerAccounts, targetAccounts] = await Promise.all([
          winner
            .discover(scope)
            .then((raw) => ({ ok: true as const, accounts: this.parseAccounts(raw) }))
            .catch((err: unknown) => ({ ok: false as const, err })),
          skipNative
            ? Promise.resolve({ ok: true as const, accounts: [] })
            : target
                .discover(scope)
                .then((raw) => ({ ok: true as const, accounts: this.parseAccounts(raw) }))
                .catch((err: unknown) => ({ ok: false as const, err })),
        ]);
        if (!winnerAccounts.ok) {
          if (skipNative) {
            this.logger.warn(
              { sourceId: winnerId, target: targetId, err: winnerAccounts.err },
              "Usage source takeover failed; native fallback disabled",
            );
            // Keep only this winner's own previous cards (stale). Restoring
            // the taken-over source's cards would reintroduce native cards
            // in a provider the winner owns.
            this.previousFor(reports, previous, (report) => report.overriddenId === targetId);
            return reports;
          }
          this.logger.warn(
            { sourceId: winnerId, target: targetId, err: winnerAccounts.err },
            "Usage source takeover failed; falling back to built-in source",
          );
          if (targetAccounts.ok) {
            for (const account of targetAccounts.accounts)
              this.addAccount(reports, targetId, account, target);
          } else {
            this.previousFor(
              reports,
              previous,
              (report) => report.overriddenId === targetId || report.source === target,
            );
          }
          return reports;
        }
        const targetByKey = new Map<
          string,
          { input: unknown; harness?: string; identity?: string }[]
        >();
        if (targetAccounts.ok) {
          for (const account of targetAccounts.accounts) {
            const list = targetByKey.get(account.key) ?? [];
            list.push(account);
            targetByKey.set(account.key, list);
          }
        }
        for (const account of winnerAccounts.accounts) {
          // Fallback needs a proven same-account match: both sides must
          // carry an explicitly verified identity in a shared vendor
          // namespace, and the strings must be exactly equal. A locator
          // hash, key equality alone, or an unknown identity on either side
          // is not proof and fails closed: the override keeps its own error
          // (or its last successful snapshot with its age). The card key
          // only groups cards; it never authorizes quota movement.
          const candidates = targetByKey.get(account.key) ?? [];
          const matched =
            account.identity !== undefined
              ? candidates.filter((native) => native.identity === account.identity)
              : [];
          const fallback =
            matched.length > 0
              ? {
                  source: target,
                  identity: account.identity!,
                  logins: matched.map((match) => ({
                    // COMPAT(usageLoginHarness): added in v0.11.0, remove after 2027-04-05.
                    input: match.input,
                    harness: match.harness ?? target.label,
                    identity: match.identity,
                  })) as [Login, ...Login[]],
                }
              : undefined;
          this.addAccount(reports, targetId, account, winner, targetId, fallback);
        }
        return reports;
      }),
    );
    const merged = new Map<string, KnownReport>();
    for (const reports of [...discovered, ...takeovers]) {
      for (const [id, report] of reports) merged.set(id, report);
    }
    return merged;
  }

  // COMPAT(providerUsageList): added in v0.1.98, remove after 2027-03-26.
  async listLegacyUsage(): Promise<{ fetchedAt: string; providers: ProviderUsage[] }> {
    const reports = await this.listReports();
    return {
      fetchedAt: reports.length
        ? reports.reduce(
            (oldest, entry) => (entry.fetchedAt < oldest ? entry.fetchedAt : oldest),
            reports[0]!.fetchedAt,
          )
        : new Date(this.now()).toISOString(),
      providers: reports.map((entry) => ({
        providerId: entry.sourceId,
        displayName: entry.account.label
          ? `${entry.sourceLabel} (${entry.account.label})`
          : entry.sourceLabel,
        status: entry.report.status,
        planLabel: entry.report.status === "available" ? (entry.report.planLabel ?? null) : null,
        windows: entry.report.status === "available" ? entry.report.windows : [],
        balances: entry.report.status === "available" ? (entry.report.balances ?? []) : [],
        details: entry.report.status === "available" ? (entry.report.details ?? []) : [],
        error: legacyError(entry.report, this.now()),
      })),
    };
  }

  private fetchId(
    id: string,
    known: KnownReport,
    forceRefresh = false,
  ): Promise<{ entry: UsageReportEntry; token: LivenessToken } | null> {
    // Account identity groups cards; the ordered login set identifies a fetch result.
    const cacheKey = cacheIdentity(id, known);
    const token = this.captureToken(known);
    const cached = this.cache.get(cacheKey);
    if (!forceRefresh && cached && this.now() - cached.at < this.ttlMs) {
      // A retire (disable, reload, opt-out, event) can land synchronously
      // between this warm hit and the awaiting caller, so the token is
      // rechecked in a later microtask, just before delivery.
      const entry = cached.entry;
      return Promise.resolve().then(() => (this.tokenLive(token, known) ? { entry, token } : null));
    }
    const pending = this.pending.get(cacheKey);
    if (pending) return pending;
    // False once an override, disable, unregister, reload, opt-out, or
    // authoritative event invalidation retired this request. A retired
    // request never starts native fallback and never publishes: after
    // unregister/disable or a new opt-out winner, the old primary's quota
    // must not start a native host or reappear as a ghost card — and after
    // an event, its older quota must not overwrite the event's newer data.
    // The watched-source epochs scope this to the card's actual
    // owner/override/allowed-fallback relation; unrelated sources keep
    // their own fetches.
    const isLive = () => this.tokenLive(token, known);
    const request: Promise<{ entry: UsageReportEntry; token: LivenessToken } | null> =
      (async () => {
        const fetchedAt = new Date(this.now()).toISOString();
        const outcome = await this.fetchWithFallback(known, isLive);
        if (!isLive()) {
          // Retired while in flight: publish nothing anywhere — no callback,
          // no return, no cache, no last-success. A freshness retire converges
          // through the re-read the invalidation's push already triggered; an
          // override retire has no live card left to serve.
          return null;
        }
        const completedAt = new Date(this.now()).toISOString();
        // Taken-over cards keep the native identity: same id prefix, label and
        // icon as the built-in source they replace.
        const native = known.overriddenId ? this.sources.get(known.overriddenId) : undefined;
        const entry: UsageReportEntry = {
          id,
          sourceId: native?.id ?? known.source.id,
          sourceLabel: native?.label ?? known.source.label,
          icon: native?.icon ?? known.source.icon,
          account: { label: known.label },
          fetchedAt,
          ...outcome,
        };
        if (entry.report.status === "available") {
          entry.successfulAt = completedAt;
        } else {
          entry.lastSuccessful = this.successful.get(cacheKey);
        }
        if (isLive() && this.activeCacheKeys().has(cacheKey)) {
          if (entry.report.status === "available") {
            this.successful.set(cacheKey, {
              fetchedAt: completedAt,
              report: entry.report,
            });
          }
          this.writeCache(cacheKey, entry);
        }
        return { entry, token };
      })();
    this.pending.set(cacheKey, request);
    void request.finally(() => {
      if (this.pending.get(cacheKey) === request) this.pending.delete(cacheKey);
    });
    return request;
  }

  private writeCache(id: string, entry: UsageReportEntry): void {
    const at = this.now();
    for (const [cachedId, cached] of this.cache) {
      if (at - cached.at >= this.ttlMs) this.cache.delete(cachedId);
    }
    this.cache.set(id, { at, entry });
  }

  private async fetchBeforeDeadline(source: UsageSource, input: unknown): Promise<UsageReport> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<UsageReport>((resolve) => {
      timer = setTimeout(
        () => resolve({ status: "error", error: "Usage fetch timed out" }),
        this.deadlineMs,
      );
    });
    try {
      return await Promise.race([this.fetchLogin(source, input), deadline]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async fetchLogins(source: UsageSource, logins: readonly Login[]) {
    // Start each login within the same deadline window, then prefer discovery order.
    // Sequential deadlines can exceed the client's RPC timeout before all errors arrive.
    const attempts = logins.map((login) => this.fetchBeforeDeadline(source, login.input));
    const loginErrors: NonNullable<UsageReportEntry["loginErrors"]> = [];
    for (const [index, login] of logins.entries()) {
      const report = await attempts[index]!;
      if (report.status === "available") return { available: report as UsageReport, loginErrors };
      loginErrors.push({ harness: login.harness, report });
    }
    return { available: null as UsageReport | null, loginErrors };
  }

  private async fetchWithFallback(
    known: KnownReport,
    isLive: () => boolean,
  ): Promise<Pick<UsageReportEntry, "report" | "loginErrors">> {
    const primary = await this.fetchLogins(known.source, known.logins);
    if (primary.available) return { report: primary.available };
    const failed = (): Pick<UsageReportEntry, "report" | "loginErrors"> => ({
      // COMPAT(usageLoginErrors): added in v0.11.0, remove after 2027-04-05 once app floor >= v0.11.0.
      // Keep the final single report so older apps still parse and display failed accounts.
      report: primary.loginErrors[primary.loginErrors.length - 1]!.report,
      loginErrors: primary.loginErrors,
    });
    if (!known.fallback) return failed();
    // A retired request never touches native sources: after unregister,
    // disable, or a new opt-out winner, the old primary's failure must not
    // start a native host (e.g. a transient muse serve) just to fail.
    if (!isLive()) return failed();
    const fallback = await this.fetchFallbackLogins(
      known.fallback.source,
      known.fallback.logins,
      known.fallback.identity,
    );
    const loginErrors = [...primary.loginErrors, ...fallback.loginErrors];
    if (fallback.available) return { report: fallback.available, loginErrors };
    // The card keeps the override's own error; native failures (including a
    // discarded identity mismatch) stay visible in `loginErrors` only, so a
    // rotation can never replace A's error with another account's values.
    // COMPAT(usageLoginErrors): added in v0.11.0, remove after 2027-04-05 once app floor >= v0.11.0.
    return { report: primary.loginErrors[primary.loginErrors.length - 1]!.report, loginErrors };
  }

  /**
   * Native fallback bound to the verified identity both sides proved at
   * discovery AND to the credentials actually read for the quota request.
   * A new discovery alone does not close the rotation race (the login file
   * may change between discovery and fetch, and targeted refreshes skip
   * discovery entirely), so each available native result must attest the
   * expected identity. Anything else — a mismatch, or an available result
   * with no attestation — is discarded with a provenance error and the
   * override keeps its own error (or its last successful snapshot).
   */
  private async fetchFallbackLogins(
    source: UsageSource,
    logins: readonly Login[],
    expectedIdentity: string,
  ): Promise<{
    available: UsageReport | null;
    loginErrors: NonNullable<UsageReportEntry["loginErrors"]>;
  }> {
    const attempts = logins.map((login) => this.fetchBeforeDeadline(source, login.input));
    const loginErrors: NonNullable<UsageReportEntry["loginErrors"]> = [];
    for (const [index, login] of logins.entries()) {
      const report = await attempts[index]!;
      if (report.status !== "available") {
        loginErrors.push({ harness: login.harness, report });
        continue;
      }
      if (report.accountIdentity === expectedIdentity) {
        return { available: report, loginErrors };
      }
      loginErrors.push({
        harness: login.harness,
        report: {
          status: "error",
          error:
            `Native login identity ${report.accountIdentity ?? "unknown"} does not match ` +
            `the override account's verified identity; its quota is not served under this card.`,
        },
      });
    }
    return { available: null, loginErrors };
  }

  private async fetchLogin(source: UsageSource, input: unknown): Promise<UsageReport> {
    try {
      return UsageReportSchema.parse(await source.fetch(input));
    } catch (error) {
      this.logger.warn({ sourceId: source.id, err: error }, "Usage fetch failed");
      return { status: "error", error: error instanceof Error ? error.message : String(error) };
    }
  }
}

// The legacy RPC has only an error string; the current app owns its own presentation.
// COMPAT(providerUsageList): added in v0.1.98, remove after 2027-03-26.
function legacyProblem(problem: UsageProblem, now: number): string {
  if (problem.kind === "no_quota") return problem.detail;
  const remedy = problem.refreshedBy
    ? `Run ${problem.refreshedBy} to refresh it.`
    : "Sign in again.";
  if (problem.kind === "rejected") return `Login rejected (HTTP ${problem.status}). ${remedy}`;
  const elapsed = Math.max(0, now - Date.parse(problem.expiresAt));
  let ago = "just now";
  if (elapsed >= 86_400_000) ago = `${Math.floor(elapsed / 86_400_000)}d ago`;
  else if (elapsed >= 3_600_000) ago = `${Math.floor(elapsed / 3_600_000)}h ago`;
  else if (elapsed >= 60_000) ago = `${Math.floor(elapsed / 60_000)}m ago`;
  return `Login expired ${ago}. ${remedy}`;
}

// COMPAT(providerUsageList): added in v0.1.98, remove after 2027-03-26.
function legacyError(report: UsageReport, now: number): string | null {
  if (report.status === "error") return report.error;
  if (report.status === "unavailable") return legacyProblem(report.problem, now);
  return null;
}

/**
 * Merges a fallback discovered in another scope into a known card. Logins
 * from different scopes must prove the same verified identity; a
 * conflicting match fails closed instead of mixing quotas.
 */
function mergeFallback(into: KnownReport, from: NonNullable<KnownReport["fallback"]>): void {
  const current = into.fallback;
  if (!current) {
    into.fallback = from;
    return;
  }
  if (current.source !== from.source) {
    into.fallback = from;
    return;
  }
  if (current.identity !== from.identity) into.fallback = undefined;
  else mergeLogins(current, from.logins);
}

// Inputs are opaque JSON locators. Canonical equality deduplicates discovery across scopes.
function mergeLogins(into: { logins: Login[] }, from: readonly Login[]): void {
  for (const login of from) {
    if (!into.logins.some((existing) => loginKey(existing) === loginKey(login)))
      into.logins.push(login);
  }
}
function loginKey(login: Login): string {
  return JSON.stringify(login, (_key, value) =>
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
      : value,
  );
}

function cacheIdentity(id: string, known: KnownReport): string {
  return `${id}:${createHash("sha256")
    .update(
      JSON.stringify([
        known.label,
        known.logins.map(loginKey),
        known.fallback?.logins.map(loginKey) ?? null,
      ]),
    )
    .digest("hex")}`;
}
