import { describe, expect, test } from "bun:test";
import { anthropicStreamAdapter, assembleAnthropicBody, type AnthropicStreamState } from "../src/providers/anthropic-stream";
import { chatCompletionsStreamAdapter, type ChatStreamState } from "../src/providers/chat-completions-stream";
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
