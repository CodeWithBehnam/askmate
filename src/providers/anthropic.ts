import {
	DEFAULT_PROVIDER_SETTINGS,
	getNonNegativeInteger,
	getProviderLabel,
	OpenAITokenUsage,
	ProviderModelRef,
	ProviderTextResult,
	validateProviderBaseUrl
} from "../shared/core";
import { extractProviderError, fetchModelList, formatProviderHttpError } from "./common";
import type { ProviderRuntime } from "./types";

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
			"anthropic-version": "2023-06-01",
			"Content-Type": "application/json"
		},
		abortSignal,
		body: JSON.stringify({
			model: providerRef.model,
			system: instructions,
			max_tokens: 4096,
			messages: [
				{ role: "user", content: input }
			]
		})
	});
	const body = response.body;

	if (!response.ok) {
		throw new Error(formatProviderHttpError("Anthropic", response.status, extractProviderError(body, "")));
	}

	return {
		text: extractAnthropicText(body),
		model: providerRef.model,
		endpoint: "anthropic_messages",
		usage: normalizeAnthropicUsage(body?.usage)
	};
}

export async function fetchAnthropicModels(runtime: ProviderRuntime): Promise<string[]> {
	const providerId = "anthropic";
	const providerName = getProviderLabel(providerId);
	const apiKey = await runtime.getProviderApiKey(providerId);

	if (!apiKey) {
		throw new Error(`Add a ${providerName} API key before refreshing models.`);
	}

	return await fetchModelList(runtime, {
		baseUrl: getAnthropicBaseUrl(runtime),
		providerName,
		headers: {
			"x-api-key": apiKey,
			"anthropic-version": "2023-06-01"
		},
		timeoutMessage: `${providerName} model refresh timed out after 10 seconds.`
	});
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
