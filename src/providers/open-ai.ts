import {
	DEFAULT_IMAGE_GENERATION_TIMEOUT_MS,
	DEFAULT_MODEL_OPTIONS,
	DEFAULT_PROVIDER_SETTINGS,
	DEFAULT_TEXT_GENERATION_TIMEOUT_MS,
	getProviderLabel,
	getSupportedReasoningEffort,
	isGptImage2Model,
	isOpenAITextModel,
	OpenAIImageGenerationBody,
	OpenAIResponseBody,
	ReasoningEffort,
	validateProviderBaseUrl
} from "../shared/core";
import { fetchModelList, formatTimeoutDuration } from "./common";
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

const OPENAI_MEDIUM_EFFORT_TIMEOUT_MS = 300000;
const OPENAI_HIGH_EFFORT_TIMEOUT_MS = 600000;

/**
 * How long one Responses call may take. A reasoning model can think for minutes before the first token, and a buffered
 * request returns only when generation ends, so the limit follows the reasoning effort that is actually sent. A model
 * that takes no reasoning parameter keeps the base limit whatever the setting says.
 */
export function getOpenAIGenerationTimeoutMs(model: string, reasoningEffort: ReasoningEffort): number {
	return getReasoningEffortTimeoutMs(getSupportedReasoningEffort(model, reasoningEffort));
}

/** The limit for an effort that is already the value being sent (null: no reasoning parameter). */
export function getReasoningEffortTimeoutMs(effort: string | null): number {
	switch (effort) {
		case "medium":
			return OPENAI_MEDIUM_EFFORT_TIMEOUT_MS;
		case "high":
		case "xhigh":
			return OPENAI_HIGH_EFFORT_TIMEOUT_MS;
		default:
			return DEFAULT_TEXT_GENERATION_TIMEOUT_MS;
	}
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
	const timeoutMs = getOpenAIGenerationTimeoutMs(model, reasoningEffort);
	return await runtime.requestJson<OpenAIResponseBody>(joinOpenAIUrl(baseUrl, "responses"), {
		method: "POST",
		headers: {
			Authorization: `Bearer ${apiKey}`,
			"Content-Type": "application/json"
		},
		abortSignal,
		timeoutMs,
		timeoutMessage: `OpenAI generation timed out after ${formatTimeoutDuration(timeoutMs)}.`,
		body: JSON.stringify(buildOpenAIResponsesBody({ model, instructions, input, reasoningEffort }))
	});
}

export function buildOpenAIResponsesBody({
	model,
	instructions,
	input,
	reasoningEffort
}: {
	model: string;
	instructions: string;
	input: string;
	reasoningEffort: ReasoningEffort;
}): Record<string, unknown> {
	const effort = getSupportedReasoningEffort(model, reasoningEffort);

	return {
		model,
		instructions,
		input,
		// Note content should not be retained server-side; AskMate never chains responses by ID.
		store: false,
		...(effort ? { reasoning: { effort } } : {})
	};
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

/** Responses API refusals arrive as `refusal` content parts with no `output_text`. */
export function extractOpenAIRefusal(body: OpenAIResponseBody | null): string {
	for (const item of body?.output ?? []) {
		for (const part of item.content ?? []) {
			const refusal = "refusal" in part ? part.refusal : undefined;
			if (part.type === "refusal" && typeof refusal === "string" && refusal.trim()) {
				return refusal.trim();
			}
		}
	}

	return "";
}

export async function fetchOpenAIModels(runtime: ProviderRuntime): Promise<string[]> {
	const providerId = "openai";
	const providerName = getProviderLabel(providerId);
	const apiKey = await runtime.getProviderApiKey(providerId);

	if (!apiKey) {
		throw new Error(`Add a ${providerName} API key before refreshing models.`);
	}

	const baseUrl = getOpenAIBaseUrl(runtime);
	const models = await fetchModelList(runtime, {
		baseUrl,
		providerName,
		headers: {
			Authorization: `Bearer ${apiKey}`
		},
		timeoutMessage: `${providerName} model refresh timed out after 10 seconds.`
	});
	// gpt-image-2 stays because the model picker is also how image mode is chosen.
	return models.filter((model) => isOpenAITextModel(model) || isGptImage2Model(model));
}
