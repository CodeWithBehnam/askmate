import { createAbortError } from "../settings/normalize";
import { formatTimeoutDuration } from "./common";
import { feedSse, flushSse, INITIAL_SSE_STATE, type SseEvent } from "./sse";

export interface SseRequestInit {
	method?: string;
	headers?: Record<string, string>;
	body?: string;
	abortSignal?: AbortSignal;
	/** Maximum silence between chunks, not a limit on the whole reply. */
	idleTimeoutMs?: number;
}

export type SseTransportOutcome =
	/**
	 * fetch failed before any response arrived (a network error, CORS or TLS). The request may or may not have reached
	 * the server, and a browser reports both the same way, so a caller that retries on the buffered path accepts a small
	 * risk of the same prompt being sent twice. That trade keeps endpoints without CORS support working.
	 */
	| { kind: "unavailable"; reason: string }
	/** The server answered with an error status, a plain JSON body or a page instead of a stream. */
	| { kind: "response"; status: number; ok: boolean; text: string }
	| { kind: "streamed" };

export type FetchLike = (url: string, init: {
	method: string;
	headers?: Record<string, string>;
	body?: string;
	signal: AbortSignal;
}) => Promise<Response>;

/** Names the limit in the unit it was set in. A limit under a second is not rounded down to "0 seconds". */
export function formatIdleDuration(idleMs: number): string {
	return idleMs < 1000 ? `${Math.max(0, Math.round(idleMs))} ms` : formatTimeoutDuration(idleMs);
}

export class StreamIdleError extends Error {
	constructor(idleMs: number) {
		super(`The connection went quiet for ${formatIdleDuration(idleMs)}, so AskMate stopped waiting.`);
		this.name = "StreamIdleError";
	}
}

/** Only a body labelled text/event-stream is read live. Anything else is read whole and then looked at. */
function isEventStream(response: Response): boolean {
	return response.ok && Boolean(response.body) && /text\/event-stream/i.test(response.headers.get("content-type") ?? "");
}

/** A body that starts like SSE (a data or event field, or a comment) is a stream whatever its Content-Type says. */
export function looksLikeSse(text: string): boolean {
	return /^\s*(?:data:|event:|:)/.test(text);
}

function looksLikeJsonObject(text: string): boolean {
	const trimmed = text.trim();

	if (!trimmed.startsWith("{")) {
		return false;
	}

	try {
		const parsed: unknown = JSON.parse(trimmed);
		return Boolean(parsed) && typeof parsed === "object" && !Array.isArray(parsed);
	} catch {
		return false;
	}
}

/** Realm-safe: a TypeError raised in a popout window is not an instance of this window's TypeError. */
function isNetworkFailure(error: unknown): boolean {
	return error instanceof Error && error.name === "TypeError";
}

/**
 * POSTs and reads a Server-Sent Events body. Aborting `abortSignal` cancels the HTTP request itself.
 * Throws the abort error on abort, StreamIdleError on silence, and any error thrown by `onEvent`.
 */
export async function fetchSse(
	fetchFn: FetchLike,
	url: string,
	init: SseRequestInit,
	onEvent: (event: SseEvent) => void
): Promise<SseTransportOutcome> {
	if (init.abortSignal?.aborted) {
		throw createAbortError();
	}

	const controller = new AbortController();
	const forwardAbort = (): void => controller.abort();
	init.abortSignal?.addEventListener("abort", forwardAbort, { once: true });
	let idleTimer: number | null = null;
	let idleFired = false;
	const armIdleTimer = (): void => {
		if (idleTimer !== null) {
			window.clearTimeout(idleTimer);
		}
		if (init.idleTimeoutMs && init.idleTimeoutMs > 0) {
			idleTimer = window.setTimeout(() => {
				idleFired = true;
				controller.abort();
			}, init.idleTimeoutMs);
		}
	};
	const classify = (error: unknown): Error => {
		if (init.abortSignal?.aborted) {
			return createAbortError();
		}
		if (idleFired) {
			return new StreamIdleError(init.idleTimeoutMs ?? 0);
		}
		return error instanceof Error ? error : new Error(String(error));
	};

	/**
	 * Reads the body chunk by chunk. The idle timer restarts before every read, so silence is measured from the last
	 * byte (or, for the first read, from the response headers) and not from when the request was sent.
	 */
	const readBody = async (response: Response, onText: (text: string) => void): Promise<void> => {
		if (!response.body) {
			try {
				onText(await response.text());
			} catch (error) {
				throw classify(error);
			}
			return;
		}

		const reader = response.body.getReader();
		const decoder = new TextDecoder("utf-8");

		try {
			for (;;) {
				// A handler may abort between chunks; do not rely on the stream erroring promptly.
				if (init.abortSignal?.aborted) {
					throw createAbortError();
				}
				armIdleTimer();
				const { done, value } = await reader.read();
				if (done) {
					break;
				}
				onText(decoder.decode(value, { stream: true }));
			}
			// The final decode flushes bytes of a multi-byte character the server cut off.
			onText(decoder.decode());
		} catch (error) {
			await reader.cancel().catch(() => undefined);
			throw classify(error);
		}
	};

	try {
		armIdleTimer();
		let response: Response;
		try {
			response = await fetchFn(url, {
				method: init.method ?? "POST",
				headers: init.headers,
				body: init.body,
				signal: controller.signal
			});
		} catch (error) {
			if (init.abortSignal?.aborted || idleFired) {
				throw classify(error);
			}
			// Only a network-level failure means no answer arrived. Anything else is a real error, and retrying it
			// on the buffered path could send the prompt a second time for nothing.
			if (isNetworkFailure(error)) {
				return { kind: "unavailable", reason: error instanceof Error ? error.message : String(error) };
			}
			throw classify(error);
		}

		if (!isEventStream(response)) {
			// Error statuses, JSON bodies and pages are read whole, with the same idle and abort handling as a stream.
			let text = "";
			await readBody(response, (chunk) => {
				text += chunk;
			});

			// A gateway that labels its SSE bytes as JSON (or sends no type at all) is still a stream.
			if (response.ok && looksLikeSse(text)) {
				let sniffed = INITIAL_SSE_STATE;
				const fed = feedSse(sniffed, text);
				sniffed = fed.state;
				fed.events.forEach(onEvent);
				flushSse(sniffed).forEach(onEvent);
				return { kind: "streamed" };
			}

			return { kind: "response", status: response.status, ok: response.ok, text };
		}

		let state = INITIAL_SSE_STATE;
		let eventCount = 0;
		// Kept only until the first event arrives, so a real stream never accumulates its whole body.
		let rawHead = "";
		const dispatch = (events: SseEvent[]): void => {
			eventCount += events.length;
			events.forEach(onEvent);
		};

		await readBody(response, (chunk) => {
			if (eventCount === 0) {
				rawHead += chunk;
			}
			const fed = feedSse(state, chunk);
			state = fed.state;
			dispatch(fed.events);
			if (eventCount > 0) {
				rawHead = "";
			}
		});
		dispatch(flushSse(state));

		// A server that labels a plain JSON reply as an event stream sent no events. That reply is read as JSON.
		if (eventCount === 0 && looksLikeJsonObject(rawHead)) {
			return { kind: "response", status: response.status, ok: response.ok, text: rawHead };
		}

		return { kind: "streamed" };
	} finally {
		if (idleTimer !== null) {
			window.clearTimeout(idleTimer);
		}
		init.abortSignal?.removeEventListener("abort", forwardAbort);
	}
}
