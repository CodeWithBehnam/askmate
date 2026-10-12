/**
 * Provider-neutral tool-calling model for AskMate. Pure types and helpers only; no I/O.
 * Every wire format (Responses, Chat Completions, Anthropic Messages, Gemini generateContent) maps to and from these.
 */
import type { TextProviderId } from "../../shared/core";

/** The providers AskMate can call. Tool turns accept exactly the ids the text path does. */
export type ProviderId = TextProviderId;

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

/** Same shape as the token usage the rest of AskMate records, so a loop total can go straight into a usage record. */
export interface Usage {
	input_tokens?: number;
	output_tokens?: number;
	total_tokens?: number;
	input_tokens_details?: { cached_tokens?: number };
	output_tokens_details?: { reasoning_tokens?: number };
}

/** What the model is shown. `name` is always wire-safe and unique within one run; see buildToolNameMap. */
export interface ToolSpec {
	name: string;
	description: string;
	/** JSON Schema with type "object" at the root. */
	inputSchema: JsonObject;
	/** True only for first-party tools whose schema is authored strict-compatible. Never true for MCP tools. */
	strict?: boolean;
}

export interface ToolCall {
	/** Provider call id (call_id, tool_use id, tool_call id) or a synthesised "askmate-N" id when the provider has none. */
	id: string;
	name: string;
	input: JsonObject;
	/** The exact argument text the model produced; replayed verbatim on Chat Completions. */
	rawInput: string;
	/** Set when rawInput is not a JSON object. The loop must still answer the call, with an error result. */
	inputError?: string;
}

export interface ToolResult {
	callId: string;
	name: string;
	/** Text only in v1. The loop truncates this before it reaches a provider. */
	text: string;
	isError: boolean;
}

/** Forced choices are deliberately absent: Claude Sonnet 5.5 and Opus 5.5 answer HTTP 400, Ollama ignores tool_choice. */
export type ToolChoice = "auto" | "none";

export type HistoryItem =
	| { kind: "user"; text: string }
	| {
		kind: "assistant";
		text: string;
		toolCalls: readonly ToolCall[];
		/** Provider-native replay payload (Responses output items, Anthropic content blocks, Gemini parts, Chat extras). Opaque, memory only. */
		native: Json;
	}
	| { kind: "tool_results"; results: readonly ToolResult[] };

export interface TurnRequest {
	model: string;
	instructions: string;
	history: readonly HistoryItem[];
	tools: readonly ToolSpec[];
	toolChoice: ToolChoice;
	parallelToolCalls: boolean;
	/** 0 omits the cap. Responses and Gemini count reasoning tokens against it, so AskMate sends none by default. */
	maxOutputTokens: number;
	/** Already clamped for the model. Null omits the parameter, and with it the encrypted reasoning replay on Responses. */
	reasoningEffort: string | null;
}

export type StopKind = "end" | "tool_calls" | "truncated" | "refused" | "blocked" | "malformed_call";

export interface TurnResult {
	/** Text eligible to be the final answer. Empty when the turn requested tools. */
	text: string;
	/** Progress narration such as "I will check the note first". Never part of the answer, never applied to a note. */
	narration: string;
	/** Always empty unless `stop` is "tool_calls": a truncated, blocked or malformed turn never has a call to run. */
	toolCalls: ToolCall[];
	stop: StopKind;
	providerStopReason: string | null;
	usage: Usage | null;
	native: Json;
}

export class ProviderToolError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ProviderToolError";
	}
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asArray(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

export function asString(value: unknown): string {
	return typeof value === "string" ? value : "";
}

/** Narration/answer split used by every adapter: text beside tool calls is narration, never the answer. */
export function splitText(text: string, toolCalls: readonly ToolCall[], commentary = ""): { text: string; narration: string } {
	const clean = text.trim();
	const narration = commentary.trim();
	return toolCalls.length > 0
		? { text: "", narration: [narration, clean].filter(Boolean).join("\n") }
		: { text: clean, narration };
}

/**
 * Tool arguments arrive as text (OpenAI, Anthropic stream) or as an object (Gemini, some local servers).
 * Empty text means a no-argument tool. Anything that is not a JSON object is reported, not guessed at.
 */
export function parseToolInput(raw: unknown): { input: JsonObject; rawInput: string; inputError?: string } {
	if (isRecord(raw)) {
		return { input: raw as JsonObject, rawInput: JSON.stringify(raw) };
	}

	const rawInput = typeof raw === "string" ? raw : "";

	if (!rawInput.trim()) {
		return { input: {}, rawInput: "{}" };
	}

	try {
		const parsed: unknown = JSON.parse(rawInput);
		return isRecord(parsed)
			? { input: parsed as JsonObject, rawInput }
			: { input: {}, rawInput, inputError: "Tool arguments must be a JSON object." };
	} catch {
		return { input: {}, rawInput, inputError: "Tool arguments were not valid JSON." };
	}
}

export function addUsage(a: Usage | null, b: Usage | null): Usage | null {
	if (!a || !b) {
		return a ?? b;
	}

	const sum = (x?: number, y?: number): number | undefined => (x === undefined && y === undefined ? undefined : (x ?? 0) + (y ?? 0));
	const cached = sum(a.input_tokens_details?.cached_tokens, b.input_tokens_details?.cached_tokens);
	const reasoning = sum(a.output_tokens_details?.reasoning_tokens, b.output_tokens_details?.reasoning_tokens);

	return {
		input_tokens: sum(a.input_tokens, b.input_tokens),
		output_tokens: sum(a.output_tokens, b.output_tokens),
		total_tokens: sum(a.total_tokens, b.total_tokens),
		...(cached !== undefined ? { input_tokens_details: { cached_tokens: cached } } : {}),
		...(reasoning !== undefined ? { output_tokens_details: { reasoning_tokens: reasoning } } : {})
	};
}

/** Reads a usage object whose fields are named like OpenAI's, keeping only well-formed non-negative numbers. */
export function readOpenAIStyleUsage(value: unknown, names: { input: string; output: string; total: string }): Usage | null {
	if (!isRecord(value)) {
		return null;
	}

	const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);
	const inputDetails = isRecord(value.input_tokens_details) ? value.input_tokens_details : isRecord(value.prompt_tokens_details) ? value.prompt_tokens_details : null;
	const outputDetails = isRecord(value.output_tokens_details) ? value.output_tokens_details : isRecord(value.completion_tokens_details) ? value.completion_tokens_details : null;
	const cached = num(inputDetails?.cached_tokens);
	const reasoning = num(outputDetails?.reasoning_tokens);

	return {
		input_tokens: num(value[names.input]),
		output_tokens: num(value[names.output]),
		total_tokens: num(value[names.total]),
		...(cached !== undefined ? { input_tokens_details: { cached_tokens: cached } } : {}),
		...(reasoning !== undefined ? { output_tokens_details: { reasoning_tokens: reasoning } } : {})
	};
}
