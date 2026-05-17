import {
	DEFAULT_PROVIDER_SETTINGS,
	getProviderLabel,
	ProviderModelRef,
	ProviderSettings,
	ProviderTextResult,
	validateAzureOpenAIBaseUrl
} from "../shared/core";
import { completeChatCompletionsText, extractProviderError, fetchModelList, formatProviderHttpError } from "./common";
import type { ProviderRuntime } from "./types";

export function getAzureOpenAIHeaders(apiKey: string): Record<string, string> {
	return {
		"Content-Type": "application/json",
		"api-key": apiKey
	};
}

export function getAzureOpenAIBaseUrl(provider: ProviderSettings): string {
	return validateAzureOpenAIBaseUrl(provider.baseUrl, DEFAULT_PROVIDER_SETTINGS["azure-openai"].baseUrl);
}

export async function completeAzureOpenAIText(
	runtime: ProviderRuntime,
	providerRef: ProviderModelRef,
	instructions: string,
	input: string,
	abortSignal?: AbortSignal
): Promise<ProviderTextResult> {
	const provider = runtime.getProviderSettings("azure-openai");
	const apiKey = await runtime.getProviderApiKey("azure-openai");

	if (!apiKey) {
		throw new Error("Add an Azure OpenAI API key in AskMate settings before asking a question.");
	}

	if (!providerRef.model.trim()) {
		throw new Error("Enter an Azure OpenAI deployment name in AskMate settings before asking a question.");
	}

	return await completeChatCompletionsText(runtime, {
		providerRef,
		instructions,
		input,
		abortSignal,
		baseUrl: getAzureOpenAIBaseUrl(provider),
		headers: getAzureOpenAIHeaders(apiKey)
	});
}

export async function fetchAzureOpenAIModels(runtime: ProviderRuntime): Promise<string[]> {
	const providerId = "azure-openai";
	const provider = runtime.getProviderSettings(providerId);
	const apiKey = await runtime.getProviderApiKey(providerId);

	if (!apiKey) {
		throw new Error(`Add a ${getProviderLabel(providerId)} API key before refreshing models.`);
	}

	return await fetchModelList(runtime, {
		baseUrl: getAzureOpenAIBaseUrl(provider),
		providerName: getProviderLabel(providerId),
		headers: getAzureOpenAIHeaders(apiKey),
		timeoutMessage: `${getProviderLabel(providerId)} model refresh timed out after 10 seconds.`
	});
}

export async function testAzureOpenAIConnection(runtime: ProviderRuntime): Promise<string> {
	const provider = runtime.getProviderSettings("azure-openai");
	const apiKey = await runtime.getProviderApiKey("azure-openai");
	const deploymentName = provider.model.trim();

	if (!apiKey) {
		throw new Error("Add an Azure OpenAI API key before testing the provider connection.");
	}

	if (!deploymentName) {
		throw new Error("Enter an Azure OpenAI deployment name before testing the provider connection.");
	}

	const baseUrl = getAzureOpenAIBaseUrl(provider);
	const response = await runtime.requestJson<Record<string, unknown>>(`${baseUrl}/chat/completions`, {
		method: "POST",
		headers: getAzureOpenAIHeaders(apiKey),
		timeoutMs: 10000,
		timeoutMessage: "Azure OpenAI test request timed out after 10 seconds.",
		body: JSON.stringify({
			model: deploymentName,
			messages: [
				{ role: "user", content: "Reply with OK to confirm this Azure OpenAI deployment works." }
			]
		})
	});
	const body = response.body;

	if (!response.ok) {
		throw new Error(formatProviderHttpError("Azure OpenAI", response.status, extractProviderError(body, "")));
	}

	return "AskMate Azure OpenAI test passed. It sent a minimal text request to the selected deployment and may have consumed a small number of tokens.";
}
