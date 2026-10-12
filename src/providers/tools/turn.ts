/**
 * One tool-capable model turn over HTTP: resolves the endpoint and headers for a provider, sends the body its wire adapter
 * builds, streams when it can and falls back to a buffered request, and hands back a neutral TurnResult. The text-only
 * paths in the sibling files are untouched; nothing here runs unless a caller asks for a tool turn.
 */
import type { ApiEndpoint, ProviderModelRef, ReasoningEffort } from "../../shared/core";
import { getSupportedReasoningEffort } from "../../shared/modelCapabilities";
import { ANTHROPIC_API_VERSION, ANTHROPIC_BUFFERED_TIMEOUT_MS, ANTHROPIC_GENERATION_TIMEOUT_MS, getAnthropicBaseUrl, getAnthropicMaxTokens } from "../anthropic";
import { AZURE_AI_INFERENCE_API_VERSION, getAzureAIBaseUrl, getAzureAIHeaders } from "../azure-ai";
import { getAzureOpenAIBaseUrl, getAzureOpenAIHeaders } from "../azure-open-ai";
import { describeProviderErrorBody, formatProviderHttpError, formatTimeoutDuration, getSecretHeaderValues, redactSecrets } from "../common";
import { getGeminiBaseUrl } from "../google-gemini";
import { getOpenAICompatibleBaseUrl } from "../open-ai-compatible";
import { getOpenAIBaseUrl, getReasoningEffortTimeoutMs, joinOpenAIUrl } from "../open-ai";
import { getOpenRouterBaseUrl } from "../open-router";
import { runTextStream } from "../streaming";
import type { ProviderRuntime } from "../types";
import { getToolWireAdapter, type ToolWireAdapter } from "./adapter";
import type { ToolLoopDeps } from "./loop";
import { ProviderToolError, type ProviderId, type TurnRequest, type TurnResult } from "./neutral";
import type { GeminiSchemaDialect } from "./wire-gemini";

/** What a provider learnt about itself while a session ran, kept by the caller so it outlives one request. */
export interface ToolTurnMemory {
	/** Set to "openapi" after a Gemini endpoint rejected parametersJsonSchema, so later turns skip the failed attempt. */
	geminiSchemaDialect: GeminiSchemaDialect;
}

export function createToolTurnMemory(): ToolTurnMemory {
	return { geminiSchemaDialect: "json-schema" };
}

/** The model or server answered that it cannot use tools. The host can offer to continue without them. */
export class ToolsUnsupportedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ToolsUnsupportedError";
	}
}

export interface ToolTurnContext {
	runtime: ProviderRuntime;
	providerRef: ProviderModelRef;
	abortSignal?: AbortSignal;
	/**
	 * Text as it streams. Text beside tool calls is narration and only the last, tool-free turn is the answer, so a caller
	 * that shows these deltas as the reply must clear them when a turn ends in tool calls.
	 */
	onDelta?: (delta: string) => void;
	memory?: ToolTurnMemory;
}

/** The endpoint to record in usage history for a tool turn. Azure OpenAI tool turns use Responses, unlike its text path. */
export function getToolTurnEndpoint(providerId: ProviderId): ApiEndpoint {
	return getToolWireAdapter(providerId).endpoint;
}

/**
 * Output cap for a tool turn. Responses, Gemini and Chat Completions count reasoning against any cap, so they get none.
 * Anthropic requires one, and gets the same per-model budget as its text path.
 */
export function getToolTurnMaxOutputTokens(providerId: ProviderId, model: string): number {
	return providerId === "anthropic" ? getAnthropicMaxTokens(model) : 0;
}

/** The reasoning effort to send with a tool turn, or null. Only OpenAI models are known well enough to clamp it. */
export function getToolTurnReasoningEffort(providerId: ProviderId, model: string, effort: ReasoningEffort): string | null {
	return providerId === "openai" ? getSupportedReasoningEffort(model, effort) : null;
}

interface ToolTarget {
	providerName: string;
	adapter: ToolWireAdapter;
	bufferedUrl: string;
	streamUrl: string;
	bufferedHeaders: Record<string, string>;
	streamHeaders: Record<string, string>;
	secrets: string[];
	timeoutMs: number;
	timeoutMessage: string;
	idleTimeoutMs: number;
}

function requireKey(apiKey: string, message: string): void {
	if (!apiKey) {
		throw new Error(message);
	}
}

function requireModel(model: string, message: string): void {
	if (!model.trim()) {
		throw new Error(message);
	}
}

async function resolveTarget(runtime: ProviderRuntime, providerRef: ProviderModelRef, request: TurnRequest): Promise<ToolTarget> {
	const { providerId, providerName } = providerRef;
	const adapter = getToolWireAdapter(providerId);
	const apiKey = await runtime.getProviderApiKey(providerId);
	const reasoningTimeout = getReasoningEffortTimeoutMs(request.reasoningEffort);
	const target = (
		url: string,
		headers: Record<string, string>,
		timing: { timeoutMs: number; idleTimeoutMs: number } = { timeoutMs: reasoningTimeout, idleTimeoutMs: reasoningTimeout },
		streamUrl = url,
		streamHeaders = headers
	): ToolTarget => ({
		providerName,
		adapter,
		bufferedUrl: url,
		streamUrl,
		bufferedHeaders: headers,
		streamHeaders,
		secrets: getSecretHeaderValues(streamHeaders),
		timeoutMs: timing.timeoutMs,
		timeoutMessage: `${providerName} generation timed out after ${formatTimeoutDuration(timing.timeoutMs)}.`,
		idleTimeoutMs: timing.idleTimeoutMs
	});

	switch (providerId) {
		case "openai": {
			requireKey(apiKey, "Add an OpenAI API key in AskMate settings before asking a question.");
			return target(joinOpenAIUrl(getOpenAIBaseUrl(runtime), "responses"), { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" });
		}
		case "azure-openai": {
			requireKey(apiKey, "Add an Azure OpenAI API key in AskMate settings before asking a question.");
			requireModel(providerRef.model, "Enter an Azure OpenAI deployment name in AskMate settings before asking a question.");
			return target(`${getAzureOpenAIBaseUrl(runtime.getProviderSettings("azure-openai"))}/responses`, getAzureOpenAIHeaders(apiKey));
		}
		case "azure-ai": {
			requireKey(apiKey, "Add an Azure AI Foundry API key in AskMate settings before asking a question.");
			requireModel(providerRef.model, "Enter an Azure AI Foundry model or deployment name in AskMate settings before asking a question.");
			return target(
				`${getAzureAIBaseUrl(runtime.getProviderSettings("azure-ai"))}/chat/completions?api-version=${AZURE_AI_INFERENCE_API_VERSION}`,
				getAzureAIHeaders(apiKey)
			);
		}
		case "openrouter": {
			requireKey(apiKey, `Add a ${providerName} API key in AskMate settings before asking a question.`);
			return target(`${getOpenRouterBaseUrl(runtime)}/chat/completions`, { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" });
		}
		case "openai-compatible": {
			// A local server often needs no key, so a blank one sends no Authorization header at all.
			const headers: Record<string, string> = { "Content-Type": "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) };
			return target(`${getOpenAICompatibleBaseUrl(runtime)}/chat/completions`, headers);
		}
		case "anthropic": {
			requireKey(apiKey, "Add an Anthropic API key in AskMate settings before asking a question.");
			const base = { "x-api-key": apiKey, "anthropic-version": ANTHROPIC_API_VERSION, "Content-Type": "application/json" };
			const url = `${getAnthropicBaseUrl(runtime)}/messages`;
			// Required for requests that originate in a browser context such as Obsidian's renderer; requestUrl needs no such header.
			const streamHeaders = { ...base, "anthropic-dangerous-direct-browser-access": "true" };
			return target(url, base, { timeoutMs: ANTHROPIC_BUFFERED_TIMEOUT_MS, idleTimeoutMs: ANTHROPIC_GENERATION_TIMEOUT_MS }, url, streamHeaders);
		}
		case "google-gemini": {
			requireKey(apiKey, "Add a Google Gemini API key in AskMate settings before asking a question.");
			const model = encodeURIComponent(providerRef.model);
			const base = getGeminiBaseUrl(runtime);
			// Header auth keeps the API key out of the request URL (logs, proxies).
			return target(
				`${base}/models/${model}:generateContent`,
				{ "Content-Type": "application/json", "x-goog-api-key": apiKey },
				undefined,
				`${base}/models/${model}:streamGenerateContent?alt=sse`
			);
		}
		default: {
			const unhandled: never = providerId;
			throw new Error(`Unsupported text provider: ${String(unhandled)}`);
		}
	}
}

// How servers say it: Ollama "does not support tools", OpenRouter "No endpoints found that support tool use", Gemini
// "Function calling is not enabled for ...", Foundry "Tool calling is not supported".
const TOOLS_UNSUPPORTED_PATTERN = /does(?:\s+not|n['’]t) support (?:tools?|tool use|tool calling|function calling)|no endpoints found that support tool|(?:tools?|tool use|tool calling|function calling) (?:is|are)(?: not|n['’]t) (?:supported|enabled|available)/i;
const WIRE_TOOL_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const GEMINI_SCHEMA_REJECTION_PATTERN = /HTTP 400[\s\S]*(?:parametersJsonSchema|parameters_json_schema|Unknown name)/i;

/** One name a provider dislikes fails the whole request with an opaque 400, so a bad name is caught here with its fix. */
function assertWireToolNames(request: TurnRequest): void {
	const seen = new Set<string>();

	for (const tool of request.tools) {
		if (!WIRE_TOOL_NAME_PATTERN.test(tool.name)) {
			throw new Error(`Tool name "${tool.name}" is not valid for every provider. Build tool names with buildToolNameMap.`);
		}

		if (seen.has(tool.name)) {
			throw new Error(`Tool name "${tool.name}" is listed twice. Build tool names with buildToolNameMap.`);
		}

		seen.add(tool.name);
	}
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function asToolFailure(error: unknown, providerName: string, secrets: string[]): unknown {
	// A failure inside a wire adapter reads "<what happened>" without a provider name, and may echo provider text.
	return error instanceof ProviderToolError ? new Error(redactSecrets(`${providerName} ${error.message}`, secrets)) : error;
}

async function attempt(context: ToolTurnContext, target: ToolTarget, request: TurnRequest, schemaDialect: GeminiSchemaDialect): Promise<TurnResult> {
	const { adapter, providerName, secrets } = target;
	const { runtime } = context;
	const parse = (readBody: () => Record<string, unknown> | null): TurnResult => {
		try {
			const body = readBody();

			if (!body) {
				throw new Error(`${providerName} returned a reply that is not JSON. Check the base URL.`);
			}

			return adapter.parseBody(body);
		} catch (error) {
			throw asToolFailure(error, providerName, secrets);
		}
	};

	if (context.onDelta && runtime.streamSse) {
		const outcome = await runTextStream(runtime, {
			providerName,
			url: target.streamUrl,
			headers: target.streamHeaders,
			body: JSON.stringify(adapter.buildBody(request, { stream: true, schemaDialect })),
			abortSignal: context.abortSignal,
			idleTimeoutMs: target.idleTimeoutMs,
			adapter: adapter.stream,
			onDelta: context.onDelta
		});

		switch (outcome.kind) {
			case "unavailable":
				break;
			case "buffered":
				return parse(() => outcome.response.body);
			case "complete":
				return parse(() => adapter.assembleBody(outcome.state));
			case "interrupted":
				// Half a tool turn is no turn: a call may be cut off, so nothing from it is used.
				throw new Error(outcome.message);
			default: {
				const unhandled: never = outcome;
				throw new Error(`Unhandled stream outcome: ${String(unhandled)}`);
			}
		}
	}

	const response = await runtime.requestJson<Record<string, unknown>>(target.bufferedUrl, {
		method: "POST",
		headers: target.bufferedHeaders,
		abortSignal: context.abortSignal,
		timeoutMs: target.timeoutMs,
		timeoutMessage: target.timeoutMessage,
		body: JSON.stringify(adapter.buildBody(request, { stream: false, schemaDialect }))
	});

	if (!response.ok) {
		throw new Error(formatProviderHttpError(providerName, response.status, describeProviderErrorBody(response, secrets)));
	}

	return parse(() => response.body);
}

/**
 * Sends one turn. Streams when the caller wants deltas and the runtime can; a stream that fails before any response falls
 * back to one buffered request, exactly as the text path does. A Gemini endpoint that rejects parametersJsonSchema gets the
 * OpenAPI form once and the choice is remembered in `memory`. A model that cannot use tools raises ToolsUnsupportedError.
 */
export async function sendToolTurn(context: ToolTurnContext, request: TurnRequest): Promise<TurnResult> {
	assertWireToolNames(request);
	const target = await resolveTarget(context.runtime, context.providerRef, request);
	const memory = context.memory ?? createToolTurnMemory();

	try {
		try {
			return await attempt(context, target, request, memory.geminiSchemaDialect);
		} catch (error) {
			const retryable = context.providerRef.providerId === "google-gemini"
				&& request.tools.length > 0
				&& memory.geminiSchemaDialect === "json-schema"
				&& GEMINI_SCHEMA_REJECTION_PATTERN.test(messageOf(error));

			if (!retryable) {
				throw error;
			}

			memory.geminiSchemaDialect = "openapi";
			return await attempt(context, target, request, "openapi");
		}
	} catch (error) {
		if (request.tools.length > 0 && TOOLS_UNSUPPORTED_PATTERN.test(messageOf(error))) {
			throw new ToolsUnsupportedError(`${target.providerName} cannot use tools with model "${context.providerRef.model}". ${messageOf(error)}`);
		}

		throw error;
	}
}

/** Binds a context and the parts of a request that stay the same across a run into the `sendTurn` a loop expects. */
export function createToolTurnSender(
	context: Omit<ToolTurnContext, "abortSignal">,
	template: Omit<TurnRequest, "history" | "toolChoice">
): ToolLoopDeps["sendTurn"] {
	return (history, toolChoice, signal) => sendToolTurn({ ...context, abortSignal: signal }, { ...template, history, toolChoice });
}
