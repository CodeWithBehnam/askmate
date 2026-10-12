/**
 * Chat Completions wire format, as served by OpenRouter, Azure AI Foundry, Ollama, LM Studio and other OpenAI-compatible
 * servers. (OpenAI and Azure OpenAI use the Responses API for tool turns.) Each server drifts, so the reducer is
 * deliberately tolerant.
 */
import { extractChatCompletionBodyError, normalizeChatCompletionsUsage } from "../common";
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

export interface ChatQuirks {
	/** Ollama ignores tool_choice; strict servers may reject unknown fields. */
	sendToolChoice: boolean;
	/** Documented for OpenAI and OpenRouter. Unstated for Ollama and LM Studio. */
	sendParallelToolCalls: boolean;
	/** Only hosted providers that document stream_options. */
	includeUsage: boolean;
	/** "max_completion_tokens" for OpenAI reasoning models and Azure OpenAI; "max_tokens" elsewhere. */
	tokenParam: "max_tokens" | "max_completion_tokens";
}

export function buildChatBody(req: TurnRequest, quirks: ChatQuirks, options: { stream: boolean }): JsonObject {
	const messages: Json[] = [
		{ role: "system", content: req.instructions },
		...req.history.flatMap((item): Json[] => {
			switch (item.kind) {
				case "user":
					return [{ role: "user", content: item.text }];
				case "assistant": {
					// native carries OpenRouter reasoning_details; it must be echoed unchanged on the tool-call message.
					const extras = isRecord(item.native) ? item.native : {};
					return [{
						role: "assistant",
						content: item.text ? item.text : null,
						...(item.toolCalls.length > 0
							? {
								tool_calls: item.toolCalls.map((call) => ({
									id: call.id,
									type: "function",
									function: { name: call.name, arguments: call.rawInput }
								}))
							}
							: {}),
						...extras
					}];
				}
				case "tool_results":
					return item.results.map((result) => ({ role: "tool", tool_call_id: result.callId, content: result.text }));
			}
		})
	];

	return {
		model: req.model,
		messages,
		...(req.maxOutputTokens > 0 ? { [quirks.tokenParam]: req.maxOutputTokens } : {}),
		...(req.tools.length > 0
			? {
				tools: req.tools.map((tool) => ({
					type: "function",
					function: { name: tool.name, description: tool.description, parameters: normaliseToolSchema(tool.inputSchema) }
				})),
				...(quirks.sendToolChoice ? { tool_choice: req.toolChoice } : {}),
				...(quirks.sendParallelToolCalls ? { parallel_tool_calls: req.parallelToolCalls } : {})
			}
			: {}),
		...(options.stream ? { stream: true, ...(quirks.includeUsage ? { stream_options: { include_usage: true } } : {}) } : {})
	};
}

function mapFinish(finish: string | null, hasCalls: boolean): StopKind {
	// OpenRouter reports a generation that failed part-way as finish_reason "error", so whatever arrived is cut off.
	if (finish === "length" || finish === "error") {
		return "truncated";
	}

	if (finish === "content_filter") {
		return "blocked";
	}

	// Some local servers answer finish_reason "stop" beside tool_calls, so the calls decide.
	return hasCalls ? "tool_calls" : "end";
}

export function parseChatBody(body: Record<string, unknown>): TurnResult {
	// Some gateways report an upstream failure inside an HTTP 200 body.
	const bodyError = extractChatCompletionBodyError(body);
	if (bodyError) {
		throw new ProviderToolError(`reported an error in its response. Provider message: ${bodyError}`);
	}

	const choice = asArray(body.choices).find(isRecord);
	const message = choice && isRecord(choice.message) ? choice.message : {};
	const toolCalls: ToolCall[] = asArray(message.tool_calls).flatMap((raw, index): ToolCall[] => {
		const fn = isRecord(raw) && isRecord(raw.function) ? raw.function : null;
		return fn
			? [{ id: asString((raw as Record<string, unknown>).id) || `askmate-${index}`, name: asString(fn.name), ...parseToolInput(fn.arguments) }]
			: [];
	});
	const finish = choice && typeof choice.finish_reason === "string" ? choice.finish_reason : null;
	const nameless = toolCalls.some((call) => !call.name);
	const { text, narration } = splitText(asString(message.content), toolCalls);
	const mapped = mapFinish(finish, toolCalls.length > 0);
	// A call with no name cannot be answered or replayed, so the whole turn is malformed rather than half-run.
	const stop: StopKind = mapped === "tool_calls" && nameless
		? "malformed_call"
		: asString(message.refusal) && !text && toolCalls.length === 0 && mapped === "end"
			? "refused"
			: mapped;
	const native: JsonObject = Array.isArray(message.reasoning_details) ? { reasoning_details: message.reasoning_details as Json[] } : {};

	return {
		text,
		narration,
		toolCalls: stop === "tool_calls" ? toolCalls : [],
		stop,
		providerStopReason: finish,
		usage: normalizeChatCompletionsUsage(body.usage),
		native
	};
}

interface CallSlot {
	id: string;
	name: string;
	args: string;
}

export interface ChatToolStreamState {
	text: string;
	slots: CallSlot[];
	/** Server tool_call index to our slot, so an Ollama stream that reuses index 0 can still be told apart by id. */
	slotByIndex: Record<number, number>;
	finish: string | null;
	usage: unknown;
	reasoningDetails: Record<number, JsonObject>;
	done: boolean;
}

export const chatToolStreamAdapter: StreamAdapter<ChatToolStreamState> = {
	initial: { text: "", slots: [], slotByIndex: {}, finish: null, usage: null, reasoningDetails: {}, done: false },
	getText: (state) => state.text,
	getUsage: (state) => normalizeChatCompletionsUsage(state.usage),
	isTerminal: (state) => state.done || state.finish !== null,
	reduce(state, event: SseEvent) {
		if (event.data.trim() === "[DONE]") {
			return { state: { ...state, done: true }, delta: "" };
		}

		let body: unknown;
		try {
			body = JSON.parse(event.data);
		} catch {
			return { state, delta: "" };
		}

		if (!isRecord(body)) {
			return { state, delta: "" };
		}

		// Same rule as the text path: an error at the top level or on a choice ends the reply as a failure.
		const bodyError = extractChatCompletionBodyError(body);
		if (bodyError) {
			throw new StreamProviderError(bodyError);
		}

		const choice = asArray(body.choices).find(isRecord);
		const delta = choice && isRecord(choice.delta) ? choice.delta : {};
		const content = typeof delta.content === "string" ? delta.content : "";
		const slots = state.slots.map((slot) => ({ ...slot }));
		const slotByIndex = { ...state.slotByIndex };

		for (const raw of asArray(delta.tool_calls)) {
			if (!isRecord(raw)) {
				continue;
			}

			const index = typeof raw.index === "number" ? raw.index : slots.length > 0 ? slots.length - 1 : 0;
			const id = typeof raw.id === "string" ? raw.id : "";
			let slotIndex = slotByIndex[index];

			// A new non-empty id on an index that already holds a different id is a new call (Ollama reuses index 0).
			if (slotIndex === undefined || (id && slots[slotIndex].id && slots[slotIndex].id !== id)) {
				slotIndex = slots.length;
				slots.push({ id: "", name: "", args: "" });
				slotByIndex[index] = slotIndex;
			}

			const slot = slots[slotIndex];
			const fn = isRecord(raw.function) ? raw.function : {};
			slot.id ||= id;
			slot.name ||= asString(fn.name);
			// null, "" and object forms all occur; objects replace, strings append.
			if (typeof fn.arguments === "string") {
				slot.args += fn.arguments;
			} else if (isRecord(fn.arguments)) {
				slot.args = JSON.stringify(fn.arguments);
			}
		}

		const reasoningDetails = { ...state.reasoningDetails };
		for (const detail of asArray(delta.reasoning_details)) {
			if (isRecord(detail) && typeof detail.index === "number") {
				const previous = reasoningDetails[detail.index] ?? {};
				// Text, summary and data concatenate; id, format and signature keep the latest value.
				const merged: JsonObject = { ...previous, ...(detail as JsonObject) };
				for (const key of ["text", "summary", "data"]) {
					const before = previous[key];
					const after = detail[key];
					if (typeof before === "string" && typeof after === "string") {
						merged[key] = before + after;
					}
				}
				reasoningDetails[detail.index] = merged;
			}
		}

		return {
			state: {
				...state,
				text: state.text + content,
				slots,
				slotByIndex,
				reasoningDetails,
				finish: choice && typeof choice.finish_reason === "string" && choice.finish_reason ? choice.finish_reason : state.finish,
				usage: isRecord(body.usage) ? body.usage : state.usage
			},
			delta: content
		};
	}
};

export function assembleChatBody(state: ChatToolStreamState): Record<string, unknown> {
	const details = Object.entries(state.reasoningDetails).sort(([a], [b]) => Number(a) - Number(b)).map(([, detail]) => detail);

	return {
		choices: [{
			message: {
				content: state.text,
				...(state.slots.length > 0
					? {
						// Nameless slots are kept: parseChatBody turns them into a malformed turn instead of a silent drop.
						tool_calls: state.slots.map((slot) => ({ id: slot.id, type: "function", function: { name: slot.name, arguments: slot.args } }))
					}
					: {}),
				...(details.length > 0 ? { reasoning_details: details } : {})
			},
			finish_reason: state.finish
		}],
		usage: state.usage
	};
}
