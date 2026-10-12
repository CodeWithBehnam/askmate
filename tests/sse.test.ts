import { describe, expect, test } from "bun:test";
import { feedSse, flushSse, INITIAL_SSE_STATE, type SseEvent } from "../src/providers/sse";
import { fetchSse, formatIdleDuration, StreamIdleError, type FetchLike } from "../src/providers/sseTransport";
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

	test("the idle error names the limit in a unit that is not rounded to nothing", () => {
		expect(new StreamIdleError(20).message).toBe("The connection went quiet for 20 ms, so AskMate stopped waiting.");
		expect(new StreamIdleError(499).message).toContain("499 ms");
		expect(new StreamIdleError(1000).message).toBe("The connection went quiet for 1 second, so AskMate stopped waiting.");
		expect(new StreamIdleError(45000).message).toContain("45 seconds");
		expect(new StreamIdleError(120000).message).toContain("2 minutes");
		expect(formatIdleDuration(0)).toBe("0 ms");
		expect(new StreamIdleError(20).message).not.toContain("0 seconds");
	});

	test("errors thrown by the event handler stop the read and propagate", async () => {
		const bytes = new TextEncoder().encode("data: a\n\ndata: b\n\n");
		const run = fetchSse(fetchReturning(new Response(streamOf([bytes]), { headers: sseHeaders })), "https://example.test", {}, () => {
			throw new Error("handler failed");
		});
		await expect(run).rejects.toThrow("handler failed");
	});
});

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A body that sends its headers and then goes silent until the request is aborted, like a stalled gateway. */
function stallingFetch(status: number, contentType: string): FetchLike {
	return async (_url, init) => {
		const body = new ReadableStream<Uint8Array>({
			start(stream) {
				init.signal.addEventListener("abort", () => stream.error(new DOMException("aborted", "AbortError")));
			}
		});
		return new Response(body, { status, headers: { "content-type": contentType } });
	};
}

describe("fetchSse non-stream bodies", () => {
	test("a body that stalls after an error status is an idle error, not a user stop", async () => {
		const run = fetchSse(stallingFetch(502, "text/plain"), "https://example.test", { idleTimeoutMs: 30 }, () => undefined);
		const error = await rejectionOf(run);
		expect(error).toBeInstanceOf(StreamIdleError);
		expect(isAbortError(error)).toBe(false);
	});

	test("a JSON body that stalls is an idle error too", async () => {
		const run = fetchSse(stallingFetch(200, "application/json"), "https://example.test", { idleTimeoutMs: 30 }, () => undefined);
		await expect(run).rejects.toBeInstanceOf(StreamIdleError);
	});

	test("a user abort while the body is stalled is still reported as a stop", async () => {
		const controller = new AbortController();
		const run = fetchSse(stallingFetch(502, "text/plain"), "https://example.test", { abortSignal: controller.signal, idleTimeoutMs: 5000 }, () => undefined);
		setTimeout(() => controller.abort(), 20);
		expect(isAbortError(await rejectionOf(run))).toBe(true);
	});

	test("the idle window restarts when the headers arrive, so a slow start is not a stall", async () => {
		const fetchFn: FetchLike = async (_url, init) => {
			await wait(60);
			const body = new ReadableStream<Uint8Array>({
				start(stream) {
					init.signal.addEventListener("abort", () => stream.error(new DOMException("aborted", "AbortError")));
					setTimeout(() => {
						if (!init.signal.aborted) {
							stream.enqueue(new TextEncoder().encode('{"ok":true}'));
							stream.close();
						}
					}, 60);
				}
			});
			return new Response(body, { headers: { "content-type": "application/json" } });
		};
		// 60 ms to the headers plus 60 ms to the body is more than the 100 ms limit, but neither wait alone is.
		const outcome = await fetchSse(fetchFn, "https://example.test", { idleTimeoutMs: 100 }, () => undefined);
		expect(outcome).toEqual({ kind: "response", status: 200, ok: true, text: '{"ok":true}' });
	});
});

describe("fetchSse stream detection", () => {
	const sse = "data: one\n\ndata: two\n\n";

	test.each([
		["application/json"],
		["text/plain"],
		["application/octet-stream"]
	])("SSE bytes labelled %s are still read as a stream", async (contentType: string) => {
		const seen: string[] = [];
		const outcome = await fetchSse(fetchReturning(new Response(sse, { headers: { "content-type": contentType } })), "https://example.test", {}, (event) => seen.push(event.data));
		expect(outcome).toEqual({ kind: "streamed" });
		expect(seen).toEqual(["one", "two"]);
	});

	test("SSE bytes sent with no Content-Type at all are read as a stream", async () => {
		const bytes = new TextEncoder().encode(sse);
		const seen: string[] = [];
		const outcome = await fetchSse(fetchReturning(new Response(streamOf([bytes]))), "https://example.test", {}, (event) => seen.push(event.data));
		expect(outcome.kind).toBe("streamed");
		expect(seen).toEqual(["one", "two"]);
	});

	test("an SSE comment line is enough to sniff a stream", async () => {
		const seen: string[] = [];
		await fetchSse(fetchReturning(new Response(": ping\n\ndata: x\n\n", { headers: { "content-type": "application/json" } })), "https://example.test", {}, (event) => seen.push(event.data));
		expect(seen).toEqual(["x"]);
	});

	test("a JSON body with a missing or odd Content-Type is a response, never fed to the SSE parser", async () => {
		const seen: string[] = [];
		const outcome = await fetchSse(fetchReturning(new Response('{"choices":[]}', { headers: { "content-type": "text/plain" } })), "https://example.test", {}, (event) => seen.push(event.data));
		expect(outcome).toEqual({ kind: "response", status: 200, ok: true, text: '{"choices":[]}' });
		expect(seen).toEqual([]);
	});

	test("a JSON reply labelled as an event stream comes back as a response", async () => {
		const seen: string[] = [];
		const body = '{\n  "choices": [{ "message": { "content": "Hi" } }]\n}\n';
		const outcome = await fetchSse(fetchReturning(new Response(body, { headers: sseHeaders })), "https://example.test", {}, (event) => seen.push(event.data));
		expect(outcome).toEqual({ kind: "response", status: 200, ok: true, text: body });
		expect(seen).toEqual([]);
	});

	test("an event stream that sent only comments is still a streamed outcome with no events", async () => {
		const outcome = await fetchSse(fetchReturning(new Response(": hello\n\n", { headers: sseHeaders })), "https://example.test", {}, () => undefined);
		expect(outcome).toEqual({ kind: "streamed" });
	});

	test("an HTML page is a response, even with a 200 status", async () => {
		const page = "<!doctype html><html><body>Sign in to the network</body></html>";
		const outcome = await fetchSse(fetchReturning(new Response(page, { headers: { "content-type": "text/html" } })), "https://example.test", {}, () => undefined);
		expect(outcome).toEqual({ kind: "response", status: 200, ok: true, text: page });
	});

	test("only a network TypeError means unavailable; any other fetch failure is thrown so the prompt is not sent twice", async () => {
		const network = await fetchSse(async () => { throw new TypeError("Failed to fetch"); }, "https://example.test", {}, () => undefined);
		expect(network.kind).toBe("unavailable");
		const other = fetchSse(async () => { throw new Error("socket hang up"); }, "https://example.test", {}, () => undefined);
		await expect(other).rejects.toThrow("socket hang up");
	});
});
