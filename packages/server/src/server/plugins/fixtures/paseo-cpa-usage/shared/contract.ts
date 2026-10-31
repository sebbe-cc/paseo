import { z } from "zod";

/**
 * Client contract for GET /v0/management/subscription-quotas (v1, fixed).
 *
 * Fixed by mayor decision from ft-a962 (see the work item notes): the route
 * does not exist in the installed backend yet, so the plugin builds against
 * this exact shape and tests against a fake endpoint. Any deviation the
 * backend ships must go through the mayor, never through silent tolerance
 * here: unknown account statuses and unusable windows fail that account
 * loudly instead of rendering zeros or "ok".
 *
 * Window ids are opaque stable strings. This plugin never parses them: the
 * backend owns the encoding (see nix/quota-contract.md "Window-id
 * encoding" in cl-ewj, e.g. `weekly_scoped:opus:`,
 * `limit:gpt-5:codex:primary`). Labels come from the separate
 * `window_seconds` / `scope` fields.
 */

export const SUPPORTED_PROVIDERS = ["claude", "codex"] as const;
export type SupportedProvider = (typeof SUPPORTED_PROVIDERS)[number];

/**
 * Exact v1 account statuses. `stale` is usable history with a warning, not
 * an error. There is no `exhausted`/`cooldown`/`error` status: exhaustion
 * and cooldown arrive as windows with real percents (or as `unavailable`
 * with a detail), hard failures use `expired`/`rejected`/`rate_limited` /
 * `unavailable`.
 */
export const AccountStatusSchema = z.enum([
	"ok",
	"stale",
	"expired",
	"rejected",
	"rate_limited",
	"unavailable",
]);
export type AccountStatus = z.infer<typeof AccountStatusSchema>;

/** Scope of a model- or surface-scoped window. Never a free-form string. */
export const QuotaScopeSchema = z.object({
	model: z.string().max(128).nullable(),
	surface: z.string().max(128).nullable(),
});
export type QuotaScope = z.infer<typeof QuotaScopeSchema>;

export const QuotaWindowSchema = z.object({
	/** Opaque stable id; never parsed, length uncapped by contract. */
	id: z.string().min(1),
	/**
	 * Finite non-negative percent (not a fraction). Vendor overdraw above
	 * 100 is preserved, never clamped or dropped.
	 */
	used_percent: z.number().finite().min(0),
	/** Positive duration in seconds; null when the provider reports none. */
	window_seconds: z.number().finite().positive().nullable(),
	resets_at: z.string().nullable(),
	scope: QuotaScopeSchema.nullable(),
});
export type QuotaWindow = z.infer<typeof QuotaWindowSchema>;

/**
 * Opaque stable account key. Exactly `quota-v1-` + lowercase SHA-256 hex of
 * the compact JSON array `["quota-v1","claude",account_uuid,organization_uuid]`
 * (Claude) or `["quota-v1","codex",chatgpt_account_id]` (Codex). Never a
 * file name, token, or email. The namespace prefix keeps CPA keys from ever
 * key-matching a native login key on daemons without the verified-identity
 * fallback chain (see server/sources.ts).
 */
export const ACCOUNT_KEY_PATTERN = /^quota-v1-[0-9a-f]{64}$/;

export const SubscriptionAccountSchema = z.object({
	account_id: z.string().regex(ACCOUNT_KEY_PATTERN),
	provider: z.string().min(1),
	plan: z.string().max(128).nullable(),
	status: AccountStatusSchema,
	detail: z.string().max(512).nullable(),
	/** Last successful validated vendor observation; null on cold failure. */
	observed_at: z.string().nullable(),
	/** Last actual check; null when never attempted. */
	checked_at: z.string().nullable(),
	/** Absolute UTC backoff; null when no backoff applies. */
	retry_at: z.string().nullable(),
	windows: z.array(QuotaWindowSchema),
});
export type SubscriptionAccount = z.infer<typeof SubscriptionAccountSchema>;

export const SubscriptionInventorySchema = z.object({
	schema_version: z.literal(1),
	generated_at: z.string().min(1),
	accounts: z.array(z.unknown()),
});
export type SubscriptionInventory = {
	schema_version: 1;
	generated_at: string;
	accounts: SubscriptionAccount[];
};

/** Opaque locator the registry hands back to fetch. Never a credential. */
export const AccountInputSchema = z.object({
	provider: z.enum(SUPPORTED_PROVIDERS),
	accountId: z.string().regex(ACCOUNT_KEY_PATTERN),
});
export type AccountInput = z.infer<typeof AccountInputSchema>;

/** Parse one account strictly; unknown statuses and bad keys fail the account. */
export function parseAccount(raw: unknown):
	| { ok: true; account: SubscriptionAccount }
	| { ok: false; error: string } {
	const parsed = SubscriptionAccountSchema.safeParse(raw);
	if (!parsed.success) {
		return { ok: false, error: `invalid account payload: ${parsed.error.issues[0]?.message ?? "unknown"}` };
	}
	return { ok: true, account: parsed.data };
}
