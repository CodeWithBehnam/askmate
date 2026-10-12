/**
 * Anthropic Messages API. The assistant turn is stored as the exact ordered content blocks the model produced
 * (thinking with signature, redacted_thinking, text, tool_use) because Claude Sonnet 5.5 thinks by default and rejects
 * a tool loop whose thinking blocks were edited, reordered or dropped.
 */
import { getAnthropicMaxTokens } from "../anthropic";
import { normalizeAnthropicUsage } from "../anthropic-stream";
import type { SseEvent } from "../sse";
import { StreamProviderError, type StreamAdapter } from "../streaming";
import {
	asArray,
	asString,
	isRecord,
	parseToolInput,
	ProviderToolError,
	splitText,
	type Json,
	type JsonObject,
	type StopKind,
	type ToolCall,
	type TurnRequest,
	type TurnResult
} from "./neutral";
import { normaliseToolSchema } from "./schema";

export function buildAnthropicBody(req: TurnRequest, options: { stream: boolean }): JsonObject {
	const messages: Json[] = req.history.map((item): Json => {
		switch (item.kind) {
			case "user":
				return { role: "user", content: [{ type: "text", text: item.text }] };
			case "assistant":
				return {
					role: "assistant",
					content: Array.isArray(item.native)
						? item.native
						: [
							...(item.text ? [{ type: "text", text: item.text }] : []),
							...item.toolCalls.map((call) => ({ type: "tool_use", id: call.id, name: call.name, input: call.input }))
						]
				};
			case "tool_results":
				// One tool_result per tool_use, all in one user message, tool_result blocks first and NO trailing text.
				return {
					role: "user",
					content: item.results.map((result) => ({
						type: "tool_result",
						tool_use_id: result.callId,
						content: result.text,
						...(result.isError ? { is_error: true } : {})
					}))
				};
		}
	});

	return {
		model: req.model,
		max_tokens: req.maxOutputTokens > 0 ? req.maxOutputTokens : getAnthropicMaxTokens(req.model),
		system: req.instructions,
		messages,
		// No `thinking` parameter on purpose: Sonnet 5.5 thinks adaptively by default and rejects "disabled".
		...(req.tools.length > 0
			? {
				tools: req.tools.map((tool) => ({
					name: tool.name,
					description: tool.description,
					input_schema: normaliseToolSchema(tool.inputSchema),
					...(tool.strict === true ? { strict: true } : {})
				})),
				// Only auto and none: type "any" or "tool" is a 400 on Sonnet 5.5 and Opus 5.5.
				tool_choice: req.toolChoice === "none" ? { type: "none" } : { type: "auto", disable_parallel_tool_use: !req.parallelToolCalls }
			}
			: {}),
		...(options.stream ? { stream: true } : {})
	};
}

function mapStop(reason: string | null, hasCalls: boolean): StopKind {
	switch (reason) {
		case "tool_use":
			return "tool_calls";
		case "max_tokens":
		case "model_context_window_exceeded":
			return "truncated";
		case "refusal":
			return "refused";
		case "pause_turn":
			// Only server tools pause; AskMate declares none, so this is unexpected rather than resumable.
			throw new ProviderToolError("paused the turn (pause_turn), which only happens with server tools.");
		default:
			return hasCalls ? "tool_calls" : "end";
	}
}

/** `content` is the array as received, or as assembled from a stream by assembleAnthropicBody. */
export function parseAnthropicBody(body: Record<string, unknown>): TurnResult {
	const content = asArray(body.content).filter(isRecord);
	// Same join as the text path: only text blocks count, so a thinking block between two of them adds nothing.
	const text = content.filter((block) => block.type === "text").map((block) => asString(block.text)).join("\n");
	const toolCalls: ToolCall[] = content.flatMap((block, index): ToolCall[] =>
		block.type === "tool_use" ? [{ id: asString(block.id) || `askmate-${index}`, name: asString(block.name), ...parseToolInput(block.input) }] : []
	);
	const reason = typeof body.stop_reason === "string" ? body.stop_reason : null;
	// A max_tokens stop that ends in a tool_use block means the input was cut off: no call is run.
	const stop = mapStop(reason, toolCalls.length > 0);
	const split = splitText(text, toolCalls);

	return {
		...split,
		toolCalls: stop === "tool_calls" ? toolCalls : [],
		stop,
		providerStopReason: reason,
		usage: normalizeAnthropicUsage(body.usage),
		// The replayed block must carry an object input even when the model's text was not valid JSON.
		native: content.map((block) => (block.type === "tool_use" && typeof block.input === "string" ? { ...block, input: {} } : block)) as Json[]
	};
}

interface BlockState {
	block: Record<string, unknown>;
	/** Accumulated input_json_delta text for tool_use blocks. */
	partial: string;
}

export interface AnthropicToolStreamState {
	blocks: Record<number, BlockState>;
	stopReason: string | null;
	usage: Record<string, unknown>;
	done: boolean;
}

function joinedText(state: AnthropicToolStreamState): string {
	return Object.entries(state.blocks)
		.sort(([a], [b]) => Number(a) - Number(b))
		.filter(([, { block }]) => block.type === "text")
		.map(([, { block }]) => asString(block.text))
		.join("\n");
}

export const anthropicToolStreamAdapter: StreamAdapter<AnthropicToolStreamState> = {
	initial: { blocks: {}, stopReason: null, usage: {}, done: false },
	getText: joinedText,
	getUsage: (state) => {
		// Before message_delta, output_tokens in message_start is only a placeholder.
		if (state.stopReason !== null) {
			return normalizeAnthropicUsage(state.usage);
		}

		const input = state.usage.input_tokens;
		return typeof input === "number" ? { input_tokens: input } : null;
	},
	// message_delta carries the stop reason and message_stop follows at once.
	isTerminal: (state) => state.done || state.stopReason !== null,
	reduce(state, event: SseEvent) {
		let body: unknown;
		try {
			body = JSON.parse(event.data);
		} catch {
			return { state, delta: "" };
		}

		if (!isRecord(body)) {
			return { state, delta: "" };
		}

		const index = typeof body.index === "number" ? body.index : -1;
		const current = state.blocks[index];

		switch (body.type) {
			case "message_start":
				return { state: { ...state, usage: { ...state.usage, ...(isRecord(body.message) && isRecord(body.message.usage) ? body.message.usage : {}) } }, delta: "" };
			case "content_block_start": {
				if (!isRecord(body.content_block)) {
					return { state, delta: "" };
				}

				// A second text block starts on a new line, as the text path and the buffered parser both do.
				const separator = body.content_block.type === "text" && joinedText(state) ? "\n" : "";
				return { state: { ...state, blocks: { ...state.blocks, [index]: { block: { ...body.content_block }, partial: "" } } }, delta: separator };
			}
			case "content_block_delta": {
				if (!current || !isRecord(body.delta)) {
					return { state, delta: "" };
				}

				const d = body.delta;
				const next: BlockState = { block: { ...current.block }, partial: current.partial };
				let delta = "";

				if (d.type === "text_delta") {
					delta = asString(d.text);
					next.block.text = asString(next.block.text) + delta;
				} else if (d.type === "input_json_delta") {
					next.partial += asString(d.partial_json);
				} else if (d.type === "thinking_delta") {
					next.block.thinking = asString(next.block.thinking) + asString(d.thinking);
				} else if (d.type === "signature_delta") {
					next.block.signature = asString(d.signature);
				}

				return { state: { ...state, blocks: { ...state.blocks, [index]: next } }, delta };
			}
			case "message_delta":
				return {
					state: {
						...state,
						stopReason: isRecord(body.delta) && typeof body.delta.stop_reason === "string" ? body.delta.stop_reason : state.stopReason,
						// message_delta usage is cumulative.
						usage: { ...state.usage, ...(isRecord(body.usage) ? body.usage : {}) }
					},
					delta: ""
				};
			case "message_stop":
				return { state: { ...state, done: true }, delta: "" };
			case "error":
				throw new StreamProviderError(isRecord(body.error) && asString(body.error.message) ? asString(body.error.message) : "The provider reported an error.");
			default:
				// ping and unknown events are ignored.
				return { state, delta: "" };
		}
	}
};

/**
 * Rebuilds the ordered content array. tool_use input is parsed from the joined partial_json here, so an empty string is
 * a no-argument call ({}) and unparseable text is kept in the raw form for parseToolInput to report. Only the fields the
 * API accepts back are kept on each block, and empty text blocks are dropped because the API rejects them on replay.
 */
export function assembleAnthropicBody(state: AnthropicToolStreamState): Record<string, unknown> {
	const content = Object.entries(state.blocks)
		.sort(([a], [b]) => Number(a) - Number(b))
		.flatMap(([, { block, partial }]): Record<string, unknown>[] => {
			switch (block.type) {
				case "tool_use": {
					const parsed = parseToolInput(partial);
					// Unparseable input stays as the raw string so parseAnthropicBody reports it; the replayed block uses {}.
					return [{ type: "tool_use", id: block.id, name: block.name, input: parsed.inputError ? partial : parsed.input }];
				}
				case "thinking":
					return [{ type: "thinking", thinking: asString(block.thinking), signature: asString(block.signature) }];
				case "redacted_thinking":
					return [{ type: "redacted_thinking", data: block.data }];
				case "text":
					return asString(block.text) ? [{ type: "text", text: asString(block.text) }] : [];
				default:
					// A block type AskMate does not know is kept as received so the replay stays complete and in order.
					return [{ ...block }];
			}
		});

	return { content, stop_reason: state.stopReason, usage: state.usage };
}
