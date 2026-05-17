import {
	DEFAULT_MODEL_OPTIONS,
	DEFAULT_PROVIDER_SETTINGS,
	getProviderLabel,
	OpenAIImageGenerationBody,
	OpenAIResponseBody,
	OpenAIStreamEvent,
	OpenAITokenUsage,
	ReasoningEffort,
	validateProviderBaseUrl
} from "../shared/core";
import { fetchModelList } from "./common";
import type { ProviderRuntime } from "./types";

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
	return await runtime.requestJson<OpenAIResponseBody>("https://api.openai.com/v1/responses", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${apiKey}`,
			"Content-Type": "application/json"
		},
		abortSignal,
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
	return await runtime.requestJson<OpenAIImageGenerationBody>("https://api.openai.com/v1/images/generations", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${apiKey}`,
			"Content-Type": "application/json"
		},
		abortSignal,
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

export function parseOpenAIStreamEvent(line: string): OpenAIStreamEvent | null {
	if (!line.startsWith("data: ")) {
		return null;
	}

	const payload = line.slice(6).trim();

	if (!payload || payload === "[DONE]") {
		return null;
	}

	try {
		const event = JSON.parse(payload) as OpenAIStreamEvent;

		if (event.error?.message) {
			throw new Error(event.error.message);
		}

		return event;
	} catch (error) {
		if (error instanceof Error) {
			throw error;
		}
	}

	return null;
}

export function getOpenAIStreamDelta(event: OpenAIStreamEvent): string {
	if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
		return event.delta;
	}

	return "";
}

export function getOpenAIStreamUsage(event: OpenAIStreamEvent): OpenAITokenUsage | null {
	return event.response?.usage ?? event.usage ?? null;
}

export function isCompletedOpenAIStreamEvent(event: OpenAIStreamEvent): boolean {
	return event.type === "response.completed" || event.response?.status === "completed";
}

export function getOpenAIStreamTerminalError(event: OpenAIStreamEvent): string | null {
	const responseError = event.response?.error?.message?.trim();

	if (responseError) {
		return responseError;
	}

	if (event.type === "response.failed" || event.response?.status === "failed") {
		return "OpenAI response failed.";
	}

	if (event.type === "response.incomplete" || event.response?.status === "incomplete") {
		const reason = event.response?.incomplete_details?.reason?.trim();
		return reason ? `OpenAI response incomplete: ${reason}.` : "OpenAI response incomplete.";
	}

	return null;
}

export async function fetchOpenAIModels(runtime: ProviderRuntime): Promise<string[]> {
	const providerId = "openai";
	const providerName = getProviderLabel(providerId);
	const provider = runtime.getProviderSettings(providerId);
	const apiKey = await runtime.getProviderApiKey(providerId);

	if (!apiKey) {
		throw new Error(`Add a ${providerName} API key before refreshing models.`);
	}

	const baseUrl = validateProviderBaseUrl(provider.baseUrl, DEFAULT_PROVIDER_SETTINGS[providerId].baseUrl, providerName);
	return await fetchModelList(runtime, {
		baseUrl,
		providerName,
		headers: {
			Authorization: `Bearer ${apiKey}`
		},
		timeoutMessage: `${providerName} model refresh timed out after 10 seconds.`
	});
}
