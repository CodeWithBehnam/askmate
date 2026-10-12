/**
 * data.json can sync from another computer, and it holds each provider's address next to the name of the stored secret
 * that key is read from. A changed address in a synced file would send the key to a new host, so a custom endpoint gets
 * the key only after this device has approved that exact (secret, host) pair. Official endpoints are not custom, and a
 * server on this computer never leaves it.
 */
import type { TextProviderId } from "../shared/types";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
/** Azure OpenAI addresses are checked against the official Azure host patterns when they load, so they need no second approval. */
const SELF_VALIDATING_PROVIDERS: ReadonlySet<TextProviderId> = new Set<TextProviderId>(["azure-openai"]);

/** The host (and port) a provider address points at, or null when the address is not a URL. */
export function endpointHost(baseUrl: string): string | null {
	try {
		const url = new URL(baseUrl.trim());
		return url.host ? url.host.toLowerCase() : null;
	} catch {
		return null;
	}
}

function isLoopback(host: string): boolean {
	return LOOPBACK_HOSTS.has(host.replace(/:\d+$/, ""));
}

/**
 * True when the stored key must not be sent until the person approves it for this host. `approvedHost` is what this
 * device last approved for the secret, or null.
 */
export function needsKeyApproval(input: {
	providerId: TextProviderId;
	firstPartyProviders: readonly TextProviderId[];
	baseUrl: string;
	secretName: string;
	approvedHost: string | null;
}): boolean {
	if (!input.secretName.trim() || input.firstPartyProviders.includes(input.providerId) || SELF_VALIDATING_PROVIDERS.has(input.providerId)) {
		return false;
	}
	const host = endpointHost(input.baseUrl);
	if (host === null) {
		// An address that is not a URL is rejected by the provider before any request is made.
		return false;
	}
	return !isLoopback(host) && input.approvedHost !== host;
}
