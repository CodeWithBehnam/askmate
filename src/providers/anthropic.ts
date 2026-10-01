import {
	DEFAULT_PROVIDER_SETTINGS,
	getNonNegativeInteger,
	getProviderLabel,
	OpenAITokenUsage,
	ProviderModelRef,
	ProviderTextResult,
	validateProviderBaseUrl
} from "../shared/core";
import { assertProviderTextPresent, collectModelPages, describeProviderErrorBody, formatProviderHttpError } from "./common";
import type { ProviderRuntime } from "./types";

/** Named default so long-note workflows are not silently capped without intent. */
export const ANTHROPIC_DEFAULT_MAX_TOKENS = 8192;
const ANTHROPIC_API_VERSION = "2023-06-01";
/** Non-streaming requests return only when generation ends; slower Claude models need several minutes for an 8192-token answer. */
export const ANTHROPIC_GENERATION_TIMEOUT_MS = 300000;

export async function completeAnthropicText(
	runtime: ProviderRuntime,
	providerRef: ProviderModelRef,
	instructions: string,
	input: string,
	abortSignal?: AbortSignal
): Promise<ProviderTextResult> {
	const apiKey = await runtime.getProviderApiKey("anthropic");

	if (!apiKey) {
		throw new Error("Add an Anthropic API key in AskMate settings before asking a question.");
	}

	const baseUrl = getAnthropicBaseUrl(runtime);
	const response = await runtime.requestJson<Record<string, unknown>>(`${baseUrl}/messages`, {
		method: "POST",
		headers: {
			"x-api-key": apiKey,
			"anthropic-version": ANTHROPIC_API_VERSION,
			"Content-Type": "application/json"
		},
		abortSignal,
		timeoutMs: ANTHROPIC_GENERATION_TIMEOUT_MS,
		timeoutMessage: "Anthropic generation timed out after 5 minutes.",
		body: JSON.stringify({
			model: providerRef.model,
			system: instructions,
			max_tokens: ANTHROPIC_DEFAULT_MAX_TOKENS,
			messages: [
				{ role: "user", content: input }
			]
		})
	});
	const body = response.body;

	if (!response.ok) {
		throw new Error(formatProviderHttpError("Anthropic", response.status, describeProviderErrorBody(response, [apiKey])));
	}

	const text = extractAnthropicText(body);
	const incompleteReason = getAnthropicIncompleteReason(body);
	assertProviderTextPresent("Anthropic", text, incompleteReason);

	return {
		text,
		model: providerRef.model,
		endpoint: "anthropic_messages",
		usage: normalizeAnthropicUsage(body?.usage),
		incompleteReason
	};
}

const ANTHROPIC_COMPLETE_STOP_REASONS = new Set(["end_turn", "stop_sequence"]);

/** Any stop other than a natural end (max_tokens, refusal, model_context_window_exceeded, pause_turn) means the answer is partial. */
export function getAnthropicIncompleteReason(body: Record<string, unknown> | null): string | null {
	const stopReason = body?.stop_reason;

	if (typeof stopReason !== "string" || !stopReason || ANTHROPIC_COMPLETE_STOP_REASONS.has(stopReason)) {
		return null;
	}

	return stopReason;
}

export async function fetchAnthropicModels(runtime: ProviderRuntime): Promise<string[]> {
	const providerId = "anthropic";
	const providerName = getProviderLabel(providerId);
	const apiKey = await runtime.getProviderApiKey(providerId);

	if (!apiKey) {
		throw new Error(`Add a ${providerName} API key before refreshing models.`);
	}

	const baseUrl = getAnthropicBaseUrl(runtime);
	return await collectModelPages<AnthropicModelListBody | null>(
		async (cursor) => {
			const afterId = cursor ? `&after_id=${encodeURIComponent(cursor)}` : "";
			const response = await runtime.requestJson<AnthropicModelListBody>(`${baseUrl}/models?limit=1000${afterId}`, {
				headers: {
					"x-api-key": apiKey,
					"anthropic-version": ANTHROPIC_API_VERSION
				},
				timeoutMs: 10000,
				timeoutMessage: `${providerName} model refresh timed out after 10 seconds.`
			});

			if (!response.ok) {
				throw new Error(formatProviderHttpError(providerName, response.status, describeProviderErrorBody(response, [apiKey])));
			}

			return response.body;
		},
		(page) => page?.data?.map((model) => model.id ?? "") ?? [],
		(page) => (page?.has_more && page.last_id ? page.last_id : null)
	);
}

interface AnthropicModelListBody {
	data?: Array<{
		id?: string;
	}>;
	has_more?: boolean;
	last_id?: string | null;
	error?: {
		message?: string;
	};
}

function getAnthropicBaseUrl(runtime: ProviderRuntime): string {
	return validateProviderBaseUrl(
		runtime.getProviderSettings("anthropic").baseUrl,
		DEFAULT_PROVIDER_SETTINGS.anthropic.baseUrl,
		getProviderLabel("anthropic")
	);
}

function extractAnthropicText(body: Record<string, unknown> | null): string {
	const content = Array.isArray(body?.content) ? body.content : [];
	const parts: string[] = [];

	for (const block of content) {
		if (!block || typeof block !== "object") {
			continue;
		}

		const text = (block as { text?: unknown }).text;
		if (typeof text === "string") {
			parts.push(text);
		}
	}

	return parts.join("\n").trim();
}

function normalizeAnthropicUsage(value: unknown): OpenAITokenUsage | null {
	if (!value || typeof value !== "object") {
		return null;
	}

	const usage = value as { input_tokens?: unknown; output_tokens?: unknown };
	const inputTokens = getNonNegativeInteger(usage.input_tokens);
	const outputTokens = getNonNegativeInteger(usage.output_tokens);

	return {
		input_tokens: inputTokens ?? undefined,
		output_tokens: outputTokens ?? undefined,
		total_tokens: inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : undefined
	};
}
