import {
	DEFAULT_PROVIDER_SETTINGS,
	DEFAULT_TEXT_GENERATION_TIMEOUT_MS,
	GeminiModelListBody,
	getNonNegativeInteger,
	getProviderLabel,
	OpenAITokenUsage,
	ProviderModelRef,
	ProviderTextResult,
	validateProviderBaseUrl
} from "../shared/core";
import { assertProviderTextPresent, collectModelPages, describeProviderErrorBody, formatProviderHttpError } from "./common";
import type { ProviderRuntime } from "./types";

/** Default max output tokens for generateContent (API default can be too low for note workflows). */
export const GEMINI_DEFAULT_MAX_OUTPUT_TOKENS = 8192;

export async function completeGeminiText(
	runtime: ProviderRuntime,
	providerRef: ProviderModelRef,
	instructions: string,
	input: string,
	abortSignal?: AbortSignal
): Promise<ProviderTextResult> {
	const apiKey = await runtime.getProviderApiKey("google-gemini");

	if (!apiKey) {
		throw new Error("Add a Google Gemini API key in AskMate settings before asking a question.");
	}

	const baseUrl = getGeminiBaseUrl(runtime);
	const model = encodeURIComponent(providerRef.model);
	// Prefer header auth so the API key is not embedded in the request URL (logs/proxies).
	const response = await runtime.requestJson<Record<string, unknown>>(`${baseUrl}/models/${model}:generateContent`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"x-goog-api-key": apiKey
		},
		abortSignal,
		timeoutMs: DEFAULT_TEXT_GENERATION_TIMEOUT_MS,
		timeoutMessage: "Google Gemini generation timed out after 2 minutes.",
		body: JSON.stringify({
			systemInstruction: {
				parts: [{ text: instructions }]
			},
			contents: [
				{
					role: "user",
					parts: [{ text: input }]
				}
			],
			generationConfig: {
				maxOutputTokens: GEMINI_DEFAULT_MAX_OUTPUT_TOKENS
			}
		})
	});
	const body = response.body;

	if (!response.ok) {
		throw new Error(formatProviderHttpError("Google Gemini", response.status, describeProviderErrorBody(response, [apiKey])));
	}

	const blockReason = getGeminiPromptBlockReason(body);
	if (blockReason) {
		throw new Error(`Google Gemini blocked this request (${blockReason}). Rephrase the question or reduce the note context.`);
	}

	const text = extractGeminiText(body);
	const incompleteReason = getGeminiIncompleteReason(body);
	assertProviderTextPresent("Google Gemini", text, incompleteReason);

	return {
		text,
		model: providerRef.model,
		endpoint: "gemini_generate_content",
		usage: normalizeGeminiUsage(body?.usageMetadata),
		incompleteReason
	};
}

export function getGeminiPromptBlockReason(body: Record<string, unknown> | null): string | null {
	const feedback = body?.promptFeedback;
	const blockReason = feedback && typeof feedback === "object"
		? (feedback as { blockReason?: unknown }).blockReason
		: null;

	return typeof blockReason === "string" && blockReason && blockReason !== "BLOCK_REASON_UNSPECIFIED" ? blockReason : null;
}

/** Only STOP is a natural end; MAX_TOKENS, SAFETY, RECITATION and the rest leave the answer partial or empty. */
export function getGeminiIncompleteReason(body: Record<string, unknown> | null): string | null {
	const candidates = Array.isArray(body?.candidates) ? body.candidates : [];
	const first: unknown = candidates[0];
	const finishReason = first && typeof first === "object"
		? (first as { finishReason?: unknown }).finishReason
		: null;

	return typeof finishReason === "string" && finishReason && finishReason !== "STOP" ? finishReason : null;
}

export async function fetchGeminiModels(runtime: ProviderRuntime): Promise<string[]> {
	const apiKey = await runtime.getProviderApiKey("google-gemini");

	if (!apiKey) {
		throw new Error("Add a Google Gemini API key before refreshing models.");
	}

	const baseUrl = getGeminiBaseUrl(runtime);
	return await collectModelPages<GeminiModelListPage | null>(
		async (cursor) => {
			const pageToken = cursor ? `&pageToken=${encodeURIComponent(cursor)}` : "";
			const response = await runtime.requestJson<GeminiModelListPage>(`${baseUrl}/models?pageSize=1000${pageToken}`, {
				headers: {
					"x-goog-api-key": apiKey
				},
				timeoutMs: 10000,
				timeoutMessage: "Google Gemini model refresh timed out after 10 seconds."
			});

			if (!response.ok) {
				throw new Error(formatProviderHttpError("Google Gemini", response.status, describeProviderErrorBody(response, [apiKey])));
			}

			return response.body;
		},
		(page) => (page?.models ?? [])
			.filter((model) => !Array.isArray(model.supportedGenerationMethods) || model.supportedGenerationMethods.includes("generateContent"))
			.map((model) => (model.name ?? "").replace(/^models\//, "")),
		(page) => page?.nextPageToken || null
	);
}

type GeminiModelListPage = GeminiModelListBody & { nextPageToken?: string };

function getGeminiBaseUrl(runtime: ProviderRuntime): string {
	return validateProviderBaseUrl(
		runtime.getProviderSettings("google-gemini").baseUrl,
		DEFAULT_PROVIDER_SETTINGS["google-gemini"].baseUrl,
		getProviderLabel("google-gemini")
	);
}

function extractGeminiText(body: Record<string, unknown> | null): string {
	const candidates = Array.isArray(body?.candidates) ? body.candidates : [];
	const parts: string[] = [];

	for (const candidate of candidates) {
		if (!candidate || typeof candidate !== "object") {
			continue;
		}

		const content = (candidate as { content?: unknown }).content;
		const blocks = content && typeof content === "object"
			? (content as { parts?: unknown }).parts
			: null;

		if (!Array.isArray(blocks)) {
			continue;
		}

		for (const block of blocks) {
			if (!block || typeof block !== "object") {
				continue;
			}

			const text = (block as { text?: unknown }).text;
			if (typeof text === "string") {
				parts.push(text);
			}
		}
	}

	return parts.join("\n").trim();
}

function normalizeGeminiUsage(value: unknown): OpenAITokenUsage | null {
	if (!value || typeof value !== "object") {
		return null;
	}

	const usage = value as {
		promptTokenCount?: unknown;
		candidatesTokenCount?: unknown;
		thoughtsTokenCount?: unknown;
		totalTokenCount?: unknown;
	};
	const inputTokens = getNonNegativeInteger(usage.promptTokenCount);
	const candidateTokens = getNonNegativeInteger(usage.candidatesTokenCount);
	// Thinking tokens are billed as output but reported apart from candidate tokens.
	const thoughtTokens = getNonNegativeInteger(usage.thoughtsTokenCount);
	const outputTokens = candidateTokens === null && thoughtTokens === null
		? null
		: (candidateTokens ?? 0) + (thoughtTokens ?? 0);
	const totalTokens = getNonNegativeInteger(usage.totalTokenCount);

	return {
		input_tokens: inputTokens ?? undefined,
		output_tokens: outputTokens ?? undefined,
		total_tokens: totalTokens ?? undefined,
		...(thoughtTokens !== null ? { output_tokens_details: { reasoning_tokens: thoughtTokens } } : {})
	};
}
