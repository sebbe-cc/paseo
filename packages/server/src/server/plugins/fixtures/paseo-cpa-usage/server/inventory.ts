import { readFile } from "node:fs/promises";
import { SubscriptionInventorySchema, parseAccount, type SubscriptionAccount } from "../shared/contract.js";

export interface CpaConfig {
	url: string;
	key: string;
}

export interface InventorySnapshot {
	/** Validated accounts. Always fully validated: see `complete`. */
	accounts: SubscriptionAccount[];
	/** Always empty on success; a payload with any invalid entry fails the read. */
	invalid: { index: number; error: string }[];
	/** True only when the HTTP fetch validated end to end. */
	complete: boolean;
	at: number;
}

export class UnconfiguredError extends Error {
	constructor() {
		super("CLIProxyAPI quota endpoint is not configured (PASEO_CPA_QUOTAS_URL + key)");
		this.name = "UnconfiguredError";
	}
}

export class InventoryError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "InventoryError";
	}
}

function readEnv(name: string): string | undefined {
	const raw = process.env[name];
	if (raw === undefined) return undefined;
	const trimmed = raw.trim();
	return trimmed ? trimmed : undefined;
}

/**
 * Server-only configuration. Read at registration time and on every
 * inventory refresh so provisioning (mayor-owned, daemon-side env) takes
 * effect on plugin reload. Never read in client code; never logged.
 */
export async function loadConfig(): Promise<CpaConfig | null> {
	const urlRaw = readEnv("PASEO_CPA_QUOTAS_URL");
	const keyFile = readEnv("PASEO_CPA_MANAGEMENT_KEY_FILE");
	const keyEnv = readEnv("PASEO_CPA_MANAGEMENT_KEY");
	if (!urlRaw) return null;
	let url: URL;
	try {
		url = new URL(urlRaw);
	} catch {
		throw new InventoryError("PASEO_CPA_QUOTAS_URL is not a valid URL");
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") {
		throw new InventoryError("PASEO_CPA_QUOTAS_URL must be http(s)");
	}
	let key: string | undefined;
	if (keyFile) {
		try {
			key = (await readFile(keyFile, "utf8")).trim() || undefined;
		} catch {
			throw new InventoryError("PASEO_CPA_MANAGEMENT_KEY_FILE is unreadable");
		}
	}
	key ??= keyEnv;
	if (!key) return null;
	return { url: url.toString().replace(/\/$/, ""), key };
}

export interface InventoryFetcherOptions {
	now?: () => number;
	/** Total budget per inventory read. Contract ceiling is 10 s. */
	timeoutMs?: number;
	/** How long a successful snapshot stays usable without refetch. */
	cacheTtlMs?: number;
	fetchImpl?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_CACHE_TTL_MS = 60_000;

/**
 * Normalize a Retry-After value to an absolute epoch-millis timestamp.
 * Bare digits are delta-seconds from `nowMs`; HTTP-dates are already
 * absolute. Anything else is not a backoff.
 */
export function parseRetryAfter(value: string | null, nowMs: number): number | null {
	if (!value) return null;
	const trimmed = value.trim();
	if (!trimmed) return null;
	if (/^\d+$/.test(trimmed)) {
		const seconds = Number(trimmed);
		if (Number.isSafeInteger(seconds) && seconds >= 0 && seconds <= 31_536_000) return nowMs + seconds * 1_000;
		return null;
	}
	// HTTP-date only (IMF-fixdate/RFC850 carry a comma); bare words or years
	// like "-5" must not become a backoff.
	if (!trimmed.includes(",")) return null;
	const at = Date.parse(trimmed);
	if (Number.isNaN(at)) return null;
	return at;
}

/** Single-flight cached reader for the v1 inventory endpoint. */
export class InventoryFetcher {
	private readonly now: () => number;
	private readonly timeoutMs: number;
	private readonly cacheTtlMs: number;
	private readonly fetchImpl: typeof fetch;
	private cached: InventorySnapshot | null = null;
	private inflight: Promise<InventorySnapshot> | null = null;
	/** Management-level 429 backoff: absolute epoch-millis + sanitized message. */
	private retryUntil: number | null = null;
	private retryMessage: string | null = null;

	constructor(options: InventoryFetcherOptions = {}) {
		this.now = options.now ?? Date.now;
		this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
		this.fetchImpl = options.fetchImpl ?? fetch;
	}

	cachedSnapshot(): InventorySnapshot | null {
		return this.cached;
	}

	async snapshot(config: CpaConfig): Promise<InventorySnapshot> {
		const fresh = this.cached;
		if (fresh?.complete && this.now() - fresh.at < this.cacheTtlMs) return fresh;
		// A retained 429 backoff holds without touching the endpoint again:
		// polls during a future retry_at must not re-contact management.
		if (this.retryUntil !== null) {
			if (this.now() < this.retryUntil) {
				throw new InventoryError(this.retryMessage ?? "quota endpoint is backing off");
			}
			this.retryUntil = null;
			this.retryMessage = null;
		}
		if (!this.inflight) {
			this.inflight = this.read(config).finally(() => {
				this.inflight = null;
			});
		}
		const result = await this.inflight;
		if (result.complete) this.cached = result;
		return result;
	}

	private async read(config: CpaConfig): Promise<InventorySnapshot> {
		const at = this.now();
		const controller = new AbortController();
		// One deadline for the whole read: headers, body and validation.
		// A server that flushes headers fast but never finishes the body
		// must still fail within budget instead of wedging every follower.
		const timer = setTimeout(() => controller.abort(), this.timeoutMs);
		try {
			let response: Response;
			try {
				response = await this.fetchImpl(config.url, {
					method: "GET",
					headers: {
						Authorization: `Bearer ${config.key}`,
						Accept: "application/json",
					},
					signal: controller.signal,
				});
			} catch (error) {
				throw new InventoryError(
					`quota endpoint unreachable: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
			if (response.status === 401 || response.status === 403) {
				throw new InventoryError(`management auth rejected (HTTP ${response.status})`);
			}
			if (response.status === 429) {
				const retryAt = parseRetryAfter(response.headers.get("retry-after"), this.now());
				const hint = retryAt !== null ? `, retry at ${new Date(retryAt).toISOString()}` : "";
				const message = `quota endpoint rate limited (HTTP 429${hint})`;
				// Retain the backoff past this flight so repeated polls do not
				// re-contact the endpoint before the backoff expires.
				if (retryAt !== null && retryAt > this.now()) {
					this.retryUntil = retryAt;
					this.retryMessage = message;
				}
				throw new InventoryError(message);
			}
			if (!response.ok) {
				throw new InventoryError(`quota endpoint returned HTTP ${response.status}`);
			}
			let body: unknown;
			try {
				body = await response.json();
			} catch (error) {
				throw new InventoryError(
					`quota endpoint body unreachable or invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
			const parsed = SubscriptionInventorySchema.safeParse(body);
			if (!parsed.success) {
				throw new InventoryError(
					`quota endpoint returned invalid v1 payload: ${parsed.error.issues[0]?.message ?? "unknown"}`,
				);
			}
			if (Number.isNaN(Date.parse(parsed.data.generated_at))) {
				throw new InventoryError("quota endpoint returned invalid generated_at");
			}
			const accounts: SubscriptionAccount[] = [];
			for (const [index, raw] of parsed.data.accounts.entries()) {
				const account = parseAccount(raw);
				if (!account.ok) {
					// An unidentifiable or invalid supported entry must never
					// confirm removal: the whole inventory is incomplete, so
					// callers keep previously known cards flagged with error.
					// Only a completely validated inventory may clear cards.
					throw new InventoryError(
						`quota inventory incomplete: entry ${index} invalid (${account.error})`,
					);
				}
				accounts.push(account.account);
			}
			return { accounts, invalid: [], complete: true, at };
		} finally {
			clearTimeout(timer);
		}
	}
}
