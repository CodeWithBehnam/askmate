import {
	ApiEndpoint,
	getProviderLabel,
	ProviderModelRef,
	ProviderTextResult,
	TextProviderId
} from "../shared/core";
import { completeAnthropicText, fetchAnthropicModels } from "./anthropic";
import { completeAzureAIText, fetchAzureAIModels, testAzureAIConnection } from "./azure-ai";
import { completeAzureOpenAIText, fetchAzureOpenAIModels, testAzureOpenAIConnection } from "./azure-open-ai";
import { completeGeminiText, fetchGeminiModels } from "./google-gemini";
import { fetchOpenAIModels } from "./open-ai";
import { completeOpenAICompatibleText, fetchOpenAICompatibleModels } from "./open-ai-compatible";
import { completeOpenRouterText, fetchOpenRouterModels } from "./open-router";
import type { ProviderRuntime } from "./types";

export {
	extractProviderError,
	formatProviderHttpError
} from "./common";
export {
	extractOpenAIText,
	getOpenAIBaseUrl,
	joinOpenAIUrl,
	normalizeOpenAIModelOptions,
	requestOpenAIImageGeneration,
	requestOpenAIResponses
} from "./open-ai";
// Stream helpers are quarantined in open-ai-stream.ts (not live path).
export type {
	ProviderRequestOptions,
	ProviderRuntime
} from "./types";

export function getProviderTextEndpoint(providerId: TextProviderId): ApiEndpoint {
	if (providerId === "openai") {
		return "responses";
	}

	if (providerId === "anthropic") {
		return "anthropic_messages";
	}

	if (providerId === "google-gemini") {
		return "gemini_generate_content";
	}

	return "chat_completions";
}

export async function completeProviderTextRequest(
	runtime: ProviderRuntime,
	providerRef: ProviderModelRef,
	instructions: string,
	input: string,
	abortSignal?: AbortSignal
): Promise<ProviderTextResult> {
	if (providerRef.providerId === "openai") {
		// OpenAI text always uses Responses API via plugin streamOpenAI / requestOpenAIResponses.
		// Never fall through to OpenAI-compatible chat/completions with OpenAI settings.
		throw new Error(
			"OpenAI text requests use the Responses API. Call requestOpenAIResponses instead of completeProviderTextRequest."
		);
	}

	if (providerRef.providerId === "anthropic") {
		return await completeAnthropicText(runtime, providerRef, instructions, input, abortSignal);
	}

	if (providerRef.providerId === "google-gemini") {
		return await completeGeminiText(runtime, providerRef, instructions, input, abortSignal);
	}

	if (providerRef.providerId === "azure-openai") {
		return await completeAzureOpenAIText(runtime, providerRef, instructions, input, abortSignal);
	}

	if (providerRef.providerId === "azure-ai") {
		return await completeAzureAIText(runtime, providerRef, instructions, input, abortSignal);
	}

	if (providerRef.providerId === "openrouter") {
		return await completeOpenRouterText(runtime, providerRef, instructions, input, abortSignal);
	}

	if (providerRef.providerId === "openai-compatible") {
		return await completeOpenAICompatibleText(runtime, providerRef, instructions, input, abortSignal);
	}

	throw new Error(`Unsupported text provider: ${providerRef.providerId}`);
}

export async function fetchProviderModels(runtime: ProviderRuntime, providerId: TextProviderId): Promise<string[]> {
	if (providerId === "openai") {
		return await fetchOpenAIModels(runtime);
	}

	if (providerId === "azure-openai") {
		return await fetchAzureOpenAIModels(runtime);
	}

	if (providerId === "azure-ai") {
		return await fetchAzureAIModels(runtime);
	}

	if (providerId === "openrouter") {
		return await fetchOpenRouterModels(runtime);
	}

	if (providerId === "anthropic") {
		return await fetchAnthropicModels(runtime);
	}

	if (providerId === "google-gemini") {
		return await fetchGeminiModels(runtime);
	}

	return await fetchOpenAICompatibleModels(runtime);
}

export async function testProviderConnection(runtime: ProviderRuntime, providerId: TextProviderId): Promise<string> {
	if (providerId === "azure-openai") {
		return await testAzureOpenAIConnection(runtime);
	}

	if (providerId === "azure-ai") {
		return await testAzureAIConnection(runtime);
	}

	const models = await fetchProviderModels(runtime, providerId);
	return `AskMate ${getProviderLabel(providerId)} test passed. ${models.length} models are visible.`;
}
