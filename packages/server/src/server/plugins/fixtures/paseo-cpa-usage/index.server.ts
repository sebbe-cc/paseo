import type { PluginServerContext } from "@getpaseo/plugin/server";
import { makeCpaSource, supportedProviders } from "./server/sources.js";

/**
 * Native plan usage from CLIProxyAPI subscription quotas (Claude/Codex).
 *
 * One registration per provider takes over that provider's native source id
 * (pa-bp84z override API, daemon >= 0.14.0). Muse is deliberately not
 * registered: pa-l1bv4 owns the Muse path via usage/changed. No client
 * contribution: results render in Paseo's native usage cards.
 *
 * Registration happens synchronously inside contribute: the daemon
 * snapshots its source table before the first await and sends that list as
 * `ready`, so anything registered from a later Promise never reaches the
 * registry. Configuration (server-side key file, daemon env) is still read
 * lazily at each discover/fetch, so provisioning takes effect on reload.
 *
 * Server-only secrets: PASEO_CPA_QUOTAS_URL plus PASEO_CPA_MANAGEMENT_KEY_FILE
 * (or PASEO_CPA_MANAGEMENT_KEY), provisioned daemon-side by the mayor. When
 * the URL is absent the plugin registers nothing, so native sources keep
 * working untouched. Management credentials never appear in settings, argv
 * or logs.
 */

function hasQuotaUrl(): boolean {
	const raw = process.env.PASEO_CPA_QUOTAS_URL;
	return raw !== undefined && raw.trim() !== "";
}

interface CapabilityContext {
	daemonCapabilities?: {
		usageObservedAt?: boolean;
		usageSkipNativeFallback?: boolean;
	};
}

/**
 * Controlled compatibility (pa-vtgw9 core contract, fynd 10): the takeover
 * is only safe on a daemon that honors `skipNativeFallback` and the
 * source-owned `observedAt` ceiling. Both flags are advertised via
 * `daemonCapabilities` by patched daemons; on any older daemon (field
 * absent, older vendored SDK types, unknown shape) the plugin stays
 * dormant and native sources keep working untouched. Never probe by
 * version string: capabilities are the contract.
 */
function daemonSupportsTakeover(server: PluginServerContext): boolean {
	const capabilities = (server as unknown as CapabilityContext).daemonCapabilities;
	return (
		!!capabilities &&
		capabilities.usageObservedAt === true &&
		capabilities.usageSkipNativeFallback === true
	);
}

export default function contribute(server: PluginServerContext) {
	if (!hasQuotaUrl()) {
		console.log("paseo-cpa-usage: unconfigured, native usage sources untouched");
		return () => {};
	}
	if (!daemonSupportsTakeover(server)) {
		console.log(
			"paseo-cpa-usage: daemon lacks the usage provenance/capability contract, takeover disabled",
		);
		return () => {};
	}
	for (const provider of supportedProviders()) {
		server.registerUsageSource(makeCpaSource(provider));
	}
	return () => {};
}
