import { getNonNegativeInteger, type OpenAITokenUsage } from "../shared/core";
import { parseEventJson, StreamProviderError, type StreamAdapter } from "./streaming";

export interface GeminiStreamState {
	text: string;
	finishReason: string | null;
	usageMetadata: unknown;
	promptFeedback: unknown;
}

function readFirstCandidate(body: Record<string, unknown> | null): { content?: unknown; finishReason?: unknown } | null {
	const candidates = Array.isArray(body?.candidates) ? body.candidates as unknown[] : [];
	const first = candidates[0];
	return first && typeof first === "object" ? first : null;
}

/**
 * Text of the first candidate: parts are joined with no separator (one reply is split across parts at arbitrary
 * points) and thought summaries are skipped. Shared by the buffered parser and the stream adapter so they cannot drift.
 */
export function readGeminiCandidateText(body: Record<string, unknown> | null): string {
	const content = readFirstCandidate(body)?.content;
	const parts = content && typeof content === "object" ? (content as { parts?: unknown }).parts : null;

	if (!Array.isArray(parts)) {
		return "";
	}

	return parts
		.map((part: unknown) => {
			if (!part || typeof part !== "object") {
				return "";
			}

			const { text, thought } = part as { text?: unknown; thought?: unknown };
			return thought === true || typeof text !== "string" ? "" : text;
		})
		.join("");
}

function readChunkText(body: Record<string, unknown>): { text: string; finishReason: string | null } {
	const finishReason = readFirstCandidate(body)?.finishReason;
	return { text: readGeminiCandidateText(body), finishReason: typeof finishReason === "string" && finishReason ? finishReason : null };
}

/**
 * The reason a prompt was blocked, or null. An empty value and the proto3 default BLOCK_REASON_UNSPECIFIED mean "not
 * blocked". The buffered parser and the stream adapter share this so a truncated stream is never mistaken for a block.
 */
export function getGeminiPromptBlockReason(body: Record<string, unknown> | null): string | null {
	const feedback = body?.promptFeedback;
	const blockReason = feedback && typeof feedback === "object"
		? (feedback as { blockReason?: unknown }).blockReason
		: null;

	return typeof blockReason === "string" && blockReason && blockReason !== "BLOCK_REASON_UNSPECIFIED" ? blockReason : null;
}

/** Thinking tokens are billed as output but reported apart from candidate tokens. */
export function normalizeGeminiUsage(value: unknown): OpenAITokenUsage | null {
	if (!value || typeof value !== "object") {
		return null;
	}

	const usage = value as {
		promptTokenCount?: unknown;
		candidatesTokenCount?: unknown;
		thoughtsTokenCount?: unknown;
		totalTokenCount?: unknown;
	};
	const inputTokens = getNonNegativeInteger(usage.promptTokenCount);
	const candidateTokens = getNonNegativeInteger(usage.candidatesTokenCount);
	const thoughtTokens = getNonNegativeInteger(usage.thoughtsTokenCount);
	const outputTokens = candidateTokens === null && thoughtTokens === null
		? null
		: (candidateTokens ?? 0) + (thoughtTokens ?? 0);
	const totalTokens = getNonNegativeInteger(usage.totalTokenCount);

	return {
		input_tokens: inputTokens ?? undefined,
		output_tokens: outputTokens ?? undefined,
		total_tokens: totalTokens ?? undefined,
		...(thoughtTokens !== null ? { output_tokens_details: { reasoning_tokens: thoughtTokens } } : {})
	};
}

export const geminiStreamAdapter: StreamAdapter<GeminiStreamState> = {
	initial: { text: "", finishReason: null, usageMetadata: null, promptFeedback: null },
	getText: (state) => state.text,
	// Later chunks carry running totals, so what arrived before a break is still real usage.
	getUsage: (state) => normalizeGeminiUsage(state.usageMetadata),
	// The final chunk carries finishReason; a prompt block arrives as promptFeedback with no candidates at all.
	isTerminal: (state) => state.finishReason !== null || getGeminiPromptBlockReason({ promptFeedback: state.promptFeedback }) !== null,
	reduce: (state, event) => {
		const body = parseEventJson(event);
		if (!body) {
			return { state, delta: "" };
		}

		if (body.error && typeof body.error === "object") {
			const message = (body.error as { message?: unknown }).message;
			throw new StreamProviderError(typeof message === "string" && message.trim() ? message.trim() : "The provider reported an error.");
		}

		const { text, finishReason } = readChunkText(body);
		return {
			state: {
				text: state.text + text,
				finishReason: finishReason ?? state.finishReason,
				// Later chunks carry running totals, so the last one present wins.
				usageMetadata: body.usageMetadata && typeof body.usageMetadata === "object" ? body.usageMetadata : state.usageMetadata,
				promptFeedback: body.promptFeedback && typeof body.promptFeedback === "object" ? body.promptFeedback : state.promptFeedback
			},
			delta: text
		};
	}
};

/** Shapes the accumulated stream like a non-streamed generateContent response for the existing parser. */
export function assembleGeminiBody(state: GeminiStreamState): Record<string, unknown> {
	return {
		candidates: [{
			content: { parts: [{ text: state.text }] },
			finishReason: state.finishReason ?? undefined
		}],
		usageMetadata: state.usageMetadata,
		...(state.promptFeedback ? { promptFeedback: state.promptFeedback } : {})
	};
}
