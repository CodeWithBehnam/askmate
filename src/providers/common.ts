import {
	AskMateHttpResponse,
	DEFAULT_PROVIDER_SETTINGS,
	DEFAULT_TEXT_GENERATION_TIMEOUT_MS,
	getNonNegativeInteger,
	OpenAIModelListBody,
	OpenAITokenUsage,
	ProviderModelRef,
	ProviderTextResult,
	validateProviderBaseUrl
} from "../shared/core";
import type { ProviderRuntime } from "./types";

export function extractProviderError(body: Record<string, unknown> | null, fallback: string): string {
	const error = body?.error;

	if (error && typeof error === "object") {
		const message = (error as { message?: unknown }).message;
		if (typeof message === "string" && message.trim()) {
			return message.trim();
		}
	}

	return fallback;
}

const MAX_ERROR_DETAIL_LENGTH = 300;
const SECRET_PATTERNS: Array<[RegExp, string]> = [
	[/\bsk-[A-Za-z0-9_-]{16,}/g, "[redacted]"],
	[/\bAIza[0-9A-Za-z_-]{30,}/g, "[redacted]"],
	[/(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi, "$1[redacted]"],
	[/([?&](?:key|api[-_]?key)=)[^&\s"']+/gi, "$1[redacted]"]
];

/** Provider error text is shown in the UI and stored in usage history, so key-like strings must never survive. */
export function redactSecrets(text: string, secrets: string[] = []): string {
	const withoutKnown = secrets
		.map((secret) => secret.trim())
		.filter((secret) => secret.length >= 8)
		.reduce((current, secret) => current.split(secret).join("[redacted]"), text);

	return SECRET_PATTERNS.reduce((current, [pattern, replacement]) => current.replace(pattern, replacement), withoutKnown);
}

function summarizeErrorText(text: string): string {
	const plain = text
		.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, " ")
		.replace(/<[^>]*>/g, " ")
		.replace(/\s+/g, " ")
		.trim();

	return plain.length > MAX_ERROR_DETAIL_LENGTH ? `${plain.slice(0, MAX_ERROR_DETAIL_LENGTH)}...` : plain;
}

const SECRET_HEADER_PATTERN = /^(?:authorization|api-key|x-api-key|x-goog-api-key)$/i;

export function getSecretHeaderValues(headers: Record<string, string>): string[] {
	return Object.entries(headers)
		.filter(([name]) => SECRET_HEADER_PATTERN.test(name))
		.map(([, value]) => value.replace(/^Bearer\s+/i, ""));
}

/** Uses the JSON error message when present, otherwise a short plain-text excerpt of a non-JSON body (gateway pages, proxies). */
export function describeProviderErrorBody(response: AskMateHttpResponse<unknown>, secrets: string[] = []): string {
	const body = response.body && typeof response.body === "object" ? response.body as Record<string, unknown> : null;
	const message = extractProviderError(body, "") || summarizeErrorText(response.text);
	return redactSecrets(message, secrets);
}

export function formatProviderHttpError(providerName: string, status: number, message: string): string {
	const cleanMessage = redactSecrets(message.trim());
	const detail = cleanMessage ? ` Provider message: ${cleanMessage}` : "";

	if (status === 401) {
		return `${providerName} authentication failed. Check the API key secret in AskMate settings.${detail}`;
	}

	if (status === 403) {
		return `${providerName} access is forbidden. Check model access, account permissions, or organization verification.${detail}`;
	}

	if (status === 404) {
		return `${providerName} could not find the endpoint or model. Check the base URL and model ID.${detail}`;
	}

	if (status === 408 || status === 504) {
		return `${providerName} request timed out. Try again or choose a smaller context budget.${detail}`;
	}

	if (status === 429) {
		return `${providerName} rate limit or quota was reached. Wait, reduce context, or check billing.${detail}`;
	}

	if (status >= 500) {
		return `${providerName} service error. Try again later.${detail}`;
	}

	return `${providerName} request failed with HTTP ${status}.${detail}`;
}

export function extractChatCompletionText(body: Record<string, unknown> | null): string {
	const choices = Array.isArray(body?.choices) ? body.choices : [];
	const parts: string[] = [];

	for (const choice of choices) {
		if (!choice || typeof choice !== "object") {
			continue;
		}

		const message = (choice as { message?: unknown }).message;
		if (!message || typeof message !== "object") {
			continue;
		}

		const content = (message as { content?: unknown }).content;
		if (typeof content === "string") {
			parts.push(content);
		}
	}

	return parts.join("\n").trim();
}

const CHAT_COMPLETION_INCOMPLETE_REASONS = new Set(["length", "content_filter"]);

export function getChatCompletionIncompleteReason(body: Record<string, unknown> | null): string | null {
	const choices = Array.isArray(body?.choices) ? body.choices : [];

	for (const choice of choices) {
		if (!choice || typeof choice !== "object") {
			continue;
		}

		const reason = (choice as { finish_reason?: unknown }).finish_reason;
		if (typeof reason === "string" && CHAT_COMPLETION_INCOMPLETE_REASONS.has(reason)) {
			return reason;
		}
	}

	return null;
}

function extractChatCompletionRefusal(body: Record<string, unknown> | null): string {
	const choices = Array.isArray(body?.choices) ? body.choices : [];

	for (const choice of choices) {
		const message = choice && typeof choice === "object" ? (choice as { message?: unknown }).message : null;
		const refusal = message && typeof message === "object" ? (message as { refusal?: unknown }).refusal : null;
		if (typeof refusal === "string" && refusal.trim()) {
			return refusal.trim();
		}
	}

	return "";
}

/** An early stop with no text would otherwise surface as a vague "no output" error that hides the provider's reason. */
export function assertProviderTextPresent(providerName: string, text: string, incompleteReason: string | null): void {
	if (!text && incompleteReason) {
		throw new Error(
			`${providerName} returned no text. The response stopped with reason "${incompleteReason}", which usually means a refusal, a safety block or the output token limit.`
		);
	}
}

export function buildChatCompletionsResult(
	providerName: string,
	model: string,
	body: Record<string, unknown> | null
): ProviderTextResult {
	const text = extractChatCompletionText(body);
	const refusal = extractChatCompletionRefusal(body);

	if (!text && refusal) {
		throw new Error(`${providerName} refused the request. Provider message: ${refusal}`);
	}

	const incompleteReason = getChatCompletionIncompleteReason(body);
	assertProviderTextPresent(providerName, text, incompleteReason);

	return {
		text,
		model,
		endpoint: "chat_completions",
		usage: normalizeChatCompletionsUsage(body?.usage),
		incompleteReason
	};
}

export function normalizeChatCompletionsUsage(value: unknown): OpenAITokenUsage | null {
	if (!value || typeof value !== "object") {
		return null;
	}

	const usage = value as { prompt_tokens?: unknown; completion_tokens?: unknown; total_tokens?: unknown };
	const inputTokens = getNonNegativeInteger(usage.prompt_tokens);
	const outputTokens = getNonNegativeInteger(usage.completion_tokens);
	const totalTokens = getNonNegativeInteger(usage.total_tokens);

	return {
		input_tokens: inputTokens ?? undefined,
		output_tokens: outputTokens ?? undefined,
		total_tokens: totalTokens ?? undefined
	};
}

export async function completeChatCompletionsText(
	runtime: ProviderRuntime,
	{
		providerRef,
		instructions,
		input,
		abortSignal,
		baseUrl,
		headers
	}: {
		providerRef: ProviderModelRef;
		instructions: string;
		input: string;
		abortSignal?: AbortSignal;
		baseUrl: string;
		headers: Record<string, string>;
	}
): Promise<ProviderTextResult> {
	const response = await runtime.requestJson<Record<string, unknown>>(`${baseUrl}/chat/completions`, {
		method: "POST",
		headers,
		abortSignal,
		timeoutMs: DEFAULT_TEXT_GENERATION_TIMEOUT_MS,
		timeoutMessage: `${providerRef.providerName} generation timed out after 2 minutes.`,
		body: JSON.stringify({
			model: providerRef.model,
			messages: [
				{ role: "system", content: instructions },
				{ role: "user", content: input }
			]
		})
	});
	const body = response.body;

	if (!response.ok) {
		throw new Error(formatProviderHttpError(providerRef.providerName, response.status, describeProviderErrorBody(response, getSecretHeaderValues(headers))));
	}

	return buildChatCompletionsResult(providerRef.providerName, providerRef.model, body);
}

export async function fetchModelList(
	runtime: ProviderRuntime,
	{
		baseUrl,
		providerName,
		headers,
		timeoutMessage
	}: {
		baseUrl: string;
		providerName: string;
		headers: Record<string, string>;
		timeoutMessage: string;
	}
): Promise<string[]> {
	const response = await runtime.requestJson<OpenAIModelListBody>(
		`${baseUrl}/models`,
		{
			headers,
			timeoutMs: 10000,
			timeoutMessage
		}
	);
	const body = response.body;

	if (!response.ok) {
		throw new Error(formatProviderHttpError(providerName, response.status, describeProviderErrorBody(response, getSecretHeaderValues(headers))));
	}

	return body?.data?.map((model) => model.id ?? "").filter(Boolean).sort((a, b) => a.localeCompare(b)) ?? [];
}

/** Upper bound so a provider that keeps returning a cursor cannot loop forever. */
export const MAX_MODEL_LIST_PAGES = 20;

/** Follows a cursor-paginated model list until the provider reports no further page. */
export async function collectModelPages<TPage>(
	fetchPage: (cursor: string | null) => Promise<TPage>,
	getItems: (page: TPage) => string[],
	getNextCursor: (page: TPage) => string | null
): Promise<string[]> {
	const items: string[] = [];
	const seenCursors = new Set<string>();
	let cursor: string | null = null;

	for (let pageIndex = 0; pageIndex < MAX_MODEL_LIST_PAGES; pageIndex += 1) {
		const page = await fetchPage(cursor);
		items.push(...getItems(page));
		const next = getNextCursor(page);

		if (!next || seenCursors.has(next)) {
			break;
		}

		seenCursors.add(next);
		cursor = next;
	}

	return Array.from(new Set(items.filter(Boolean))).sort((a, b) => a.localeCompare(b));
}

export function getValidatedProviderBaseUrl(runtime: ProviderRuntime, providerRef: ProviderModelRef): string {
	const provider = runtime.getProviderSettings(providerRef.providerId);
	return validateProviderBaseUrl(provider.baseUrl, DEFAULT_PROVIDER_SETTINGS[providerRef.providerId].baseUrl, providerRef.providerName);
}
