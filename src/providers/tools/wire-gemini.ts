/**
 * Gemini generateContent / streamGenerateContent?alt=sse (v1beta). The model turn is kept as the exact ordered parts,
 * because Gemini 3 answers 400 when a functionCall part loses its thoughtSignature or changes position.
 */
import { getGeminiPromptBlockReason, normalizeGeminiUsage } from "../google-gemini-stream";
import type { SseEvent } from "../sse";
import { StreamProviderError, type StreamAdapter } from "../streaming";
import {
	asArray,
	asString,
	isRecord,
	splitText,
	type Json,
	type JsonObject,
	type StopKind,
	type ToolCall,
	type TurnRequest,
	type TurnResult
} from "./neutral";
import { prepareGeminiJsonSchema, toGeminiOpenApiSchema } from "./schema";

/** Ids we invent for Gemini 2.5, which sends none. They are matched by name and order, and never put on the wire. */
export const SYNTHETIC_ID_PREFIX = "askmate-";

/**
 * `parametersJsonSchema` takes full JSON Schema. `parameters` is the older OpenAPI 3.0 subset, kept as the one retry for
 * an endpoint that answers 400 "Unknown name" for the newer field.
 */
export type GeminiSchemaDialect = "json-schema" | "openapi";

export interface GeminiBodyOptions {
	schemaDialect?: GeminiSchemaDialect;
}

export function buildGeminiBody(req: TurnRequest, options: GeminiBodyOptions = {}): JsonObject {
	const dialect = options.schemaDialect ?? "json-schema";
	const contents: Json[] = req.history.map((item): Json => {
		switch (item.kind) {
			case "user":
				return { role: "user", parts: [{ text: item.text }] };
			case "assistant":
				return {
					role: "model",
					parts: isRecord(item.native) && Array.isArray(item.native.parts)
						? item.native.parts
						: [
							...(item.text ? [{ text: item.text }] : []),
							...item.toolCalls.map((call) => ({ functionCall: { name: call.name, args: call.input } }))
						]
				};
			case "tool_results":
				// All responses to one model turn go together in ONE user content, after the calls (no FC1, FR1, FC2, FR2).
				return {
					role: "user",
					parts: item.results.map((result): JsonObject => {
						const response: JsonObject = result.isError ? { error: result.text } : { result: result.text };
						const functionResponse: JsonObject = result.callId.startsWith(SYNTHETIC_ID_PREFIX)
							? { name: result.name, response }
							: { id: result.callId, name: result.name, response };
						return { functionResponse };
					})
				};
		}
	});

	return {
		systemInstruction: { parts: [{ text: req.instructions }] },
		contents,
		...(req.maxOutputTokens > 0 ? { generationConfig: { maxOutputTokens: req.maxOutputTokens } } : {}),
		...(req.tools.length > 0
			? {
				tools: [{
					functionDeclarations: req.tools.map((tool) => ({
						name: tool.name,
						description: tool.description,
						...(dialect === "openapi"
							? { parameters: toGeminiOpenApiSchema(tool.inputSchema) }
							: { parametersJsonSchema: prepareGeminiJsonSchema(tool.inputSchema) })
					}))
				}],
				// AUTO or NONE only. ANY and VALIDATED force calls and reject large or deeply nested schemas.
				toolConfig: { functionCallingConfig: { mode: req.toolChoice === "none" ? "NONE" : "AUTO" } }
			}
			: {})
	};
}

/** Finish reasons that mean the model tried to call a tool and the call is unusable. */
const MALFORMED_CALL_REASONS = new Set(["MALFORMED_FUNCTION_CALL", "UNEXPECTED_TOOL_CALL", "TOO_MANY_TOOL_CALLS", "MISSING_THOUGHT_SIGNATURE"]);
const BLOCKED_REASONS = new Set([
	"SAFETY",
	"RECITATION",
	"BLOCKLIST",
	"PROHIBITED_CONTENT",
	"SPII",
	"LANGUAGE",
	"OTHER",
	"IMAGE_SAFETY",
	"IMAGE_PROHIBITED_CONTENT",
	"IMAGE_RECITATION",
	"IMAGE_OTHER",
	"NO_IMAGE"
]);

function mapFinish(reason: string | null, blockReason: string | null, hasCalls: boolean): StopKind {
	if (blockReason) {
		return "blocked";
	}

	if (reason === "MAX_TOKENS") {
		return "truncated";
	}

	if (reason !== null && MALFORMED_CALL_REASONS.has(reason)) {
		return "malformed_call";
	}

	if (reason !== null && BLOCKED_REASONS.has(reason)) {
		return "blocked";
	}

	return hasCalls ? "tool_calls" : "end";
}

export function parseGeminiBody(body: Record<string, unknown>): TurnResult {
	const candidate = asArray(body.candidates).find(isRecord);
	const content = candidate && isRecord(candidate.content) ? candidate.content : {};
	const parts = asArray(content.parts).filter(isRecord);
	// functionCall parts can sit anywhere in the list, so every part is inspected. Thought summaries are not answer text.
	const text = parts.map((part) => (part.thought === true ? "" : asString(part.text))).join("");
	const toolCalls: ToolCall[] = parts.flatMap((part, index): ToolCall[] => {
		const call = isRecord(part.functionCall) ? part.functionCall : null;
		if (!call) {
			return [];
		}

		const args = isRecord(call.args) ? (call.args as JsonObject) : {};
		return [{ id: asString(call.id) || `${SYNTHETIC_ID_PREFIX}${index}`, name: asString(call.name), input: args, rawInput: JSON.stringify(args) }];
	});
	const reason = candidate && typeof candidate.finishReason === "string" ? candidate.finishReason : null;
	const feedback = getGeminiPromptBlockReason(body);
	const stop = mapFinish(reason, feedback, toolCalls.length > 0);

	return {
		...splitText(text, toolCalls),
		toolCalls: stop === "tool_calls" ? toolCalls : [],
		stop,
		providerStopReason: reason ?? feedback,
		usage: normalizeGeminiUsage(body.usageMetadata),
		native: { parts } as Json
	};
}

export interface GeminiToolStreamState {
	parts: Record<string, unknown>[];
	finishReason: string | null;
	usageMetadata: unknown;
	promptFeedback: unknown;
}

function isPlainText(part: Record<string, unknown>): boolean {
	const keys = Object.keys(part);
	return keys.length === 1 && keys[0] === "text" && typeof part.text === "string";
}

function answerText(parts: readonly Record<string, unknown>[]): string {
	return parts.map((part) => (part.thought === true ? "" : asString(part.text))).join("");
}

export const geminiToolStreamAdapter: StreamAdapter<GeminiToolStreamState> = {
	initial: { parts: [], finishReason: null, usageMetadata: null, promptFeedback: null },
	getText: (state) => answerText(state.parts),
	getUsage: (state) => normalizeGeminiUsage(state.usageMetadata),
	isTerminal: (state) => state.finishReason !== null || getGeminiPromptBlockReason({ promptFeedback: state.promptFeedback }) !== null,
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

		if (isRecord(body.error)) {
			throw new StreamProviderError(asString(body.error.message) || "The provider reported an error.");
		}

		const candidate = asArray(body.candidates).find(isRecord);
		const incoming = candidate && isRecord(candidate.content) ? asArray(candidate.content.parts).filter(isRecord) : [];
		const parts = state.parts.map((part) => ({ ...part }));
		let delta = "";

		for (const part of incoming) {
			const last = parts[parts.length - 1];

			// Merge only adjacent unsigned plain text. A part carrying thoughtSignature (even with empty text) stays separate.
			if (isPlainText(part) && last && isPlainText(last)) {
				last.text = asString(last.text) + asString(part.text);
			} else {
				parts.push({ ...part });
			}

			if (part.thought !== true && typeof part.text === "string") {
				delta += part.text;
			}
		}

		return {
			state: {
				parts,
				finishReason: candidate && typeof candidate.finishReason === "string" && candidate.finishReason ? candidate.finishReason : state.finishReason,
				usageMetadata: isRecord(body.usageMetadata) ? body.usageMetadata : state.usageMetadata,
				promptFeedback: isRecord(body.promptFeedback) ? body.promptFeedback : state.promptFeedback
			},
			delta
		};
	}
};

export function assembleGeminiBody(state: GeminiToolStreamState): Record<string, unknown> {
	return {
		candidates: [{ content: { role: "model", parts: state.parts }, ...(state.finishReason ? { finishReason: state.finishReason } : {}) }],
		usageMetadata: state.usageMetadata,
		...(state.promptFeedback ? { promptFeedback: state.promptFeedback } : {})
	};
}
