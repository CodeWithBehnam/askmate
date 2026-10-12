import {
	DEFAULT_PROVIDER_SETTINGS,
	DEFAULT_TEXT_GENERATION_TIMEOUT_MS,
	GeminiModelListBody,
	getProviderLabel,
	ProviderModelRef,
	ProviderTextResult,
	validateProviderBaseUrl
} from "../shared/core";
import { assertProviderTextPresent, collectModelPages, describeProviderErrorBody, formatProviderHttpError } from "./common";
import {
	assembleGeminiBody,
	geminiStreamAdapter,
	getGeminiPromptBlockReason,
	normalizeGeminiUsage,
	readGeminiCandidateText
} from "./google-gemini-stream";
import { tryStreamTextResult } from "./streaming";
import type { ProviderRuntime } from "./types";

// Kept exported from here for existing importers; the implementation lives beside the stream adapter that shares it.
export { getGeminiPromptBlockReason };

export async function completeGeminiText(
	runtime: ProviderRuntime,
	providerRef: ProviderModelRef,
	instructions: string,
	input: string,
	abortSignal?: AbortSignal,
	onDelta?: (delta: string) => void
): Promise<ProviderTextResult> {
	const apiKey = await runtime.getProviderApiKey("google-gemini");

	if (!apiKey) {
		throw new Error("Add a Google Gemini API key in AskMate settings before asking a question.");
	}

	const baseUrl = getGeminiBaseUrl(runtime);
	const model = encodeURIComponent(providerRef.model);
	// Prefer header auth so the API key is not embedded in the request URL (logs/proxies).
	const headers = {
		"Content-Type": "application/json",
		"x-goog-api-key": apiKey
	};
	// maxOutputTokens is left out on purpose: Gemini 2.5 counts thinking tokens against it, so a fixed cap could leave a
	// long rewrite with no visible text, and each model's own limit is the right ceiling.
	const requestBody = JSON.stringify({
		systemInstruction: {
			parts: [{ text: instructions }]
		},
		contents: [
			{
				role: "user",
				parts: [{ text: input }]
			}
		]
	});

	if (onDelta) {
		const streamed = await tryStreamTextResult(runtime, {
			providerName: "Google Gemini",
			url: `${baseUrl}/models/${model}:streamGenerateContent?alt=sse`,
			headers,
			body: requestBody,
			abortSignal,
			idleTimeoutMs: DEFAULT_TEXT_GENERATION_TIMEOUT_MS,
			adapter: geminiStreamAdapter,
			onDelta,
			model: providerRef.model,
			endpoint: "gemini_generate_content",
			assemble: assembleGeminiBody,
			buildResult: (body) => buildGeminiResult(providerRef.model, body)
		});

		if (streamed) {
			return streamed;
		}
	}

	const response = await runtime.requestJson<Record<string, unknown>>(`${baseUrl}/models/${model}:generateContent`, {
		method: "POST",
		headers,
		abortSignal,
		timeoutMs: DEFAULT_TEXT_GENERATION_TIMEOUT_MS,
		timeoutMessage: "Google Gemini generation timed out after 2 minutes.",
		body: requestBody
	});

	if (!response.ok) {
		throw new Error(formatProviderHttpError("Google Gemini", response.status, describeProviderErrorBody(response, [apiKey])));
	}

	return buildGeminiResult(providerRef.model, response.body);
}

/** Single parser for buffered bodies and for bodies assembled from a stream. */
export function buildGeminiResult(model: string, body: Record<string, unknown> | null): ProviderTextResult {
	const blockReason = getGeminiPromptBlockReason(body);
	if (blockReason) {
		throw new Error(`Google Gemini blocked this request (${blockReason}). Rephrase the question or reduce the note context.`);
	}

	const text = extractGeminiText(body);
	const incompleteReason = getGeminiIncompleteReason(body);
	assertProviderTextPresent("Google Gemini", text, incompleteReason);

	return {
		text,
		model,
		endpoint: "gemini_generate_content",
		usage: normalizeGeminiUsage(body?.usageMetadata),
		incompleteReason
	};
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

export function getGeminiBaseUrl(runtime: ProviderRuntime): string {
	return validateProviderBaseUrl(
		runtime.getProviderSettings("google-gemini").baseUrl,
		DEFAULT_PROVIDER_SETTINGS["google-gemini"].baseUrl,
		getProviderLabel("google-gemini")
	);
}

/**
 * Gemini splits one reply across several text parts at arbitrary points (even inside a word), so parts are joined
 * with no separator, exactly as the stream adapter and Google's SDKs do. Only the first candidate is read and thought
 * summaries are not answer text.
 */
function extractGeminiText(body: Record<string, unknown> | null): string {
	return readGeminiCandidateText(body).trim();
}
