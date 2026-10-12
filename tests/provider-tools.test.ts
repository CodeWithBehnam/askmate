import { describe, expect, test } from "bun:test";
import { completeAnthropicText, getAnthropicIncompleteReason } from "../src/providers/anthropic";
import { completeAzureAIText } from "../src/providers/azure-ai";
import { completeAzureOpenAIText } from "../src/providers/azure-open-ai";
import { completeGeminiText } from "../src/providers/google-gemini";
import { requestOpenAIResponses } from "../src/providers/open-ai";
import { completeOpenAICompatibleText } from "../src/providers/open-ai-compatible";
import { streamOpenAIResponses } from "../src/providers/open-ai-stream";
import { completeOpenRouterText } from "../src/providers/open-router";
import type { SseEvent } from "../src/providers/sse";
import { fetchSse, type FetchLike } from "../src/providers/sseTransport";
import type { StreamAdapter } from "../src/providers/streaming";
import {
	buildToolNameMap,
	CHAT_QUIRKS,
	createToolTurnMemory,
	createToolTurnSender,
	DEFAULT_TOOL_LOOP_LIMITS,
	describeToolLoopEnd,
	findWireName,
	getToolTurnEndpoint,
	getToolTurnMaxOutputTokens,
	getToolTurnReasoningEffort,
	getToolWireAdapter,
	normaliseToolSchema,
	prepareGeminiJsonSchema,
	runToolLoop,
	sendToolTurn,
	supportsTools,
	toGeminiOpenApiSchema,
	ToolsUnsupportedError,
	truncateResult,
	WIRE_NAME_MAX,
	type HistoryItem,
	type ToolCall,
	type ToolChoice,
	type ToolLoopDeps,
	type ToolLoopProgress,
	type ToolRuntime,
	type ToolSpec,
	type TurnRequest,
	type TurnResult
} from "../src/providers/tools";
import { anthropicToolStreamAdapter, assembleAnthropicBody, buildAnthropicBody, parseAnthropicBody } from "../src/providers/tools/wire-anthropic";
import { assembleChatBody, buildChatBody, chatToolStreamAdapter, parseChatBody, type ChatQuirks } from "../src/providers/tools/wire-chat";
import { assembleGeminiBody, buildGeminiBody, geminiToolStreamAdapter, parseGeminiBody } from "../src/providers/tools/wire-gemini";
import { assembleResponsesBody, buildResponsesBody, filterReplayItems, parseResponsesBody, responsesToolStreamAdapter } from "../src/providers/tools/wire-responses";
import type { ProviderRequestOptions, ProviderRuntime } from "../src/providers/types";
import { isAbortError } from "../src/shared/core";
import type { AskMateHttpResponse, ProviderModelRef, ProviderSettings, TextProviderId } from "../src/shared/types";

interface RecordedRequest {
	kind: "buffered" | "stream";
	url: string;
	headers: Record<string, string>;
	body: string;
	timeoutMs?: number;
	timeoutMessage?: string;
}

/** Records every request a text-only path makes. The replies are empty, so callers tolerate the parse failure. */
function recordingRuntime(baseUrl: string, withStream: boolean): { runtime: ProviderRuntime; recorded: RecordedRequest[] } {
	const recorded: RecordedRequest[] = [];
	const fetchFn: FetchLike = async (url, init) => {
		recorded.push({ kind: "stream", url, headers: init.headers ?? {}, body: init.body ?? "" });
		return new Response("", { headers: { "content-type": "text/event-stream" } });
	};
	const runtime: ProviderRuntime = {
		getProviderSettings: (_providerId: TextProviderId): ProviderSettings => ({ apiKeySecretName: "", model: "m", modelOptions: [], baseUrl }),
		getProviderApiKey: async () => "KEY",
		requestJson: async <T>(url: string, options?: ProviderRequestOptions) => {
			recorded.push({
				kind: "buffered",
				url,
				headers: options?.headers ?? {},
				body: options?.body ?? "",
				timeoutMs: options?.timeoutMs,
				timeoutMessage: options?.timeoutMessage
			});
			return { status: 200, ok: true, body: null as T | null, text: "" };
		},
		...(withStream ? { streamSse: (url, options, onEvent) => fetchSse(fetchFn, url, options, onEvent) } : {})
	};
	return { runtime, recorded };
}

function textRef(providerId: TextProviderId, model: string): ProviderModelRef {
	return { providerId, providerName: providerId, model, capability: "text" };
}

async function settle(promise: Promise<unknown>): Promise<void> {
	await promise.catch(() => undefined);
}

describe("text-only requests carry no tool fields and stay byte-identical", () => {
	const onDelta = (): void => undefined;

	test("Anthropic buffered and streamed bodies", async () => {
		const buffered = recordingRuntime("https://a.test/v1", false);
		await settle(completeAnthropicText(buffered.runtime, textRef("anthropic", "claude-sonnet-5-5"), "sys", "in"));
		expect(buffered.recorded).toHaveLength(1);
		expect(buffered.recorded[0].url).toBe("https://a.test/v1/messages");
		expect(buffered.recorded[0].headers).toEqual({ "x-api-key": "KEY", "anthropic-version": "2023-06-01", "Content-Type": "application/json" });
		expect(buffered.recorded[0].body).toBe("{\"model\":\"claude-sonnet-5-5\",\"system\":\"sys\",\"max_tokens\":32000,\"messages\":[{\"role\":\"user\",\"content\":\"in\"}]}");

		const streamed = recordingRuntime("https://a.test/v1", true);
		await settle(completeAnthropicText(streamed.runtime, textRef("anthropic", "claude-sonnet-5-5"), "sys", "in", undefined, onDelta));
		expect(streamed.recorded).toHaveLength(1);
		expect(streamed.recorded[0].headers).toEqual({
			"x-api-key": "KEY",
			"anthropic-version": "2023-06-01",
			"anthropic-dangerous-direct-browser-access": "true",
			"Content-Type": "application/json"
		});
		expect(streamed.recorded[0].body).toBe("{\"model\":\"claude-sonnet-5-5\",\"system\":\"sys\",\"max_tokens\":32000,\"messages\":[{\"role\":\"user\",\"content\":\"in\"}],\"stream\":true}");
	});

	test("Gemini buffered and streamed bodies", async () => {
		const buffered = recordingRuntime("https://g.test/v1beta", false);
		await settle(completeGeminiText(buffered.runtime, textRef("google-gemini", "gemini-2.5-pro"), "sys", "in"));
		expect(buffered.recorded[0].url).toBe("https://g.test/v1beta/models/gemini-2.5-pro:generateContent");
		expect(buffered.recorded[0].headers).toEqual({ "Content-Type": "application/json", "x-goog-api-key": "KEY" });
		expect(buffered.recorded[0].body).toBe("{\"systemInstruction\":{\"parts\":[{\"text\":\"sys\"}]},\"contents\":[{\"role\":\"user\",\"parts\":[{\"text\":\"in\"}]}]}");

		const streamed = recordingRuntime("https://g.test/v1beta", true);
		await settle(completeGeminiText(streamed.runtime, textRef("google-gemini", "gemini-2.5-pro"), "sys", "in", undefined, onDelta));
		expect(streamed.recorded[0].url).toBe("https://g.test/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse");
		expect(streamed.recorded[0].body).toBe(buffered.recorded[0].body);
	});

	test("OpenRouter buffered and streamed bodies", async () => {
		const buffered = recordingRuntime("https://or.test/api/v1", false);
		await settle(completeOpenRouterText(buffered.runtime, textRef("openrouter", "openai/gpt-5"), "sys", "in"));
		expect(buffered.recorded[0].url).toBe("https://or.test/api/v1/chat/completions");
		expect(buffered.recorded[0].headers).toEqual({ Authorization: "Bearer KEY", "Content-Type": "application/json" });
		expect(buffered.recorded[0].body).toBe("{\"model\":\"openai/gpt-5\",\"messages\":[{\"role\":\"system\",\"content\":\"sys\"},{\"role\":\"user\",\"content\":\"in\"}]}");

		const streamed = recordingRuntime("https://or.test/api/v1", true);
		await settle(completeOpenRouterText(streamed.runtime, textRef("openrouter", "openai/gpt-5"), "sys", "in", undefined, onDelta));
		expect(streamed.recorded[0].body).toBe("{\"model\":\"openai/gpt-5\",\"messages\":[{\"role\":\"system\",\"content\":\"sys\"},{\"role\":\"user\",\"content\":\"in\"}],\"stream\":true,\"stream_options\":{\"include_usage\":true}}");
	});

	test("OpenAI-compatible buffered and streamed bodies", async () => {
		const buffered = recordingRuntime("http://localhost:11434/v1", false);
		await settle(completeOpenAICompatibleText(buffered.runtime, textRef("openai-compatible", "llama3"), "sys", "in"));
		expect(buffered.recorded[0].headers).toEqual({ "Content-Type": "application/json", Authorization: "Bearer KEY" });
		expect(buffered.recorded[0].body).toBe("{\"model\":\"llama3\",\"messages\":[{\"role\":\"system\",\"content\":\"sys\"},{\"role\":\"user\",\"content\":\"in\"}]}");

		const streamed = recordingRuntime("http://localhost:11434/v1", true);
		await settle(completeOpenAICompatibleText(streamed.runtime, textRef("openai-compatible", "llama3"), "sys", "in", undefined, onDelta));
		expect(streamed.recorded[0].body).toBe("{\"model\":\"llama3\",\"messages\":[{\"role\":\"system\",\"content\":\"sys\"},{\"role\":\"user\",\"content\":\"in\"}],\"stream\":true}");
	});

	test("Azure OpenAI buffered and streamed bodies", async () => {
		const base = "https://r.openai.azure.com/openai/v1";
		const buffered = recordingRuntime(base, false);
		await settle(completeAzureOpenAIText(buffered.runtime, textRef("azure-openai", "dep"), "sys", "in"));
		expect(buffered.recorded[0].url).toBe(`${base}/chat/completions`);
		expect(buffered.recorded[0].headers).toEqual({ "Content-Type": "application/json", "api-key": "KEY" });
		expect(buffered.recorded[0].body).toBe("{\"model\":\"dep\",\"messages\":[{\"role\":\"system\",\"content\":\"sys\"},{\"role\":\"user\",\"content\":\"in\"}]}");

		const streamed = recordingRuntime(base, true);
		await settle(completeAzureOpenAIText(streamed.runtime, textRef("azure-openai", "dep"), "sys", "in", undefined, onDelta));
		expect(streamed.recorded[0].body).toBe("{\"model\":\"dep\",\"messages\":[{\"role\":\"system\",\"content\":\"sys\"},{\"role\":\"user\",\"content\":\"in\"}],\"stream\":true,\"stream_options\":{\"include_usage\":true}}");
	});

	test("Azure AI Foundry buffered and streamed bodies", async () => {
		const url = "https://r.services.ai.azure.com/models/chat/completions?api-version=2024-05-01-preview";
		const buffered = recordingRuntime("https://r.services.ai.azure.com", false);
		await settle(completeAzureAIText(buffered.runtime, textRef("azure-ai", "dep"), "sys", "in"));
		expect(buffered.recorded[0].url).toBe(url);
		expect(buffered.recorded[0].body).toBe("{\"model\":\"dep\",\"messages\":[{\"role\":\"system\",\"content\":\"sys\"},{\"role\":\"user\",\"content\":\"in\"}]}");

		const streamed = recordingRuntime("https://r.services.ai.azure.com", true);
		await settle(completeAzureAIText(streamed.runtime, textRef("azure-ai", "dep"), "sys", "in", undefined, { onDelta }));
		expect(streamed.recorded[0].url).toBe(url);
		expect(streamed.recorded[0].body).toBe("{\"model\":\"dep\",\"messages\":[{\"role\":\"system\",\"content\":\"sys\"},{\"role\":\"user\",\"content\":\"in\"}],\"stream\":true}");
	});

	test("OpenAI Responses buffered and streamed bodies", async () => {
		const buffered = recordingRuntime("https://api.openai.com/v1", false);
		await requestOpenAIResponses(buffered.runtime, { apiKey: "KEY", model: "gpt-5.5", instructions: "sys", input: "in", reasoningEffort: "medium" });
		expect(buffered.recorded[0].url).toBe("https://api.openai.com/v1/responses");
		expect(buffered.recorded[0].headers).toEqual({ Authorization: "Bearer KEY", "Content-Type": "application/json" });
		expect(buffered.recorded[0].body).toBe("{\"model\":\"gpt-5.5\",\"instructions\":\"sys\",\"input\":\"in\",\"store\":false,\"reasoning\":{\"effort\":\"medium\"}}");

		const streamed = recordingRuntime("https://api.openai.com/v1", true);
		await settle(streamOpenAIResponses(streamed.runtime, { apiKey: "KEY", model: "gpt-5.5", instructions: "sys", input: "in", reasoningEffort: "high", onDelta }));
		expect(streamed.recorded[0].body).toBe("{\"model\":\"gpt-5.5\",\"instructions\":\"sys\",\"input\":\"in\",\"store\":false,\"reasoning\":{\"effort\":\"high\"},\"stream\":true}");
	});

	test("no text-only body mentions tools, tool_choice or parallel_tool_calls", async () => {
		const runs = [
			recordingRuntime("https://a.test/v1", true),
			recordingRuntime("https://g.test/v1beta", true),
			recordingRuntime("https://or.test/api/v1", true),
			recordingRuntime("https://api.openai.com/v1", true)
		];
		await settle(completeAnthropicText(runs[0].runtime, textRef("anthropic", "claude-sonnet-5-5"), "s", "i", undefined, onDelta));
		await settle(completeGeminiText(runs[1].runtime, textRef("google-gemini", "gemini-2.5-pro"), "s", "i", undefined, onDelta));
		await settle(completeOpenRouterText(runs[2].runtime, textRef("openrouter", "m"), "s", "i", undefined, onDelta));
		await settle(streamOpenAIResponses(runs[3].runtime, { apiKey: "KEY", model: "gpt-5.5", instructions: "s", input: "i", reasoningEffort: "low", onDelta }));
		for (const run of runs) {
			expect(run.recorded[0].body).not.toMatch(/tool|function/i);
		}
	});

	test("the text paths do not import the tool layer", async () => {
		const sources = ["anthropic", "azure-ai", "azure-open-ai", "google-gemini", "open-ai", "open-ai-compatible", "open-ai-stream", "open-router", "chat-completions-stream", "streaming", "common"];
		for (const name of sources) {
			expect(await Bun.file(`src/providers/${name}.ts`).text()).not.toMatch(/from "\.\/tools/);
		}
	});
});

// ---- Shared helpers for the tool layer --------------------------------------------------------------------------------

function ev(payload: unknown): SseEvent {
	return { event: "message", data: typeof payload === "string" ? payload : JSON.stringify(payload) };
}

function reduceAll<S>(adapter: StreamAdapter<S>, events: SseEvent[]): { state: S; text: string } {
	let state = adapter.initial;
	let text = "";
	for (const event of events) {
		const next = adapter.reduce(state, event);
		state = next.state;
		text += next.delta;
	}
	return { state, text };
}

const weather: ToolSpec = {
	name: "get_weather",
	description: "Get the weather",
	inputSchema: { type: "object", properties: { location: { type: "string" } }, required: ["location"] }
};

const baseRequest = (history: HistoryItem[], overrides: Partial<TurnRequest> = {}): TurnRequest => ({
	model: "m",
	instructions: "Be brief.",
	history,
	tools: [weather],
	toolChoice: "auto",
	parallelToolCalls: true,
	maxOutputTokens: 0,
	reasoningEffort: null,
	...overrides
});

const user = (text: string): HistoryItem => ({ kind: "user", text });

describe("tool names", () => {
	test("a clean name stays readable and carries its server", () => {
		const map = buildToolNameMap([{ serverId: "github", toolName: "search_issues" }]);
		expect([...map.keys()]).toEqual(["github__search_issues"]);
	});

	test("dotted, long and colliding MCP names become unique wire-safe names", () => {
		const long = "a".repeat(80);
		const tools = [
			{ serverId: "a", toolName: "search.issues" },
			{ serverId: "a", toolName: "search_issues" },
			{ serverId: "b", toolName: long },
			{ serverId: "c", toolName: "9lives" },
			{ serverId: "9", toolName: "lives" }
		];
		const map = buildToolNameMap(tools);
		expect(new Set(map.keys()).size).toBe(tools.length);
		for (const name of map.keys()) {
			expect(name).toMatch(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/);
			expect(name.length).toBeLessThanOrEqual(WIRE_NAME_MAX);
		}
	});

	test("the mapping is reversible and does not depend on the listing order", () => {
		const tools = [
			{ serverId: "a", toolName: "search.issues" },
			{ serverId: "a", toolName: "search_issues" },
			{ serverId: "b", toolName: "x".repeat(100) }
		];
		const forward = buildToolNameMap(tools);
		const backward = buildToolNameMap([...tools].reverse());
		for (const tool of tools) {
			const name = findWireName(forward, tool);
			expect(name).toBeDefined();
			expect(forward.get(name ?? "")).toBe(tool);
			expect(findWireName(backward, tool)).toBe(name);
		}
	});

	test("two tools that only differ after the cut still get different names", () => {
		const map = buildToolNameMap([
			{ serverId: "s", toolName: `${"p".repeat(70)}one` },
			{ serverId: "s", toolName: `${"p".repeat(70)}two` }
		]);
		expect(map.size).toBe(2);
	});

	test("listing the same tool twice keeps one", () => {
		expect(buildToolNameMap([{ serverId: "a", toolName: "t" }, { serverId: "a", toolName: "t" }]).size).toBe(1);
	});

	test("a name the model made up is not in the map", () => {
		const map = buildToolNameMap([{ serverId: "a", toolName: "t" }]);
		expect(map.get("a__T")).toBeUndefined();
		expect(findWireName(map, { serverId: "z", toolName: "t" })).toBeUndefined();
	});
});

describe("tool schemas", () => {
	test("a tool with no parameters gets an empty properties object and loses $schema", () => {
		expect(normaliseToolSchema({ $schema: "http://json-schema.org/draft-07/schema#", type: "object" })).toEqual({ type: "object", properties: {} });
		expect(normaliseToolSchema({})).toEqual({ type: "object", properties: {} });
	});

	test("a composed root is not given empty properties, and a non-object root is passed on as written", () => {
		expect(normaliseToolSchema({ oneOf: [{ type: "object" }] })).toEqual({ type: "object", oneOf: [{ type: "object" }] });
		expect(normaliseToolSchema({ type: "string" })).toEqual({ type: "string" });
	});

	test("Gemini JSON Schema keeps a property named title and drops dangling required entries", () => {
		const out = prepareGeminiJsonSchema({
			$schema: "http://json-schema.org/draft-07/schema#",
			type: "object",
			properties: { title: { type: "string" } },
			required: ["title", "missing"]
		});
		expect(out).toEqual({ type: "object", properties: { title: { type: "string" } }, required: ["title"] });
	});

	test("the OpenAPI fallback converts nullable unions and drops additionalProperties", () => {
		const out = toGeminiOpenApiSchema({
			type: "object",
			additionalProperties: false,
			properties: { note: { type: ["string", "null"] }, mode: { const: "fast" }, title: { type: "string", title: "dropped" } }
		});
		expect(out).toEqual({
			type: "object",
			properties: { note: { type: "string", nullable: true }, mode: { enum: ["fast"] }, title: { type: "string" } }
		});
	});
});

describe("OpenAI Responses tool turns", () => {
	const output = [
		{ type: "reasoning", id: "rs_1", summary: [], encrypted_content: "enc-1" },
		{ type: "reasoning", id: "rs_2", summary: [], encrypted_content: null },
		{ type: "message", id: "msg_1", role: "assistant", phase: "commentary", content: [{ type: "output_text", text: "Checking the weather first." }] },
		{ id: "fc_1", call_id: "call_1", type: "function_call", name: "get_weather", arguments: "{\"location\":\"Paris\"}", status: "completed" }
	];

	test("parses a tool turn, keeps commentary as narration and replays only what can be replayed", () => {
		const turn = parseResponsesBody({ status: "completed", output, usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } });
		expect(turn.stop).toBe("tool_calls");
		expect(turn.toolCalls).toEqual([{ id: "call_1", name: "get_weather", input: { location: "Paris" }, rawInput: "{\"location\":\"Paris\"}" }]);
		expect(turn.text).toBe("");
		expect(turn.narration).toBe("Checking the weather first.");
		expect((turn.native as { id: string }[]).map((item) => item.id)).toEqual(["rs_1", "msg_1", "fc_1"]);
		expect(turn.usage).toEqual({ input_tokens: 10, output_tokens: 5, total_tokens: 15 });
	});

	test("keeps cached and reasoning token details in usage", () => {
		const turn = parseResponsesBody({
			status: "completed",
			output: [],
			usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15, input_tokens_details: { cached_tokens: 4 }, output_tokens_details: { reasoning_tokens: 3 } }
		});
		expect(turn.usage).toEqual({
			input_tokens: 10,
			output_tokens: 5,
			total_tokens: 15,
			input_tokens_details: { cached_tokens: 4 },
			output_tokens_details: { reasoning_tokens: 3 }
		});
	});

	test("only reasoning items with encrypted content are replayed", () => {
		const kept = filterReplayItems([
			{ type: "reasoning", id: "rs_a", encrypted_content: "" },
			{ type: "reasoning", id: "rs_b", encrypted_content: "abc" },
			{ type: "web_search_call", id: "ws_1" },
			"not an item",
			{ type: "message", id: "m" }
		]);
		expect(kept).toEqual([{ type: "reasoning", id: "rs_b", encrypted_content: "abc" }, { type: "message", id: "m" }]);
	});

	test("an incomplete function call is never run", () => {
		const turn = parseResponsesBody({
			status: "incomplete",
			incomplete_details: { reason: "max_output_tokens" },
			output: [{ type: "function_call", call_id: "c", name: "x", arguments: "{\"a\":", status: "incomplete" }]
		});
		expect(turn.stop).toBe("truncated");
		expect(turn.toolCalls).toEqual([]);
	});

	test("a call whose arguments are not valid JSON is kept with its error so the loop can answer it", () => {
		const turn = parseResponsesBody({ status: "completed", output: [{ type: "function_call", call_id: "c", name: "x", arguments: "{\"a\":", status: "completed" }] });
		expect(turn.stop).toBe("tool_calls");
		expect(turn.toolCalls[0].inputError).toBeDefined();
	});

	test("a missing call_id falls back to the item id, then to a synthetic one", () => {
		const turn = parseResponsesBody({
			status: "completed",
			output: [
				{ type: "function_call", id: "fc_9", name: "x", arguments: "{}" },
				{ type: "function_call", name: "y", arguments: "{}" }
			]
		});
		expect(turn.toolCalls.map((call) => call.id)).toEqual(["fc_9", "askmate-1"]);
	});

	test("refusals, content filters and failures map to their own stops", () => {
		expect(parseResponsesBody({ status: "completed", output: [{ type: "message", content: [{ type: "refusal", refusal: "No." }] }] }).stop).toBe("refused");
		expect(parseResponsesBody({ status: "incomplete", incomplete_details: { reason: "content_filter" }, output: [] }).stop).toBe("blocked");
		expect(() => parseResponsesBody({ status: "failed", error: { message: "boom" } })).toThrow("boom");
	});

	test("the final answer is the answer-phase text, not the commentary", () => {
		const turn = parseResponsesBody({
			status: "completed",
			output: [
				{ type: "message", phase: "commentary", content: [{ type: "output_text", text: "Working." }] },
				{ type: "message", phase: "final_answer", content: [{ type: "output_text", text: "Done." }] }
			]
		});
		expect(turn.stop).toBe("end");
		expect(turn.text).toBe("Done.");
		expect(turn.narration).toBe("Working.");
	});

	test("the stream keys items by output_index and prefers output_item.done over an empty terminal output", () => {
		const events = [
			ev({ type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "get_weather", arguments: "" } }),
			ev({ type: "response.function_call_arguments.delta", item_id: "fc_1", output_index: 0, delta: "{\"location\":" }),
			ev({ type: "response.function_call_arguments.delta", item_id: "fc_1", output_index: 0, delta: "\"Paris\"}" }),
			ev({ type: "response.function_call_arguments.done", item_id: "fc_1", output_index: 0, arguments: "{\"location\":\"Paris\"}" }),
			ev({ type: "response.output_item.done", output_index: 0, item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "get_weather", arguments: "{\"location\":\"Paris\"}", status: "completed" } }),
			ev({ type: "response.completed", response: { status: "completed", output: [], usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 } } })
		];
		const { state } = reduceAll(responsesToolStreamAdapter, events);
		expect(responsesToolStreamAdapter.isTerminal(state)).toBe(true);
		const turn = parseResponsesBody(assembleResponsesBody(state));
		expect(turn.toolCalls.map((call) => call.input)).toEqual([{ location: "Paris" }]);
		expect(turn.usage?.total_tokens).toBe(5);
	});

	test("items finished out of order are replayed in output_index order", () => {
		const { state } = reduceAll(responsesToolStreamAdapter, [
			ev({ type: "response.output_item.done", output_index: 1, item: { type: "function_call", call_id: "c", name: "get_weather", arguments: "{}", status: "completed" } }),
			ev({ type: "response.output_item.done", output_index: 0, item: { type: "reasoning", id: "rs", encrypted_content: "enc" } }),
			ev({ type: "response.completed", response: { status: "completed", output: null } })
		]);
		const turn = parseResponsesBody(assembleResponsesBody(state));
		expect((turn.native as { type: string }[]).map((item) => item.type)).toEqual(["reasoning", "function_call"]);
	});

	test("a terminal output is used only when no item was finished, and streamed text is never lost", () => {
		const fromTerminal = reduceAll(responsesToolStreamAdapter, [
			ev({ type: "response.completed", response: { status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "From terminal" }] }] } })
		]);
		expect(parseResponsesBody(assembleResponsesBody(fromTerminal.state)).text).toBe("From terminal");

		const textOnly = reduceAll(responsesToolStreamAdapter, [
			ev({ type: "response.output_text.delta", output_index: 0, delta: "Streamed " }),
			ev({ type: "response.output_text.delta", output_index: 0, delta: "answer" }),
			ev({ type: "response.completed", response: { status: "completed", output: [] } })
		]);
		expect(textOnly.text).toBe("Streamed answer");
		expect(parseResponsesBody(assembleResponsesBody(textOnly.state)).text).toBe("Streamed answer");
	});

	test("a stream that ends before the terminal event is an error, not a half turn", () => {
		const { state } = reduceAll(responsesToolStreamAdapter, [ev({ type: "response.output_item.done", output_index: 0, item: { type: "function_call", call_id: "c", name: "x", arguments: "{}" } })]);
		expect(responsesToolStreamAdapter.isTerminal(state)).toBe(false);
		expect(() => assembleResponsesBody(state)).toThrow("closed the connection before the reply finished");
	});

	test("an error event raises a provider error", () => {
		expect(() => reduceAll(responsesToolStreamAdapter, [ev({ type: "error", message: "Overloaded" })])).toThrow("Overloaded");
	});

	test("the request replays output items, answers with function_call_output and caps nothing by default", () => {
		const first = parseResponsesBody({ status: "completed", output });
		const body = buildResponsesBody(baseRequest([
			user("Weather?"),
			{ kind: "assistant", text: "", toolCalls: first.toolCalls, native: first.native },
			{ kind: "tool_results", results: [{ callId: "call_1", name: "get_weather", text: "15C", isError: false }] }
		], { reasoningEffort: "medium" }), { stream: true });
		const input = body.input as { type?: string; call_id?: string; output?: string }[];
		expect(input.at(-1)).toEqual({ type: "function_call_output", call_id: "call_1", output: "15C" });
		expect(input.slice(1, -1)).toEqual(first.native as never);
		expect(body.store).toBe(false);
		expect(body.max_output_tokens).toBeUndefined();
		expect(body.tools).toEqual([{ type: "function", name: "get_weather", description: "Get the weather", parameters: weather.inputSchema, strict: false }]);
		expect(body.tool_choice).toBe("auto");
		expect(body.parallel_tool_calls).toBe(true);
		expect(body.stream).toBe(true);
	});

	test("encrypted reasoning is requested only together with a reasoning effort", () => {
		const reasoning = buildResponsesBody(baseRequest([user("x")], { reasoningEffort: "high" }), { stream: false });
		expect(reasoning.include).toEqual(["reasoning.encrypted_content"]);
		expect(reasoning.reasoning).toEqual({ effort: "high" });
		const plain = buildResponsesBody(baseRequest([user("x")]), { stream: false });
		expect(plain.include).toBeUndefined();
		expect(plain.reasoning).toBeUndefined();
	});

	test("the last allowed turn keeps the tools attached and sets tool_choice none, and an explicit cap is honoured", () => {
		const body = buildResponsesBody(baseRequest([user("x")], { toolChoice: "none", maxOutputTokens: 4000 }), { stream: false });
		expect((body.tools as unknown[]).length).toBe(1);
		expect(body.tool_choice).toBe("none");
		expect(body.max_output_tokens).toBe(4000);
	});

	test("a strict first-party tool is sent strict and a tool with no parameters still gets a properties object", () => {
		const body = buildResponsesBody(baseRequest([user("x")], {
			tools: [{ name: "ping", description: "Ping", inputSchema: { type: "object" }, strict: true }]
		}), { stream: false });
		expect(body.tools).toEqual([{ type: "function", name: "ping", description: "Ping", parameters: { type: "object", properties: {} }, strict: true }]);
	});

	test("a request with no tools carries no tool fields", () => {
		const body = buildResponsesBody(baseRequest([user("x")], { tools: [] }), { stream: false });
		expect(body.tools).toBeUndefined();
		expect(body.tool_choice).toBeUndefined();
		expect(body.parallel_tool_calls).toBeUndefined();
	});
});

describe("Chat Completions tool turns", () => {
	const quirks: ChatQuirks = { sendToolChoice: true, sendParallelToolCalls: true, includeUsage: true, tokenParam: "max_tokens" };
	const turnOf = (events: SseEvent[]): TurnResult => parseChatBody(assembleChatBody(reduceAll(chatToolStreamAdapter, events).state));

	test("accumulates the canonical OpenAI tool call stream and the trailing usage chunk", () => {
		const turn = turnOf([
			ev({ choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_abc", type: "function", function: { name: "get_weather", arguments: "" } }] }, finish_reason: null }] }),
			ev({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "{\"location\":" } }] }, finish_reason: null }] }),
			ev({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "\"Paris\"}" } }] }, finish_reason: null }] }),
			ev({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }),
			ev({ choices: [], usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 } }),
			ev("[DONE]")
		]);
		expect(turn.stop).toBe("tool_calls");
		expect(turn.toolCalls[0]).toMatchObject({ id: "call_abc", name: "get_weather", input: { location: "Paris" } });
		expect(turn.usage?.total_tokens).toBe(70);
	});

	test("separates two parallel calls that an Ollama stream both labels index 0", () => {
		const turn = turnOf([
			ev({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "get_weather", arguments: "{\"location\":\"Paris\"}" } }] } }] }),
			ev({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_2", function: { name: "get_weather", arguments: "{\"location\":\"London\"}" } }] } }] }),
			ev({ choices: [{ delta: {}, finish_reason: "stop" }] })
		]);
		expect(turn.toolCalls.map((call) => call.input)).toEqual([{ location: "Paris" }, { location: "London" }]);
		expect(turn.stop).toBe("tool_calls");
	});

	test("tolerates LM Studio nulls and a server that sends arguments as an object", () => {
		const turn = turnOf([
			ev({ choices: [{ delta: { tool_calls: [{ index: 0, id: "814890118", type: "function", function: { name: "get_weather", arguments: "" } }] } }] }),
			ev({ choices: [{ delta: { tool_calls: [{ index: 0, id: null, type: null, function: { name: null, arguments: "{\"location\":\"Rome\"}" } }] } }] }),
			ev({ choices: [{ delta: { tool_calls: [{ index: 1, id: "x2", function: { name: "get_weather", arguments: { location: "Oslo" } } }] } }] }),
			ev({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })
		]);
		expect(turn.toolCalls.map((call) => call.input)).toEqual([{ location: "Rome" }, { location: "Oslo" }]);
	});

	test("a missing id gets a synthetic one and empty arguments mean a call with no arguments", () => {
		const turn = parseChatBody({ choices: [{ message: { tool_calls: [{ function: { name: "ping", arguments: "" } }] }, finish_reason: "tool_calls" }] });
		expect(turn.toolCalls).toEqual([{ id: "askmate-0", name: "ping", input: {}, rawInput: "{}" }]);
	});

	test("finish_reason stop beside tool_calls is still a tool turn", () => {
		const turn = parseChatBody({ choices: [{ message: { content: "On it.", tool_calls: [{ id: "c", function: { name: "ping", arguments: "{}" } }] }, finish_reason: "stop" }] });
		expect(turn.stop).toBe("tool_calls");
		expect(turn.text).toBe("");
		expect(turn.narration).toBe("On it.");
	});

	test("a call cut off by the length limit, or by an upstream error, is never run", () => {
		for (const finish_reason of ["length", "error"]) {
			const turn = parseChatBody({ choices: [{ message: { tool_calls: [{ id: "c", function: { name: "ping", arguments: "{\"a\":" } }] }, finish_reason }] });
			expect(turn.stop).toBe("truncated");
			expect(turn.toolCalls).toEqual([]);
		}
	});

	test("a call with no name makes the whole turn malformed instead of being dropped", () => {
		const turn = turnOf([
			ev({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { arguments: "{}" } }] } }] }),
			ev({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })
		]);
		expect(turn.stop).toBe("malformed_call");
		expect(turn.toolCalls).toEqual([]);
	});

	test("content filters, refusals and errors hidden in a 200 body are reported", () => {
		expect(parseChatBody({ choices: [{ message: { content: "" }, finish_reason: "content_filter" }] }).stop).toBe("blocked");
		expect(parseChatBody({ choices: [{ message: { content: null, refusal: "No." }, finish_reason: "stop" }] }).stop).toBe("refused");
		expect(() => parseChatBody({ error: { message: "upstream down" } })).toThrow("upstream down");
		expect(() => reduceAll(chatToolStreamAdapter, [ev({ choices: [{ finish_reason: "error", error: { message: "overloaded" } }] })])).toThrow("overloaded");
	});

	test("merges OpenRouter reasoning_details by index and echoes them on the assistant message", () => {
		const turn = turnOf([
			ev({ choices: [{ delta: { reasoning_details: [{ type: "reasoning.text", index: 0, text: "Let me ", signature: "s1" }] } }] }),
			ev({ choices: [{ delta: { reasoning_details: [{ type: "reasoning.text", index: 0, text: "think." }] } }] }),
			ev({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "get_weather", arguments: "{}" } }] }, finish_reason: "tool_calls" }] })
		]);
		const body = buildChatBody(baseRequest([
			user("hi"),
			{ kind: "assistant", text: turn.text, toolCalls: turn.toolCalls, native: turn.native },
			{ kind: "tool_results", results: [{ callId: "c1", name: "get_weather", text: "ok", isError: false }] }
		]), quirks, { stream: false });
		const messages = body.messages as Record<string, unknown>[];
		expect(messages[2].reasoning_details).toEqual([{ type: "reasoning.text", index: 0, text: "Let me think.", signature: "s1" }]);
		expect(messages[2].content).toBeNull();
		expect(messages[2].tool_calls).toEqual([{ id: "c1", type: "function", function: { name: "get_weather", arguments: "{}" } }]);
		expect(messages[3]).toEqual({ role: "tool", tool_call_id: "c1", content: "ok" });
	});

	test("local servers receive neither tool_choice, parallel_tool_calls nor stream_options", () => {
		const body = buildChatBody(baseRequest([user("hi")]), CHAT_QUIRKS["openai-compatible"], { stream: true });
		expect(body.tool_choice).toBeUndefined();
		expect(body.parallel_tool_calls).toBeUndefined();
		expect(body.stream_options).toBeUndefined();
		expect(body.stream).toBe(true);
	});

	test("hosted providers get what they document", () => {
		const openrouter = buildChatBody(baseRequest([user("hi")]), CHAT_QUIRKS.openrouter, { stream: true });
		expect(openrouter.tool_choice).toBe("auto");
		expect(openrouter.parallel_tool_calls).toBe(true);
		expect(openrouter.stream_options).toEqual({ include_usage: true });
		const foundry = buildChatBody(baseRequest([user("hi")], { toolChoice: "none" }), CHAT_QUIRKS["azure-ai"], { stream: false });
		expect(foundry.tool_choice).toBe("none");
		expect(foundry.parallel_tool_calls).toBeUndefined();
		expect(foundry.stream_options).toBeUndefined();
	});

	test("sends no output cap by default and the right parameter name when one is set", () => {
		expect(buildChatBody(baseRequest([user("x")]), quirks, { stream: false }).max_tokens).toBeUndefined();
		expect(buildChatBody(baseRequest([user("x")], { maxOutputTokens: 900 }), quirks, { stream: false }).max_tokens).toBe(900);
		expect(buildChatBody(baseRequest([user("x")], { maxOutputTokens: 900 }), { ...quirks, tokenParam: "max_completion_tokens" }, { stream: false }).max_completion_tokens).toBe(900);
	});
});

describe("Anthropic Messages tool turns", () => {
	const stream = [
		ev({ type: "message_start", message: { id: "msg_1", usage: { input_tokens: 472, output_tokens: 2 } } }),
		ev({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } }),
		ev({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "" } }),
		ev({ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "EqQB-sig" } }),
		ev({ type: "content_block_stop", index: 0 }),
		ev({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }),
		ev({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "I'll check." } }),
		ev({ type: "content_block_stop", index: 1 }),
		ev({ type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "toolu_01T1", name: "get_weather", input: {} } }),
		ev({ type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: "" } }),
		ev({ type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: "{\"location\":" } }),
		ev({ type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: " \"San Francisco, CA\"}" } }),
		ev({ type: "content_block_stop", index: 2 }),
		ev({ type: "ping" }),
		ev({ type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 89 } }),
		ev({ type: "message_stop" })
	];
	const streamedTurn = (): TurnResult => parseAnthropicBody(assembleAnthropicBody(reduceAll(anthropicToolStreamAdapter, stream).state));

	test("streams text, keeps thinking with its signature, and parses tool input at the end", () => {
		const { text } = reduceAll(anthropicToolStreamAdapter, stream);
		expect(text).toBe("I'll check.");
		const turn = streamedTurn();
		expect(turn.stop).toBe("tool_calls");
		expect(turn.toolCalls).toEqual([{ id: "toolu_01T1", name: "get_weather", input: { location: "San Francisco, CA" }, rawInput: "{\"location\":\"San Francisco, CA\"}" }]);
		expect(turn.native).toEqual([
			{ type: "thinking", thinking: "", signature: "EqQB-sig" },
			{ type: "text", text: "I'll check." },
			{ type: "tool_use", id: "toolu_01T1", name: "get_weather", input: { location: "San Francisco, CA" } }
		]);
		expect(turn.narration).toBe("I'll check.");
		expect(turn.usage).toEqual({ input_tokens: 472, output_tokens: 89, total_tokens: 561 });
	});

	test("the buffered parse of the same reply gives the same turn", () => {
		const buffered = parseAnthropicBody({
			stop_reason: "tool_use",
			usage: { input_tokens: 472, output_tokens: 89 },
			content: [
				{ type: "thinking", thinking: "", signature: "EqQB-sig" },
				{ type: "text", text: "I'll check." },
				{ type: "tool_use", id: "toolu_01T1", name: "get_weather", input: { location: "San Francisco, CA" } }
			]
		});
		expect(buffered).toEqual(streamedTurn());
	});

	test("replays the ordered content blocks, thinking included, ahead of the tool results", () => {
		const turn = streamedTurn();
		const body = buildAnthropicBody(baseRequest([
			user("Weather?"),
			{ kind: "assistant", text: "", toolCalls: turn.toolCalls, native: turn.native },
			{ kind: "tool_results", results: [{ callId: "toolu_01T1", name: "get_weather", text: "Not run.", isError: true }] }
		]), { stream: true });
		const messages = body.messages as { role: string; content: Record<string, unknown>[] }[];
		expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
		expect(messages[1].content).toEqual(turn.native as never);
		expect(messages[2].content).toEqual([{ type: "tool_result", tool_use_id: "toolu_01T1", content: "Not run.", is_error: true }]);
		expect(body.tool_choice).toEqual({ type: "auto", disable_parallel_tool_use: false });
	});

	test("all results of parallel calls go in one user message, results only, in call order", () => {
		const body = buildAnthropicBody(baseRequest([
			user("x"),
			{ kind: "assistant", text: "", toolCalls: [], native: [{ type: "tool_use", id: "a", name: "t", input: {} }, { type: "tool_use", id: "b", name: "t", input: {} }] },
			{ kind: "tool_results", results: [{ callId: "a", name: "t", text: "one", isError: false }, { callId: "b", name: "t", text: "two", isError: false }] }
		]), { stream: false });
		const last = (body.messages as { content: Record<string, unknown>[] }[]).at(-1);
		expect(last?.content.map((block) => block.type)).toEqual(["tool_result", "tool_result"]);
		expect(last?.content.map((block) => block.tool_use_id)).toEqual(["a", "b"]);
		expect(last?.content.every((block) => block.is_error === undefined)).toBe(true);
	});

	test("never sends a thinking parameter or a forced tool_choice", () => {
		for (const toolChoice of ["auto", "none"] as ToolChoice[]) {
			const body = buildAnthropicBody(baseRequest([user("x")], { toolChoice }), { stream: false });
			expect(body.thinking).toBeUndefined();
			expect(JSON.stringify(body.tool_choice)).not.toMatch(/"any"|"tool"/);
		}
		expect(buildAnthropicBody(baseRequest([user("x")], { toolChoice: "none" }), { stream: false }).tool_choice).toEqual({ type: "none" });
		expect(buildAnthropicBody(baseRequest([user("x")], { parallelToolCalls: false }), { stream: false }).tool_choice).toEqual({ type: "auto", disable_parallel_tool_use: true });
	});

	test("keeps the system prompt and tools identical on every turn so thinking blocks stay valid", () => {
		const first = buildAnthropicBody(baseRequest([user("x")]), { stream: false });
		const later = buildAnthropicBody(baseRequest([user("x"), { kind: "assistant", text: "", toolCalls: [], native: [] }, { kind: "tool_results", results: [] }], { toolChoice: "none" }), { stream: false });
		expect(later.system).toBe(first.system);
		expect(later.tools).toEqual(first.tools);
	});

	test("max_tokens is always present: the per-model default unless the caller sets one", () => {
		expect(buildAnthropicBody(baseRequest([user("x")]), { stream: false }).max_tokens).toBe(32000);
		expect(buildAnthropicBody(baseRequest([user("x")], { model: "claude-3-haiku-20240307" }), { stream: false }).max_tokens).toBe(4096);
		expect(buildAnthropicBody(baseRequest([user("x")], { maxOutputTokens: 5000 }), { stream: false }).max_tokens).toBe(5000);
	});

	test("tool_use is a normal end of turn, never an incomplete reply", () => {
		expect(getAnthropicIncompleteReason({ stop_reason: "tool_use" })).toBeNull();
		expect(parseAnthropicBody({ stop_reason: "tool_use", content: [{ type: "tool_use", id: "t", name: "x", input: {} }] }).stop).toBe("tool_calls");
	});

	test("invalid streamed JSON is reported and replays as an empty object", () => {
		const bad = [
			ev({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t1", name: "get_weather", input: {} } }),
			ev({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"location\": \"Pa" } }),
			ev({ type: "content_block_stop", index: 0 }),
			ev({ type: "message_delta", delta: { stop_reason: "tool_use" } }),
			ev({ type: "message_stop" })
		];
		const turn = parseAnthropicBody(assembleAnthropicBody(reduceAll(anthropicToolStreamAdapter, bad).state));
		expect(turn.toolCalls[0].inputError).toBeDefined();
		expect(turn.native).toEqual([{ type: "tool_use", id: "t1", name: "get_weather", input: {} }]);
	});

	test("max_tokens that cuts a tool_use runs nothing, and a refusal stops the run", () => {
		const cut = parseAnthropicBody({ stop_reason: "max_tokens", content: [{ type: "tool_use", id: "t", name: "x", input: "{\"a\":" }] });
		expect(cut.stop).toBe("truncated");
		expect(cut.toolCalls).toEqual([]);
		expect(parseAnthropicBody({ stop_reason: "refusal", content: [] }).stop).toBe("refused");
		expect(parseAnthropicBody({ stop_reason: "model_context_window_exceeded", content: [] }).stop).toBe("truncated");
	});

	test("pause_turn is an error because AskMate declares no server tools", () => {
		expect(() => parseAnthropicBody({ stop_reason: "pause_turn", content: [] })).toThrow("pause_turn");
	});

	test("empty text blocks are not replayed, unknown blocks are kept in place", () => {
		const events = [
			ev({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
			ev({ type: "content_block_start", index: 1, content_block: { type: "redacted_thinking", data: "opaque" } }),
			ev({ type: "content_block_start", index: 2, content_block: { type: "server_tool_use", id: "s", name: "web_search" } }),
			ev({ type: "message_delta", delta: { stop_reason: "end_turn" } })
		];
		const assembled = assembleAnthropicBody(reduceAll(anthropicToolStreamAdapter, events).state);
		expect(assembled.content).toEqual([{ type: "redacted_thinking", data: "opaque" }, { type: "server_tool_use", id: "s", name: "web_search" }]);
	});

	test("a thinking block between two text blocks adds no blank line", () => {
		const turn = parseAnthropicBody({
			stop_reason: "end_turn",
			content: [{ type: "text", text: "A" }, { type: "thinking", thinking: "hmm", signature: "s" }, { type: "text", text: "B" }]
		});
		expect(turn.text).toBe("A\nB");
	});

	test("a connection that closes after message_delta is still a finished turn", () => {
		const cut = stream.slice(0, -1);
		const { state } = reduceAll(anthropicToolStreamAdapter, cut);
		expect(anthropicToolStreamAdapter.isTerminal(state)).toBe(true);
		const early = reduceAll(anthropicToolStreamAdapter, stream.slice(0, 8));
		expect(anthropicToolStreamAdapter.isTerminal(early.state)).toBe(false);
		expect(anthropicToolStreamAdapter.getUsage?.(early.state)).toEqual({ input_tokens: 472 });
	});

	test("an overloaded error event raises a provider error", () => {
		expect(() => reduceAll(anthropicToolStreamAdapter, [ev({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } })])).toThrow("Overloaded");
	});
});

describe("Gemini tool turns", () => {
	const chunks = [
		ev({ candidates: [{ content: { role: "model", parts: [{ text: "Let me " }, { text: "check." }] } }] }),
		ev({
			candidates: [{ content: { role: "model", parts: [
				{ functionCall: { name: "get_weather", args: { location: "Paris" } }, thoughtSignature: "SigA" },
				{ functionCall: { name: "get_weather", args: { location: "London" } } }
			] }, finishReason: "STOP" }],
			usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 4, thoughtsTokenCount: 6, totalTokenCount: 20 }
		})
	];
	const streamedTurn = (): TurnResult => parseGeminiBody(assembleGeminiBody(reduceAll(geminiToolStreamAdapter, chunks).state));

	test("keeps ordered parts, merges only plain adjacent text, and synthesises ids for Gemini 2.5", () => {
		const { text } = reduceAll(geminiToolStreamAdapter, chunks);
		expect(text).toBe("Let me check.");
		const turn = streamedTurn();
		expect(turn.stop).toBe("tool_calls");
		expect(turn.toolCalls.map((call) => [call.id, call.input])).toEqual([["askmate-1", { location: "Paris" }], ["askmate-2", { location: "London" }]]);
		expect((turn.native as { parts: unknown[] }).parts).toEqual([
			{ text: "Let me check." },
			{ functionCall: { name: "get_weather", args: { location: "Paris" } }, thoughtSignature: "SigA" },
			{ functionCall: { name: "get_weather", args: { location: "London" } } }
		]);
		expect(turn.usage).toEqual({ input_tokens: 10, output_tokens: 10, total_tokens: 20, output_tokens_details: { reasoning_tokens: 6 } });
	});

	test("a signature on an empty text part is preserved, not merged away", () => {
		const { state } = reduceAll(geminiToolStreamAdapter, [
			ev({ candidates: [{ content: { parts: [{ text: "Done." }] } }] }),
			ev({ candidates: [{ content: { parts: [{ text: "", thoughtSignature: "SigEnd" }] }, finishReason: "STOP" }] })
		]);
		const turn = parseGeminiBody(assembleGeminiBody(state));
		expect(turn.text).toBe("Done.");
		expect((turn.native as { parts: unknown[] }).parts).toEqual([{ text: "Done." }, { text: "", thoughtSignature: "SigEnd" }]);
	});

	test("thought summaries are not answer text, in the stream or the buffered reply", () => {
		const parts = [{ text: "Planning.", thought: true }, { text: "The answer." }];
		const buffered = parseGeminiBody({ candidates: [{ content: { parts }, finishReason: "STOP" }] });
		expect(buffered.text).toBe("The answer.");
		const streamed = reduceAll(geminiToolStreamAdapter, [ev({ candidates: [{ content: { parts }, finishReason: "STOP" }] })]);
		expect(streamed.text).toBe("The answer.");
		expect(parseGeminiBody(assembleGeminiBody(streamed.state)).text).toBe("The answer.");
		expect((buffered.native as { parts: unknown[] }).parts).toEqual(parts);
	});

	test("answer text is joined without a separator", () => {
		expect(parseGeminiBody({ candidates: [{ content: { parts: [{ text: "Hel" }, { text: "lo" }] }, finishReason: "STOP" }] }).text).toBe("Hello");
	});

	test("the request returns all functionResponse parts in one user content and omits synthetic ids", () => {
		const turn = streamedTurn();
		const body = buildGeminiBody(baseRequest([
			user("Weather in Paris and London?"),
			{ kind: "assistant", text: "", toolCalls: turn.toolCalls, native: turn.native },
			{ kind: "tool_results", results: turn.toolCalls.map((call) => ({ callId: call.id, name: call.name, text: "15C", isError: false })) }
		]));
		const contents = body.contents as { role: string; parts: Record<string, unknown>[] }[];
		expect(contents.map((content) => content.role)).toEqual(["user", "model", "user"]);
		expect(contents[2].parts).toEqual([
			{ functionResponse: { name: "get_weather", response: { result: "15C" } } },
			{ functionResponse: { name: "get_weather", response: { result: "15C" } } }
		]);
		expect(contents[1].parts[1]).toMatchObject({ thoughtSignature: "SigA" });
		expect(body.toolConfig).toEqual({ functionCallingConfig: { mode: "AUTO" } });
	});

	test("real Gemini 3 ids are echoed and an error result uses the error key", () => {
		const body = buildGeminiBody(baseRequest([
			user("x"),
			{ kind: "assistant", text: "", toolCalls: [], native: { parts: [{ functionCall: { id: "8f2b1a3c", name: "x", args: {} } }] } },
			{ kind: "tool_results", results: [{ callId: "8f2b1a3c", name: "x", text: "Declined.", isError: true }] }
		]));
		const last = (body.contents as { parts: unknown[] }[]).at(-1);
		expect(last?.parts).toEqual([{ functionResponse: { id: "8f2b1a3c", name: "x", response: { error: "Declined." } } }]);
	});

	test("sends parametersJsonSchema by default and the OpenAPI subset on the retry", () => {
		const declaration = (dialect?: "json-schema" | "openapi"): Record<string, unknown> => {
			const body = buildGeminiBody(baseRequest([user("x")], {
				tools: [{ name: "t", description: "d", inputSchema: { type: "object", additionalProperties: false, properties: { a: { type: ["string", "null"] } } } }]
			}), { schemaDialect: dialect });
			return ((body.tools as { functionDeclarations: Record<string, unknown>[] }[])[0].functionDeclarations[0]);
		};
		expect(declaration().parametersJsonSchema).toEqual({ type: "object", additionalProperties: false, properties: { a: { type: ["string", "null"] } } });
		expect(declaration().parameters).toBeUndefined();
		expect(declaration("openapi").parameters).toEqual({ type: "object", properties: { a: { type: "string", nullable: true } } });
		expect(declaration("openapi").parametersJsonSchema).toBeUndefined();
	});

	test("omits generationConfig unless a cap is set, and uses NONE for the last turn", () => {
		expect(buildGeminiBody(baseRequest([user("x")])).generationConfig).toBeUndefined();
		expect(buildGeminiBody(baseRequest([user("x")], { maxOutputTokens: 2000 })).generationConfig).toEqual({ maxOutputTokens: 2000 });
		expect(buildGeminiBody(baseRequest([user("x")], { toolChoice: "none" })).toolConfig).toEqual({ functionCallingConfig: { mode: "NONE" } });
	});

	test("malformed and unexpected calls are reported, never run", () => {
		for (const finishReason of ["MALFORMED_FUNCTION_CALL", "UNEXPECTED_TOOL_CALL", "TOO_MANY_TOOL_CALLS", "MISSING_THOUGHT_SIGNATURE"]) {
			const turn = parseGeminiBody({ candidates: [{ content: { parts: [{ functionCall: { name: "x", args: {} } }] }, finishReason }] });
			expect(turn.stop).toBe("malformed_call");
			expect(turn.toolCalls).toEqual([]);
			expect(turn.providerStopReason).toBe(finishReason);
		}
	});

	test("safety stops, blocked prompts and token limits map to their own stops", () => {
		expect(parseGeminiBody({ candidates: [{ finishReason: "SAFETY" }] }).stop).toBe("blocked");
		expect(parseGeminiBody({ promptFeedback: { blockReason: "PROHIBITED_CONTENT" } }).stop).toBe("blocked");
		expect(parseGeminiBody({ promptFeedback: { blockReason: "BLOCK_REASON_UNSPECIFIED" }, candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }] }).stop).toBe("end");
		const cut = parseGeminiBody({ candidates: [{ content: { parts: [{ functionCall: { name: "x", args: {} } }] }, finishReason: "MAX_TOKENS" }] });
		expect(cut.stop).toBe("truncated");
		expect(cut.toolCalls).toEqual([]);
	});

	test("Gemini 3 ids are kept as given", () => {
		const turn = parseGeminiBody({ candidates: [{ content: { parts: [{ functionCall: { id: "8f2b1a3c", name: "x", args: {} } }] }, finishReason: "STOP" }] });
		expect(turn.toolCalls[0].id).toBe("8f2b1a3c");
	});

	test("an error chunk raises a provider error", () => {
		expect(() => reduceAll(geminiToolStreamAdapter, [ev({ error: { message: "quota" } })])).toThrow("quota");
	});
});

describe("tool wire adapter registry", () => {
	test.each([
		["openai", "responses", "responses"],
		["azure-openai", "responses", "responses"],
		["anthropic", "anthropic", "anthropic_messages"],
		["google-gemini", "gemini", "gemini_generate_content"],
		["openrouter", "chat", "chat_completions"],
		["azure-ai", "chat", "chat_completions"],
		["openai-compatible", "chat", "chat_completions"]
	] as const)("%s uses the %s wire format and records %s", (providerId, family, endpoint) => {
		const adapter = getToolWireAdapter(providerId);
		expect(adapter.family).toBe(family);
		expect(adapter.endpoint).toBe(endpoint);
		expect(getToolTurnEndpoint(providerId)).toBe(endpoint);
	});

	test("each chat provider's adapter carries its own quirks", () => {
		const request = baseRequest([user("x")]);
		expect(getToolWireAdapter("openai-compatible").buildBody(request, { stream: true }).tool_choice).toBeUndefined();
		expect(getToolWireAdapter("openrouter").buildBody(request, { stream: true }).tool_choice).toBe("auto");
		expect(getToolWireAdapter("openrouter").buildBody(request, { stream: true }).stream_options).toEqual({ include_usage: true });
		expect(getToolWireAdapter("azure-ai").buildBody(request, { stream: true }).parallel_tool_calls).toBeUndefined();
	});

	test("an unknown provider is refused instead of reusing another provider's wire format", () => {
		expect(() => getToolWireAdapter("made-up" as never)).toThrow("Unsupported text provider: made-up");
	});

	test.each([
		["openai", "gpt-5.5", true],
		["openai", "o3", true],
		["openai", "o1-mini", false],
		["openai", "o3-deep-research", false],
		["openai", "gpt-image-2", false],
		["openai", "text-embedding-3-large", false],
		["azure-openai", "my-deployment", true],
		["azure-ai", "mistral-large", true],
		["openrouter", "anthropic/claude-sonnet-5-5", true],
		["openai-compatible", "llama3.1", true],
		["anthropic", "claude-sonnet-5-5", true],
		["anthropic", "claude-3-haiku-20240307", true],
		["anthropic", "claude-2.1", false],
		["anthropic", "claude-instant-1.2", false],
		["google-gemini", "gemini-2.5-pro", true],
		["google-gemini", "gemini-3-pro-preview", true],
		["google-gemini", "gemma-3-27b-it", false],
		["google-gemini", "gemini-2.5-flash-image", false],
		["google-gemini", "gemini-2.5-flash-preview-tts", false]
	] as const)("supportsTools(%s, %s) is %p", (providerId, model, expected) => {
		expect(supportsTools(providerId, model)).toBe(expected);
	});

	test.each(["openai", "azure-openai", "azure-ai", "openrouter", "anthropic", "google-gemini", "openai-compatible"] as const)("%s offers no tools without a model", (providerId) => {
		expect(supportsTools(providerId, "  ")).toBe(false);
	});

	test("tool turns send no output cap, except where the API requires one", () => {
		expect(getToolTurnMaxOutputTokens("openai", "gpt-5.5")).toBe(0);
		expect(getToolTurnMaxOutputTokens("google-gemini", "gemini-2.5-pro")).toBe(0);
		expect(getToolTurnMaxOutputTokens("openrouter", "m")).toBe(0);
		expect(getToolTurnMaxOutputTokens("anthropic", "claude-sonnet-5-5")).toBe(32000);
		expect(getToolTurnMaxOutputTokens("anthropic", "claude-3-5-haiku-20241022")).toBe(8192);
	});

	test("only OpenAI models get a reasoning effort, clamped for the model", () => {
		expect(getToolTurnReasoningEffort("openai", "gpt-5.5", "high")).toBe("high");
		expect(getToolTurnReasoningEffort("openai", "o3", "xhigh")).toBe("high");
		expect(getToolTurnReasoningEffort("openai", "gpt-4.1", "high")).toBeNull();
		expect(getToolTurnReasoningEffort("azure-openai", "my-deployment", "high")).toBeNull();
		expect(getToolTurnReasoningEffort("anthropic", "claude-sonnet-5-5", "high")).toBeNull();
	});
});

describe("tool loop", () => {
	const known = new Set(["get_weather", "ask_user"]);

	function runtime(overrides: Partial<ToolRuntime> = {}): ToolRuntime & { ran: ToolCall[] } {
		const ran: ToolCall[] = [];
		return {
			ran,
			has: (name) => known.has(name),
			run: async (call) => {
				ran.push(call);
				return { text: `ran ${call.name}`, isError: false };
			},
			needsApproval: (call) => call.name === "ask_user",
			...overrides
		};
	}

	function turn(overrides: Partial<TurnResult>): TurnResult {
		return { text: "", narration: "", toolCalls: [], stop: "end", providerStopReason: null, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }, native: null, ...overrides };
	}

	const call = (id: string, name = "get_weather", overrides: Partial<ToolCall> = {}): ToolCall => ({ id, name, input: {}, rawInput: "{}", ...overrides });
	const callsTurn = (...calls: ToolCall[]): TurnResult => turn({ stop: "tool_calls", toolCalls: calls });

	function harness(turns: TurnResult[], tools: ToolRuntime, overrides: Partial<ToolLoopDeps> = {}): { deps: ToolLoopDeps; choices: ToolChoice[]; progress: ToolLoopProgress[]; sent: HistoryItem[][] } {
		const choices: ToolChoice[] = [];
		const sent: HistoryItem[][] = [];
		const progress: ToolLoopProgress[] = [];
		const queue = [...turns];
		const deps: ToolLoopDeps = {
			sendTurn: async (history, choice) => {
				choices.push(choice);
				sent.push([...history]);
				const next = queue.shift();
				if (!next) {
					throw new Error("The model was asked for more turns than the test planned.");
				}
				return next;
			},
			tools,
			approve: async () => true,
			onProgress: (event) => progress.push(event),
			signal: new AbortController().signal,
			...overrides
		};
		return { deps, choices, progress, sent };
	}

	const resultsOf = (history: HistoryItem[], index: number): ToolCall["id"][] =>
		(history[index] as Extract<HistoryItem, { kind: "tool_results" }>).results.map((result) => `${result.callId}:${result.isError ? "error" : "ok"}`);

	test("answers every call exactly once, in order, including invalid, unknown and declined ones", async () => {
		const tools = runtime();
		const { deps, choices } = harness([
			turn({
				stop: "tool_calls",
				narration: "Working on it.",
				toolCalls: [call("1"), call("2", "nope"), call("3", "get_weather", { rawInput: "{", inputError: "Tool arguments were not valid JSON." }), call("4", "ask_user")]
			}),
			turn({ text: "Final answer." })
		], tools, { approve: async () => false });
		const outcome = await runToolLoop(deps, [user("go")]);
		expect(resultsOf(outcome.history, 2)).toEqual(["1:ok", "2:error", "3:error", "4:error"]);
		expect(tools.ran.map((ran) => ran.id)).toEqual(["1"]);
		expect(outcome.answer).toBe("Final answer.");
		expect(outcome.end).toBe("answered");
		expect(outcome.usage?.total_tokens).toBe(4);
		expect(outcome.toolCallsRun).toBe(1);
		expect(outcome.turns).toBe(2);
		expect(choices).toEqual(["auto", "auto"]);
	});

	test("the history it builds is what the next turn is sent", async () => {
		const { deps, sent } = harness([callsTurn(call("1")), turn({ text: "ok" })], runtime());
		await runToolLoop(deps, [user("go")]);
		expect(sent[0].map((item) => item.kind)).toEqual(["user"]);
		expect(sent[1].map((item) => item.kind)).toEqual(["user", "assistant", "tool_results"]);
	});

	test("an error message tells the model which tool or JSON was wrong", async () => {
		const { deps } = harness([callsTurn(call("1", "nope"), call("2", "get_weather", { inputError: "Tool arguments were not valid JSON." })), turn({ text: "x" })], runtime());
		const outcome = await runToolLoop(deps, [user("go")]);
		const results = (outcome.history[2] as Extract<HistoryItem, { kind: "tool_results" }>).results;
		expect(results[0].text).toContain('Unknown tool "nope"');
		expect(results[1].text).toContain("not valid JSON");
	});

	test("a model that never stops asking gets tool_choice none on the last turn, runs nothing then, and no answer is invented", async () => {
		const tools = runtime();
		let counter = 0;
		const { deps, choices } = harness([], tools, {
			sendTurn: async (_history, choice) => {
				choices.push(choice);
				counter += 1;
				return callsTurn(call(String(counter)));
			}
		});
		const outcome = await runToolLoop(deps, [user("go")], { maxTurns: 3, maxToolCalls: 12, maxResultChars: 100 });
		expect(outcome.end).toBe("turn_limit");
		expect(outcome.answer).toBe("");
		expect(choices).toEqual(["auto", "auto", "none"]);
		expect(tools.ran.map((ran) => ran.id)).toEqual(["1", "2"]);
		expect(resultsOf(outcome.history, 6)).toEqual(["3:error"]);
	});

	test("the default limits are 8 turns, 12 calls and 12,000 characters", () => {
		expect(DEFAULT_TOOL_LOOP_LIMITS).toEqual({ maxTurns: 8, maxToolCalls: 12, maxResultChars: 12000 });
	});

	test("after the call budget is spent the extra calls are answered as not run and the next turn must answer", async () => {
		const tools = runtime();
		const { deps, choices } = harness([
			callsTurn(call("1"), call("2"), call("3")),
			turn({ text: "Here is what I found." })
		], tools);
		const outcome = await runToolLoop(deps, [user("go")], { maxTurns: 8, maxToolCalls: 2, maxResultChars: 100 });
		expect(tools.ran.map((ran) => ran.id)).toEqual(["1", "2"]);
		expect(resultsOf(outcome.history, 2)).toEqual(["1:ok", "2:ok", "3:error"]);
		expect(choices).toEqual(["auto", "none"]);
		expect(outcome.end).toBe("answered");
		expect(outcome.toolCallsRun).toBe(2);
	});

	test("a model that keeps asking after the budget is spent ends the run as call_limit", async () => {
		const tools = runtime();
		const { deps } = harness([callsTurn(call("1")), callsTurn(call("2"))], tools);
		const outcome = await runToolLoop(deps, [user("go")], { maxTurns: 8, maxToolCalls: 1, maxResultChars: 100 });
		expect(outcome.end).toBe("call_limit");
		expect(outcome.answer).toBe("");
		expect(tools.ran.map((ran) => ran.id)).toEqual(["1"]);
		expect(resultsOf(outcome.history, 4)).toEqual(["2:error"]);
	});

	test("calls that were invalid, unknown or declined do not use up the call budget", async () => {
		const tools = runtime();
		const { deps } = harness([
			callsTurn(call("1", "nope"), call("2", "ask_user"), call("3")),
			turn({ text: "done" })
		], tools, { approve: async () => false });
		const outcome = await runToolLoop(deps, [user("go")], { maxTurns: 8, maxToolCalls: 1, maxResultChars: 100 });
		expect(tools.ran.map((ran) => ran.id)).toEqual(["3"]);
		expect(outcome.toolCallsRun).toBe(1);
	});

	test("a tool that runs but reports failure still counts as a call", async () => {
		const tools = runtime({ run: async () => ({ text: "boom", isError: true }) });
		const { deps } = harness([callsTurn(call("1"), call("2")), turn({ text: "x" })], tools);
		const outcome = await runToolLoop(deps, [user("go")], { maxTurns: 8, maxToolCalls: 1, maxResultChars: 100 });
		expect(outcome.toolCallsRun).toBe(1);
		expect(resultsOf(outcome.history, 2)).toEqual(["1:error", "2:error"]);
	});

	test("truncated, blocked, refused and malformed turns end the run without an answer", async () => {
		for (const stop of ["truncated", "blocked", "refused", "malformed_call"] as const) {
			const { deps } = harness([turn({ text: "Half a sen", stop, providerStopReason: "why" })], runtime());
			const outcome = await runToolLoop(deps, [user("go")]);
			expect(outcome).toMatchObject({ end: stop, answer: "", providerStopReason: "why" });
		}
	});

	test("a turn that claims tool calls but carries none is malformed, not an answer", async () => {
		const { deps } = harness([turn({ stop: "tool_calls", text: "I will call it" })], runtime());
		const outcome = await runToolLoop(deps, [user("go")]);
		expect(outcome).toMatchObject({ end: "malformed_call", answer: "" });
	});

	test("a finished turn with no text is an empty answer, not a silent success", async () => {
		const { deps } = harness([callsTurn(call("1")), turn({ text: "  " })], runtime());
		const outcome = await runToolLoop(deps, [user("go")]);
		expect(outcome).toMatchObject({ end: "empty_answer", answer: "" });
		expect(describeToolLoopEnd(outcome)).toContain("without writing an answer");
	});

	test("only the text of the last tool-free turn is the answer; narration is progress", async () => {
		const { deps, progress } = harness([
			turn({ stop: "tool_calls", toolCalls: [call("1")], narration: "Let me check.", text: "" }),
			turn({ text: "It is sunny.", narration: "Done checking." })
		], runtime());
		const outcome = await runToolLoop(deps, [user("go")]);
		expect(outcome.answer).toBe("It is sunny.");
		expect(progress.filter((event) => event.kind === "narration").map((event) => (event as { text: string }).text)).toEqual(["Let me check.", "Done checking."]);
	});

	test("reports turns, calls and results as progress, with the call's real arguments", async () => {
		const withArgs = call("1", "get_weather", { input: { location: "Paris" }, rawInput: "{\"location\":\"Paris\"}" });
		const { deps, progress } = harness([callsTurn(withArgs), turn({ text: "ok" })], runtime());
		await runToolLoop(deps, [user("go")]);
		expect(progress.map((event) => event.kind)).toEqual(["turn", "call", "result", "turn"]);
		const started = progress.find((event) => event.kind === "call");
		expect(started).toMatchObject({ turn: 1, call: { input: { location: "Paris" } } });
	});

	test("asks for approval with the real call, only for tools that need it, one at a time", async () => {
		const asked: string[] = [];
		let open = 0;
		let overlap = false;
		const { deps } = harness([callsTurn(call("1", "ask_user"), call("2", "ask_user")), turn({ text: "ok" })], runtime(), {
			approve: async (approved) => {
				open += 1;
				overlap ||= open > 1;
				asked.push(approved.id);
				await Promise.resolve();
				open -= 1;
				return true;
			}
		});
		await runToolLoop(deps, [user("go")]);
		expect(asked).toEqual(["1", "2"]);
		expect(overlap).toBe(false);
	});

	test("a read-only tool runs without asking", async () => {
		let asked = false;
		const { deps } = harness([callsTurn(call("1")), turn({ text: "ok" })], runtime(), { approve: async () => { asked = true; return true; } });
		await runToolLoop(deps, [user("go")]);
		expect(asked).toBe(false);
	});

	test("a tool result is cut to the limit, notice included, and never in the middle of a character", async () => {
		const long = "x".repeat(20000);
		const { deps } = harness([callsTurn(call("1")), turn({ text: "ok" })], runtime({ run: async () => ({ text: long, isError: false }) }));
		const outcome = await runToolLoop(deps, [user("go")]);
		const text = (outcome.history[2] as Extract<HistoryItem, { kind: "tool_results" }>).results[0].text;
		expect(text.length).toBeLessThanOrEqual(12000);
		expect(text).toContain("AskMate cut this tool result after 12000 characters");

		const emoji = "😀".repeat(100);
		const cut = truncateResult(emoji, 60);
		expect(cut.length).toBeLessThanOrEqual(60);
		expect(cut).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
		expect(truncateResult("short", 60)).toBe("short");
	});

	test("a tool that throws is answered with an error and the key is not leaked", async () => {
		const secret = "sk-abcdefghijklmnopqrstuvwxyz0123";
		const { deps } = harness([callsTurn(call("1")), turn({ text: "ok" })], runtime({ run: async () => { throw new Error(`failed with ${secret}`); } }));
		const outcome = await runToolLoop(deps, [user("go")]);
		const result = (outcome.history[2] as Extract<HistoryItem, { kind: "tool_results" }>).results[0];
		expect(result.isError).toBe(true);
		expect(result.text).toContain("The tool failed");
		expect(result.text).not.toContain(secret);
		expect(outcome.end).toBe("answered");
	});

	test("a stop reaches the model request: sendTurn gets the run's signal, and an aborted run never sends", async () => {
		const controller = new AbortController();
		const seen: { signal: AbortSignal | null } = { signal: null };
		const { deps } = harness([], runtime(), {
			signal: controller.signal,
			sendTurn: async (_history, _choice, signal) => {
				seen.signal = signal;
				return turn({ text: "ok" });
			}
		});
		await runToolLoop(deps, [user("go")]);
		expect(seen.signal).toBe(controller.signal);

		controller.abort();
		let sent = false;
		const stopped = harness([], runtime(), { signal: controller.signal, sendTurn: async () => { sent = true; return turn({ text: "x" }); } });
		const error = await runToolLoop(stopped.deps, [user("go")]).catch((caught: unknown) => caught);
		expect(isAbortError(error)).toBe(true);
		expect(sent).toBe(false);
	});

	test("a stop reaches the tool: run gets the signal and the loop rejects without waiting for a tool that ignores it", async () => {
		const controller = new AbortController();
		const seen: { signal: AbortSignal | null } = { signal: null };
		const tools = runtime({
			run: async (_call, signal) => {
				seen.signal = signal;
				controller.abort();
				return await new Promise<never>(() => undefined);
			}
		});
		const { deps } = harness([callsTurn(call("1"))], tools, { signal: controller.signal });
		const error = await runToolLoop(deps, [user("go")]).catch((caught: unknown) => caught);
		expect(isAbortError(error)).toBe(true);
		expect(seen.signal).toBe(controller.signal);
	});

	test("a stop while waiting for approval rejects and the tool never runs", async () => {
		const controller = new AbortController();
		const tools = runtime();
		const { deps } = harness([callsTurn(call("1", "ask_user"))], tools, {
			signal: controller.signal,
			approve: async () => {
				controller.abort();
				return await new Promise<boolean>(() => undefined);
			}
		});
		const error = await runToolLoop(deps, [user("go")]).catch((caught: unknown) => caught);
		expect(isAbortError(error)).toBe(true);
		expect(tools.ran).toEqual([]);
	});

	test("a stop between calls of one turn runs no further call", async () => {
		const controller = new AbortController();
		const started: string[] = [];
		const tools = runtime({
			run: async (ran) => {
				started.push(ran.id);
				if (ran.id === "1") {
					controller.abort();
				}
				return { text: "ok", isError: false };
			}
		});
		const { deps } = harness([callsTurn(call("1"), call("2"))], tools, { signal: controller.signal });
		const error = await runToolLoop(deps, [user("go")]).catch((caught: unknown) => caught);
		expect(isAbortError(error)).toBe(true);
		expect(started).toEqual(["1"]);
	});

	test("the end of a run is explained in plain words", () => {
		const base = { toolCallsRun: 3, turns: 8, providerStopReason: "max_tokens" };
		expect(describeToolLoopEnd({ ...base, end: "answered" })).toBe("");
		expect(describeToolLoopEnd({ ...base, end: "turn_limit" })).toContain("8 model turns");
		expect(describeToolLoopEnd({ ...base, end: "call_limit" })).toContain("3 tool calls");
		expect(describeToolLoopEnd({ ...base, end: "truncated" })).toContain("(max_tokens)");
		for (const end of ["turn_limit", "call_limit", "truncated", "refused", "blocked", "malformed_call", "empty_answer"] as const) {
			expect(describeToolLoopEnd({ ...base, end })).not.toContain("—");
		}
	});

	test("a run that ends after tools already ran never says nothing ran", () => {
		const base = { turns: 2, providerStopReason: "max_tokens" };

		const truncatedAfterTools = describeToolLoopEnd({ ...base, toolCallsRun: 12, end: "truncated" });
		expect(truncatedAfterTools).toContain("(max_tokens)");
		expect(truncatedAfterTools).toContain("12 tool calls");
		expect(truncatedAfterTools).toContain("already ran");
		expect(truncatedAfterTools).not.toContain("no tool was run");

		const truncatedAlone = describeToolLoopEnd({ ...base, toolCallsRun: 0, end: "truncated" });
		expect(truncatedAlone).toContain("no tool was run");
		expect(truncatedAlone).not.toContain("already ran");

		expect(describeToolLoopEnd({ ...base, toolCallsRun: 1, end: "truncated" })).toContain("1 tool call already ran");
	});

	test("the retry advice is withheld once tools with side effects have run", () => {
		const base = { turns: 2, providerStopReason: "stop" };

		for (const end of ["malformed_call", "empty_answer"] as const) {
			const afterTools = describeToolLoopEnd({ ...base, toolCallsRun: 4, end });
			expect(afterTools).toContain("4 tool calls");
			expect(afterTools).not.toMatch(/try again/i);

			expect(describeToolLoopEnd({ ...base, toolCallsRun: 0, end })).toMatch(/try again/i);
		}
	});

	test("the other non-answer ends also mention tool calls that already ran", () => {
		const base = { turns: 8, providerStopReason: "stop" };

		for (const end of ["turn_limit", "refused", "blocked"] as const) {
			expect(describeToolLoopEnd({ ...base, toolCallsRun: 5, end })).toContain("5 tool calls");
			expect(describeToolLoopEnd({ ...base, toolCallsRun: 0, end })).not.toMatch(/tool call/);
		}
	});

	test("a truncated second turn after executed calls is reported with the real count", async () => {
		const tools = runtime();
		const { deps } = harness([callsTurn(call("1"), call("2")), turn({ stop: "truncated", providerStopReason: "max_tokens" })], tools);
		const outcome = await runToolLoop(deps, [user("go")]);
		expect(outcome.end).toBe("truncated");
		expect(outcome.toolCallsRun).toBe(2);
		const message = describeToolLoopEnd(outcome);
		expect(message).toContain("2 tool calls");
		expect(message).not.toContain("no tool was run");
	});
});

// ---- One tool turn over HTTP ------------------------------------------------------------------------------------------

const KEY = "test-secret-key-0123456789";

interface SentRequest {
	kind: "buffered" | "stream";
	url: string;
	headers: Record<string, string>;
	body: Record<string, unknown>;
	signal: AbortSignal | undefined;
	timeoutMs?: number;
	timeoutMessage?: string;
}

type StreamScript = { chunks: string[]; contentType?: string } | "network-error" | "close-empty";

interface ToolRuntimeOptions {
	baseUrl: string;
	apiKey?: string;
	model?: string;
	buffered?: AskMateHttpResponse<unknown>[];
	streams?: StreamScript[];
}

function frame(payload: unknown): string {
	return `data: ${typeof payload === "string" ? payload : JSON.stringify(payload)}\n\n`;
}

function ok(body: unknown): AskMateHttpResponse<unknown> {
	return { status: 200, ok: true, body, text: JSON.stringify(body) };
}

function failure(status: number, body: unknown): AskMateHttpResponse<unknown> {
	return { status, ok: false, body, text: JSON.stringify(body) };
}

function toolRuntime({ baseUrl, apiKey = KEY, model = "test-model", buffered = [], streams }: ToolRuntimeOptions): { runtime: ProviderRuntime; sent: SentRequest[] } {
	const sent: SentRequest[] = [];
	const bufferedQueue = [...buffered];
	const streamQueue = [...(streams ?? [])];
	const fetchFn: FetchLike = async (url, init) => {
		sent.push({ kind: "stream", url, headers: init.headers ?? {}, body: JSON.parse(init.body ?? "{}") as Record<string, unknown>, signal: init.signal });
		const script = streamQueue.shift();
		if (!script) {
			throw new Error(`Unexpected stream request to ${url}`);
		}
		if (script === "network-error") {
			throw new TypeError("Failed to fetch");
		}
		const encoder = new TextEncoder();
		const chunks = script === "close-empty" ? [] : script.chunks;
		return new Response(new ReadableStream<Uint8Array>({
			start(controller) {
				chunks.forEach((chunk) => controller.enqueue(encoder.encode(chunk)));
				controller.close();
			}
		}), { headers: { "content-type": script === "close-empty" ? "text/event-stream" : script.contentType ?? "text/event-stream" } });
	};
	const runtime: ProviderRuntime = {
		getProviderSettings: (_providerId: TextProviderId): ProviderSettings => ({ apiKeySecretName: "", model, modelOptions: [], baseUrl }),
		getProviderApiKey: async () => apiKey,
		requestJson: async <T>(url: string, options?: ProviderRequestOptions): Promise<AskMateHttpResponse<T>> => {
			sent.push({
				kind: "buffered",
				url,
				headers: options?.headers ?? {},
				body: JSON.parse(options?.body ?? "{}") as Record<string, unknown>,
				signal: options?.abortSignal,
				timeoutMs: options?.timeoutMs,
				timeoutMessage: options?.timeoutMessage
			});
			const next = bufferedQueue.shift();
			if (!next) {
				throw new Error(`Unexpected buffered request to ${url}`);
			}
			return next as AskMateHttpResponse<T>;
		},
		...(streams ? { streamSse: (url, options, onEvent) => fetchSse(fetchFn, url, options, onEvent) } : {})
	};
	return { runtime, sent };
}

function refFor(providerId: TextProviderId, model = "test-model"): ProviderModelRef {
	return { providerId, providerName: providerId === "openai" ? "OpenAI" : providerId === "anthropic" ? "Anthropic" : providerId === "google-gemini" ? "Google Gemini" : providerId, model, capability: "text" };
}

const turnRequest = (overrides: Partial<TurnRequest> = {}): TurnRequest => baseRequest([user("Weather in Paris?")], overrides);

const anthropicToolReply = {
	stop_reason: "tool_use",
	usage: { input_tokens: 30, output_tokens: 12 },
	content: [
		{ type: "thinking", thinking: "", signature: "sig-1" },
		{ type: "text", text: "Checking." },
		{ type: "tool_use", id: "toolu_1", name: "get_weather", input: { location: "Paris" } }
	]
};
const anthropicFinalReply = { stop_reason: "end_turn", usage: { input_tokens: 50, output_tokens: 8 }, content: [{ type: "text", text: "It is 15C in Paris." }] };

describe("sendToolTurn", () => {
	test("OpenAI: posts to /responses with the key, no cap, and a limit that follows the effort", async () => {
		const { runtime, sent } = toolRuntime({
			baseUrl: "https://api.openai.com/v1",
			buffered: [ok({ status: "completed", output: [{ type: "function_call", call_id: "call_1", name: "get_weather", arguments: "{\"location\":\"Paris\"}", status: "completed" }] })]
		});
		const turn = await sendToolTurn({ runtime, providerRef: refFor("openai", "gpt-5.5") }, turnRequest({ model: "gpt-5.5", reasoningEffort: "high" }));
		expect(sent[0].url).toBe("https://api.openai.com/v1/responses");
		expect(sent[0].headers).toEqual({ Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" });
		expect(sent[0].body).toMatchObject({ model: "gpt-5.5", store: false, include: ["reasoning.encrypted_content"], reasoning: { effort: "high" }, tool_choice: "auto" });
		expect(sent[0].body.max_output_tokens).toBeUndefined();
		expect(sent[0].timeoutMs).toBe(600000);
		expect(sent[0].timeoutMessage).toBe("OpenAI generation timed out after 10 minutes.");
		expect(turn.stop).toBe("tool_calls");
		expect(turn.toolCalls[0]).toMatchObject({ id: "call_1", input: { location: "Paris" } });
	});

	test("OpenAI: streams a tool call, passes text deltas on and assembles the turn", async () => {
		const { runtime, sent } = toolRuntime({
			baseUrl: "https://api.openai.com/v1",
			streams: [{
				chunks: [
					frame({ type: "response.output_text.delta", output_index: 0, delta: "Checking." }),
					frame({ type: "response.output_item.done", output_index: 0, item: { type: "message", phase: "commentary", content: [{ type: "output_text", text: "Checking." }] } }),
					frame({ type: "response.output_item.done", output_index: 1, item: { type: "function_call", call_id: "call_1", name: "get_weather", arguments: "{\"location\":\"Paris\"}", status: "completed" } }),
					frame({ type: "response.completed", response: { status: "completed", output: [], usage: { input_tokens: 9, output_tokens: 4, total_tokens: 13 } } })
				]
			}]
		});
		const deltas: string[] = [];
		const turn = await sendToolTurn({ runtime, providerRef: refFor("openai", "gpt-5.5"), onDelta: (delta) => deltas.push(delta) }, turnRequest({ model: "gpt-5.5" }));
		expect(sent).toHaveLength(1);
		expect(sent[0].kind).toBe("stream");
		expect(sent[0].body.stream).toBe(true);
		expect(deltas).toEqual(["Checking."]);
		expect(turn.stop).toBe("tool_calls");
		expect(turn.narration).toBe("Checking.");
		expect(turn.text).toBe("");
		expect(turn.usage?.total_tokens).toBe(13);
	});

	test("Azure OpenAI: Responses at the resource's /openai/v1 with an api-key header", async () => {
		const base = "https://res.openai.azure.com/openai/v1";
		const { runtime, sent } = toolRuntime({ baseUrl: base, buffered: [ok({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "Hi" }] }] })] });
		const turn = await sendToolTurn({ runtime, providerRef: refFor("azure-openai", "my-deployment") }, turnRequest({ model: "my-deployment" }));
		expect(sent[0].url).toBe(`${base}/responses`);
		expect(sent[0].headers).toEqual({ "Content-Type": "application/json", "api-key": KEY });
		expect(sent[0].body.model).toBe("my-deployment");
		expect(sent[0].body.include).toBeUndefined();
		expect(turn.text).toBe("Hi");
	});

	test("Azure AI Foundry: chat completions with the API version and no parallel_tool_calls", async () => {
		const { runtime, sent } = toolRuntime({ baseUrl: "https://res.services.ai.azure.com", buffered: [ok({ choices: [{ message: { content: "Hi" }, finish_reason: "stop" }] })] });
		await sendToolTurn({ runtime, providerRef: refFor("azure-ai", "mistral-large") }, turnRequest({ model: "mistral-large" }));
		expect(sent[0].url).toBe("https://res.services.ai.azure.com/models/chat/completions?api-version=2024-05-01-preview");
		expect(sent[0].headers["api-key"]).toBe(KEY);
		expect(sent[0].body.tool_choice).toBe("auto");
		expect(sent[0].body.parallel_tool_calls).toBeUndefined();
	});

	test("a local server gets no Authorization header without a key, and no tool_choice either way", async () => {
		const reply = ok({ choices: [{ message: { content: "Hi" }, finish_reason: "stop" }] });
		const keyless = toolRuntime({ baseUrl: "http://localhost:11434/v1", apiKey: "", buffered: [reply] });
		await sendToolTurn({ runtime: keyless.runtime, providerRef: refFor("openai-compatible", "llama3.1") }, turnRequest({ model: "llama3.1" }));
		expect(keyless.sent[0].url).toBe("http://localhost:11434/v1/chat/completions");
		expect(keyless.sent[0].headers.Authorization).toBeUndefined();
		expect(keyless.sent[0].body.tool_choice).toBeUndefined();
		expect(keyless.sent[0].body.parallel_tool_calls).toBeUndefined();
		const keyed = toolRuntime({ baseUrl: "http://localhost:11434/v1", buffered: [reply] });
		await sendToolTurn({ runtime: keyed.runtime, providerRef: refFor("openai-compatible", "llama3.1") }, turnRequest());
		expect(keyed.sent[0].headers.Authorization).toBe(`Bearer ${KEY}`);
	});

	test("OpenRouter: streams a chat tool call with usage requested", async () => {
		const { runtime, sent } = toolRuntime({
			baseUrl: "https://openrouter.ai/api/v1",
			streams: [{
				chunks: [
					frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_a", function: { name: "get_weather", arguments: "{\"location\":\"Paris\"}" } }] } }] }),
					frame({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
					frame({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } }),
					frame("[DONE]")
				]
			}]
		});
		const turn = await sendToolTurn({ runtime, providerRef: refFor("openrouter", "openai/gpt-5"), onDelta: () => undefined }, turnRequest({ model: "openai/gpt-5" }));
		expect(sent[0].url).toBe("https://openrouter.ai/api/v1/chat/completions");
		expect(sent[0].body.stream_options).toEqual({ include_usage: true });
		expect(turn.toolCalls[0]).toMatchObject({ id: "call_a", name: "get_weather" });
		expect(turn.usage?.total_tokens).toBe(8);
	});

	test("Anthropic: the buffered request needs no browser header, the streamed one sends it", async () => {
		const buffered = toolRuntime({ baseUrl: "https://api.anthropic.com/v1", buffered: [ok(anthropicToolReply)] });
		const turn = await sendToolTurn({ runtime: buffered.runtime, providerRef: refFor("anthropic", "claude-sonnet-5-5") }, turnRequest({ model: "claude-sonnet-5-5" }));
		expect(buffered.sent[0].url).toBe("https://api.anthropic.com/v1/messages");
		expect(buffered.sent[0].headers).toEqual({ "x-api-key": KEY, "anthropic-version": "2023-06-01", "Content-Type": "application/json" });
		expect(buffered.sent[0].timeoutMs).toBe(600000);
		expect(buffered.sent[0].body.max_tokens).toBe(32000);
		expect(turn.stop).toBe("tool_calls");

		const events = [
			frame({ type: "message_start", message: { usage: { input_tokens: 4, output_tokens: 1 } } }),
			frame({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
			frame({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } }),
			frame({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } }),
			frame({ type: "message_stop" })
		];
		const streamed = toolRuntime({ baseUrl: "https://api.anthropic.com/v1", streams: [{ chunks: events }] });
		const deltas: string[] = [];
		const answer = await sendToolTurn({ runtime: streamed.runtime, providerRef: refFor("anthropic", "claude-sonnet-5-5"), onDelta: (delta) => deltas.push(delta) }, turnRequest());
		expect(streamed.sent[0].headers["anthropic-dangerous-direct-browser-access"]).toBe("true");
		expect(deltas).toEqual(["Hello"]);
		expect(answer).toMatchObject({ stop: "end", text: "Hello", usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 } });
	});

	test("Gemini: header auth, the generate and stream endpoints, and the key never in the URL", async () => {
		const reply = ok({ candidates: [{ content: { parts: [{ text: "Hi" }] }, finishReason: "STOP" }] });
		const buffered = toolRuntime({ baseUrl: "https://generativelanguage.googleapis.com/v1beta", buffered: [reply] });
		await sendToolTurn({ runtime: buffered.runtime, providerRef: refFor("google-gemini", "gemini-2.5-pro") }, turnRequest());
		expect(buffered.sent[0].url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent");
		expect(buffered.sent[0].headers["x-goog-api-key"]).toBe(KEY);

		const streamed = toolRuntime({
			baseUrl: "https://generativelanguage.googleapis.com/v1beta",
			streams: [{ chunks: [frame({ candidates: [{ content: { parts: [{ text: "Hi" }] }, finishReason: "STOP" }] })] }]
		});
		const turn = await sendToolTurn({ runtime: streamed.runtime, providerRef: refFor("google-gemini", "gemini-2.5-pro"), onDelta: () => undefined }, turnRequest());
		expect(streamed.sent[0].url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse");
		expect(streamed.sent[0].url).not.toContain(KEY);
		expect(turn.text).toBe("Hi");
	});

	test("Gemini: a 400 about parametersJsonSchema is retried once with the OpenAPI subset and remembered", async () => {
		const rejection = failure(400, { error: { message: "Invalid JSON payload received. Unknown name \"parametersJsonSchema\" at 'tools[0].function_declarations[0]': Cannot find field." } });
		const reply = ok({ candidates: [{ content: { parts: [{ text: "Hi" }] }, finishReason: "STOP" }] });
		const { runtime, sent } = toolRuntime({ baseUrl: "https://generativelanguage.googleapis.com/v1beta", buffered: [rejection, reply, reply] });
		const memory = createToolTurnMemory();
		const context = { runtime, providerRef: refFor("google-gemini", "gemini-2.5-pro"), memory };
		const declaration = (index: number): Record<string, unknown> => (sent[index].body.tools as { functionDeclarations: Record<string, unknown>[] }[])[0].functionDeclarations[0];

		const first = await sendToolTurn(context, turnRequest());
		expect(first.text).toBe("Hi");
		expect(sent).toHaveLength(2);
		expect(declaration(0).parametersJsonSchema).toBeDefined();
		expect(declaration(1).parameters).toBeDefined();
		expect(declaration(1).parametersJsonSchema).toBeUndefined();
		expect(memory.geminiSchemaDialect).toBe("openapi");

		await sendToolTurn(context, turnRequest());
		expect(sent).toHaveLength(3);
		expect(declaration(2).parameters).toBeDefined();
	});

	test("Gemini: any other 400, or a rejection after the retry, is not retried again", async () => {
		const other = toolRuntime({ baseUrl: "https://g.test/v1beta", buffered: [failure(400, { error: { message: "API key not valid" } })] });
		await expect(sendToolTurn({ runtime: other.runtime, providerRef: refFor("google-gemini") }, turnRequest())).rejects.toThrow("API key not valid");
		expect(other.sent).toHaveLength(1);

		const rejection = failure(400, { error: { message: "Unknown name \"parameters\"" } });
		const twice = toolRuntime({ baseUrl: "https://g.test/v1beta", buffered: [failure(400, { error: { message: "Unknown name \"parametersJsonSchema\"" } }), rejection] });
		await expect(sendToolTurn({ runtime: twice.runtime, providerRef: refFor("google-gemini") }, turnRequest())).rejects.toThrow("Unknown name");
		expect(twice.sent).toHaveLength(2);

		const noTools = toolRuntime({ baseUrl: "https://g.test/v1beta", buffered: [failure(400, { error: { message: "Unknown name \"parametersJsonSchema\"" } })] });
		await expect(sendToolTurn({ runtime: noTools.runtime, providerRef: refFor("google-gemini") }, turnRequest({ tools: [] }))).rejects.toThrow("Unknown name");
		expect(noTools.sent).toHaveLength(1);
	});

	test("a model that cannot use tools raises ToolsUnsupportedError so the host can offer to continue without them", async () => {
		const { runtime } = toolRuntime({ baseUrl: "http://localhost:11434/v1", buffered: [failure(400, { error: { message: "registry.ollama.ai/library/llama2:latest does not support tools" } })] });
		const error = await sendToolTurn({ runtime, providerRef: refFor("openai-compatible", "llama2") }, turnRequest()).catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(ToolsUnsupportedError);
		expect((error as Error).message).toContain("llama2");
		expect((error as Error).message).toContain("does not support tools");

		const withoutTools = toolRuntime({ baseUrl: "http://localhost:11434/v1", buffered: [failure(400, { error: { message: "model does not support tools" } })] });
		const plain = await sendToolTurn({ runtime: withoutTools.runtime, providerRef: refFor("openai-compatible", "llama2") }, turnRequest({ tools: [] })).catch((caught: unknown) => caught);
		expect(plain).not.toBeInstanceOf(ToolsUnsupportedError);
	});

	test.each([
		["openai-compatible", "llama2:latest does not support tools"],
		["openai-compatible", "this model doesn't support tool use"],
		["openrouter", "No endpoints found that support tool use. To learn more about provider routing, visit the docs."],
		["google-gemini", "Function calling is not enabled for models/gemma-3-27b-it"],
		["azure-ai", "Tool calling is not supported by this model"]
	] as const)("%s: %s is recognised as a model without tools", async (providerId, message) => {
		const { runtime } = toolRuntime({ baseUrl: "https://x.test/v1", buffered: [failure(providerId === "openrouter" ? 404 : 400, { error: { message } })] });
		const error = await sendToolTurn({ runtime, providerRef: refFor(providerId, "m") }, turnRequest()).catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(ToolsUnsupportedError);
	});

	test("an unrelated 400 is not mistaken for a model without tools", async () => {
		const { runtime } = toolRuntime({ baseUrl: "https://x.test/v1", buffered: [failure(400, { error: { message: "Invalid value for 'tools[0].function.name'" } })] });
		const error = await sendToolTurn({ runtime, providerRef: refFor("openrouter", "m") }, turnRequest()).catch((caught: unknown) => caught);
		expect(error).not.toBeInstanceOf(ToolsUnsupportedError);
	});

	test.each(["get.weather", "has space", "9lives", "", "x".repeat(65), "dash-name"])("a tool named %p is refused before anything is sent", async (name) => {
		const { runtime, sent } = toolRuntime({ baseUrl: "https://api.anthropic.com/v1", buffered: [ok(anthropicFinalReply)] });
		const request = turnRequest({ tools: [{ ...weather, name }] });
		await expect(sendToolTurn({ runtime, providerRef: refFor("anthropic") }, request)).rejects.toThrow(/buildToolNameMap/);
		expect(sent).toHaveLength(0);
	});

	test("two tools with the same name are refused before anything is sent", async () => {
		const { runtime, sent } = toolRuntime({ baseUrl: "https://api.anthropic.com/v1", buffered: [ok(anthropicFinalReply)] });
		const request = turnRequest({ tools: [weather, { ...weather, description: "Again" }] });
		await expect(sendToolTurn({ runtime, providerRef: refFor("anthropic") }, request)).rejects.toThrow(/twice/);
		expect(sent).toHaveLength(0);
	});

	test("HTTP errors read like the text path's and never carry the key", async () => {
		const { runtime } = toolRuntime({ baseUrl: "https://api.anthropic.com/v1", buffered: [failure(401, { error: { message: `Invalid key ${KEY}` } })] });
		const error = await sendToolTurn({ runtime, providerRef: refFor("anthropic", "claude-sonnet-5-5") }, turnRequest()).catch((caught: unknown) => caught);
		expect((error as Error).message).toContain("Anthropic authentication failed");
		expect((error as Error).message).not.toContain(KEY);
	});

	test("an error hidden in a 200 body, or a failed response, is raised with the provider's name and no key", async () => {
		const hidden = toolRuntime({ baseUrl: "https://openrouter.ai/api/v1", buffered: [ok({ error: { message: `Bad key ${KEY}` } })] });
		const chatError = await sendToolTurn({ runtime: hidden.runtime, providerRef: refFor("openrouter") }, turnRequest()).catch((caught: unknown) => caught);
		expect((chatError as Error).message).toContain("openrouter reported an error in its response");
		expect((chatError as Error).message).not.toContain(KEY);

		const failed = toolRuntime({ baseUrl: "https://api.openai.com/v1", buffered: [ok({ status: "failed", error: { message: "server_error" } })] });
		const responsesError = await sendToolTurn({ runtime: failed.runtime, providerRef: refFor("openai", "gpt-5.5") }, turnRequest()).catch((caught: unknown) => caught);
		expect((responsesError as Error).message).toBe("OpenAI could not complete the response. Provider message: server_error");
	});

	test("a missing key or deployment is reported before anything is sent", async () => {
		const noKey = toolRuntime({ baseUrl: "https://api.anthropic.com/v1", apiKey: "" });
		await expect(sendToolTurn({ runtime: noKey.runtime, providerRef: refFor("anthropic") }, turnRequest())).rejects.toThrow("Add an Anthropic API key");
		const noDeployment = toolRuntime({ baseUrl: "https://res.openai.azure.com/openai/v1" });
		await expect(sendToolTurn({ runtime: noDeployment.runtime, providerRef: refFor("azure-openai", " ") }, turnRequest())).rejects.toThrow("deployment name");
		expect(noKey.sent).toHaveLength(0);
		expect(noDeployment.sent).toHaveLength(0);
	});

	test("a stream that breaks mid-turn is an error, never a half turn that could run a cut-off call", async () => {
		const { runtime } = toolRuntime({
			baseUrl: "https://openrouter.ai/api/v1",
			streams: [{ chunks: [frame({ choices: [{ delta: { content: "Let me check" } }] })] }]
		});
		await expect(sendToolTurn({ runtime, providerRef: refFor("openrouter"), onDelta: () => undefined }, turnRequest())).rejects.toThrow("closed the connection before the reply finished");
	});

	test("a network failure before any response falls back to one buffered request", async () => {
		const { runtime, sent } = toolRuntime({
			baseUrl: "https://api.anthropic.com/v1",
			streams: ["network-error"],
			buffered: [ok(anthropicFinalReply)]
		});
		const turn = await sendToolTurn({ runtime, providerRef: refFor("anthropic"), onDelta: () => undefined }, turnRequest());
		expect(sent.map((request) => request.kind)).toEqual(["stream", "buffered"]);
		expect(turn.text).toBe("It is 15C in Paris.");
	});

	test("with no delta consumer the turn is buffered even when the runtime can stream", async () => {
		const { runtime, sent } = toolRuntime({ baseUrl: "https://api.anthropic.com/v1", streams: [], buffered: [ok(anthropicFinalReply)] });
		await sendToolTurn({ runtime, providerRef: refFor("anthropic") }, turnRequest());
		expect(sent.map((request) => request.kind)).toEqual(["buffered"]);
	});

	test("a stop signal reaches both the streamed and the buffered request", async () => {
		const controller = new AbortController();
		const streamed = toolRuntime({ baseUrl: "https://api.anthropic.com/v1", streams: ["network-error"], buffered: [ok(anthropicFinalReply)] });
		await sendToolTurn({ runtime: streamed.runtime, providerRef: refFor("anthropic"), onDelta: () => undefined, abortSignal: controller.signal }, turnRequest());
		expect(streamed.sent[1].signal).toBe(controller.signal);
		const direct = toolRuntime({ baseUrl: "https://api.anthropic.com/v1", buffered: [ok(anthropicFinalReply)] });
		await sendToolTurn({ runtime: direct.runtime, providerRef: refFor("anthropic"), abortSignal: controller.signal }, turnRequest());
		expect(direct.sent[0].signal).toBe(controller.signal);
	});

	test("the run's stop signal is handed to the streaming transport, so a stop cancels the HTTP request itself", async () => {
		const controller = new AbortController();
		const reply = frame({ choices: [{ delta: { content: "Hi" }, finish_reason: "stop" }] });
		const base = toolRuntime({ baseUrl: "https://openrouter.ai/api/v1", streams: [{ chunks: [reply] }] });
		const handed: Array<AbortSignal | undefined> = [];
		const streamSse = base.runtime.streamSse;
		const runtime: ProviderRuntime = {
			...base.runtime,
			streamSse: (url, options, onEvent) => {
				handed.push(options.abortSignal);
				return (streamSse as NonNullable<typeof streamSse>)(url, options, onEvent);
			}
		};
		const send = createToolTurnSender(
			{ runtime, providerRef: refFor("openrouter"), onDelta: () => undefined },
			{ model: "m", instructions: "i", tools: [weather], parallelToolCalls: true, maxOutputTokens: 0, reasoningEffort: null }
		);
		await send([user("x")], "auto", controller.signal);
		expect(handed).toEqual([controller.signal]);
	});

	test("a stream that closes without sending anything is reported as no reply", async () => {
		const empty = toolRuntime({ baseUrl: "https://openrouter.ai/api/v1", streams: ["close-empty"] });
		const error = await sendToolTurn({ runtime: empty.runtime, providerRef: refFor("openrouter"), onDelta: () => undefined }, turnRequest()).catch((caught: unknown) => caught);
		expect((error as Error).message).toContain("without sending a reply");
	});

	test("every turn's endpoint can be recorded: Azure OpenAI tool turns are Responses calls, unlike its text path", () => {
		expect(getToolTurnEndpoint("azure-openai")).toBe("responses");
	});
});

describe("a tool run end to end", () => {
	const server = { serverId: "weather", toolName: "get.weather" };
	const nameMap = buildToolNameMap([server]);
	const wireName = findWireName(nameMap, server) ?? "";
	const spec: ToolSpec = { ...weather, name: wireName };

	function loopDeps(runtime: ProviderRuntime, providerId: TextProviderId, model: string, overrides: Partial<ToolLoopDeps> = {}, request: Partial<TurnRequest> = {}): { deps: ToolLoopDeps; executed: string[] } {
		const executed: string[] = [];
		const deps: ToolLoopDeps = {
			sendTurn: createToolTurnSender(
				{ runtime, providerRef: refFor(providerId, model) },
				{ model, instructions: "Be brief.", tools: [spec], parallelToolCalls: true, maxOutputTokens: getToolTurnMaxOutputTokens(providerId, model), reasoningEffort: null, ...request }
			),
			tools: {
				has: (name) => nameMap.has(name),
				needsApproval: () => false,
				run: async (call) => {
					// The host maps the wire name back to the tool before it runs anything.
					executed.push(`${nameMap.get(call.name)?.toolName}:${JSON.stringify(call.input)}`);
					return { text: "15C and clear", isError: false };
				}
			},
			approve: async () => true,
			onProgress: () => undefined,
			signal: new AbortController().signal,
			...overrides
		};
		return { deps, executed };
	}

	test("Anthropic: the thinking block, tool call and result are replayed in order, and the tool list never changes", async () => {
		const reply = { ...anthropicToolReply, content: [anthropicToolReply.content[0], anthropicToolReply.content[1], { type: "tool_use", id: "toolu_1", name: wireName, input: { location: "Paris" } }] };
		const { runtime, sent } = toolRuntime({ baseUrl: "https://api.anthropic.com/v1", buffered: [ok(reply), ok(anthropicFinalReply)] });
		const { deps, executed } = loopDeps(runtime, "anthropic", "claude-sonnet-5-5");
		const outcome = await runToolLoop(deps, [user("Weather in Paris?")]);

		expect(outcome).toMatchObject({ end: "answered", answer: "It is 15C in Paris.", toolCallsRun: 1, turns: 2 });
		expect(outcome.usage).toEqual({ input_tokens: 80, output_tokens: 20, total_tokens: 100 });
		expect(executed).toEqual(["get.weather:{\"location\":\"Paris\"}"]);
		expect(sent).toHaveLength(2);

		const messages = sent[1].body.messages as { role: string; content: Record<string, unknown>[] }[];
		expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
		expect(messages[1].content.map((block) => block.type)).toEqual(["thinking", "text", "tool_use"]);
		expect(messages[1].content[0]).toMatchObject({ signature: "sig-1" });
		expect(messages[2].content).toEqual([{ type: "tool_result", tool_use_id: "toolu_1", content: "15C and clear" }]);
		expect(sent[1].body.tools).toEqual(sent[0].body.tools);
		expect(sent[1].body.system).toBe(sent[0].body.system);
		expect(sent[1].body.thinking).toBeUndefined();
	});

	test("OpenAI Responses over a stream: the function_call and its output are replayed, and the answer streams", async () => {
		const turnOne = [
			frame({ type: "response.output_item.done", output_index: 0, item: { type: "reasoning", id: "rs_1", encrypted_content: "enc" } }),
			frame({ type: "response.output_item.done", output_index: 1, item: { type: "function_call", id: "fc_1", call_id: "call_1", name: wireName, arguments: "{\"location\":\"Paris\"}", status: "completed" } }),
			frame({ type: "response.completed", response: { status: "completed", output: [], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } })
		];
		const turnTwo = [
			frame({ type: "response.output_text.delta", output_index: 0, delta: "It is " }),
			frame({ type: "response.output_text.delta", output_index: 0, delta: "15C." }),
			frame({ type: "response.output_item.done", output_index: 0, item: { type: "message", phase: "final_answer", content: [{ type: "output_text", text: "It is 15C." }] } }),
			frame({ type: "response.completed", response: { status: "completed", output: [], usage: { input_tokens: 20, output_tokens: 6, total_tokens: 26 } } })
		];
		const { runtime, sent } = toolRuntime({ baseUrl: "https://api.openai.com/v1", streams: [{ chunks: turnOne }, { chunks: turnTwo }] });
		const deltas: string[] = [];
		const { deps } = loopDeps(runtime, "openai", "gpt-5.5", {}, { reasoningEffort: "medium" });
		const withDeltas: ToolLoopDeps = {
			...deps,
			sendTurn: createToolTurnSender(
				{ runtime, providerRef: refFor("openai", "gpt-5.5"), onDelta: (delta) => deltas.push(delta) },
				{ model: "gpt-5.5", instructions: "Be brief.", tools: [spec], parallelToolCalls: true, maxOutputTokens: 0, reasoningEffort: "medium" }
			)
		};
		const outcome = await runToolLoop(withDeltas, [user("Weather in Paris?")]);

		expect(outcome).toMatchObject({ end: "answered", answer: "It is 15C.", toolCallsRun: 1 });
		expect(deltas.join("")).toBe("It is 15C.");
		const input = sent[1].body.input as Record<string, unknown>[];
		expect(input.map((item) => item.type ?? "user")).toEqual(["user", "reasoning", "function_call", "function_call_output"]);
		expect(input[3]).toEqual({ type: "function_call_output", call_id: "call_1", output: "15C and clear" });
		expect(sent[1].body.store).toBe(false);
	});

	test("the last allowed turn is sent with the same tools and tool_choice none", async () => {
		const reply = { ...anthropicToolReply, content: [{ type: "tool_use", id: "toolu_1", name: wireName, input: {} }] };
		const { runtime, sent } = toolRuntime({ baseUrl: "https://api.anthropic.com/v1", buffered: [ok(reply), ok(anthropicFinalReply)] });
		const { deps } = loopDeps(runtime, "anthropic", "claude-sonnet-5-5");
		const outcome = await runToolLoop(deps, [user("go")], { maxTurns: 2, maxToolCalls: 12, maxResultChars: 12000 });
		expect(outcome.end).toBe("answered");
		expect(sent[0].body.tool_choice).toEqual({ type: "auto", disable_parallel_tool_use: false });
		expect(sent[1].body.tool_choice).toEqual({ type: "none" });
		expect(sent[1].body.tools).toEqual(sent[0].body.tools);
	});

	test("a model-made-up tool name is answered as unknown and nothing runs", async () => {
		const reply = { ...anthropicToolReply, content: [{ type: "tool_use", id: "toolu_1", name: "delete_everything", input: {} }] };
		const { runtime, sent } = toolRuntime({ baseUrl: "https://api.anthropic.com/v1", buffered: [ok(reply), ok(anthropicFinalReply)] });
		const { deps, executed } = loopDeps(runtime, "anthropic", "claude-sonnet-5-5");
		await runToolLoop(deps, [user("go")]);
		expect(executed).toEqual([]);
		const results = (sent[1].body.messages as { content: Record<string, unknown>[] }[]).at(-1)?.content;
		expect(results?.[0]).toMatchObject({ type: "tool_result", is_error: true });
		expect(String(results?.[0].content)).toContain('Unknown tool "delete_everything"');
	});

	test("Gemini: parallel calls are answered in one user content with their thought signature kept on the call", async () => {
		const modelParts = [
			{ functionCall: { name: wireName, args: { location: "Paris" } }, thoughtSignature: "SigA" },
			{ functionCall: { name: wireName, args: { location: "London" } } }
		];
		const first = ok({ candidates: [{ content: { role: "model", parts: modelParts }, finishReason: "STOP" }] });
		const second = ok({ candidates: [{ content: { role: "model", parts: [{ text: "Both are mild." }] }, finishReason: "STOP" }] });
		const { runtime, sent } = toolRuntime({ baseUrl: "https://g.test/v1beta", buffered: [first, second] });
		const { deps, executed } = loopDeps(runtime, "google-gemini", "gemini-2.5-pro");
		const outcome = await runToolLoop(deps, [user("Paris and London?")]);
		expect(outcome).toMatchObject({ end: "answered", answer: "Both are mild.", toolCallsRun: 2 });
		expect(executed).toEqual(["get.weather:{\"location\":\"Paris\"}", "get.weather:{\"location\":\"London\"}"]);
		const contents = sent[1].body.contents as { role: string; parts: Record<string, unknown>[] }[];
		expect(contents.map((content) => content.role)).toEqual(["user", "model", "user"]);
		expect(contents[1].parts).toEqual(modelParts);
		expect(contents[2].parts).toHaveLength(2);
	});
});
