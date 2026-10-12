import { getNonNegativeInteger, type OpenAITokenUsage } from "../shared/core";
import { parseEventJson, StreamProviderError, type StreamAdapter } from "./streaming";

export interface AnthropicStreamState {
	text: string;
	stopReason: string | null;
	usage: Record<string, unknown>;
	done: boolean;
}

function readRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function normalizeAnthropicUsage(value: unknown): OpenAITokenUsage | null {
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

export const anthropicStreamAdapter: StreamAdapter<AnthropicStreamState> = {
	initial: { text: "", stopReason: null, usage: {}, done: false },
	getText: (state) => state.text,
	// message_delta carries the stop reason and message_stop follows at once, so a connection that closes in between
	// has still delivered the whole reply. The buffered parser classifies max_tokens and refusal from the stop reason.
	isTerminal: (state) => state.done || state.stopReason !== null,
	getUsage: (state) => {
		// Before message_delta, output_tokens in message_start is only a placeholder, so only the input side is real.
		if (state.stopReason !== null) {
			return normalizeAnthropicUsage(state.usage);
		}

		const inputTokens = getNonNegativeInteger(state.usage.input_tokens);
		return inputTokens === null ? null : { input_tokens: inputTokens };
	},
	reduce: (state, event) => {
		const body = parseEventJson(event);
		if (!body) {
			return { state, delta: "" };
		}

		switch (body.type) {
			case "message_start": {
				// input_tokens arrives here; output_tokens is only a placeholder until message_delta.
				const usage = readRecord(readRecord(body.message).usage);
				return { state: { ...state, usage: { ...state.usage, ...usage } }, delta: "" };
			}
			case "content_block_start": {
				// The buffered parser joins text blocks with a newline, so a second text block starts on a new line here too.
				const isText = readRecord(body.content_block).type === "text";
				const separator = isText && state.text ? "\n" : "";
				return { state: { ...state, text: state.text + separator }, delta: separator };
			}
			case "content_block_delta": {
				const delta = readRecord(body.delta);
				const text = delta.type === "text_delta" && typeof delta.text === "string" ? delta.text : "";
				return { state: { ...state, text: state.text + text }, delta: text };
			}
			case "message_delta": {
				const stopReason = readRecord(body.delta).stop_reason;
				return {
					state: {
						...state,
						stopReason: typeof stopReason === "string" && stopReason ? stopReason : state.stopReason,
						// message_delta usage is cumulative, so its fields replace the earlier ones.
						usage: { ...state.usage, ...readRecord(body.usage) }
					},
					delta: ""
				};
			}
			case "message_stop":
				return { state: { ...state, done: true }, delta: "" };
			case "error": {
				const message = readRecord(body.error).message;
				throw new StreamProviderError(typeof message === "string" && message.trim() ? message.trim() : "The provider reported an error.");
			}
			default:
				return { state, delta: "" };
		}
	}
};

/** Shapes the accumulated stream like a non-streamed Messages response so the buffered parser stays the only one. */
export function assembleAnthropicBody(state: AnthropicStreamState): Record<string, unknown> {
	return {
		content: [{ type: "text", text: state.text }],
		stop_reason: state.stopReason,
		usage: state.usage
	};
}
