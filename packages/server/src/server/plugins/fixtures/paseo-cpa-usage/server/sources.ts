import type { z } from "zod";
import type {
	UsageAccount,
	UsageReport,
	UsageScope,
	UsageSourceRegistration,
	UsageWindow,
} from "@getpaseo/plugin/server/usage";
import { toneFromUsedPct, windowFromUsedPct } from "@getpaseo/plugin/server/usage";
import {
	AccountInputSchema,
	SUPPORTED_PROVIDERS,
} from "../shared/contract.js";
import type {
	AccountInput,
	SubscriptionAccount,
	SupportedProvider,
} from "../shared/contract.js";
import {
	InventoryError,
	InventoryFetcher,
	UnconfiguredError,
	loadConfig,
	type CpaConfig,
	type InventorySnapshot,
} from "./inventory.js";

/**
 * Extended registration understood by the fork daemon (pa-bp84z merged in
 * 0.14.0; skipNativeFallback lands with pa-91k7j). The vendored 0.13.0 SDK
 * types do not declare these fields yet, so they live here: the daemon
 * spreads unknown registration fields through untouched, which keeps the
 * plugin typecheck-clean today and behavior-correct once the fallback fix
 * ships. Unknown fields are ignored by older daemons.
 *
 * Safety does not depend on the flag alone (see NO_VERIFIED_IDENTITY below):
 * published keys live in the `quota-v1-<64hex>` namespace, which can never
 * key-match a native login on older daemons, and omitting `identity` fails
 * closed on newer daemons with the verified-identity chain.
 */
export interface CpaUsageSourceRegistration extends UsageSourceRegistration {
	replaces?: string[];
	skipNativeFallback?: boolean;
}

/**
 * This plugin never publishes a verified account identity and never attests
 * one on a report. The opaque `quota-v1-…` key is a locator hash, not proof
 * of which vendor credentials were read, and locator hashes must never
 * authorize fallback quota movement (pa-91k7j). Omitting `identity` /
 * `accountIdentity` fails closed on daemons with the verified-identity
 * chain; on older daemons the quota-v1 key namespace already prevents
 * key-match fallback (see makeCpaSource).
 */
export const NO_VERIFIED_IDENTITY = true;

/** Age after which observed quota is shown with a stale warning. */
export const STALE_WARN_MS = 300_000;
/** Age after which observed quota is no longer shown as quota at all. Contract ceiling. */
export const MAX_OBSERVED_AGE_MS = 1_800_000;

const PROVIDER_LABELS: Record<SupportedProvider, string> = {
	claude: "Claude",
	codex: "Codex",
};

function parseTime(value: string | null): number | null {
	if (!value) return null;
	const at = Date.parse(value);
	return Number.isNaN(at) ? null : at;
}

function ageText(ageMs: number): string {
	const minutes = Math.floor(ageMs / 60_000);
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes} min ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours} h ago`;
	return `${Math.floor(hours / 24)} d ago`;
}

/**
 * Human label for a window duration. Fixed vendor cadences keep their
 * native names; anything else is named by its largest whole unit. Never
 * derived from the opaque window id.
 */
export function durationLabel(seconds: number | null): { label: string; shortLabel?: string } {
	if (seconds === null || !Number.isFinite(seconds) || seconds <= 0) {
		return { label: "Usage window" };
	}
	if (seconds === 18_000) return { label: "5-hour", shortLabel: "5h" };
	if (seconds === 604_800) return { label: "7-day", shortLabel: "7d" };
	const units = [
		[86_400, "day", "d"],
		[3_600, "hour", "h"],
		[60, "minute", "m"],
		[1, "second", "s"],
	] as const;
	const unit = units.find(([size]) => seconds % size === 0) ?? units[units.length - 1];
	if (!unit) return { label: "Usage window" };
	const amount = seconds / unit[0];
	return { label: `${amount}-${unit[1]}`, shortLabel: `${amount}${unit[2]}` };
}

/** Scope suffix from the contract scope object, e.g. "opus · web". */
export function scopeSuffix(scope: { model: string | null; surface: string | null } | null): string | null {
	if (!scope) return null;
	const parts = [scope.model, scope.surface]
		.map((part) => part?.trim())
		.filter((part): part is string => !!part);
	return parts.length > 0 ? parts.join(" · ") : null;
}

interface MappedWindow {
	window: UsageWindow;
}

function mapWindow(
	raw: SubscriptionAccount["windows"][number],
): MappedWindow | { error: string } {
	// Contract: any finite non-negative percent is real, including vendor
	// overdraw above 100 (preserved, never clamped or dropped). Only
	// non-finite or negative percents are unusable.
	if (!Number.isFinite(raw.used_percent) || raw.used_percent < 0) {
		return { error: `window ${raw.id} has unusable percent` };
	}
	let resetsAt: string | null = null;
	if (raw.resets_at !== null) {
		const at = Date.parse(raw.resets_at);
		if (Number.isNaN(at)) return { error: `window ${raw.id} has invalid resets_at` };
		resetsAt = new Date(at).toISOString();
	}
	// The backend id stays exact for pinning; the label comes only from
	// the separate duration/scope fields. The id is never parsed.
	const duration = durationLabel(raw.window_seconds);
	const scope = scopeSuffix(raw.scope);
	const label = scope ? `${duration.label} · ${scope}` : duration.label;
	const window = windowFromUsedPct({
		id: raw.id,
		label,
		...(duration.shortLabel === undefined ? {} : { shortLabel: duration.shortLabel }),
		utilizationPct: raw.used_percent,
		resetsAt,
		tone: toneFromUsedPct(raw.used_percent),
	});
	return { window };
}

function httpStatusFromDetail(detail: string | null, fallback: number): number {
	const match = detail?.match(/http-(\d{3})/i);
	if (!match) return fallback;
	const status = Number(match[1]);
	return status >= 400 && status < 600 ? status : fallback;
}

function detailText(detail: string | null, fallback: string): string {
	const text = detail?.trim();
	return text ? text : fallback;
}

/**
 * Source-owned history for error statuses (pa-vtgw9 R1). The backend's last
 * validated quota, attached alongside the visible error — never instead of
 * it — so a cold restart still shows error + recent history. Usable only
 * with mapped windows and a valid, non-future observation inside the
 * ceiling. The vendored SDK has no `history` field yet, so the report is
 * widened structurally; the patched daemon's protocol schema carries it.
 */
export interface ErrorHistory {
	observedAt: string;
	windows: UsageWindow[];
	planLabel?: string;
}

function errorHistory(
	account: SubscriptionAccount,
	mappedWindows: UsageWindow[],
	observedAtMs: number | null,
	now: number,
): ErrorHistory | undefined {
	if (mappedWindows.length === 0) return undefined;
	if (!account.observed_at || observedAtMs === null || observedAtMs > now) return undefined;
	if (now - observedAtMs > MAX_OBSERVED_AGE_MS) return undefined;
	return {
		observedAt: account.observed_at,
		windows: mappedWindows,
		...(account.plan ? { planLabel: account.plan } : {}),
	};
}

/** Map one validated v1 account to a native usage report. Never throws. */
export function mapAccount(account: SubscriptionAccount, now: number): UsageReport {
	// The validated backend observation owns quota age. Poll time is never
	// used as an observation: without a real observed_at there is no quota
	// to show, however fresh the fetch itself is. A future observed_at (R2)
	// is invalid provenance, never clamped to "just now".
	const observedAtMs = parseTime(account.observed_at);
	const checkedAt = parseTime(account.checked_at);
	const retryAt = parseTime(account.retry_at);
	const futureObservation = observedAtMs !== null && observedAtMs > now;
	const validObservation = observedAtMs !== null && !futureObservation;
	const ageMs = validObservation ? now - (observedAtMs as number) : null;
	const lastSuccessText =
		ageMs === null
			? futureObservation
				? `invalid future observation ${account.observed_at}`
				: "no verified observation yet"
			: `last verified observation ${ageText(ageMs)}`;

	const mappedWindows: UsageWindow[] = [];
	const windowErrors: string[] = [];
	for (const raw of account.windows) {
		const mapped = mapWindow(raw);
		if ("window" in mapped) mappedWindows.push(mapped.window);
		else windowErrors.push(mapped.error);
	}
	const firstWindow = mappedWindows[0];
	if (firstWindow) firstWindow.summary = true;
	const history = errorHistory(account, mappedWindows, observedAtMs, now);

	const ageDetail =
		ageMs !== null && ageMs > STALE_WARN_MS
			? [
					{
						id: "freshness",
						label: "Last success",
						value: `${ageText(ageMs)} (stale)`,
						tone: "warning" as const,
					},
				]
			: [];
	const retryDetail =
		retryAt !== null && retryAt > now
			? [
					{
						id: "retry",
						label: "Retry",
						value: new Date(retryAt).toISOString(),
						tone: "warning" as const,
					},
				]
			: [];

	switch (account.status) {
		case "ok":
		case "stale": {
			const markedStale = account.status === "stale";
			if (mappedWindows.length === 0) {
				return {
					status: "error",
					error:
						windowErrors.length > 0
							? `quota has no usable windows (${windowErrors[0]})`
							: "quota has no windows",
				};
			}
			if (ageMs === null) {
				// Cold failure: windows without a verified observation are
				// never rendered as quota.
				return { status: "error", error: `quota has no verified observation (${lastSuccessText})` };
			}
			if (ageMs > MAX_OBSERVED_AGE_MS) {
				return { status: "error", error: `quota data is stale (last success ${ageText(ageMs)})` };
			}
			return {
				status: "available",
				...(account.plan ? { planLabel: account.plan } : {}),
				// Source-owned provenance (pa-vtgw9 core contract): the daemon
				// and app enforce the 1800 s ceiling on this timestamp, never
				// on poll time. Only a validated non-null observed_at reaches
				// here; without one this branch already returned an error.
				...(account.observed_at ? { observedAt: account.observed_at } : {}),
				windows: mappedWindows,
				details: [
					...(markedStale
						? [
								{
									id: "status",
									label: "Status",
									value: detailText(account.detail, "stale"),
									tone: "warning" as const,
								},
							]
						: []),
					...ageDetail,
					...retryDetail,
				],
			};
		}
		case "expired":
			// Verified dead grant: the status stays expired, but freshly
			// validated windows still travel as history (R1), exactly like
			// the other error statuses — never as live quota.
			return {
				status: "unavailable",
				problem: {
					kind: "expired",
					expiresAt: new Date(checkedAt ?? now).toISOString(),
					refreshedBy: "CLIProxyAPI auto-refresh",
				},
				...(history ? { history } : {}),
			} as UsageReport;
		case "rejected":
			return {
				status: "unavailable",
				problem: {
					kind: "rejected",
					status: httpStatusFromDetail(account.detail, 401),
					refreshedBy: "CLIProxyAPI auto-refresh",
				},
				...(history ? { history } : {}),
			} as UsageReport;
		case "rate_limited":
			// Visible error, never quota: the error text carries the true
			// backend observation age so it stays truthful across restarts
			// without depending on plugin-local memory. Fresh backend
			// windows travel alongside as history (R1), never as live quota.
			return {
				status: "error",
				error:
					retryAt !== null && retryAt > now
						? `quota rate limited, retry at ${new Date(retryAt).toISOString()} (${lastSuccessText})`
						: `quota rate limited (${lastSuccessText})`,
				...(history ? { history } : {}),
			} as UsageReport;
		case "unavailable": {
			const base = detailText(account.detail, "quota unavailable");
			return {
				status: "unavailable",
				problem: {
					kind: "no_quota",
					detail: ageMs !== null ? `${base} (last success ${ageText(ageMs)})` : base,
				},
				...(history ? { history } : {}),
			} as UsageReport;
		}
		default: {
			// Unreachable through the strict contract schema; loud if it ever happens.
			const unknown = (account as { status: unknown }).status;
			return { status: "error", error: `unknown quota status ${JSON.stringify(unknown)}` };
		}
	}
}

export interface CpaSourceDeps {
	now?: () => number;
	fetcher?: InventoryFetcher;
}

export function providerInputSchema(): z.ZodType {
	return AccountInputSchema;
}

/**
 * One usage source per provider. Discover filters the shared inventory to
 * this provider's accounts only, so the same account list never publishes
 * under two replaces-targets.
 *
 * Fallback safety on every daemon generation, without a version probe
 * (PluginServerContext exposes no capability channel):
 * - Older daemons match fallback by account key. Every published key is
 *   schema-enforced to `quota-v1-<64hex>`, which a native login key can
 *   never equal, so native quota can never serve a CPA card.
 * - Newer daemons (pa-91k7j chain) match fallback by verified identity.
 *   This plugin publishes no `identity` and attests no `accountIdentity`
 *   (NO_VERIFIED_IDENTITY), so fallback fails closed there too.
 * `skipNativeFallback: true` is still declared so patched daemons skip the
 * native attempt entirely.
 */
export function makeCpaSource(
	provider: SupportedProvider,
	deps: CpaSourceDeps = {},
): CpaUsageSourceRegistration {
	const now = deps.now ?? Date.now;
	const fetcher = deps.fetcher ?? new InventoryFetcher({ now });
	let known: InventorySnapshot | null = null;

	async function inventory(allowStale: boolean): Promise<SubscriptionAccount[]> {
		const config = await loadConfig();
		if (!config) throw new UnconfiguredError();
		try {
			// read() throws on any invalid entry, so a stored snapshot is
			// always completely validated: it may back warm cards but never
			// confirms a removal.
			const snapshot = await fetcher.snapshot(config);
			known = snapshot;
			return snapshot.accounts.filter((account) => account.provider === provider);
		} catch (error) {
			if (error instanceof UnconfiguredError) throw error;
			// A failed inventory never deletes known cards: callers serve the
			// last complete snapshot so cards stay visible, while fetch
			// reports the failure so the registry error-marks the card.
			// Only a complete successful inventory may clear cards.
			if (allowStale && known) return known.accounts.filter((account) => account.provider === provider);
			throw error;
		}
	}

	return {
		id: `cpa-${provider}`,
		label: `CLIProxyAPI ${PROVIDER_LABELS[provider]}`,
		input: AccountInputSchema,
		replaces: [provider],
		skipNativeFallback: true,
		discover: async (scope: UsageScope): Promise<UsageAccount[]> => {
			// Session scope fails closed: there is no verified route or pool
			// membership evidence that would prove a local session belongs to
			// this CPA pool, so a session never gets CPA cards. Claiming pool
			// membership from a provider-name heuristic would invent an
			// account binding. Global scope shows the verified pool.
			if (scope.kind === "session") return [];
			let accounts: SubscriptionAccount[];
			try {
				// inventory(true) already serves the warm snapshot itself; a
				// throw here means cold failure or deprovisioning.
				accounts = await inventory(true);
			} catch (error) {
				if (error instanceof UnconfiguredError) {
					// Dormant before first provisioning; loud afterwards so
					// the daemon keeps previous cards instead of deleting.
					if (known) throw error;
					return [];
				}
				// Cold failure with no snapshot: publish nothing rather than
				// reintroducing native logins the daemon would fall back to.
				return [];
			}
			return accounts.map((account) => ({
				key: account.account_id,
				...(account.plan ? { label: account.plan } : {}),
				harness: provider,
				input: { provider, accountId: account.account_id } satisfies AccountInput,
			}));
		},
		fetch: async (input: unknown): Promise<UsageReport> => {
			const parsed = AccountInputSchema.safeParse(input);
			if (!parsed.success || parsed.data.provider !== provider) {
				return { status: "error", error: "unknown account" };
			}
			let accounts: SubscriptionAccount[];
			try {
				accounts = await inventory(false);
			} catch (error) {
				if (error instanceof InventoryError || error instanceof UnconfiguredError) {
					return { status: "error", error: error.message };
				}
				throw error;
			}
			const account = accounts.find((candidate) => candidate.account_id === parsed.data.accountId);
			if (!account) {
				return { status: "error", error: "account no longer reported" };
			}
			return mapAccount(account, now());
		},
	};
}

export function supportedProviders(): readonly SupportedProvider[] {
	return SUPPORTED_PROVIDERS;
}

export type { CpaConfig };
