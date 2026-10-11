import {
	DEFAULT_PROVIDER_SETTINGS,
	getProviderLabel,
	ProviderModelRef,
	ProviderTextResult,
	validateProviderBaseUrl
} from "../shared/core";
import { completeChatCompletionsStreaming } from "./chat-completions-stream";
import { fetchModelList } from "./common";
import type { ProviderRuntime } from "./types";

export async function completeOpenRouterText(
	runtime: ProviderRuntime,
	providerRef: ProviderModelRef,
	instructions: string,
	input: string,
	abortSignal?: AbortSignal,
	onDelta?: (delta: string) => void
): Promise<ProviderTextResult> {
	const apiKey = await runtime.getProviderApiKey("openrouter");

	if (!apiKey) {
		throw new Error(`Add a ${providerRef.providerName} API key in AskMate settings before asking a question.`);
	}

	return await completeChatCompletionsStreaming(runtime, {
		providerRef,
		instructions,
		input,
		abortSignal,
		onDelta,
		includeUsage: true,
		baseUrl: getOpenRouterBaseUrl(runtime),
		headers: {
			Authorization: `Bearer ${apiKey}`,
			"Content-Type": "application/json"
		}
	});
}

export async function fetchOpenRouterModels(runtime: ProviderRuntime): Promise<string[]> {
	const providerId = "openrouter";
	const providerName = getProviderLabel(providerId);
	const apiKey = await runtime.getProviderApiKey(providerId);

	if (!apiKey) {
		throw new Error(`Add a ${providerName} API key before refreshing models.`);
	}

	return await fetchModelList(runtime, {
		baseUrl: getOpenRouterBaseUrl(runtime),
		providerName,
		headers: {
			Authorization: `Bearer ${apiKey}`
		},
		timeoutMessage: `${providerName} model refresh timed out after 10 seconds.`
	});
}

function getOpenRouterBaseUrl(runtime: ProviderRuntime): string {
	return validateProviderBaseUrl(
		runtime.getProviderSettings("openrouter").baseUrl,
		DEFAULT_PROVIDER_SETTINGS.openrouter.baseUrl,
		getProviderLabel("openrouter")
	);
}
