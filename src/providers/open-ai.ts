import {
	DEFAULT_IMAGE_GENERATION_TIMEOUT_MS,
	DEFAULT_MODEL_OPTIONS,
	DEFAULT_PROVIDER_SETTINGS,
	DEFAULT_TEXT_GENERATION_TIMEOUT_MS,
	getProviderLabel,
	OpenAIImageGenerationBody,
	OpenAIResponseBody,
	ReasoningEffort,
	validateProviderBaseUrl
} from "../shared/core";
import { fetchModelList } from "./common";
import type { ProviderRuntime } from "./types";

/** Default OpenAI max output for Responses API is provider-side; image/text hosts share one base. */
export function getOpenAIBaseUrl(runtime: ProviderRuntime): string {
	const providerId = "openai";
	const provider = runtime.getProviderSettings(providerId);
	return validateProviderBaseUrl(
		provider.baseUrl,
		DEFAULT_PROVIDER_SETTINGS[providerId].baseUrl,
		getProviderLabel(providerId)
	);
}

export function joinOpenAIUrl(baseUrl: string, path: string): string {
	const base = baseUrl.replace(/\/+$/, "");
	const suffix = path.replace(/^\/+/, "");
	return `${base}/${suffix}`;
}

export function normalizeOpenAIModelOptions(
	models: string[],
	fallback: string[] = DEFAULT_MODEL_OPTIONS,
	selectedModel = ""
): string[] {
	const normalizeList = (values: unknown[]): string[] => Array.from(
		new Set(
			values
				.filter((model): model is string => typeof model === "string")
				.map((model) => model.trim())
				.filter(Boolean)
		)
	);
	const options = normalizeList([...models, selectedModel]);
	return options.length > 0 ? options : normalizeList(fallback);
}

export async function requestOpenAIResponses(
	runtime: ProviderRuntime,
	{
		apiKey,
		model,
		instructions,
		input,
		reasoningEffort,
		abortSignal
	}: {
		apiKey: string;
		model: string;
		instructions: string;
		input: string;
		reasoningEffort: ReasoningEffort;
		abortSignal?: AbortSignal;
	}
) {
	const baseUrl = getOpenAIBaseUrl(runtime);
	return await runtime.requestJson<OpenAIResponseBody>(joinOpenAIUrl(baseUrl, "responses"), {
		method: "POST",
		headers: {
			Authorization: `Bearer ${apiKey}`,
			"Content-Type": "application/json"
		},
		abortSignal,
		timeoutMs: DEFAULT_TEXT_GENERATION_TIMEOUT_MS,
		timeoutMessage: "OpenAI generation timed out after 2 minutes.",
		body: JSON.stringify({
			model,
			instructions,
			input,
			reasoning: {
				effort: reasoningEffort
			}
		})
	});
}

export async function requestOpenAIImageGeneration(
	runtime: ProviderRuntime,
	{
		apiKey,
		model,
		prompt,
		abortSignal
	}: {
		apiKey: string;
		model: string;
		prompt: string;
		abortSignal?: AbortSignal;
	}
) {
	const baseUrl = getOpenAIBaseUrl(runtime);
	return await runtime.requestJson<OpenAIImageGenerationBody>(joinOpenAIUrl(baseUrl, "images/generations"), {
		method: "POST",
		headers: {
			Authorization: `Bearer ${apiKey}`,
			"Content-Type": "application/json"
		},
		abortSignal,
		timeoutMs: DEFAULT_IMAGE_GENERATION_TIMEOUT_MS,
		timeoutMessage: "OpenAI image generation timed out after 5 minutes.",
		body: JSON.stringify({
			model,
			prompt
		})
	});
}

export function extractOpenAIText(body: OpenAIResponseBody | null): string {
	if (!body) {
		return "";
	}

	if (typeof body.output_text === "string") {
		return body.output_text.trim();
	}

	const parts: string[] = [];

	for (const item of body.output ?? []) {
		for (const part of item.content ?? []) {
			if (part.type === "output_text" && typeof part.text === "string") {
				parts.push(part.text);
			}
		}
	}

	return parts.join("\n").trim();
}

export async function fetchOpenAIModels(runtime: ProviderRuntime): Promise<string[]> {
	const providerId = "openai";
	const providerName = getProviderLabel(providerId);
	const apiKey = await runtime.getProviderApiKey(providerId);

	if (!apiKey) {
		throw new Error(`Add a ${providerName} API key before refreshing models.`);
	}

	const baseUrl = getOpenAIBaseUrl(runtime);
	return await fetchModelList(runtime, {
		baseUrl,
		providerName,
		headers: {
			Authorization: `Bearer ${apiKey}`
		},
		timeoutMessage: `${providerName} model refresh timed out after 10 seconds.`
	});
}
