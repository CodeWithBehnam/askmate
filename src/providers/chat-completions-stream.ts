import { DEFAULT_TEXT_GENERATION_TIMEOUT_MS } from "../shared/core";
import type { ProviderModelRef, ProviderTextResult } from "../shared/core";
import { buildChatCompletionsResult, completeChatCompletionsText, extractChatCompletionBodyError } from "./common";
import { parseEventJson, StreamProviderError, tryStreamTextResult, type StreamAdapter } from "./streaming";
import type { ProviderRuntime } from "./types";

export interface ChatStreamState {
	text: string;
	refusal: string;
	finishReason: string | null;
	usage: unknown;
	done: boolean;
}

function readFirstChoice(body: Record<string, unknown>): { delta: Record<string, unknown> | null; finishReason: string | null } {
	const choices = Array.isArray(body.choices) ? body.choices as unknown[] : [];
	const first = choices[0];

	if (!first || typeof first !== "object") {
		return { delta: null, finishReason: null };
	}

	const { delta, finish_reason: finishReason } = first as { delta?: unknown; finish_reason?: unknown };
	return {
		delta: delta && typeof delta === "object" ? delta as Record<string, unknown> : null,
		finishReason: typeof finishReason === "string" && finishReason ? finishReason : null
	};
}

export const chatCompletionsStreamAdapter: StreamAdapter<ChatStreamState> = {
	initial: { text: "", refusal: "", finishReason: null, usage: null, done: false },
	getText: (state) => state.text,
	// Some servers omit [DONE] but always report a finish reason before closing.
	isTerminal: (state) => state.done || state.finishReason !== null,
	reduce: (state, event) => {
		if (event.data.trim() === "[DONE]") {
			return { state: { ...state, done: true }, delta: "" };
		}

		const body = parseEventJson(event);
		if (!body) {
			return { state, delta: "" };
		}

		// Same rule as the buffered parser: an error at the top level or on a choice ends the reply as a failure.
		const bodyError = extractChatCompletionBodyError(body);
		if (bodyError) {
			throw new StreamProviderError(bodyError);
		}

		const { delta, finishReason } = readFirstChoice(body);
		const content = typeof delta?.content === "string" ? delta.content : "";
		const refusal = typeof delta?.refusal === "string" ? delta.refusal : "";
		const usage = body.usage && typeof body.usage === "object" ? body.usage : state.usage;

		return {
			state: {
				text: state.text + content,
				refusal: state.refusal + refusal,
				finishReason: finishReason ?? state.finishReason,
				usage,
				done: state.done
			},
			delta: content
		};
	}
};

/** Shapes the accumulated stream like a non-streamed response so buildChatCompletionsResult stays the only parser. */
export function assembleChatCompletionsBody(state: ChatStreamState): Record<string, unknown> {
	return {
		choices: [{
			message: { content: state.text, ...(state.refusal ? { refusal: state.refusal } : {}) },
			finish_reason: state.finishReason
		}],
		usage: state.usage
	};
}

export async function tryStreamChatCompletions(
	runtime: ProviderRuntime,
	{
		providerRef,
		url,
		headers,
		instructions,
		input,
		abortSignal,
		onDelta,
		includeUsage,
		idleTimeoutMs = DEFAULT_TEXT_GENERATION_TIMEOUT_MS
	}: {
		providerRef: ProviderModelRef;
		url: string;
		headers: Record<string, string>;
		instructions: string;
		input: string;
		abortSignal?: AbortSignal;
		onDelta: (delta: string) => void;
		/** Hosted providers accept stream_options; some local servers reject unknown fields, so it is opt-in. */
		includeUsage: boolean;
		idleTimeoutMs?: number;
	}
): Promise<ProviderTextResult | null> {
	return await tryStreamTextResult(runtime, {
		providerName: providerRef.providerName,
		url,
		headers,
		abortSignal,
		idleTimeoutMs,
		adapter: chatCompletionsStreamAdapter,
		onDelta,
		model: providerRef.model,
		endpoint: "chat_completions",
		assemble: assembleChatCompletionsBody,
		buildResult: (body) => buildChatCompletionsResult(providerRef.providerName, providerRef.model, body),
		body: JSON.stringify({
			model: providerRef.model,
			messages: [
				{ role: "system", content: instructions },
				{ role: "user", content: input }
			],
			stream: true,
			...(includeUsage ? { stream_options: { include_usage: true } } : {})
		})
	});
}

/** Streams when asked to and possible, otherwise uses the buffered request. */
export async function completeChatCompletionsStreaming(
	runtime: ProviderRuntime,
	params: Parameters<typeof completeChatCompletionsText>[1] & {
		onDelta?: (delta: string) => void;
		includeUsage: boolean;
	}
): Promise<ProviderTextResult> {
	if (params.onDelta) {
		const streamed = await tryStreamChatCompletions(runtime, {
			providerRef: params.providerRef,
			url: `${params.baseUrl}/chat/completions`,
			headers: params.headers,
			instructions: params.instructions,
			input: params.input,
			abortSignal: params.abortSignal,
			onDelta: params.onDelta,
			includeUsage: params.includeUsage
		});

		if (streamed) {
			return streamed;
		}
	}

	return await completeChatCompletionsText(runtime, params);
}
