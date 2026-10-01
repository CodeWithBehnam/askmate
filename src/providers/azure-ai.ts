import {
	DEFAULT_PROVIDER_SETTINGS,
	DEFAULT_TEXT_GENERATION_TIMEOUT_MS,
	getProviderLabel,
	ProviderModelRef,
	ProviderSettings,
	ProviderTextResult,
	validateProviderBaseUrl
} from "../shared/core";
import {
	buildChatCompletionsResult,
	describeProviderErrorBody,
	formatProviderHttpError
} from "./common";
import type { ProviderRuntime } from "./types";

const AZURE_AI_INFERENCE_API_VERSION = "2024-05-01-preview";
const AZURE_AI_RESOURCE_HOST_PATTERN = /\.(?:services\.ai|cognitiveservices)\.azure\.com$/i;

interface AzureAIModelInfoBody {
	model_name?: string;
	model_type?: string;
	model_provider_name?: string;
	error?: {
		message?: string;
	};
}

export function getAzureAIHeaders(apiKey: string): Record<string, string> {
	return {
		"Content-Type": "application/json",
		"api-key": apiKey
	};
}

export function getAzureAIBaseUrl(provider: ProviderSettings): string {
	const baseUrl = validateProviderBaseUrl(provider.baseUrl, DEFAULT_PROVIDER_SETTINGS["azure-ai"].baseUrl, "Azure AI Foundry");
	const url = new URL(baseUrl);

	if (url.search || url.hash) {
		throw new Error("Azure AI Foundry base URL must not include query strings or fragments.");
	}

	const normalized = baseUrl.replace(/\/+$/g, "");
	const hasPath = url.pathname.replace(/\/+$/g, "") !== "";

	// Only the Foundry resource hosts serve inference under /models; serverless endpoints
	// (*.models.ai.azure.com) and custom paths already point at the inference root.
	if (!hasPath && AZURE_AI_RESOURCE_HOST_PATTERN.test(url.hostname)) {
		return `${normalized}/models`;
	}

	return normalized;
}

export async function completeAzureAIText(
	runtime: ProviderRuntime,
	providerRef: ProviderModelRef,
	instructions: string,
	input: string,
	abortSignal?: AbortSignal,
	options: {
		timeoutMs?: number;
		timeoutMessage?: string;
	} = {}
): Promise<ProviderTextResult> {
	const provider = runtime.getProviderSettings("azure-ai");
	const apiKey = await runtime.getProviderApiKey("azure-ai");

	if (!apiKey) {
		throw new Error("Add an Azure AI Foundry API key in AskMate settings before asking a question.");
	}

	if (!providerRef.model.trim()) {
		throw new Error("Enter an Azure AI Foundry model or deployment name in AskMate settings before asking a question.");
	}

	const response = await runtime.requestJson<Record<string, unknown>>(
		`${getAzureAIBaseUrl(provider)}/chat/completions?api-version=${AZURE_AI_INFERENCE_API_VERSION}`,
		{
			method: "POST",
			headers: getAzureAIHeaders(apiKey),
			abortSignal,
			timeoutMs: options.timeoutMs ?? DEFAULT_TEXT_GENERATION_TIMEOUT_MS,
			timeoutMessage: options.timeoutMessage ?? "Azure AI Foundry generation timed out after 2 minutes.",
			body: JSON.stringify({
				model: providerRef.model,
				messages: [
					{ role: "system", content: instructions },
					{ role: "user", content: input }
				]
			})
		}
	);
	const body = response.body;

	if (!response.ok) {
		throw new Error(formatProviderHttpError(providerRef.providerName, response.status, describeProviderErrorBody(response, [apiKey])));
	}

	return buildChatCompletionsResult(providerRef.providerName, providerRef.model, body);
}

export async function fetchAzureAIModels(runtime: ProviderRuntime): Promise<string[]> {
	const providerId = "azure-ai";
	const provider = runtime.getProviderSettings(providerId);
	const apiKey = await runtime.getProviderApiKey(providerId);

	if (!apiKey) {
		throw new Error(`Add an ${getProviderLabel(providerId)} API key before refreshing models.`);
	}

	const response = await runtime.requestJson<AzureAIModelInfoBody>(
		`${getAzureAIBaseUrl(provider)}/info?api-version=${AZURE_AI_INFERENCE_API_VERSION}`,
		{
			headers: getAzureAIHeaders(apiKey),
			timeoutMs: 10000,
			timeoutMessage: "Azure AI Foundry model refresh timed out after 10 seconds."
		}
	);
	const body = response.body;

	if (!response.ok) {
		throw new Error(formatProviderHttpError(getProviderLabel(providerId), response.status, describeProviderErrorBody(response, [apiKey])));
	}

	const modelName = body?.model_name?.trim() ?? "";
	return modelName ? [modelName] : [];
}

export async function testAzureAIConnection(runtime: ProviderRuntime): Promise<string> {
	const providerRef: ProviderModelRef = {
		providerId: "azure-ai",
		providerName: getProviderLabel("azure-ai"),
		model: runtime.getProviderSettings("azure-ai").model.trim(),
		capability: "text"
	};

	await completeAzureAIText(
		runtime,
		providerRef,
		"You are a connection test. Reply with OK.",
		"Reply with OK to confirm this Azure AI Foundry deployment works.",
		undefined,
		{
			timeoutMs: 10000,
			timeoutMessage: "Azure AI Foundry test request timed out after 10 seconds."
		}
	);

	return "AskMate Azure AI Foundry test passed. It sent a minimal text request to the selected model and may have consumed a small number of tokens.";
}
