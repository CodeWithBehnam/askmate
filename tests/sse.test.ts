import { describe, expect, test } from "bun:test";
import { feedSse, flushSse, INITIAL_SSE_STATE, type SseEvent } from "../src/providers/sse";
import { fetchSse, StreamIdleError, type FetchLike } from "../src/providers/sseTransport";
import { isAbortError } from "../src/shared/core";

function parseAll(chunks: string[]): SseEvent[] {
	let state = INITIAL_SSE_STATE;
	const events: SseEvent[] = [];
	for (const chunk of chunks) {
		const fed = feedSse(state, chunk);
		state = fed.state;
		events.push(...fed.events);
	}
	return [...events, ...flushSse(state)];
}

describe("feedSse", () => {
	test("parses LF and CRLF framed events identically", () => {
		const lf = parseAll(["event: a\ndata: 1\n\ndata: 2\n\n"]);
		const crlf = parseAll(["event: a\r\ndata: 1\r\n\r\ndata: 2\r\n\r\n"]);
		expect(lf).toEqual([{ event: "a", data: "1" }, { event: "message", data: "2" }]);
		expect(crlf).toEqual(lf);
	});

	test("accepts lone CR line endings", () => {
		expect(parseAll(["data: x\r\rdata: y\r\r"])).toEqual([{ event: "message", data: "x" }, { event: "message", data: "y" }]);
	});

	test("rebuilds events split at every byte boundary, including inside CRLF", () => {
		const text = "event: delta\r\ndata: {\"a\":1}\r\n\r\ndata: [DONE]\r\n\r\n";
		const expected = parseAll([text]);
		expect(expected).toHaveLength(2);
		expect(parseAll(text.split(""))).toEqual(expected);
	});

	test("joins multi-line data fields with a newline", () => {
		expect(parseAll(["data: line one\ndata: line two\n\n"])).toEqual([{ event: "message", data: "line one\nline two" }]);
	});

	test("ignores comments, id, retry and events without data", () => {
		const events = parseAll([": keep-alive\n\nid: 7\nretry: 100\ndata: ok\n\nevent: ping\n\n"]);
		expect(events).toEqual([{ event: "message", data: "ok" }]);
	});

	test("strips only one leading space of a data value", () => {
		expect(parseAll(["data:  two spaces\n\ndata:none\n\n"]).map((event) => event.data)).toEqual([" two spaces", "none"]);
	});

	test("passes [DONE] through as data for the adapters to interpret", () => {
		expect(parseAll(["data: [DONE]\n\n"])).toEqual([{ event: "message", data: "[DONE]" }]);
	});

	test("holds an incomplete event until its blank line, and flush releases an unterminated final event", () => {
		const fed = feedSse(INITIAL_SSE_STATE, "data: partial");
		expect(fed.events).toEqual([]);
		expect(flushSse(fed.state)).toEqual([{ event: "message", data: "partial" }]);
	});

	test("flush of an empty buffer yields nothing", () => {
		expect(flushSse(INITIAL_SSE_STATE)).toEqual([]);
	});
});

function streamOf(chunks: Uint8Array[], options: { hang?: boolean } = {}): ReadableStream<Uint8Array> {
	let index = 0;
	return new ReadableStream<Uint8Array>({
		pull(controller) {
			if (index < chunks.length) {
				controller.enqueue(chunks[index]);
				index += 1;
			} else if (!options.hang) {
				controller.close();
			}
			// A hanging stream never resolves pull again, which models a silent server.
		}
	});
}

function fetchReturning(response: Response): FetchLike {
	return async () => response;
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
	try {
		await promise;
	} catch (error) {
		return error;
	}
	throw new Error("Expected the promise to reject.");
}

const sseHeaders = { "content-type": "text/event-stream" };

describe("fetchSse", () => {
	test("decodes a multi-byte character split across chunks", async () => {
		const bytes = new TextEncoder().encode("data: héllo ✨\n\n");
		const split = bytes.length - 6;
		const received: string[] = [];
		const outcome = await fetchSse(
			fetchReturning(new Response(streamOf([bytes.slice(0, split), bytes.slice(split)]), { headers: sseHeaders })),
			"https://example.test",
			{},
			(event) => received.push(event.data)
		);
		expect(outcome.kind).toBe("streamed");
		expect(received).toEqual(["héllo ✨"]);
	});

	test("reports a fetch failure before any response as unavailable", async () => {
		const outcome = await fetchSse(async () => { throw new TypeError("Failed to fetch"); }, "https://example.test", {}, () => undefined);
		expect(outcome).toEqual({ kind: "unavailable", reason: "Failed to fetch" });
	});

	test("hands back error statuses and JSON bodies without streaming", async () => {
		const error = await fetchSse(
			fetchReturning(new Response('{"error":{"message":"no"}}', { status: 429, headers: { "content-type": "application/json" } })),
			"https://example.test",
			{},
			() => undefined
		);
		expect(error).toEqual({ kind: "response", status: 429, ok: false, text: '{"error":{"message":"no"}}' });

		const json = await fetchSse(
			fetchReturning(new Response('{"ok":true}', { status: 200, headers: { "content-type": "application/json" } })),
			"https://example.test",
			{},
			() => undefined
		);
		expect(json.kind).toBe("response");
	});

	test("an abort before the request rejects with an abort error", async () => {
		const controller = new AbortController();
		controller.abort();
		const run = fetchSse(fetchReturning(new Response("")), "https://example.test", { abortSignal: controller.signal }, () => undefined);
		expect(isAbortError(await rejectionOf(run))).toBe(true);
	});

	test("aborting mid-stream cancels the fetch signal and rejects with an abort error", async () => {
		const controller = new AbortController();
		let fetchSignal: AbortSignal | null = null;
		const fetchFn: FetchLike = async (_url, init) => {
			fetchSignal = init.signal;
			const body = new ReadableStream<Uint8Array>({
				start(stream) {
					init.signal.addEventListener("abort", () => stream.error(new DOMException("aborted", "AbortError")));
					stream.enqueue(new TextEncoder().encode("data: one\n\n"));
				}
			});
			return new Response(body, { headers: sseHeaders });
		};
		const seen: string[] = [];
		const run = fetchSse(fetchFn, "https://example.test", { abortSignal: controller.signal }, (event) => {
			seen.push(event.data);
			controller.abort();
		});
		expect(isAbortError(await rejectionOf(run))).toBe(true);
		expect(seen).toEqual(["one"]);
		expect((fetchSignal as AbortSignal | null)?.aborted).toBe(true);
	});

	test("a silent stream fails with the idle error", async () => {
		const fetchFn: FetchLike = async (_url, init) => {
			const body = new ReadableStream<Uint8Array>({
				start(stream) {
					init.signal.addEventListener("abort", () => stream.error(new DOMException("aborted", "AbortError")));
				}
			});
			return new Response(body, { headers: sseHeaders });
		};
		const run = fetchSse(fetchFn, "https://example.test", { idleTimeoutMs: 20 }, () => undefined);
		await expect(run).rejects.toBeInstanceOf(StreamIdleError);
	});

	test("errors thrown by the event handler stop the read and propagate", async () => {
		const bytes = new TextEncoder().encode("data: a\n\ndata: b\n\n");
		const run = fetchSse(fetchReturning(new Response(streamOf([bytes]), { headers: sseHeaders })), "https://example.test", {}, () => {
			throw new Error("handler failed");
		});
		await expect(run).rejects.toThrow("handler failed");
	});
});
