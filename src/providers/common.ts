import {
	DEFAULT_PROVIDER_SETTINGS,
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

export function formatProviderHttpError(providerName: string, status: number, message: string): string {
	const cleanMessage = message.trim();
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

	return cleanMessage || `${providerName} request failed with HTTP ${status}.`;
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
		throw new Error(formatProviderHttpError(providerRef.providerName, response.status, extractProviderError(body, "")));
	}

	return {
		text: extractChatCompletionText(body),
		model: providerRef.model,
		endpoint: "chat_completions",
		usage: normalizeChatCompletionsUsage(body?.usage)
	};
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
		throw new Error(formatProviderHttpError(providerName, response.status, body?.error?.message ?? ""));
	}

	return body?.data?.map((model) => model.id ?? "").filter(Boolean).sort((a, b) => a.localeCompare(b)) ?? [];
}

export function getValidatedProviderBaseUrl(runtime: ProviderRuntime, providerRef: ProviderModelRef): string {
	const provider = runtime.getProviderSettings(providerRef.providerId);
	return validateProviderBaseUrl(provider.baseUrl, DEFAULT_PROVIDER_SETTINGS[providerRef.providerId].baseUrl, providerRef.providerName);
}
