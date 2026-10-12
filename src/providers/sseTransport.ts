import { createAbortError } from "../settings/normalize";
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
	/** fetch failed before any response arrived (network, CORS, TLS); the caller can safely use the buffered path. */
	| { kind: "unavailable"; reason: string }
	/** The server answered with an error status or a plain JSON body instead of a stream. */
	| { kind: "response"; status: number; ok: boolean; text: string }
	| { kind: "streamed" };

export type FetchLike = (url: string, init: {
	method: string;
	headers?: Record<string, string>;
	body?: string;
	signal: AbortSignal;
}) => Promise<Response>;

export class StreamIdleError extends Error {
	constructor(idleMs: number) {
		super(`The connection went quiet for ${Math.round(idleMs / 1000)} seconds, so AskMate stopped waiting.`);
		this.name = "StreamIdleError";
	}
}

function isStreamBody(response: Response): boolean {
	// A server that ignores `stream: true` answers with JSON; that body is parsed by the buffered path instead.
	const contentType = response.headers.get("content-type") ?? "";
	return response.ok && Boolean(response.body) && !/json/i.test(contentType);
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
			return { kind: "unavailable", reason: error instanceof Error ? error.message : String(error) };
		}

		if (!isStreamBody(response)) {
			const text = await response.text();
			return { kind: "response", status: response.status, ok: response.ok, text };
		}

		const reader = (response.body as ReadableStream<Uint8Array>).getReader();
		const decoder = new TextDecoder("utf-8");
		let state = INITIAL_SSE_STATE;

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
				const fed = feedSse(state, decoder.decode(value, { stream: true }));
				state = fed.state;
				fed.events.forEach(onEvent);
			}
			// The final decode flushes bytes of a multi-byte character the server cut off.
			const last = feedSse(state, decoder.decode());
			last.events.forEach(onEvent);
			flushSse(last.state).forEach(onEvent);
		} catch (error) {
			await reader.cancel().catch(() => undefined);
			throw classify(error);
		}

		return { kind: "streamed" };
	} finally {
		if (idleTimer !== null) {
			window.clearTimeout(idleTimer);
		}
		init.abortSignal?.removeEventListener("abort", forwardAbort);
	}
}
