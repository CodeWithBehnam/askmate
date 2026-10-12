import type { AskMateHttpResponse, ApiEndpoint, OpenAITokenUsage, ProviderTextResult } from "../shared/core";
import { isAbortError } from "../shared/core";
import {
	describeProviderErrorBody,
	formatProviderHttpError,
	getSecretHeaderValues,
	redactSecrets
} from "./common";
import type { SseEvent } from "./sse";
import type { ProviderRuntime } from "./types";

export const STREAM_INTERRUPTED_REASON = "stream_interrupted";

/** A provider-reported failure inside an otherwise healthy stream (an `error` event). */
export class StreamProviderError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "StreamProviderError";
	}
}

/** Per-provider event handling, kept pure so it can be tested without a network. */
export interface StreamAdapter<S> {
	initial: S;
	reduce: (state: S, event: SseEvent) => { state: S; delta: string };
	getText: (state: S) => string;
	/** True once the provider signalled the end of the reply, so a closed connection is a normal finish. */
	isTerminal: (state: S) => boolean;
	/** Usage the provider had already reported, kept when the stream breaks so tokens that were billed are not lost. */
	getUsage?: (state: S) => OpenAITokenUsage | null;
}

export type TextStreamOutcome<S> =
	| { kind: "unavailable" }
	/** The server ignored the stream request and answered with one JSON body. */
	| { kind: "buffered"; response: AskMateHttpResponse<Record<string, unknown>> }
	| { kind: "complete"; state: S }
	| { kind: "interrupted"; state: S; message: string };

function parseJsonObject(text: string): Record<string, unknown> | null {
	try {
		const parsed: unknown = JSON.parse(text);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
	} catch {
		return null;
	}
}

function looksLikeHtml(text: string): boolean {
	return /^\s*<(?:!doctype\s+html|html|head|body)\b/i.test(text);
}

/** Parses an SSE `data:` payload; non-JSON payloads (keep-alives, truncated tails) are ignored by the adapters. */
export function parseEventJson(event: SseEvent): Record<string, unknown> | null {
	return parseJsonObject(event.data);
}

export interface TextStreamRequest<S> {
	providerName: string;
	url: string;
	headers: Record<string, string>;
	body: string;
	abortSignal?: AbortSignal;
	idleTimeoutMs: number;
	adapter: StreamAdapter<S>;
	onDelta: (delta: string) => void;
}

/**
 * Runs one streamed request. HTTP error statuses throw with the same wording as the buffered path and are never
 * retried; only a failure before any response arrives reports "unavailable" so the caller can fall back.
 */
export async function runTextStream<S>(runtime: ProviderRuntime, request: TextStreamRequest<S>): Promise<TextStreamOutcome<S>> {
	const { adapter, providerName } = request;

	if (!runtime.streamSse) {
		return { kind: "unavailable" };
	}

	const secrets = getSecretHeaderValues(request.headers);
	let state = adapter.initial;
	const onEvent = (event: SseEvent): void => {
		const next = adapter.reduce(state, event);
		state = next.state;
		if (next.delta) {
			request.onDelta(next.delta);
		}
	};
	let outcome;

	try {
		outcome = await runtime.streamSse(request.url, {
			method: "POST",
			headers: request.headers,
			body: request.body,
			abortSignal: request.abortSignal,
			idleTimeoutMs: request.idleTimeoutMs
		}, onEvent);
	} catch (error) {
		if (isAbortError(error)) {
			throw error;
		}

		const raw = error instanceof Error ? error.message : String(error);
		const message = redactSecrets(error instanceof StreamProviderError ? `${providerName} stream error: ${raw}` : raw, secrets);

		if (adapter.getText(state)) {
			return { kind: "interrupted", state, message };
		}

		throw new Error(message);
	}

	if (outcome.kind === "unavailable") {
		return { kind: "unavailable" };
	}

	if (outcome.kind === "response") {
		const response: AskMateHttpResponse<Record<string, unknown>> = {
			status: outcome.status,
			ok: outcome.ok,
			body: parseJsonObject(outcome.text),
			text: outcome.text
		};

		if (!response.ok) {
			throw new Error(formatProviderHttpError(providerName, response.status, describeProviderErrorBody(response, secrets)));
		}

		if (!response.text.trim()) {
			throw new Error(`${providerName} closed the connection without sending a reply.`);
		}

		// A 200 that is neither JSON nor a stream is not a reply. Say what it was instead of reporting an empty answer.
		if (!response.body) {
			const excerpt = describeProviderErrorBody(response, secrets);
			const detail = excerpt ? ` What it sent: ${excerpt}` : "";
			throw new Error(looksLikeHtml(response.text)
				? `${providerName} answered with a web page instead of a reply. A proxy, a captive portal or a wrong base URL is probably in the way. Check the base URL and your network.${detail}`
				: `${providerName} returned something that is not a reply. Check the base URL.${detail}`);
		}

		return { kind: "buffered", response };
	}

	if (adapter.isTerminal(state)) {
		return { kind: "complete", state };
	}

	if (adapter.getText(state)) {
		return { kind: "interrupted", state, message: `${providerName} closed the connection before the reply finished.` };
	}

	throw new Error(`${providerName} closed the connection without sending a reply.`);
}

export function buildInterruptedResult(
	model: string,
	endpoint: ApiEndpoint,
	text: string,
	message: string,
	usage: OpenAITokenUsage | null = null
): ProviderTextResult {
	return {
		text,
		model,
		endpoint,
		usage,
		incompleteReason: STREAM_INTERRUPTED_REASON,
		streamError: message
	};
}

/**
 * Streams a reply and converts it into the same result the buffered path would give. A stream that ends well is
 * assembled into a response-shaped body and handed to the provider's existing parser, so incomplete detection and
 * usage have one implementation. Returns null when the caller should use the buffered request instead.
 */
export async function tryStreamTextResult<S>(
	runtime: ProviderRuntime,
	request: TextStreamRequest<S> & {
		model: string;
		endpoint: ApiEndpoint;
		assemble: (state: S) => Record<string, unknown>;
		buildResult: (body: Record<string, unknown> | null) => ProviderTextResult;
	}
): Promise<ProviderTextResult | null> {
	const outcome = await runTextStream(runtime, request);

	switch (outcome.kind) {
		case "unavailable":
			return null;
		case "buffered":
			return request.buildResult(outcome.response.body);
		case "complete":
			return request.buildResult(request.assemble(outcome.state));
		case "interrupted":
			return buildInterruptedResult(
				request.model,
				request.endpoint,
				request.adapter.getText(outcome.state),
				outcome.message,
				request.adapter.getUsage?.(outcome.state) ?? null
			);
		default: {
			const unhandled: never = outcome;
			throw new Error(`Unhandled stream outcome: ${String(unhandled)}`);
		}
	}
}
