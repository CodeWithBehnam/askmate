import {
	DEFAULT_PROVIDER_SETTINGS,
	getProviderLabel,
	ProviderModelRef,
	ProviderTextResult,
	validateProviderBaseUrl
} from "../shared/core";
import { completeChatCompletionsText, fetchModelList } from "./common";
import type { ProviderRuntime } from "./types";

export async function completeOpenAICompatibleText(
	runtime: ProviderRuntime,
	providerRef: ProviderModelRef,
	instructions: string,
	input: string,
	abortSignal?: AbortSignal
): Promise<ProviderTextResult> {
	const apiKey = await runtime.getProviderApiKey("openai-compatible");
	const headers: Record<string, string> = {
		"Content-Type": "application/json"
	};

	if (apiKey) {
		headers.Authorization = `Bearer ${apiKey}`;
	}

	return await completeChatCompletionsText(runtime, {
		providerRef,
		instructions,
		input,
		abortSignal,
		baseUrl: getOpenAICompatibleBaseUrl(runtime),
		headers
	});
}

export async function fetchOpenAICompatibleModels(runtime: ProviderRuntime): Promise<string[]> {
	const providerId = "openai-compatible";
	const providerName = getProviderLabel(providerId);
	const apiKey = await runtime.getProviderApiKey(providerId);
	const headers: Record<string, string> = {};

	if (apiKey) {
		headers.Authorization = `Bearer ${apiKey}`;
	}

	return await fetchModelList(runtime, {
		baseUrl: getOpenAICompatibleBaseUrl(runtime),
		providerName,
		headers,
		timeoutMessage: `${providerName} model refresh timed out after 10 seconds.`
	});
}

function getOpenAICompatibleBaseUrl(runtime: ProviderRuntime): string {
	return validateProviderBaseUrl(
		runtime.getProviderSettings("openai-compatible").baseUrl,
		DEFAULT_PROVIDER_SETTINGS["openai-compatible"].baseUrl,
		getProviderLabel("openai-compatible")
	);
}
