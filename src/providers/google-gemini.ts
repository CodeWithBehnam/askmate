import {
	DEFAULT_PROVIDER_SETTINGS,
	GeminiModelListBody,
	getNonNegativeInteger,
	getProviderLabel,
	OpenAITokenUsage,
	ProviderModelRef,
	ProviderTextResult,
	validateProviderBaseUrl
} from "../shared/core";
import { extractProviderError, formatProviderHttpError } from "./common";
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
		throw new Error(formatProviderHttpError("Google Gemini", response.status, extractProviderError(body, "")));
	}

	return {
		text: extractGeminiText(body),
		model: providerRef.model,
		endpoint: "gemini_generate_content",
		usage: normalizeGeminiUsage(body?.usageMetadata)
	};
}

export async function fetchGeminiModels(runtime: ProviderRuntime): Promise<string[]> {
	const apiKey = await runtime.getProviderApiKey("google-gemini");

	if (!apiKey) {
		throw new Error("Add a Google Gemini API key before refreshing models.");
	}

	const baseUrl = getGeminiBaseUrl(runtime);
	const response = await runtime.requestJson<GeminiModelListBody>(
		`${baseUrl}/models`,
		{
			headers: {
				"x-goog-api-key": apiKey
			},
			timeoutMs: 10000,
			timeoutMessage: "Google Gemini model refresh timed out after 10 seconds."
		}
	);
	const body = response.body;

	if (!response.ok) {
		throw new Error(formatProviderHttpError("Google Gemini", response.status, body?.error?.message ?? ""));
	}

	return (body?.models ?? [])
		.filter((model) => !Array.isArray(model.supportedGenerationMethods) || model.supportedGenerationMethods.includes("generateContent"))
		.map((model) => (model.name ?? "").replace(/^models\//, ""))
		.filter(Boolean)
		.sort((a, b) => a.localeCompare(b));
}

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

	const usage = value as { promptTokenCount?: unknown; candidatesTokenCount?: unknown; totalTokenCount?: unknown };
	const inputTokens = getNonNegativeInteger(usage.promptTokenCount);
	const outputTokens = getNonNegativeInteger(usage.candidatesTokenCount);
	const totalTokens = getNonNegativeInteger(usage.totalTokenCount);

	return {
		input_tokens: inputTokens ?? undefined,
		output_tokens: outputTokens ?? undefined,
		total_tokens: totalTokens ?? undefined
	};
}
