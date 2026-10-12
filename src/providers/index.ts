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
import { matchListedModel, redactSecrets } from "./common";
import { completeGeminiText, fetchGeminiModels } from "./google-gemini";
import { fetchOpenAIModels } from "./open-ai";
import { completeOpenAICompatibleText, fetchOpenAICompatibleModels } from "./open-ai-compatible";
import { completeOpenRouterText, fetchOpenRouterModels } from "./open-router";
import type { ProviderRuntime } from "./types";

export {
	describeProviderErrorBody,
	extractProviderError,
	formatProviderHttpError
} from "./common";
export {
	buildOpenAIResponsesBody,
	extractOpenAIRefusal,
	extractOpenAIText,
	getOpenAIBaseUrl,
	joinOpenAIUrl,
	normalizeOpenAIModelOptions,
	requestOpenAIImageGeneration,
	requestOpenAIResponses
} from "./open-ai";
export { streamOpenAIResponses } from "./open-ai-stream";
export type { OpenAIStreamResult } from "./open-ai-stream";
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
	abortSignal?: AbortSignal,
	onDelta?: (delta: string) => void
): Promise<ProviderTextResult> {
	if (providerRef.providerId === "openai") {
		// OpenAI text always uses Responses API via plugin streamOpenAI / requestOpenAIResponses.
		// Never fall through to OpenAI-compatible chat/completions with OpenAI settings.
		throw new Error(
			"OpenAI text requests use the Responses API. Call requestOpenAIResponses instead of completeProviderTextRequest."
		);
	}

	if (providerRef.providerId === "anthropic") {
		return await completeAnthropicText(runtime, providerRef, instructions, input, abortSignal, onDelta);
	}

	if (providerRef.providerId === "google-gemini") {
		return await completeGeminiText(runtime, providerRef, instructions, input, abortSignal, onDelta);
	}

	if (providerRef.providerId === "azure-openai") {
		return await completeAzureOpenAIText(runtime, providerRef, instructions, input, abortSignal, onDelta);
	}

	if (providerRef.providerId === "azure-ai") {
		return await completeAzureAIText(runtime, providerRef, instructions, input, abortSignal, { onDelta });
	}

	if (providerRef.providerId === "openrouter") {
		return await completeOpenRouterText(runtime, providerRef, instructions, input, abortSignal, onDelta);
	}

	if (providerRef.providerId === "openai-compatible") {
		return await completeOpenAICompatibleText(runtime, providerRef, instructions, input, abortSignal, onDelta);
	}

	// Every known provider returned above, so the id is typed never here, but a stale or hand-edited value can still arrive.
	throw new Error(`Unsupported text provider: ${String(providerRef.providerId)}`);
}

export async function fetchProviderModels(runtime: ProviderRuntime, providerId: TextProviderId): Promise<string[]> {
	switch (providerId) {
		case "openai":
			return await fetchOpenAIModels(runtime);
		case "azure-openai":
			return await fetchAzureOpenAIModels(runtime);
		case "azure-ai":
			return await fetchAzureAIModels(runtime);
		case "openrouter":
			return await fetchOpenRouterModels(runtime);
		case "anthropic":
			return await fetchAnthropicModels(runtime);
		case "google-gemini":
			return await fetchGeminiModels(runtime);
		case "openai-compatible":
			return await fetchOpenAICompatibleModels(runtime);
		default: {
			// A new provider must be wired here explicitly rather than sending its key to an OpenAI-compatible endpoint.
			const unhandled: never = providerId;
			throw new Error(`Unsupported text provider: ${String(unhandled)}`);
		}
	}
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

export interface ProviderConnectionTestResult {
	/** The endpoint answered and the key was accepted. A missing model is reported in `modelFound`, not here. */
	ok: boolean;
	/** One or two sentences for the user. On failure this is the provider error, already redacted. */
	message: string;
	/** true: the configured model is listed or answered. false: connected, but it is not offered. null: not checked. */
	modelFound: boolean | null;
	latencyMs: number;
	/** The listed model to offer instead: the nearest spelling when the model was not found, or the first one when none is set. */
	suggestedModel: string | null;
}

function describeModelCheck(
	label: string,
	model: string,
	models: readonly string[]
): Pick<ProviderConnectionTestResult, "message" | "modelFound" | "suggestedModel"> {
	const visible = `${models.length} ${models.length === 1 ? "model is" : "models are"} visible`;

	if (models.length === 0) {
		return {
			message: `AskMate ${label} connected, but it lists no models. Add or pull a model on that server, then test again.`,
			modelFound: model ? false : null,
			suggestedModel: null
		};
	}

	if (!model) {
		return {
			message: `AskMate ${label} test passed. ${visible}. No model is selected yet.`,
			modelFound: null,
			suggestedModel: models[0]
		};
	}

	const match = matchListedModel(model, models);

	if (match.found) {
		return { message: `AskMate ${label} test passed. ${visible} and ${model} is available.`, modelFound: true, suggestedModel: null };
	}

	return {
		message: `AskMate ${label} connected, but model "${model}" was not found.${match.closest ? ` Closest listed model: "${match.closest}".` : ""} ${visible}.`,
		modelFound: false,
		suggestedModel: match.closest
	};
}

/**
 * Test connection that also proves the selected model exists. Azure checks send a real request to the deployment, so a
 * pass already shows the model answers. Every other provider lists its models and looks for the configured one. Expected
 * failures (key, URL, quota) come back as `ok: false`; nothing here throws for them.
 */
export async function testProviderConnectionDetailed(
	runtime: ProviderRuntime,
	providerId: TextProviderId,
	now: () => number = Date.now
): Promise<ProviderConnectionTestResult> {
	const startedAt = now();
	const elapsed = (): number => Math.max(0, now() - startedAt);

	try {
		if (providerId === "azure-openai" || providerId === "azure-ai") {
			const message = await testProviderConnection(runtime, providerId);
			return { ok: true, message, modelFound: true, latencyMs: elapsed(), suggestedModel: null };
		}

		const models = await fetchProviderModels(runtime, providerId);
		const model = runtime.getProviderSettings(providerId).model.trim();
		return { ok: true, ...describeModelCheck(getProviderLabel(providerId), model, models), latencyMs: elapsed() };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { ok: false, message: redactSecrets(message), modelFound: null, latencyMs: elapsed(), suggestedModel: null };
	}
}
