import { parseEventJson, StreamProviderError, type StreamAdapter } from "./streaming";

export interface GeminiStreamState {
	text: string;
	finishReason: string | null;
	usageMetadata: unknown;
	promptFeedback: unknown;
}

function readChunkText(body: Record<string, unknown>): { text: string; finishReason: string | null } {
	const candidates = Array.isArray(body.candidates) ? body.candidates as unknown[] : [];
	const first = candidates[0];

	if (!first || typeof first !== "object") {
		return { text: "", finishReason: null };
	}

	const { content, finishReason } = first as { content?: unknown; finishReason?: unknown };
	const parts = content && typeof content === "object" ? (content as { parts?: unknown }).parts : null;
	const text = Array.isArray(parts)
		? parts
			.map((part: unknown) => (part && typeof part === "object" ? (part as { text?: unknown }).text : undefined))
			.filter((value): value is string => typeof value === "string")
			.join("")
		: "";

	return { text, finishReason: typeof finishReason === "string" && finishReason ? finishReason : null };
}

function hasBlockReason(feedback: unknown): boolean {
	return Boolean(feedback && typeof feedback === "object" && (feedback as { blockReason?: unknown }).blockReason);
}

export const geminiStreamAdapter: StreamAdapter<GeminiStreamState> = {
	initial: { text: "", finishReason: null, usageMetadata: null, promptFeedback: null },
	getText: (state) => state.text,
	// The final chunk carries finishReason; a prompt block arrives as promptFeedback with no candidates at all.
	isTerminal: (state) => state.finishReason !== null || hasBlockReason(state.promptFeedback),
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
