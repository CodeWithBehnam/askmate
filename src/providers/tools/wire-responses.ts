/**
 * OpenAI Responses API (OpenAI, and Azure OpenAI at {resource}/openai/v1/responses with an `api-key` header).
 * Stateless by design: store is false, previous_response_id is never used, and the loop replays output items itself.
 */
import type { SseEvent } from "../sse";
import { StreamProviderError, type StreamAdapter } from "../streaming";
import {
	asArray,
	asString,
	isRecord,
	parseToolInput,
	ProviderToolError,
	readOpenAIStyleUsage,
	splitText,
	type Json,
	type JsonObject,
	type StopKind,
	type ToolCall,
	type TurnRequest,
	type TurnResult
} from "./neutral";
import { normaliseToolSchema } from "./schema";

export function buildResponsesBody(req: TurnRequest, options: { stream: boolean }): JsonObject {
	const input: Json[] = req.history.flatMap((item): Json[] => {
		switch (item.kind) {
			case "user":
				return [{ role: "user", content: [{ type: "input_text", text: item.text }] }];
			case "assistant":
				// Verbatim replay of the filtered output items, including reasoning and each message's `phase`.
				return Array.isArray(item.native) ? item.native : [];
			case "tool_results":
				return item.results.map((result) => ({ type: "function_call_output", call_id: result.callId, output: result.text }));
		}
	});

	return {
		model: req.model,
		instructions: req.instructions,
		input,
		store: false,
		// Reasoning items come back encrypted only when asked for, and only reasoning models accept the request ("Encrypted
		// content is not supported with this model" otherwise), so it follows the reasoning parameter.
		...(req.reasoningEffort ? { include: ["reasoning.encrypted_content"], reasoning: { effort: req.reasoningEffort } } : {}),
		// Reasoning tokens count against this cap, so a low value can cut a tool call off. 0 omits it (AskMate sets none today).
		...(req.maxOutputTokens > 0 ? { max_output_tokens: req.maxOutputTokens } : {}),
		...(req.tools.length > 0
			? {
				// Flat shape: name, description and parameters sit beside `type`, unlike Chat Completions.
				tools: req.tools.map((tool) => ({
					type: "function",
					name: tool.name,
					description: tool.description,
					parameters: normaliseToolSchema(tool.inputSchema),
					// Explicit false for MCP schemas: omitting it lets the API rewrite the schema (all keys required) to fit strict mode.
					strict: tool.strict === true
				})),
				tool_choice: req.toolChoice,
				parallel_tool_calls: req.parallelToolCalls
			}
			: {}),
		...(options.stream ? { stream: true } : {})
	};
}

/** Reasoning items without encrypted_content cannot be replayed under store:false (404 "Item with id rs_... not found"). */
export function filterReplayItems(output: readonly unknown[]): Json[] {
	return output.filter((item): item is JsonObject => {
		if (!isRecord(item)) {
			return false;
		}

		if (item.type === "reasoning") {
			return typeof item.encrypted_content === "string" && item.encrypted_content.length > 0;
		}

		return item.type === "message" || item.type === "function_call";
	});
}

export function parseResponsesBody(body: Record<string, unknown>): TurnResult {
	if (body.status === "failed") {
		const message = isRecord(body.error) ? asString(body.error.message) : "";
		throw new ProviderToolError(message ? `could not complete the response. Provider message: ${message}` : "could not complete the response.");
	}

	const output = asArray(body.output);
	const answer: string[] = [];
	const commentary: string[] = [];
	const toolCalls: ToolCall[] = [];
	let refusal = "";
	let partialCall = false;

	output.forEach((item, index) => {
		if (!isRecord(item)) {
			return;
		}

		if (item.type === "message") {
			const parts = asArray(item.content);
			const text = parts.map((part) => (isRecord(part) && part.type === "output_text" ? asString(part.text) : "")).join("");
			refusal ||= parts.map((part) => (isRecord(part) && part.type === "refusal" ? asString(part.refusal) : "")).join("");
			(item.phase === "commentary" ? commentary : answer).push(text);
		} else if (item.type === "function_call") {
			// Fail closed: a call that is not completed may carry cut-off arguments.
			if (item.status !== undefined && item.status !== "completed") {
				partialCall = true;
				return;
			}

			toolCalls.push({
				id: asString(item.call_id) || asString(item.id) || `askmate-${index}`,
				name: asString(item.name),
				...parseToolInput(item.arguments)
			});
		}
	});

	const incompleteReason = body.status === "incomplete" && isRecord(body.incomplete_details) ? asString(body.incomplete_details.reason) || "unknown" : null;
	const { text, narration } = splitText(answer.join("\n"), toolCalls, commentary.join("\n"));
	const stop: StopKind = refusal && !text && toolCalls.length === 0
		? "refused"
		: incompleteReason === "content_filter"
			? "blocked"
			: incompleteReason || partialCall
				? "truncated"
				: toolCalls.length > 0
					? "tool_calls"
					: "end";

	return {
		text,
		narration,
		toolCalls: stop === "tool_calls" ? toolCalls : [],
		stop,
		providerStopReason: incompleteReason,
		usage: readOpenAIStyleUsage(body.usage, { input: "input_tokens", output: "output_tokens", total: "total_tokens" }),
		native: filterReplayItems(output)
	};
}

export interface ResponsesToolStreamState {
	/** Finished items by output_index; the primary source of function calls. */
	done: Record<number, unknown>;
	final: Record<string, unknown> | null;
	text: string;
}

const TERMINAL = new Set(["response.completed", "response.incomplete", "response.failed"]);

export const responsesToolStreamAdapter: StreamAdapter<ResponsesToolStreamState> = {
	initial: { done: {}, final: null, text: "" },
	getText: (state) => state.text,
	isTerminal: (state) => state.final !== null,
	reduce(state, event: SseEvent) {
		let body: unknown;
		try {
			body = JSON.parse(event.data);
		} catch {
			return { state, delta: "" };
		}

		if (!isRecord(body) || typeof body.type !== "string") {
			return { state, delta: "" };
		}

		const index = typeof body.output_index === "number" ? body.output_index : -1;

		switch (body.type) {
			case "response.output_item.done":
				return isRecord(body.item) ? { state: { ...state, done: { ...state.done, [index]: body.item } }, delta: "" } : { state, delta: "" };
			case "response.output_text.delta": {
				const delta = asString(body.delta);
				return { state: { ...state, text: state.text + delta }, delta };
			}
			case "error":
				throw new StreamProviderError(asString(body.message) || "The provider reported an error.");
			default:
				return TERMINAL.has(body.type) && isRecord(body.response)
					? { state: { ...state, final: body.response }, delta: "" }
					: { state, delta: "" };
		}
	}
};

/**
 * Builds the response body from streamed items. Items finished by output_item.done win over response.completed.output,
 * which some gateways send empty or null even after the items streamed (LiteLLM, 9router, Hermes reports) or number
 * differently (vLLM, Ollama). Never merging the two is deliberate: a call present in both under different ids would run
 * twice. Streamed text with no message item at all becomes one, so the answer is not lost.
 */
export function assembleResponsesBody(state: ResponsesToolStreamState): Record<string, unknown> {
	if (!state.final) {
		throw new ProviderToolError("closed the connection before the reply finished.");
	}

	const finished = Object.entries(state.done).sort(([a], [b]) => Number(a) - Number(b)).map(([, item]) => item).filter(isRecord);
	const items: Record<string, unknown>[] = finished.length > 0 ? finished : asArray(state.final.output).filter(isRecord);
	const hasMessage = items.some((item) => item.type === "message");
	const output = !hasMessage && state.text
		? [...items, { type: "message", role: "assistant", content: [{ type: "output_text", text: state.text }] }]
		: items;

	return { ...state.final, output };
}
