/**
 * OpenAI Responses streaming. Deltas come from `response.output_text.delta`; the terminal
 * `response.completed`, `response.incomplete` and `response.failed` events carry the full response object,
 * which is handed to the same parser as a buffered reply. The line-level helpers below are older and only
 * used by tests; the live path decodes SSE through sse.ts.
 */
import type {
	AskMateHttpResponse,
	OpenAIResponseBody,
	OpenAIStreamEvent,
	OpenAITokenUsage,
	ReasoningEffort
} from "../shared/core";
import { DEFAULT_TEXT_GENERATION_TIMEOUT_MS } from "../shared/core";
import { redactSecrets } from "./common";
import { buildOpenAIResponsesBody, extractOpenAIText, getOpenAIBaseUrl, joinOpenAIUrl } from "./open-ai";
import { parseEventJson, runTextStream, STREAM_INTERRUPTED_REASON, StreamProviderError, type StreamAdapter } from "./streaming";
import type { ProviderRuntime } from "./types";

export function parseOpenAIStreamEvent(line: string): OpenAIStreamEvent | null {
	// SSE allows "data:" with or without a following space.
	const match = /^data:\s?(.*)$/.exec(line);
	if (!match) {
		return null;
	}

	const payload = match[1].trim();

	if (!payload || payload === "[DONE]") {
		return null;
	}

	try {
		const event = JSON.parse(payload) as OpenAIStreamEvent;

		if (event.error?.message) {
			throw new Error(event.error.message);
		}

		// Responses API "error" events put the message at the top level, not under `error`.
		const topLevelMessage = "message" in event ? event.message : undefined;
		if (event.type === "error") {
			throw new Error(typeof topLevelMessage === "string" && topLevelMessage.trim() ? topLevelMessage.trim() : "OpenAI stream error.");
		}

		return event;
	} catch (error) {
		if (error instanceof Error) {
			throw error;
		}
	}

	return null;
}

export function getOpenAIStreamDelta(event: OpenAIStreamEvent): string {
	if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
		return event.delta;
	}

	return "";
}

export function getOpenAIStreamUsage(event: OpenAIStreamEvent): OpenAITokenUsage | null {
	return event.response?.usage ?? event.usage ?? null;
}

export function isCompletedOpenAIStreamEvent(event: OpenAIStreamEvent): boolean {
	return event.type === "response.completed" || event.response?.status === "completed";
}

export function getOpenAIStreamTerminalError(event: OpenAIStreamEvent): string | null {
	const responseError = event.response?.error?.message?.trim();

	if (responseError) {
		return responseError;
	}

	if (event.type === "response.failed" || event.response?.status === "failed") {
		return "OpenAI response failed.";
	}

	if (event.type === "response.incomplete" || event.response?.status === "incomplete") {
		const reason = event.response?.incomplete_details?.reason?.trim();
		return reason ? `OpenAI response incomplete: ${reason}.` : "OpenAI response incomplete.";
	}

	return null;
}

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
			return { state: { ...state, final: body.response as OpenAIResponseBody }, delta: "" };
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
		idleTimeoutMs: DEFAULT_TEXT_GENERATION_TIMEOUT_MS,
		adapter: openAIResponsesStreamAdapter,
		onDelta
	});

	switch (outcome.kind) {
		case "unavailable":
			return outcome;
		case "buffered":
			return { kind: "buffered", response: outcome.response as AskMateHttpResponse<OpenAIResponseBody> };
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
