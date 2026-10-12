/**
 * Maps each provider to the wire format that carries its tool turns, and says which models can take tools at all.
 * OpenAI and Azure OpenAI use the Responses API (Azure's chat completions endpoint rejects tools with reasoning effort on
 * newer models). OpenRouter, Azure AI Foundry and local servers use Chat Completions. Anthropic and Gemini use their own.
 */
import type { ApiEndpoint } from "../../shared/core";
import { isOpenAITextModel } from "../../shared/modelCapabilities";
import type { StreamAdapter } from "../streaming";
import type { JsonObject, ProviderId, TurnRequest, TurnResult } from "./neutral";
import {
	anthropicToolStreamAdapter,
	assembleAnthropicBody,
	buildAnthropicBody,
	parseAnthropicBody,
	type AnthropicToolStreamState
} from "./wire-anthropic";
import {
	assembleChatBody,
	buildChatBody,
	chatToolStreamAdapter,
	parseChatBody,
	type ChatQuirks,
	type ChatToolStreamState
} from "./wire-chat";
import {
	assembleGeminiBody,
	buildGeminiBody,
	geminiToolStreamAdapter,
	parseGeminiBody,
	type GeminiSchemaDialect,
	type GeminiToolStreamState
} from "./wire-gemini";
import {
	assembleResponsesBody,
	buildResponsesBody,
	parseResponsesBody,
	responsesToolStreamAdapter,
	type ResponsesToolStreamState
} from "./wire-responses";

export type ToolWireFamily = "responses" | "chat" | "anthropic" | "gemini";

export interface ToolBodyOptions {
	stream: boolean;
	/** Gemini only: which schema field the declarations use. Defaults to the full JSON Schema one. */
	schemaDialect?: GeminiSchemaDialect;
}

/** Everything a transport needs from a wire format, with no I/O of its own. */
export interface ToolWireAdapter<S = unknown> {
	readonly family: ToolWireFamily;
	/** The endpoint to record in usage history. */
	readonly endpoint: ApiEndpoint;
	buildBody(request: TurnRequest, options: ToolBodyOptions): JsonObject;
	/** Parses a buffered reply, or a stream assembled by `assembleBody`. */
	parseBody(body: Record<string, unknown>): TurnResult;
	readonly stream: StreamAdapter<S>;
	assembleBody(state: S): Record<string, unknown>;
}

/**
 * The state type of a stream is private to its adapter: a caller only ever hands a state back to the adapter that made it,
 * so the registry can hold all of them under one type.
 */
function erase<S>(adapter: ToolWireAdapter<S>): ToolWireAdapter {
	return adapter as unknown as ToolWireAdapter;
}

const RESPONSES_ADAPTER = erase<ResponsesToolStreamState>({
	family: "responses",
	endpoint: "responses",
	buildBody: (request, options) => buildResponsesBody(request, options),
	parseBody: parseResponsesBody,
	stream: responsesToolStreamAdapter,
	assembleBody: assembleResponsesBody
});

const ANTHROPIC_ADAPTER = erase<AnthropicToolStreamState>({
	family: "anthropic",
	endpoint: "anthropic_messages",
	buildBody: (request, options) => buildAnthropicBody(request, options),
	parseBody: parseAnthropicBody,
	stream: anthropicToolStreamAdapter,
	assembleBody: assembleAnthropicBody
});

const GEMINI_ADAPTER = erase<GeminiToolStreamState>({
	family: "gemini",
	endpoint: "gemini_generate_content",
	buildBody: (request, options) => buildGeminiBody(request, { schemaDialect: options.schemaDialect }),
	parseBody: parseGeminiBody,
	stream: geminiToolStreamAdapter,
	assembleBody: assembleGeminiBody
});

function chatAdapter(quirks: ChatQuirks): ToolWireAdapter {
	return erase<ChatToolStreamState>({
		family: "chat",
		endpoint: "chat_completions",
		buildBody: (request, options) => buildChatBody(request, quirks, options),
		parseBody: parseChatBody,
		stream: chatToolStreamAdapter,
		assembleBody: assembleChatBody
	});
}

/**
 * Chat Completions drifts per server. OpenRouter documents tool_choice, parallel_tool_calls and stream_options. Foundry
 * documents tool_choice only. A local server may ignore tool_choice (Ollama) or reject fields it does not know, so it is
 * sent nothing it was not asked for.
 */
export const CHAT_QUIRKS: Readonly<Record<"openrouter" | "azure-ai" | "openai-compatible", ChatQuirks>> = {
	openrouter: { sendToolChoice: true, sendParallelToolCalls: true, includeUsage: true, tokenParam: "max_tokens" },
	"azure-ai": { sendToolChoice: true, sendParallelToolCalls: false, includeUsage: false, tokenParam: "max_tokens" },
	"openai-compatible": { sendToolChoice: false, sendParallelToolCalls: false, includeUsage: false, tokenParam: "max_tokens" }
};

const CHAT_ADAPTERS: Readonly<Record<keyof typeof CHAT_QUIRKS, ToolWireAdapter>> = {
	openrouter: chatAdapter(CHAT_QUIRKS.openrouter),
	"azure-ai": chatAdapter(CHAT_QUIRKS["azure-ai"]),
	"openai-compatible": chatAdapter(CHAT_QUIRKS["openai-compatible"])
};

export function getToolWireAdapter(providerId: ProviderId): ToolWireAdapter {
	switch (providerId) {
		case "openai":
		case "azure-openai":
			return RESPONSES_ADAPTER;
		case "anthropic":
			return ANTHROPIC_ADAPTER;
		case "google-gemini":
			return GEMINI_ADAPTER;
		case "openrouter":
		case "azure-ai":
		case "openai-compatible":
			return CHAT_ADAPTERS[providerId];
		default: {
			// A new provider must be wired here explicitly rather than falling through to another provider's wire format.
			const unhandled: never = providerId;
			throw new Error(`Unsupported text provider: ${String(unhandled)}`);
		}
	}
}

/** Models that cannot take tools at all, by provider. Everything else is assumed capable and is gated by the user's own toggle. */
const TOOL_UNSUPPORTED: Readonly<Partial<Record<ProviderId, RegExp>>> = {
	// The first o1 previews, and the Claude 1 and 2 generations, predate function calling.
	anthropic: /^claude-(?:1|2|instant)(?:$|[-.])/i,
	// Gemma and the media models on the same API take no function declarations.
	"google-gemini": /(?:gemma|imagen|veo|embedding|tts|native-audio|live|-image|aqa)/i
};
const OPENAI_TOOL_UNSUPPORTED = /^o1-(?:mini|preview)(?:$|-)/i;

/**
 * Whether AskMate can offer tools for this provider and model. This is a floor, not a promise: a local model without a
 * tool template answers HTTP 400 and the host offers to continue without tools. Azure deployments are named by the user,
 * so any non-empty name is accepted.
 */
export function supportsTools(providerId: ProviderId, model: string): boolean {
	const id = model.trim();

	if (!id) {
		return false;
	}

	if (providerId === "openai") {
		return isOpenAITextModel(id) && !OPENAI_TOOL_UNSUPPORTED.test(id);
	}

	const unsupported = TOOL_UNSUPPORTED[providerId];
	return unsupported ? !unsupported.test(id) : true;
}
