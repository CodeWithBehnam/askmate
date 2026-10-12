/**
 * OpenAI Responses streaming. Deltas come from `response.output_text.delta`; the terminal
 * `response.completed`, `response.incomplete` and `response.failed` events carry the full response object,
 * which is handed to the same parser as a buffered reply. SSE framing is decoded in sse.ts.
 */
import type {
	AskMateHttpResponse,
	OpenAIResponseBody,
	ReasoningEffort
} from "../shared/core";
import { redactSecrets } from "./common";
import { buildOpenAIResponsesBody, extractOpenAIText, getOpenAIBaseUrl, getOpenAIGenerationTimeoutMs, joinOpenAIUrl } from "./open-ai";
import { parseEventJson, runTextStream, STREAM_INTERRUPTED_REASON, StreamProviderError, type StreamAdapter } from "./streaming";
import type { ProviderRuntime } from "./types";

export interface OpenAIResponsesStreamState {
	text: string;
	/** The full response object from the terminal event. */
	final: OpenAIResponseBody | null;
}

const OPENAI_TERMINAL_EVENTS = new Set(["response.completed", "response.incomplete", "response.failed"]);

export const openAIResponsesStreamAdapter: StreamAdapter<OpenAIResponsesStreamState> = {
	initial: { text: "", final: null },
	getText: (state) => state.text,
	isTerminal: (state) => state.final !== null,
	reduce: (state, event) => {
		const body = parseEventJson(event);
		const type = body?.type;

		if (!body || typeof type !== "string") {
			return { state, delta: "" };
		}

		if (type === "response.output_text.delta" && typeof body.delta === "string") {
			return { state: { ...state, text: state.text + body.delta }, delta: body.delta };
		}

		if (OPENAI_TERMINAL_EVENTS.has(type) && body.response && typeof body.response === "object") {
			return { state: { ...state, final: body.response }, delta: "" };
		}

		if (type === "error") {
			const message = typeof body.message === "string" ? body.message.trim() : "";
			throw new StreamProviderError(message || "The provider reported an error.");
		}

		return { state, delta: "" };
	}
};

export type OpenAIStreamResult =
	| { kind: "unavailable" }
	| { kind: "buffered"; response: AskMateHttpResponse<OpenAIResponseBody> }
	/** A response-shaped body for readOpenAIResponseText; `streamError` is set when the stream broke after text arrived. */
	| { kind: "body"; body: OpenAIResponseBody; streamError?: string };

function interruptedBody(text: string): OpenAIResponseBody {
	return { output_text: text, status: "incomplete", incomplete_details: { reason: STREAM_INTERRUPTED_REASON } };
}

/** Turns the final stream state into a body for the existing parser, keeping streamed text if the terminal object lacks it. */
export function assembleOpenAIResponsesBody(state: OpenAIResponsesStreamState): OpenAIStreamResult {
	const final = state.final;

	if (!final) {
		return { kind: "body", body: interruptedBody(state.text), streamError: "OpenAI closed the connection before the reply finished." };
	}

	if (final.status === "failed" && state.text) {
		const detail = final.error?.message?.trim();
		return { kind: "body", body: interruptedBody(state.text), streamError: detail ? `OpenAI could not complete the response. Provider message: ${detail}` : "OpenAI could not complete the response." };
	}

	const body = state.text && !extractOpenAIText(final) ? { ...final, output_text: state.text } : final;
	return { kind: "body", body };
}

export async function streamOpenAIResponses(
	runtime: ProviderRuntime,
	{
		apiKey,
		model,
		instructions,
		input,
		reasoningEffort,
		abortSignal,
		onDelta
	}: {
		apiKey: string;
		model: string;
		instructions: string;
		input: string;
		reasoningEffort: ReasoningEffort;
		abortSignal?: AbortSignal;
		onDelta: (delta: string) => void;
	}
): Promise<OpenAIStreamResult> {
	const outcome = await runTextStream(runtime, {
		providerName: "OpenAI",
		url: joinOpenAIUrl(getOpenAIBaseUrl(runtime), "responses"),
		headers: {
			Authorization: `Bearer ${apiKey}`,
			"Content-Type": "application/json"
		},
		body: JSON.stringify({ ...buildOpenAIResponsesBody({ model, instructions, input, reasoningEffort }), stream: true }),
		abortSignal,
		// Same scaling as the buffered limit. Keep-alive events normally reset the idle timer, but a gateway that drops
		// them would otherwise cut a long reasoning run off, so the margin follows the effort.
		idleTimeoutMs: getOpenAIGenerationTimeoutMs(model, reasoningEffort),
		adapter: openAIResponsesStreamAdapter,
		onDelta
	});

	switch (outcome.kind) {
		case "unavailable":
			return outcome;
		case "buffered":
			return { kind: "buffered", response: outcome.response };
		case "complete": {
			const assembled = assembleOpenAIResponsesBody(outcome.state);
			// The provider's failure text is stored in usage history, so it gets the same redaction as HTTP errors.
			return assembled.kind === "body" && assembled.streamError
				? { ...assembled, streamError: redactSecrets(assembled.streamError, [apiKey]) }
				: assembled;
		}
		case "interrupted":
			return { kind: "body", body: interruptedBody(outcome.state.text), streamError: outcome.message };
		default: {
			const unhandled: never = outcome;
			throw new Error(`Unhandled stream outcome: ${String(unhandled)}`);
		}
	}
}
