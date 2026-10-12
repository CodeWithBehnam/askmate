import { describe, expect, test } from "bun:test";
import { completeAnthropicText } from "../src/providers/anthropic";
import { completeAzureAIText } from "../src/providers/azure-ai";
import { buildChatCompletionsResult } from "../src/providers/common";
import { completeGeminiText, getGeminiPromptBlockReason as bufferedGetGeminiPromptBlockReason } from "../src/providers/google-gemini";
import { getGeminiPromptBlockReason } from "../src/providers/google-gemini-stream";
import { completeProviderTextRequest } from "../src/providers/index";
import { streamOpenAIResponses } from "../src/providers/open-ai-stream";
import { STREAM_INTERRUPTED_REASON } from "../src/providers/streaming";
import { fetchSse, type FetchLike } from "../src/providers/sseTransport";
import type { ProviderRequestOptions, ProviderRuntime } from "../src/providers/types";
import { readOpenAIResponseText } from "../src/requests/RequestRunner";
import { isAbortError } from "../src/shared/core";
import type { AskMateHttpResponse, ProviderModelRef, ProviderSettings, TextProviderId } from "../src/shared/types";

const API_KEY = "test-secret-key-0123456789";

function frame(event: string | null, payload: unknown): string {
	const data = typeof payload === "string" ? payload : JSON.stringify(payload);
	return `${event ? `event: ${event}\n` : ""}data: ${data}\n\n`;
}

interface StreamCall {
	url: string;
	headers: Record<string, string>;
	body: Record<string, unknown>;
}

interface Harness {
	runtime: ProviderRuntime;
	streamCalls: StreamCall[];
	bufferedCalls: string[];
}

type StreamBehaviour =
	| { kind: "sse"; chunks: string[] }
	/** A 200 reply with an arbitrary body and Content-Type, for gateways that mislabel what they send. */
	| { kind: "raw"; body: string; contentType?: string; status?: number }
	| { kind: "http"; status: number; body: unknown }
	| { kind: "network-error" }
	| { kind: "other-error" }
	| { kind: "stall"; status: number }
	| { kind: "none" };

function harness(behaviour: StreamBehaviour, buffered: AskMateHttpResponse<unknown>[] = [], baseUrl = "https://example.test/v1"): Harness {
	const streamCalls: StreamCall[] = [];
	const bufferedCalls: string[] = [];
	const queue = [...buffered];
	const fetchFn: FetchLike = async (url, init) => {
		streamCalls.push({ url, headers: init.headers ?? {}, body: JSON.parse(init.body ?? "{}") as Record<string, unknown> });
		if (behaviour.kind === "network-error") {
			throw new TypeError("Failed to fetch");
		}
		if (behaviour.kind === "other-error") {
			throw new Error("socket hang up");
		}
		if (behaviour.kind === "raw") {
			return new Response(behaviour.body, {
				status: behaviour.status ?? 200,
				headers: behaviour.contentType ? { "content-type": behaviour.contentType } : {}
			});
		}
		if (behaviour.kind === "stall") {
			return new Response(new ReadableStream<Uint8Array>({
				start(stream) {
					init.signal.addEventListener("abort", () => stream.error(new DOMException("aborted", "AbortError")));
				}
			}), { status: behaviour.status, headers: { "content-type": "text/plain" } });
		}
		if (behaviour.kind === "http") {
			return new Response(JSON.stringify(behaviour.body), { status: behaviour.status, headers: { "content-type": "application/json" } });
		}
		const encoder = new TextEncoder();
		const chunks = behaviour.kind === "sse" ? behaviour.chunks : [];
		return new Response(new ReadableStream<Uint8Array>({
			start(controller) {
				chunks.forEach((chunk) => controller.enqueue(encoder.encode(chunk)));
				controller.close();
			}
		}), { headers: { "content-type": "text/event-stream" } });
	};
	const runtime: ProviderRuntime = {
		getProviderSettings: (_providerId: TextProviderId): ProviderSettings => ({
			apiKeySecretName: "",
			model: "test-model",
			modelOptions: [],
			baseUrl
		}),
		getProviderApiKey: async () => API_KEY,
		requestJson: async <T>(url: string, _options?: ProviderRequestOptions): Promise<AskMateHttpResponse<T>> => {
			bufferedCalls.push(url);
			const next = queue.shift();
			if (!next) {
				throw new Error(`Unexpected buffered request to ${url}`);
			}
			return next as AskMateHttpResponse<T>;
		},
		...(behaviour.kind === "none" ? {} : {
			streamSse: (url, options, onEvent) => fetchSse(
				fetchFn,
				url,
				// A stalled body would otherwise wait out the real two minute limit.
				{ ...options, ...(behaviour.kind === "stall" ? { idleTimeoutMs: 30 } : {}) },
				onEvent
			)
		})
	};
	return { runtime, streamCalls, bufferedCalls };
}

function json(status: number, body: unknown): AskMateHttpResponse<unknown> {
	return { status, ok: status >= 200 && status < 300, body, text: JSON.stringify(body) };
}

function ref(providerId: TextProviderId, providerName: string): ProviderModelRef {
	return { providerId, providerName, model: "test-model", capability: "text" };
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
	try {
		await promise;
	} catch (error) {
		return error;
	}
	throw new Error("Expected the promise to reject.");
}

const chatChunk = (content: string, finishReason: string | null = null, extra: Record<string, unknown> = {}): string =>
	frame(null, { choices: [{ index: 0, delta: { content }, finish_reason: finishReason }], ...extra });

describe("chat completions streaming", () => {
	const usage = { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 };

	test("streams deltas and matches the buffered result including usage", async () => {
		const stream = harness({
			kind: "sse",
			chunks: [chatChunk("Hel"), chatChunk("lo "), chatChunk("world", "stop"), frame(null, { choices: [], usage }), frame(null, "[DONE]")]
		});
		const deltas: string[] = [];
		const streamed = await completeProviderTextRequest(stream.runtime, ref("openrouter", "OpenRouter"), "sys", "in", undefined, (delta) => deltas.push(delta));
		const buffered = buildChatCompletionsResult("OpenRouter", "test-model", {
			choices: [{ message: { content: "Hello world" }, finish_reason: "stop" }],
			usage
		});

		expect(deltas).toEqual(["Hel", "lo ", "world"]);
		expect(streamed).toEqual(buffered);
		expect(stream.bufferedCalls).toEqual([]);
		expect(stream.streamCalls[0].body.stream).toBe(true);
		expect(stream.streamCalls[0].body.stream_options).toEqual({ include_usage: true });
	});

	test("does not send stream_options to the local openai-compatible provider", async () => {
		const stream = harness({ kind: "sse", chunks: [chatChunk("ok", "stop"), frame(null, "[DONE]")] });
		const result = await completeProviderTextRequest(stream.runtime, ref("openai-compatible", "OpenAI-compatible"), "sys", "in", undefined, () => undefined);
		expect(result.text).toBe("ok");
		expect(result.usage).toBeNull();
		expect("stream_options" in stream.streamCalls[0].body).toBe(false);
	});

	test("length truncation is marked incomplete like the buffered path", async () => {
		const stream = harness({ kind: "sse", chunks: [chatChunk("cut", "length"), frame(null, "[DONE]")] }, [], "https://x.openai.azure.com/openai/v1");
		const result = await completeProviderTextRequest(stream.runtime, ref("azure-openai", "Azure OpenAI"), "sys", "in", undefined, () => undefined);
		expect(result.incompleteReason).toBe("length");
		expect(result.text).toBe("cut");
	});

	test("content_filter with no text throws the same error as the buffered path", async () => {
		const stream = harness({ kind: "sse", chunks: [chatChunk("", "content_filter"), frame(null, "[DONE]")] });
		const streamedError = await rejectionOf(completeProviderTextRequest(stream.runtime, ref("openrouter", "OpenRouter"), "s", "i", undefined, () => undefined));
		const bufferedError = await rejectionOf(Promise.resolve().then(() => buildChatCompletionsResult("OpenRouter", "test-model", {
			choices: [{ message: { content: "" }, finish_reason: "content_filter" }]
		})));
		expect((streamedError as Error).message).toBe((bufferedError as Error).message);
	});

	test("a streamed refusal throws the buffered refusal error", async () => {
		const stream = harness({
			kind: "sse",
			chunks: [frame(null, { choices: [{ delta: { refusal: "I cannot help." }, finish_reason: "stop" }] }), frame(null, "[DONE]")]
		});
		const error = await rejectionOf(completeProviderTextRequest(stream.runtime, ref("openrouter", "OpenRouter"), "s", "i", undefined, () => undefined));
		expect((error as Error).message).toBe("OpenRouter refused the request. Provider message: I cannot help.");
	});

	test("an error event after text keeps the partial reply marked incomplete", async () => {
		const stream = harness({
			kind: "sse",
			chunks: [chatChunk("partial"), frame(null, { error: { message: "upstream overloaded", code: 502 } })]
		});
		const result = await completeProviderTextRequest(stream.runtime, ref("openrouter", "OpenRouter"), "s", "i", undefined, () => undefined);
		expect(result.text).toBe("partial");
		expect(result.incompleteReason).toBe(STREAM_INTERRUPTED_REASON);
		expect(result.streamError).toContain("upstream overloaded");
	});

	test("an error event before any text throws", async () => {
		const stream = harness({ kind: "sse", chunks: [frame(null, { error: { message: "bad things" } })] });
		const error = await rejectionOf(completeProviderTextRequest(stream.runtime, ref("openrouter", "OpenRouter"), "s", "i", undefined, () => undefined));
		expect((error as Error).message).toContain("bad things");
	});

	test("a connection closed mid-reply keeps the partial text as incomplete", async () => {
		const stream = harness({ kind: "sse", chunks: [chatChunk("half")] });
		const result = await completeProviderTextRequest(stream.runtime, ref("openrouter", "OpenRouter"), "s", "i", undefined, () => undefined);
		expect(result.incompleteReason).toBe(STREAM_INTERRUPTED_REASON);
		expect(result.text).toBe("half");
	});

	test("an interrupted reply keeps the usage that was already reported", async () => {
		const stream = harness({ kind: "sse", chunks: [chatChunk("half", null, { usage })] });
		const result = await completeProviderTextRequest(stream.runtime, ref("openrouter", "OpenRouter"), "s", "i", undefined, () => undefined);
		expect(result.incompleteReason).toBe(STREAM_INTERRUPTED_REASON);
		expect(result.usage).toEqual({ input_tokens: 11, output_tokens: 7, total_tokens: 18 });
	});

	test("HTTP error statuses are formatted like the buffered path and never retried", async () => {
		const stream = harness({ kind: "http", status: 429, body: { error: { message: "slow down" } } }, [json(200, {})]);
		const error = await rejectionOf(completeProviderTextRequest(stream.runtime, ref("openrouter", "OpenRouter"), "s", "i", undefined, () => undefined));
		expect((error as Error).message).toBe("OpenRouter rate limit or quota was reached. Wait, reduce context, or check billing. Provider message: slow down");
		expect(stream.bufferedCalls).toEqual([]);
	});

	test("secrets in streamed error text are redacted", async () => {
		const stream = harness({ kind: "http", status: 401, body: { error: { message: `bad key ${API_KEY}` } } });
		const error = await rejectionOf(completeProviderTextRequest(stream.runtime, ref("openrouter", "OpenRouter"), "s", "i", undefined, () => undefined));
		expect((error as Error).message).not.toContain(API_KEY);
	});

	test("a stream labelled application/json is still streamed and gives the same result", async () => {
		const chunks = [chatChunk("Hel"), chatChunk("lo", "stop"), frame(null, "[DONE]")];
		const labelled = harness({ kind: "sse", chunks });
		const mislabelled = harness({ kind: "raw", body: chunks.join(""), contentType: "application/json" });
		const deltas: string[] = [];
		const expected = await completeProviderTextRequest(labelled.runtime, ref("openrouter", "OpenRouter"), "s", "i", undefined, () => undefined);
		const result = await completeProviderTextRequest(mislabelled.runtime, ref("openrouter", "OpenRouter"), "s", "i", undefined, (delta) => deltas.push(delta));
		expect(result).toEqual(expected);
		expect(result.text).toBe("Hello");
		expect(deltas).toEqual(["Hel", "lo"]);
		expect(mislabelled.bufferedCalls).toEqual([]);
	});

	test("an error hidden in a JSON reply to a stream request is redacted with the key that was sent", async () => {
		const body = JSON.stringify({ error: { message: `Incorrect API key ${API_KEY}` } });
		const stream = harness({ kind: "raw", body, contentType: "application/json" });
		const error = await rejectionOf(completeProviderTextRequest(stream.runtime, ref("openrouter", "OpenRouter"), "s", "i", undefined, () => undefined));
		expect((error as Error).message).toContain("reported an error in its response");
		expect((error as Error).message).not.toContain(API_KEY);
	});

	test("a JSON reply labelled as an event stream is read by the buffered parser", async () => {
		const body = JSON.stringify({ choices: [{ message: { content: "Plain reply" }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } });
		const stream = harness({ kind: "raw", body, contentType: "text/event-stream" });
		const result = await completeProviderTextRequest(stream.runtime, ref("openrouter", "OpenRouter"), "s", "i", undefined, () => undefined);
		expect(result.text).toBe("Plain reply");
		expect(result.usage).toEqual({ input_tokens: 3, output_tokens: 2, total_tokens: 5 });
		expect(result.incompleteReason).toBeNull();
		expect(stream.bufferedCalls).toEqual([]);
	});

	test("a web page instead of a reply says so, and is not retried", async () => {
		const page = "<!doctype html><html><head><title>Login</title><style>p{}</style></head><body><p>Sign in to the Wi-Fi network</p></body></html>";
		const stream = harness({ kind: "raw", body: page, contentType: "text/html" }, [json(200, {})]);
		const error = await rejectionOf(completeProviderTextRequest(stream.runtime, ref("openrouter", "OpenRouter"), "s", "i", undefined, () => undefined));
		const message = (error as Error).message;
		expect(message).toContain("OpenRouter answered with a web page instead of a reply");
		expect(message).toContain("Sign in to the Wi-Fi network");
		expect(message).not.toContain("<p>");
		expect(message).not.toContain("p{}");
		expect(message).not.toContain("closed the connection");
		expect(stream.bufferedCalls).toEqual([]);
	});

	test("an empty 200 reply is reported as no reply, and plain non-JSON text as an unexpected reply", async () => {
		const empty = harness({ kind: "raw", body: "", contentType: "application/json" });
		const emptyError = await rejectionOf(completeProviderTextRequest(empty.runtime, ref("openrouter", "OpenRouter"), "s", "i", undefined, () => undefined));
		expect((emptyError as Error).message).toBe("OpenRouter closed the connection without sending a reply.");
		const text = harness({ kind: "raw", body: "OK", contentType: "text/plain" });
		const textError = await rejectionOf(completeProviderTextRequest(text.runtime, ref("openrouter", "OpenRouter"), "s", "i", undefined, () => undefined));
		expect((textError as Error).message).toContain("OpenRouter returned something that is not a reply");
	});

	test("a fetch failure that is not a network error is thrown instead of sending the prompt again", async () => {
		const stream = harness({ kind: "other-error" }, [json(200, { choices: [{ message: { content: "second send" }, finish_reason: "stop" }] })]);
		const error = await rejectionOf(completeProviderTextRequest(stream.runtime, ref("openrouter", "OpenRouter"), "s", "i", undefined, () => undefined));
		expect((error as Error).message).toContain("socket hang up");
		expect(stream.bufferedCalls).toEqual([]);
	});

	test("a gateway that stalls after an error status reports silence, not a user stop", async () => {
		const stream = harness({ kind: "stall", status: 502 });
		const error = await rejectionOf(completeProviderTextRequest(stream.runtime, ref("openrouter", "OpenRouter"), "s", "i", undefined, () => undefined));
		expect(isAbortError(error)).toBe(false);
		expect((error as Error).message).toContain("went quiet");
	});

	test("a network failure before any response falls back silently to the buffered request", async () => {
		const stream = harness({ kind: "network-error" }, [json(200, { choices: [{ message: { content: "buffered" }, finish_reason: "stop" }] })]);
		const deltas: string[] = [];
		const result = await completeProviderTextRequest(stream.runtime, ref("openrouter", "OpenRouter"), "s", "i", undefined, (delta) => deltas.push(delta));
		expect(result.text).toBe("buffered");
		expect(deltas).toEqual([]);
		expect(stream.bufferedCalls).toHaveLength(1);
	});

	test("a runtime without streamSse, or no onDelta, uses the buffered request", async () => {
		const noStream = harness({ kind: "none" }, [json(200, { choices: [{ message: { content: "a" }, finish_reason: "stop" }] })]);
		expect((await completeProviderTextRequest(noStream.runtime, ref("openrouter", "OpenRouter"), "s", "i", undefined, () => undefined)).text).toBe("a");

		const noDelta = harness({ kind: "sse", chunks: [] }, [json(200, { choices: [{ message: { content: "b" }, finish_reason: "stop" }] })]);
		expect((await completeProviderTextRequest(noDelta.runtime, ref("openrouter", "OpenRouter"), "s", "i")).text).toBe("b");
		expect(noDelta.streamCalls).toEqual([]);
	});

	test("a server that ignores stream and answers with JSON is parsed as a buffered body", async () => {
		const stream = harness({ kind: "http", status: 200, body: { choices: [{ message: { content: "plain" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } } });
		const deltas: string[] = [];
		const result = await completeProviderTextRequest(stream.runtime, ref("openai-compatible", "OpenAI-compatible"), "s", "i", undefined, (delta) => deltas.push(delta));
		expect(result.text).toBe("plain");
		expect(result.usage?.total_tokens).toBe(3);
		expect(deltas).toEqual([]);
	});

	test("aborting rejects with an abort error", async () => {
		const stream = harness({ kind: "sse", chunks: [chatChunk("x"), chatChunk("y", "stop")] });
		const controller = new AbortController();
		const run = completeProviderTextRequest(stream.runtime, ref("openrouter", "OpenRouter"), "s", "i", controller.signal, () => controller.abort());
		expect(isAbortError(await rejectionOf(run))).toBe(true);
	});

	test("azure-ai streams to its api-version URL without stream_options", async () => {
		const stream = harness({ kind: "sse", chunks: [chatChunk("hi", "stop"), frame(null, "[DONE]")] }, [], "https://x.services.ai.azure.com");
		const result = await completeAzureAIText(stream.runtime, ref("azure-ai", "Azure AI Foundry"), "s", "i", undefined, { onDelta: () => undefined });
		expect(result.text).toBe("hi");
		expect(stream.streamCalls[0].url).toContain("/models/chat/completions?api-version=");
		expect("stream_options" in stream.streamCalls[0].body).toBe(false);
	});
});

describe("anthropic streaming", () => {
	const events = (stopReason: string, text: string[]): string[] => [
		frame("message_start", { type: "message_start", message: { usage: { input_tokens: 25, output_tokens: 1 } } }),
		frame("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
		frame("ping", { type: "ping" }),
		...text.map((part) => frame("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: part } })),
		frame("content_block_stop", { type: "content_block_stop", index: 0 }),
		frame("message_delta", { type: "message_delta", delta: { stop_reason: stopReason }, usage: { output_tokens: 15 } }),
		frame("message_stop", { type: "message_stop" })
	];

	test("matches the buffered result and sends the browser-access header", async () => {
		const stream = harness({ kind: "sse", chunks: events("end_turn", ["Hello", " there"]) });
		const deltas: string[] = [];
		const streamed = await completeAnthropicText(stream.runtime, ref("anthropic", "Anthropic"), "sys", "in", undefined, (delta) => deltas.push(delta));
		const buffered = await completeAnthropicText(
			harness({ kind: "none" }, [json(200, { content: [{ type: "text", text: "Hello there" }], stop_reason: "end_turn", usage: { input_tokens: 25, output_tokens: 15 } })]).runtime,
			ref("anthropic", "Anthropic"), "sys", "in"
		);

		expect(deltas).toEqual(["Hello", " there"]);
		expect(streamed).toEqual(buffered);
		expect(streamed.usage).toEqual({ input_tokens: 25, output_tokens: 15, total_tokens: 40 });
		expect(stream.streamCalls[0].headers["anthropic-dangerous-direct-browser-access"]).toBe("true");
		expect(stream.streamCalls[0].body.stream).toBe(true);
	});

	test("max_tokens and refusal stop reasons are incomplete", async () => {
		const cut = await completeAnthropicText(harness({ kind: "sse", chunks: events("max_tokens", ["part"]) }).runtime, ref("anthropic", "Anthropic"), "s", "i", undefined, () => undefined);
		expect(cut.incompleteReason).toBe("max_tokens");
		const refused = await rejectionOf(completeAnthropicText(harness({ kind: "sse", chunks: events("refusal", []) }).runtime, ref("anthropic", "Anthropic"), "s", "i", undefined, () => undefined));
		expect((refused as Error).message).toContain('stopped with reason "refusal"');
	});

	test("an overloaded error event after text keeps the partial reply", async () => {
		const stream = harness({
			kind: "sse",
			chunks: [events("end_turn", ["abc"])[3], frame("error", { type: "error", error: { type: "overloaded_error", message: "Overloaded" } })]
		});
		const result = await completeAnthropicText(stream.runtime, ref("anthropic", "Anthropic"), "s", "i", undefined, () => undefined);
		expect(result.text).toBe("abc");
		expect(result.incompleteReason).toBe(STREAM_INTERRUPTED_REASON);
		expect(result.streamError).toContain("Overloaded");
	});

	test("a connection that closes between message_delta and message_stop is still a complete reply", async () => {
		const withoutStop = events("end_turn", ["Hello", " there"]).slice(0, -1);
		const result = await completeAnthropicText(harness({ kind: "sse", chunks: withoutStop }).runtime, ref("anthropic", "Anthropic"), "s", "i", undefined, () => undefined);
		expect(result.text).toBe("Hello there");
		expect(result.incompleteReason).toBeNull();
		expect(result.streamError).toBeUndefined();
		expect(result.usage).toEqual({ input_tokens: 25, output_tokens: 15, total_tokens: 40 });
	});

	test("a stream that breaks before message_delta keeps the input tokens already reported", async () => {
		const early = events("end_turn", ["abc"]).slice(0, 4);
		const result = await completeAnthropicText(harness({ kind: "sse", chunks: early }).runtime, ref("anthropic", "Anthropic"), "s", "i", undefined, () => undefined);
		expect(result.incompleteReason).toBe(STREAM_INTERRUPTED_REASON);
		expect(result.text).toBe("abc");
		expect(result.usage).toEqual({ input_tokens: 25 });
	});
});

describe("gemini streaming", () => {
	const chunk = (text: string, extra: Record<string, unknown> = {}, finishReason?: string): string =>
		frame(null, { candidates: [{ content: { role: "model", parts: [{ text }] }, ...(finishReason ? { finishReason } : {}) }], ...extra });

	test("uses streamGenerateContent with alt=sse and matches the buffered result", async () => {
		const usageMetadata = { promptTokenCount: 5, candidatesTokenCount: 4, thoughtsTokenCount: 2, totalTokenCount: 11 };
		const stream = harness({ kind: "sse", chunks: [chunk("Hel"), chunk("lo", { usageMetadata }, "STOP")] });
		const deltas: string[] = [];
		const streamed = await completeGeminiText(stream.runtime, ref("google-gemini", "Google Gemini"), "s", "i", undefined, (delta) => deltas.push(delta));
		const buffered = await completeGeminiText(
			harness({ kind: "none" }, [json(200, { candidates: [{ content: { parts: [{ text: "Hello" }] }, finishReason: "STOP" }], usageMetadata })]).runtime,
			ref("google-gemini", "Google Gemini"), "s", "i"
		);

		expect(deltas).toEqual(["Hel", "lo"]);
		expect(streamed).toEqual(buffered);
		expect(stream.streamCalls[0].url).toBe("https://example.test/v1/models/test-model:streamGenerateContent?alt=sse");
		expect(stream.streamCalls[0].url).not.toContain(API_KEY);
	});

	test("MAX_TOKENS is incomplete and a prompt block throws", async () => {
		const cut = await completeGeminiText(harness({ kind: "sse", chunks: [chunk("cut", {}, "MAX_TOKENS")] }).runtime, ref("google-gemini", "Google Gemini"), "s", "i", undefined, () => undefined);
		expect(cut.incompleteReason).toBe("MAX_TOKENS");

		const blocked = await rejectionOf(completeGeminiText(
			harness({ kind: "sse", chunks: [frame(null, { promptFeedback: { blockReason: "SAFETY" } })] }).runtime,
			ref("google-gemini", "Google Gemini"), "s", "i", undefined, () => undefined
		));
		expect((blocked as Error).message).toContain("blocked this request (SAFETY)");
	});

	test("a stream with no finish reason after text is interrupted", async () => {
		const result = await completeGeminiText(harness({ kind: "sse", chunks: [chunk("so far")] }).runtime, ref("google-gemini", "Google Gemini"), "s", "i", undefined, () => undefined);
		expect(result.incompleteReason).toBe(STREAM_INTERRUPTED_REASON);
	});

	test("BLOCK_REASON_UNSPECIFIED is not a terminal block, so a cut-off stream is still interrupted", async () => {
		const result = await completeGeminiText(
			harness({ kind: "sse", chunks: [chunk("partial", { promptFeedback: { blockReason: "BLOCK_REASON_UNSPECIFIED" } })] }).runtime,
			ref("google-gemini", "Google Gemini"), "s", "i", undefined, () => undefined
		);
		expect(result.text).toBe("partial");
		expect(result.incompleteReason).toBe(STREAM_INTERRUPTED_REASON);
	});

	test("an interrupted stream keeps the usage the provider already reported", async () => {
		const usageMetadata = { promptTokenCount: 9, candidatesTokenCount: 3, totalTokenCount: 12 };
		const result = await completeGeminiText(
			harness({ kind: "sse", chunks: [chunk("so far", { usageMetadata })] }).runtime,
			ref("google-gemini", "Google Gemini"), "s", "i", undefined, () => undefined
		);
		expect(result.incompleteReason).toBe(STREAM_INTERRUPTED_REASON);
		expect(result.usage).toEqual({ input_tokens: 9, output_tokens: 3, total_tokens: 12 });
	});
});

describe("gemini prompt block reason", () => {
	test.each([
		[{ promptFeedback: { blockReason: "BLOCK_REASON_UNSPECIFIED" } }, null],
		[{ promptFeedback: { blockReason: "" } }, null],
		[{ promptFeedback: { blockReason: 3 } }, null],
		[{ promptFeedback: {} }, null],
		[{}, null],
		[null, null],
		[{ promptFeedback: { blockReason: "SAFETY" } }, "SAFETY"]
	])("%j gives %p", (body: Record<string, unknown> | null, expected: string | null) => {
		expect(getGeminiPromptBlockReason(body)).toBe(expected);
	});

	test("the buffered module re-exports the one shared implementation", () => {
		expect(bufferedGetGeminiPromptBlockReason).toBe(getGeminiPromptBlockReason);
	});
});

describe("openai responses streaming", () => {
	const params = (onDelta: (delta: string) => void) => ({
		apiKey: API_KEY,
		model: "gpt-5.5",
		instructions: "sys",
		input: "in",
		reasoningEffort: "medium" as const,
		onDelta
	});
	const delta = (text: string): string => frame("response.output_text.delta", { type: "response.output_text.delta", delta: text });
	const finalResponse = (response: Record<string, unknown>, type = "response.completed"): string => frame(type, { type, response });
	const completed = {
		status: "completed",
		output: [{ content: [{ type: "output_text", text: "Hello world" }] }],
		usage: { input_tokens: 9, output_tokens: 3, total_tokens: 12 }
	};

	test("passes the final response to the existing parser", async () => {
		const stream = harness({ kind: "sse", chunks: [frame("response.created", { type: "response.created" }), delta("Hello "), delta("world"), finalResponse(completed)] });
		const deltas: string[] = [];
		const result = await streamOpenAIResponses(stream.runtime, params((text) => deltas.push(text)));

		expect(deltas).toEqual(["Hello ", "world"]);
		expect(result.kind).toBe("body");
		if (result.kind !== "body") {
			return;
		}
		expect(readOpenAIResponseText(result.body)).toEqual(readOpenAIResponseText(completed));
		expect(result.body.usage).toEqual(completed.usage);
		expect(stream.streamCalls[0].body.stream).toBe(true);
		expect(stream.streamCalls[0].body.store).toBe(false);
		expect(stream.streamCalls[0].url).toBe("https://example.test/v1/responses");
	});

	test("response.incomplete keeps its reason", async () => {
		const incomplete = { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [{ content: [{ type: "output_text", text: "cut" }] }] };
		const stream = harness({ kind: "sse", chunks: [delta("cut"), finalResponse(incomplete, "response.incomplete")] });
		const result = await streamOpenAIResponses(stream.runtime, params(() => undefined));
		expect(result.kind === "body" && readOpenAIResponseText(result.body)).toEqual({ text: "cut", incompleteReason: "max_output_tokens" });
	});

	test("response.failed without text surfaces the buffered failure message", async () => {
		const failed = { status: "failed", error: { message: "model exploded" } };
		const stream = harness({ kind: "sse", chunks: [finalResponse(failed, "response.failed")] });
		const result = await streamOpenAIResponses(stream.runtime, params(() => undefined));
		expect(result.kind === "body" && (() => { try { readOpenAIResponseText(result.body); return ""; } catch (error) { return (error as Error).message; } })())
			.toBe("OpenAI could not complete the response. Provider message: model exploded");
	});

	test("response.failed after text keeps the partial reply as interrupted", async () => {
		const stream = harness({ kind: "sse", chunks: [delta("partial"), finalResponse({ status: "failed", error: { message: "boom" } }, "response.failed")] });
		const result = await streamOpenAIResponses(stream.runtime, params(() => undefined));
		expect(result.kind).toBe("body");
		if (result.kind === "body") {
			expect(readOpenAIResponseText(result.body)).toEqual({ text: "partial", incompleteReason: STREAM_INTERRUPTED_REASON });
			expect(result.streamError).toContain("boom");
		}
	});

	test("a failure message after text is redacted like the buffered error path", async () => {
		const failed = { status: "failed", error: { message: `rejected key ${API_KEY}` } };
		const stream = harness({ kind: "sse", chunks: [delta("partial"), finalResponse(failed, "response.failed")] });
		const result = await streamOpenAIResponses(stream.runtime, params(() => undefined));
		expect(result.kind === "body" ? result.streamError : "").toContain("rejected key");
		expect(result.kind === "body" ? result.streamError : "").not.toContain(API_KEY);
	});

	test("an error event after text is interrupted; before text it throws", async () => {
		const withText = await streamOpenAIResponses(
			harness({ kind: "sse", chunks: [delta("abc"), frame("error", { type: "error", message: "server_error" })] }).runtime,
			params(() => undefined)
		);
		expect(withText.kind === "body" && withText.streamError).toContain("server_error");

		const error = await rejectionOf(streamOpenAIResponses(
			harness({ kind: "sse", chunks: [frame("error", { type: "error", message: "rate limited" })] }).runtime,
			params(() => undefined)
		));
		expect((error as Error).message).toContain("rate limited");
	});

	test("a refusal in the final response throws the buffered refusal error", async () => {
		const refused = { status: "completed", output: [{ content: [{ type: "refusal", refusal: "No." }] }] };
		const result = await streamOpenAIResponses(harness({ kind: "sse", chunks: [finalResponse(refused)] }).runtime, params(() => undefined));
		expect(() => result.kind === "body" && readOpenAIResponseText(result.body)).toThrow("OpenAI refused the request. Provider message: No.");
	});

	test("HTTP errors are not retried and network failures report unavailable", async () => {
		const http = harness({ kind: "http", status: 401, body: { error: { message: "nope" } } });
		const error = await rejectionOf(streamOpenAIResponses(http.runtime, params(() => undefined)));
		expect((error as Error).message).toContain("OpenAI authentication failed");
		expect(http.bufferedCalls).toEqual([]);

		const network = await streamOpenAIResponses(harness({ kind: "network-error" }).runtime, params(() => undefined));
		expect(network).toEqual({ kind: "unavailable" });
		expect(await streamOpenAIResponses(harness({ kind: "none" }).runtime, params(() => undefined))).toEqual({ kind: "unavailable" });
	});
});
