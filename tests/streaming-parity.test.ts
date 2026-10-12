import { describe, expect, test } from "bun:test";
import { anthropicStreamAdapter, assembleAnthropicBody, type AnthropicStreamState } from "../src/providers/anthropic-stream";
import { chatCompletionsStreamAdapter, type ChatStreamState } from "../src/providers/chat-completions-stream";
import { buildGeminiResult } from "../src/providers/google-gemini";
import { assembleGeminiBody, geminiStreamAdapter, type GeminiStreamState } from "../src/providers/google-gemini-stream";
import { StreamProviderError, type StreamAdapter } from "../src/providers/streaming";

function run<S>(adapter: StreamAdapter<S>, payloads: unknown[]): { state: S; deltas: string[] } {
	return payloads.reduce<{ state: S; deltas: string[] }>(
		(acc, payload) => {
			const next = adapter.reduce(acc.state, { event: "message", data: JSON.stringify(payload) });
			return { state: next.state, deltas: next.delta ? [...acc.deltas, next.delta] : acc.deltas };
		},
		{ state: adapter.initial, deltas: [] }
	);
}

describe("chat-completions stream errors match the buffered parser", () => {
	test("a per-choice error chunk is a provider error, not a silent finish", () => {
		const chunks: unknown[] = [
			{ choices: [{ delta: { content: "Partial" }, finish_reason: null }] },
			{ choices: [{ delta: {}, finish_reason: "error", error: { code: 502, message: "upstream down" } }] }
		];
		expect(() => run<ChatStreamState>(chatCompletionsStreamAdapter, chunks)).toThrow(StreamProviderError);
		expect(() => run<ChatStreamState>(chatCompletionsStreamAdapter, chunks)).toThrow("upstream down");
	});
});

describe("Anthropic stream text matches the buffered parser", () => {
	test("separate text blocks are joined with a newline, like extractAnthropicText", () => {
		const { state, deltas } = run<AnthropicStreamState>(anthropicStreamAdapter, [
			{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
			{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "First" } },
			{ type: "content_block_stop", index: 0 },
			{ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
			{ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Second" } },
			{ type: "content_block_stop", index: 1 }
		]);
		expect(state.text).toBe("First\nSecond");
		expect(deltas.join("")).toBe("First\nSecond");
		expect(assembleAnthropicBody(state).content).toEqual([{ type: "text", text: "First\nSecond" }]);
	});

	test("a thinking block before the text adds no separator", () => {
		const { state } = run<AnthropicStreamState>(anthropicStreamAdapter, [
			{ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
			{ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hmm" } },
			{ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
			{ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Answer" } }
		]);
		expect(state.text).toBe("Answer");
	});
});

describe("Gemini stream text matches the buffered parser", () => {
	const candidate = (parts: unknown[], finishReason?: string): Record<string, unknown> => ({
		candidates: [{ content: { role: "model", parts }, ...(finishReason ? { finishReason } : {}) }]
	});

	function streamedResult(chunks: unknown[]): { text: string; deltas: string } {
		const { state, deltas } = run<GeminiStreamState>(geminiStreamAdapter, chunks);
		return { text: buildGeminiResult("m", assembleGeminiBody(state)).text, deltas: deltas.join("") };
	}

	test("one reply split across text parts is concatenated without a separator on both paths", () => {
		const buffered = buildGeminiResult("m", candidate([{ text: "Hel" }, { text: "lo world" }], "STOP"));
		const streamed = streamedResult([candidate([{ text: "Hel" }]), candidate([{ text: "lo world" }], "STOP")]);
		expect(buffered.text).toBe("Hello world");
		expect(streamed.text).toBe(buffered.text);
		expect(streamed.deltas).toBe(buffered.text);
	});

	test("Markdown that a part boundary splits stays intact", () => {
		const parts = [{ text: "A **bo" }, { text: "ld** word and `co" }, { text: "de`" }];
		const buffered = buildGeminiResult("m", candidate(parts, "STOP"));
		expect(buffered.text).toBe("A **bold** word and `code`");
		expect(streamedResult(parts.map((part, index) => candidate([part], index === parts.length - 1 ? "STOP" : undefined))).text).toBe(buffered.text);
	});

	test("thought summaries are not answer text on either path", () => {
		const parts = [{ text: "Planning the answer.", thought: true }, { text: "The answer." }];
		const buffered = buildGeminiResult("m", candidate(parts, "STOP"));
		expect(buffered.text).toBe("The answer.");
		expect(streamedResult([candidate(parts, "STOP")])).toEqual({ text: "The answer.", deltas: "The answer." });
	});

	test("only the first candidate is read on both paths", () => {
		const body = {
			candidates: [
				{ content: { parts: [{ text: "First." }] }, finishReason: "STOP" },
				{ content: { parts: [{ text: "Second." }] }, finishReason: "STOP" }
			]
		};
		expect(buildGeminiResult("m", body).text).toBe("First.");
		expect(streamedResult([body]).text).toBe("First.");
	});
});
