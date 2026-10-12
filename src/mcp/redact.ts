import { redactSecrets } from "../providers/common";

/** Shortest exact secret value worth masking everywhere. Shorter strings would shred ordinary words. */
const MIN_EXACT_SECRET_LENGTH = 6;

const HEADER_AND_TOKEN_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
	[/\b(Bearer\s+)[^\s"',;]+/gi, "$1[redacted]"],
	[/\b((?:proxy-)?authorization["']?\s*[:=]\s*["']?)(?:(?:Bearer|Basic)\s+)?[^\s"',;]+/gi, "$1[redacted]"],
	[/\b((?:x-api-key|api-key)["']?\s*[:=]\s*["']?)[^\s"',;]+/gi, "$1[redacted]"],
	[/\b((?:access_?token|refresh_?token|client_?secret|password|passwd)["']?\s*[:=]\s*["']?)[^\s"',;&]+/gi, "$1[redacted]"]
];

/**
 * Replaces every occurrence of the given secret values and nothing else. Used where the text is a server's own content (a tool
 * result), which must keep its wording apart from the values this server was given.
 */
export function maskSecretValues(text: string, secrets: readonly string[]): string {
	return secrets
		.map((secret) => secret.trim())
		.filter((secret) => secret.length >= MIN_EXACT_SECRET_LENGTH)
		.reduce((current, secret) => current.split(secret).join("[redacted]"), text);
}

/**
 * Masks bearer tokens, header values and the exact secrets this server uses before text reaches a notice, a log or a status chip.
 * Wraps the provider redactor so MCP and provider errors follow the same rules.
 */
export function redactMcpText(text: string, secrets: readonly string[] = []): string {
	const exact = maskSecretValues(text, secrets);
	const known = redactSecrets(exact, [...secrets]);
	return HEADER_AND_TOKEN_PATTERNS.reduce((current, [pattern, replacement]) => current.replace(pattern, replacement), known);
}

/** The token from an Authorization header value, so it can be masked on its own. */
export function stripAuthScheme(headerValue: string): string {
	return headerValue.replace(/^(?:Bearer|Basic)\s+/i, "");
}
