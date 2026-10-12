import { describe, expect, test } from "bun:test";
import { ANTHROPIC_DEFAULT_MAX_TOKENS, completeAnthropicText, fetchAnthropicModels } from "../src/providers/anthropic";
import { completeAzureAIText, getAzureAIBaseUrl, testAzureAIConnection } from "../src/providers/azure-ai";
import { completeAzureOpenAIText, fetchAzureOpenAIModels, testAzureOpenAIConnection } from "../src/providers/azure-open-ai";
import {
	buildChatCompletionsResult,
	collectModelPages,
	describeProviderErrorBody,
	describeTransportError,
	extractProviderError,
	formatProviderHttpError,
	redactSecrets
} from "../src/providers/common";
import { completeGeminiText, fetchGeminiModels } from "../src/providers/google-gemini";
import { completeProviderTextRequest, fetchProviderModels, testProviderConnection, testProviderConnectionDetailed } from "../src/providers/index";
import { completeOpenRouterText } from "../src/providers/open-router";
import type { ProviderRequestOptions, ProviderRuntime } from "../src/providers/types";
import type { AskMateHttpResponse, ProviderModelRef, ProviderSettings, TextProviderId } from "../src/shared/types";

const API_KEY = "test-secret-key-0123456789";

interface RecordedCall {
	url: string;
	options: ProviderRequestOptions;
}

function json(status: number, body: unknown): AskMateHttpResponse<unknown> {
	return { status, ok: status >= 200 && status < 300, body, text: JSON.stringify(body) };
}

function raw(status: number, text: string): AskMateHttpResponse<unknown> {
	return { status, ok: status >= 200 && status < 300, body: null, text };
}

function fakeRuntime(
	responses: Array<AskMateHttpResponse<unknown>>,
	baseUrl = "https://example.test/v1"
): { runtime: ProviderRuntime; calls: RecordedCall[] } {
	const calls: RecordedCall[] = [];
	const queue = [...responses];
	const runtime: ProviderRuntime = {
		getProviderSettings: (_providerId: TextProviderId): ProviderSettings => ({
			apiKeySecretName: "",
			model: "test-model",
			modelOptions: [],
			baseUrl
		}),
		getProviderApiKey: async () => API_KEY,
		requestJson: async <T>(url: string, options?: ProviderRequestOptions): Promise<AskMateHttpResponse<T>> => {
			calls.push({ url, options: options ?? {} });
			const next = queue.shift();
			if (!next) {
				throw new Error(`Unexpected request to ${url}`);
			}
			// The fake serves canned JSON; the generic only describes the caller's expected shape.
			return next as AskMateHttpResponse<T>;
		}
	};
	return { runtime, calls };
}

function ref(providerId: TextProviderId, providerName: string, model = "test-model"): ProviderModelRef {
	return { providerId, providerName, model, capability: "text" };
}

function parsedBody(call: RecordedCall | undefined): Record<string, unknown> {
	return JSON.parse(call?.options.body ?? "{}") as Record<string, unknown>;
}

describe("Anthropic adapter", () => {
	test("sends the Messages request shape with key headers and a long timeout", async () => {
		const { runtime, calls } = fakeRuntime([
			json(200, {
				content: [{ type: "text", text: "Hello" }, { type: "text", text: "world" }],
				stop_reason: "end_turn",
				usage: { input_tokens: 10, output_tokens: 5 }
			})
		]);
		const result = await completeAnthropicText(runtime, ref("anthropic", "Anthropic"), "sys", "question");

		expect(calls[0]?.url).toBe("https://example.test/v1/messages");
		expect(calls[0]?.options.method).toBe("POST");
		expect(calls[0]?.options.headers?.["x-api-key"]).toBe(API_KEY);
		expect(calls[0]?.options.headers?.["anthropic-version"]).toBe("2023-06-01");
		// A buffered reply returns only when generation ends, and the output cap is high, so it gets ten minutes.
		expect(calls[0]?.options.timeoutMs).toBe(600000);
		expect(calls[0]?.options.timeoutMessage).toBe("Anthropic generation timed out after 10 minutes.");
		expect(parsedBody(calls[0])).toEqual({
			model: "test-model",
			system: "sys",
			max_tokens: ANTHROPIC_DEFAULT_MAX_TOKENS,
			messages: [{ role: "user", content: "question" }]
		});
		expect(result.text).toBe("Hello\nworld");
		expect(result.incompleteReason).toBeNull();
		expect(result.usage).toEqual({ input_tokens: 10, output_tokens: 5, total_tokens: 15 });
	});

	test("flags max_tokens as incomplete but keeps the partial text", async () => {
		const { runtime } = fakeRuntime([
			json(200, { content: [{ type: "text", text: "Partial" }], stop_reason: "max_tokens" })
		]);
		const result = await completeAnthropicText(runtime, ref("anthropic", "Anthropic"), "sys", "q");
		expect(result.text).toBe("Partial");
		expect(result.incompleteReason).toBe("max_tokens");
	});

	test("a refusal with no text raises an error naming the reason", async () => {
		const { runtime } = fakeRuntime([json(200, { content: [], stop_reason: "refusal" })]);
		await expect(completeAnthropicText(runtime, ref("anthropic", "Anthropic"), "sys", "q")).rejects.toThrow(/refusal/);
	});

	test("max_tokens follows the model: modern models get the high default, older ones their own limit", async () => {
		const modern = fakeRuntime([json(200, { content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" })]);
		await completeAnthropicText(modern.runtime, ref("anthropic", "Anthropic", "claude-sonnet-5-5"), "sys", "q");
		expect(parsedBody(modern.calls[0]).max_tokens).toBe(ANTHROPIC_DEFAULT_MAX_TOKENS);
		const legacy = fakeRuntime([json(200, { content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" })]);
		await completeAnthropicText(legacy.runtime, ref("anthropic", "Anthropic", "claude-3-5-haiku-20241022"), "sys", "q");
		expect(parsedBody(legacy.calls[0]).max_tokens).toBe(8192);
	});

	test("tool_use is a normal end of a turn, not an incomplete reply", async () => {
		const { runtime } = fakeRuntime([json(200, { content: [{ type: "text", text: "Checking." }], stop_reason: "tool_use" })]);
		const result = await completeAnthropicText(runtime, ref("anthropic", "Anthropic"), "sys", "q");
		expect(result.incompleteReason).toBeNull();
	});

	test("a reply that hit the output limit with no text tells the user to raise the limit or split the note", async () => {
		const { runtime } = fakeRuntime([json(200, { content: [], stop_reason: "max_tokens" })]);
		await expect(completeAnthropicText(runtime, ref("anthropic", "Anthropic"), "sys", "q")).rejects.toThrow(/split the note/);
	});

	test("a JSON error uses the provider message", async () => {
		const { runtime } = fakeRuntime([
			json(400, { type: "error", error: { type: "invalid_request_error", message: "max_tokens too large" } })
		]);
		await expect(completeAnthropicText(runtime, ref("anthropic", "Anthropic"), "sys", "q")).rejects.toThrow(
			"Anthropic request failed with HTTP 400. Provider message: max_tokens too large"
		);
	});

	test("a non-JSON error keeps a short plain-text excerpt without the key", async () => {
		const { runtime } = fakeRuntime([
			raw(502, `<html><head><style>body{}</style></head><body><h1>Bad gateway</h1><p>key ${API_KEY}</p></body></html>`)
		]);
		const error = await completeAnthropicText(runtime, ref("anthropic", "Anthropic"), "sys", "q").catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(Error);
		const message = error instanceof Error ? error.message : "";
		expect(message).toContain("Bad gateway");
		expect(message).not.toContain(API_KEY);
		expect(message).not.toContain("<h1>");
		expect(message).not.toContain("body{}");
	});

	test("model refresh follows has_more and after_id", async () => {
		const { runtime, calls } = fakeRuntime([
			json(200, { data: [{ id: "claude-b" }], has_more: true, last_id: "claude-b" }),
			json(200, { data: [{ id: "claude-a" }], has_more: false, last_id: "claude-a" })
		]);
		const models = await fetchAnthropicModels(runtime);
		expect(models).toEqual(["claude-a", "claude-b"]);
		expect(calls[0]?.url).toBe("https://example.test/v1/models?limit=1000");
		expect(calls[1]?.url).toBe("https://example.test/v1/models?limit=1000&after_id=claude-b");
	});
});

describe("Google Gemini adapter", () => {
	test("sends generateContent with header auth and never puts the key in the URL", async () => {
		const { runtime, calls } = fakeRuntime(
			[
				json(200, {
					candidates: [{ content: { parts: [{ text: "Answer" }] }, finishReason: "STOP" }],
					usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3, thoughtsTokenCount: 20, totalTokenCount: 30 }
				})
			],
			"https://generativelanguage.googleapis.com/v1beta"
		);
		const result = await completeGeminiText(runtime, ref("google-gemini", "Google Gemini", "gemini-2.5-pro"), "sys", "q");

		expect(calls[0]?.url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent");
		expect(calls[0]?.url).not.toContain(API_KEY);
		expect(calls[0]?.options.headers?.["x-goog-api-key"]).toBe(API_KEY);
		// No maxOutputTokens: Gemini 2.5 counts thinking tokens against it, and the model's own limit is the right ceiling.
		expect(parsedBody(calls[0])).toEqual({
			systemInstruction: { parts: [{ text: "sys" }] },
			contents: [{ role: "user", parts: [{ text: "q" }] }]
		});
		expect(result.text).toBe("Answer");
		expect(result.incompleteReason).toBeNull();
		expect(result.usage).toEqual({
			input_tokens: 7,
			output_tokens: 23,
			total_tokens: 30,
			output_tokens_details: { reasoning_tokens: 20 }
		});
	});

	test("MAX_TOKENS is reported as incomplete", async () => {
		const { runtime } = fakeRuntime([
			json(200, { candidates: [{ content: { parts: [{ text: "Cut" }] }, finishReason: "MAX_TOKENS" }] })
		]);
		const result = await completeGeminiText(runtime, ref("google-gemini", "Google Gemini"), "sys", "q");
		expect(result.text).toBe("Cut");
		expect(result.incompleteReason).toBe("MAX_TOKENS");
	});

	test("a safety stop with no text raises an error naming the reason", async () => {
		const { runtime } = fakeRuntime([json(200, { candidates: [{ finishReason: "SAFETY" }] })]);
		await expect(completeGeminiText(runtime, ref("google-gemini", "Google Gemini"), "sys", "q")).rejects.toThrow(/SAFETY/);
	});

	test("thinking that uses the whole output budget raises the limit hint, a safety stop does not", async () => {
		const cut = fakeRuntime([json(200, { candidates: [{ finishReason: "MAX_TOKENS" }] })]);
		await expect(completeGeminiText(cut.runtime, ref("google-gemini", "Google Gemini"), "sys", "q")).rejects.toThrow(/split the note/);
		const safety = fakeRuntime([json(200, { candidates: [{ finishReason: "SAFETY" }] })]);
		const error = await completeGeminiText(safety.runtime, ref("google-gemini", "Google Gemini"), "sys", "q").catch((caught: unknown) => caught);
		expect(error instanceof Error ? error.message : "").not.toContain("split the note");
	});

	test("a blocked prompt raises an error naming the block reason", async () => {
		const { runtime } = fakeRuntime([json(200, { promptFeedback: { blockReason: "PROHIBITED_CONTENT" } })]);
		await expect(completeGeminiText(runtime, ref("google-gemini", "Google Gemini"), "sys", "q")).rejects.toThrow(
			/blocked this request \(PROHIBITED_CONTENT\)/
		);
	});

	test("model refresh follows nextPageToken and keeps generateContent models", async () => {
		const { runtime, calls } = fakeRuntime([
			json(200, {
				models: [
					{ name: "models/gemini-2.5-pro", supportedGenerationMethods: ["generateContent"] },
					{ name: "models/text-embedding-004", supportedGenerationMethods: ["embedContent"] }
				],
				nextPageToken: "page-2"
			}),
			json(200, { models: [{ name: "models/gemini-2.5-flash", supportedGenerationMethods: ["generateContent"] }] })
		]);
		const models = await fetchGeminiModels(runtime);
		expect(models).toEqual(["gemini-2.5-flash", "gemini-2.5-pro"]);
		expect(calls[0]?.url).toBe("https://example.test/v1/models?pageSize=1000");
		expect(calls[1]?.url).toBe("https://example.test/v1/models?pageSize=1000&pageToken=page-2");
		expect(calls.every((call) => !call.url.includes(API_KEY))).toBe(true);
	});
});

describe("Azure AI Foundry adapter", () => {
	function settings(baseUrl: string): ProviderSettings {
		return { apiKeySecretName: "", model: "m", modelOptions: [], baseUrl };
	}

	test("appends /models only for Foundry resource hosts without a path", () => {
		expect(getAzureAIBaseUrl(settings("https://res.services.ai.azure.com"))).toBe("https://res.services.ai.azure.com/models");
		expect(getAzureAIBaseUrl(settings("https://res.services.ai.azure.com/models/"))).toBe("https://res.services.ai.azure.com/models");
		expect(getAzureAIBaseUrl(settings("https://res.cognitiveservices.azure.com/"))).toBe("https://res.cognitiveservices.azure.com/models");
	});

	test("uses serverless and custom-path endpoints as given", () => {
		expect(getAzureAIBaseUrl(settings("https://my-llama.eastus2.models.ai.azure.com"))).toBe(
			"https://my-llama.eastus2.models.ai.azure.com"
		);
		expect(getAzureAIBaseUrl(settings("https://gateway.example.com/azure-ai/"))).toBe("https://gateway.example.com/azure-ai");
	});

	test("rejects query strings", () => {
		expect(() => getAzureAIBaseUrl(settings("https://res.services.ai.azure.com/models?x=1"))).toThrow(/query strings/);
	});

	test("sends chat completions with api-key header and reports length as incomplete", async () => {
		const { runtime, calls } = fakeRuntime(
			[
				json(200, {
					choices: [{ message: { content: "Partial" }, finish_reason: "length" }],
					usage: { prompt_tokens: 4, completion_tokens: 6, total_tokens: 10 }
				})
			],
			"https://res.services.ai.azure.com"
		);
		const result = await completeAzureAIText(runtime, ref("azure-ai", "Azure AI Foundry", "mistral-large"), "sys", "q");

		expect(calls[0]?.url).toBe("https://res.services.ai.azure.com/models/chat/completions?api-version=2024-05-01-preview");
		expect(calls[0]?.options.headers?.["api-key"]).toBe(API_KEY);
		expect(parsedBody(calls[0])).toEqual({
			model: "mistral-large",
			messages: [
				{ role: "system", content: "sys" },
				{ role: "user", content: "q" }
			]
		});
		expect(result.text).toBe("Partial");
		expect(result.incompleteReason).toBe("length");
		expect(result.usage).toEqual({ input_tokens: 4, output_tokens: 6, total_tokens: 10 });
	});

	test("a content filter stop with no text raises an error naming the reason", async () => {
		const { runtime } = fakeRuntime(
			[json(200, { choices: [{ message: { content: null }, finish_reason: "content_filter" }] })],
			"https://res.services.ai.azure.com"
		);
		await expect(completeAzureAIText(runtime, ref("azure-ai", "Azure AI Foundry"), "sys", "q")).rejects.toThrow(/content_filter/);
	});

	test("HTTP errors redact the key", async () => {
		const { runtime } = fakeRuntime(
			[json(401, { error: { message: `Invalid key ${API_KEY}` } })],
			"https://res.services.ai.azure.com"
		);
		const error = await completeAzureAIText(runtime, ref("azure-ai", "Azure AI Foundry"), "sys", "q").catch((caught: unknown) => caught);
		const message = error instanceof Error ? error.message : "";
		expect(message).toContain("authentication failed");
		expect(message).not.toContain(API_KEY);
	});
});

describe("chat completions providers", () => {
	test("a complete answer has no incomplete reason", async () => {
		const { runtime, calls } = fakeRuntime([json(200, { choices: [{ message: { content: "Done" }, finish_reason: "stop" }] })]);
		const result = await completeOpenRouterText(runtime, ref("openrouter", "OpenRouter"), "sys", "q");
		expect(calls[0]?.url).toBe("https://example.test/v1/chat/completions");
		expect(calls[0]?.options.headers?.Authorization).toBe(`Bearer ${API_KEY}`);
		expect(result.incompleteReason).toBeNull();
	});

	test("a length stop with no text tells the user to raise the limit or split the note", async () => {
		const { runtime } = fakeRuntime([json(200, { choices: [{ message: { content: "" }, finish_reason: "length" }] })]);
		await expect(completeOpenRouterText(runtime, ref("openrouter", "OpenRouter"), "sys", "q")).rejects.toThrow(/split the note/);
	});

	test("a refusal message with no content raises a clear error", async () => {
		const { runtime } = fakeRuntime([
			json(200, { choices: [{ message: { content: null, refusal: "I can't help with that." }, finish_reason: "stop" }] })
		]);
		await expect(completeOpenRouterText(runtime, ref("openrouter", "OpenRouter"), "sys", "q")).rejects.toThrow(
			"OpenRouter refused the request. Provider message: I can't help with that."
		);
	});

	test("an error hidden in a 200 choice is raised instead of returning empty text", async () => {
		const { runtime } = fakeRuntime([
			json(200, { choices: [{ finish_reason: "error", error: { code: 502, message: "upstream down" }, message: { content: "" } }] })
		]);
		await expect(completeOpenRouterText(runtime, ref("openrouter", "OpenRouter"), "sys", "q")).rejects.toThrow(/upstream down/);
	});

	test("a top-level error in a 200 body is raised", async () => {
		const { runtime } = fakeRuntime([json(200, { error: { code: 429, message: "rate limited upstream" } })]);
		await expect(completeOpenRouterText(runtime, ref("openrouter", "OpenRouter"), "sys", "q")).rejects.toThrow(/rate limited upstream/);
	});

	test("partial text with finish_reason error is flagged as incomplete", async () => {
		const { runtime } = fakeRuntime([json(200, { choices: [{ message: { content: "Half an ans" }, finish_reason: "error" }] })]);
		const result = await completeOpenRouterText(runtime, ref("openrouter", "OpenRouter"), "sys", "q");
		expect(result.incompleteReason).toBe("error");
	});

	test("cached and reasoning token details are carried into usage", async () => {
		const { runtime } = fakeRuntime([
			json(200, {
				choices: [{ message: { content: "Done" }, finish_reason: "stop" }],
				usage: {
					prompt_tokens: 10,
					completion_tokens: 20,
					total_tokens: 30,
					prompt_tokens_details: { cached_tokens: 4 },
					completion_tokens_details: { reasoning_tokens: 7 }
				}
			})
		]);
		const result = await completeOpenRouterText(runtime, ref("openrouter", "OpenRouter"), "sys", "q");
		expect(result.usage).toEqual({
			input_tokens: 10,
			output_tokens: 20,
			total_tokens: 30,
			input_tokens_details: { cached_tokens: 4 },
			output_tokens_details: { reasoning_tokens: 7 }
		});
	});
});

describe("secrets in 200-body provider errors", () => {
	// Not an sk- or AIza key, so only the known-key list can catch it. Azure and many gateways use keys like this.
	const HEX_KEY = "0123456789abcdef0123456789abcdef";
	const echoed = { error: { code: 401, message: `Incorrect API key ${HEX_KEY} for this resource` } };

	test("OpenRouter's buffered path redacts the key it was sent", async () => {
		const { runtime } = configurableRuntime([json(200, echoed)], { apiKey: HEX_KEY });
		const error = await completeOpenRouterText(runtime, ref("openrouter", "OpenRouter"), "sys", "q").catch((caught: unknown) => caught);
		const message = error instanceof Error ? error.message : "";
		expect(message).toContain("reported an error in its response");
		expect(message).toContain("[redacted]");
		expect(message).not.toContain(HEX_KEY);
	});

	test("Azure AI Foundry's buffered path redacts the key it was sent", async () => {
		const { runtime } = configurableRuntime([json(200, echoed)], { apiKey: HEX_KEY, baseUrl: AZURE_AI_BASE });
		const error = await completeAzureAIText(runtime, ref("azure-ai", "Azure AI Foundry"), "sys", "q").catch((caught: unknown) => caught);
		const message = error instanceof Error ? error.message : "";
		expect(message).toContain("[redacted]");
		expect(message).not.toContain(HEX_KEY);
	});

	test("buildChatCompletionsResult redacts only the secrets it is given", () => {
		const body = { error: { message: `bad ${HEX_KEY}` } };
		expect(() => buildChatCompletionsResult("X", "m", body, [HEX_KEY])).toThrow("bad [redacted]");
		expect(() => buildChatCompletionsResult("X", "m", body)).toThrow(HEX_KEY);
	});
});

describe("model list validation", () => {
	test("a non-JSON 200 is not reported as an empty model list", async () => {
		const { runtime } = fakeRuntime([raw(200, "<html>Captive portal</html>")]);
		await expect(fetchProviderModels(runtime, "openrouter")).rejects.toThrow(/did not return a model list/);
	});

	test("a JSON 200 without a data array is rejected", async () => {
		const { runtime } = fakeRuntime([json(200, { models: [] })]);
		await expect(fetchProviderModels(runtime, "openrouter")).rejects.toThrow(/did not return a model list/);
	});
});

describe("Azure OpenAI model refresh", () => {
	test("does not offer base models as deployment names", async () => {
		const { runtime, calls } = fakeRuntime([]);
		await expect(fetchAzureOpenAIModels(runtime)).rejects.toThrow(/deployments cannot be listed with an API key/);
		expect(calls).toHaveLength(0);
	});
});

describe("testProviderConnection", () => {
	const list = (...ids: string[]): AskMateHttpResponse<unknown> => json(200, { data: ids.map((id) => ({ id })) });

	test("keeps the string result of the original hosted-provider test", async () => {
		const { runtime, calls } = configurableRuntime([list("a", "b")]);
		expect(await testProviderConnection(runtime, "openrouter")).toBe("AskMate OpenRouter test passed. 2 models are visible.");
		expect(calls[0]?.url).toBe("https://example.test/v1/models");
	});

	test("routes every provider id to its own check", async () => {
		const routes: Array<[TextProviderId, AskMateHttpResponse<unknown>, string, RegExp]> = [
			["openai", list("gpt-5.5"), "https://example.test/v1/models", /OpenAI test passed/],
			["openrouter", list("m"), "https://example.test/v1/models", /OpenRouter test passed/],
			["openai-compatible", list("llama3"), "https://example.test/v1/models", /Local or self-hosted test passed/],
			["anthropic", json(200, { data: [{ id: "claude-x" }], has_more: false }), "https://example.test/v1/models?limit=1000", /Anthropic Claude test passed/],
			["google-gemini", json(200, { models: [{ name: "models/gemini-x", supportedGenerationMethods: ["generateContent"] }] }), "https://example.test/v1/models?pageSize=1000", /Google Gemini test passed/],
			["azure-openai", json(200, { choices: [{ message: { content: "OK" } }] }), `${AZURE_OPENAI_BASE}/chat/completions`, /Azure OpenAI test passed/],
			["azure-ai", json(200, { choices: [{ message: { content: "OK" }, finish_reason: "stop" }] }), `${AZURE_AI_BASE}/models/chat/completions?api-version=2024-05-01-preview`, /Azure AI Foundry test passed/]
		];

		for (const [providerId, response, url, expected] of routes) {
			const baseUrl = providerId === "azure-openai" ? AZURE_OPENAI_BASE : providerId === "azure-ai" ? AZURE_AI_BASE : "https://example.test/v1";
			const { runtime, calls } = configurableRuntime([response], { baseUrl });
			expect(await testProviderConnection(runtime, providerId)).toMatch(expected);
			expect(calls[0]?.url).toBe(url);
		}
	});

	test("sends no Authorization header to a local server that has no key", async () => {
		const { runtime, calls } = configurableRuntime([list("llama3")], { apiKey: "", baseUrl: "http://localhost:11434/v1" });
		await testProviderConnection(runtime, "openai-compatible");
		expect(calls[0]?.options.headers?.Authorization).toBeUndefined();
		const keyed = configurableRuntime([list("llama3")], { baseUrl: "http://localhost:11434/v1" });
		await testProviderConnection(keyed.runtime, "openai-compatible");
		expect(keyed.calls[0]?.options.headers?.Authorization).toBe(`Bearer ${API_KEY}`);
	});

	test("still throws a clear error when the key is rejected", async () => {
		const { runtime } = configurableRuntime([json(401, { error: { message: "Invalid key" } })]);
		await expect(testProviderConnection(runtime, "openrouter")).rejects.toThrow(/authentication failed/);
	});
});

describe("testProviderConnectionDetailed", () => {
	const list = (...ids: string[]): AskMateHttpResponse<unknown> => json(200, { data: ids.map((id) => ({ id })) });
	const clock = (...ticks: number[]): (() => number) => {
		const queue = [...ticks];
		return () => queue.shift() ?? 0;
	};

	test("reports a listed model as available, with the time the check took", async () => {
		const { runtime } = configurableRuntime([list("gpt-4.1", "gpt-5.5")], { model: "gpt-5.5" });
		const result = await testProviderConnectionDetailed(runtime, "openrouter", clock(1000, 1250));
		expect(result).toEqual({
			ok: true,
			message: "AskMate OpenRouter test passed. 2 models are visible and gpt-5.5 is available.",
			modelFound: true,
			latencyMs: 250,
			suggestedModel: null
		});
	});

	test("says connected but the model was not found, and names the closest listed model", async () => {
		const { runtime } = configurableRuntime([list("gpt-4.1", "gpt-5.5", "o3")], { model: "gpt-5.7" });
		const result = await testProviderConnectionDetailed(runtime, "openrouter", clock(0, 5));
		expect(result.ok).toBe(true);
		expect(result.modelFound).toBe(false);
		expect(result.suggestedModel).toBe("gpt-5.5");
		expect(result.message).toBe('AskMate OpenRouter connected, but model "gpt-5.7" was not found. Closest listed model: "gpt-5.5". 3 models are visible.');
	});

	test("matches the ids a provider really lists: dated snapshots, :latest tags and models/ prefixes", async () => {
		const snapshot = configurableRuntime([list("gpt-5.5-2026-04-23")], { model: "gpt-5.5" });
		expect((await testProviderConnectionDetailed(snapshot.runtime, "openai")).modelFound).toBe(true);
		const compact = configurableRuntime([json(200, { data: [{ id: "claude-sonnet-4-5-20250929" }], has_more: false })], { model: "claude-sonnet-4-5" });
		expect((await testProviderConnectionDetailed(compact.runtime, "anthropic")).modelFound).toBe(true);
		const tagged = configurableRuntime([list("llama3:latest", "qwen2.5:7b")], { model: "llama3", baseUrl: "http://localhost:11434/v1" });
		expect((await testProviderConnectionDetailed(tagged.runtime, "openai-compatible")).modelFound).toBe(true);
		const gemini = configurableRuntime([json(200, { models: [{ name: "models/gemini-2.5-pro", supportedGenerationMethods: ["generateContent"] }] })], { model: "gemini-2.5-pro" });
		expect((await testProviderConnectionDetailed(gemini.runtime, "google-gemini")).modelFound).toBe(true);
	});

	test("a different version of the same family is not a match", async () => {
		const { runtime } = configurableRuntime([list("gpt-5.5-mini", "gpt-5.50")], { model: "gpt-5.5" });
		expect((await testProviderConnectionDetailed(runtime, "openrouter")).modelFound).toBe(false);
	});

	test("with no model chosen, a local server offers the first listed model", async () => {
		const { runtime } = configurableRuntime([list("llama3", "qwen2.5")], { model: "", baseUrl: "http://localhost:11434/v1" });
		const result = await testProviderConnectionDetailed(runtime, "openai-compatible");
		expect(result.ok).toBe(true);
		expect(result.modelFound).toBeNull();
		expect(result.suggestedModel).toBe("llama3");
		expect(result.message).toContain("No model is selected yet");
	});

	test("a server that lists no models is connected but has nothing to answer with", async () => {
		const { runtime } = configurableRuntime([list()], { model: "llama3", baseUrl: "http://localhost:11434/v1" });
		const result = await testProviderConnectionDetailed(runtime, "openai-compatible");
		expect(result.ok).toBe(true);
		expect(result.modelFound).toBe(false);
		expect(result.suggestedModel).toBeNull();
		expect(result.message).toContain("lists no models");
	});

	test("a request-based check proves the deployment answered", async () => {
		const azure = configurableRuntime([json(200, { choices: [{ message: { content: "OK" } }] })], { baseUrl: AZURE_OPENAI_BASE });
		const result = await testProviderConnectionDetailed(azure.runtime, "azure-openai", clock(10, 40));
		expect(result.ok).toBe(true);
		expect(result.modelFound).toBe(true);
		expect(result.latencyMs).toBe(30);
		expect(result.message).toContain("Azure OpenAI test passed");
	});

	test("a failure comes back as a result with the key redacted, not as an exception", async () => {
		const { runtime } = configurableRuntime([json(401, { error: { message: `Invalid key ${API_KEY}` } })]);
		const result = await testProviderConnectionDetailed(runtime, "openrouter", clock(0, 12));
		expect(result.ok).toBe(false);
		expect(result.modelFound).toBeNull();
		expect(result.suggestedModel).toBeNull();
		expect(result.latencyMs).toBe(12);
		expect(result.message).toContain("authentication failed");
		expect(result.message).not.toContain(API_KEY);
	});

	test("a missing key is a failed result that names the fix", async () => {
		const { runtime, calls } = configurableRuntime([], { apiKey: "" });
		const result = await testProviderConnectionDetailed(runtime, "openrouter");
		expect(result.ok).toBe(false);
		expect(result.message).toMatch(/API key/);
		expect(calls).toHaveLength(0);
	});
});

describe("completeProviderTextRequest routing", () => {
	test("an unknown provider id is named in the error", async () => {
		const { runtime } = fakeRuntime([]);
		const unknownProvider: string = "made-up";
		await expect(completeProviderTextRequest(runtime, ref(unknownProvider as TextProviderId, "Made up"), "sys", "q")).rejects.toThrow("Unsupported text provider: made-up");
	});
});

describe("fetchProviderModels routing", () => {
	test("rejects an unknown provider instead of falling back to OpenAI-compatible", async () => {
		const { runtime, calls } = fakeRuntime([]);
		const unknownProvider: string = "made-up";
		await expect(fetchProviderModels(runtime, unknownProvider as TextProviderId)).rejects.toThrow(/Unsupported text provider/);
		expect(calls).toHaveLength(0);
	});
});

describe("describeTransportError", () => {
	const url = "http://localhost:11434/v1/chat/completions?key=secret-value";

	test.each([
		["net::ERR_CONNECTION_REFUSED", "Could not connect to localhost:11434. Check that the server is running and that the base URL is right."],
		["connect ECONNREFUSED 127.0.0.1:11434", "Could not connect to localhost:11434. Check that the server is running and that the base URL is right."],
		["net::ERR_NAME_NOT_RESOLVED", "Could not find localhost:11434. Check the spelling of the base URL and your network."],
		["getaddrinfo ENOTFOUND api.example.test", "Could not find localhost:11434. Check the spelling of the base URL and your network."],
		["net::ERR_CERT_AUTHORITY_INVALID", "localhost:11434 uses a certificate Obsidian does not trust. Use a trusted certificate, or http for a server on this machine."],
		["self-signed certificate in certificate chain", "localhost:11434 uses a certificate Obsidian does not trust. Use a trusted certificate, or http for a server on this machine."],
		["net::ERR_INTERNET_DISCONNECTED", "There is no network connection to localhost:11434. Check your internet connection."],
		["net::ERR_CONNECTION_TIMED_OUT", "localhost:11434 did not answer in time. Check that it is reachable, then try again."],
		["read ECONNRESET", "localhost:11434 closed the connection. Try again."],
		["Failed to fetch", "Could not reach localhost:11434. The server may be down, or it may not allow requests from Obsidian."]
	])("%s reads as one sentence naming the host", (raw: string, expected: string) => {
		expect(describeTransportError(new Error(raw), url)).toBe(expected);
	});

	test("never puts the path, query or key in the sentence", () => {
		const sentence = describeTransportError(new Error("net::ERR_CONNECTION_REFUSED"), url) ?? "";
		expect(sentence).not.toContain("secret-value");
		expect(sentence).not.toContain("chat/completions");
	});

	test("an error it does not recognise stays as it was", () => {
		expect(describeTransportError(new Error("The model said no"), url)).toBeNull();
		expect(describeTransportError("net::ERR_CONNECTION_REFUSED", url)).toBe("Could not connect to localhost:11434. Check that the server is running and that the base URL is right.");
		expect(describeTransportError(new Error("net::ERR_CONNECTION_REFUSED"), "not a url")).toContain("Could not connect to the server.");
	});
});

describe("provider error helpers", () => {
	test("maps statuses and prefixes the fallback with provider and status", () => {
		expect(formatProviderHttpError("X", 401, "")).toMatch(/^X authentication failed/);
		expect(formatProviderHttpError("X", 404, "")).toMatch(/could not find the endpoint or model/);
		expect(formatProviderHttpError("X", 429, "")).toMatch(/rate limit/);
		expect(formatProviderHttpError("X", 503, "")).toMatch(/service error/);
		expect(formatProviderHttpError("X", 400, "bad input")).toBe("X request failed with HTTP 400. Provider message: bad input");
		expect(formatProviderHttpError("X", 418, "")).toBe("X request failed with HTTP 418.");
	});

	test("redacts known secrets and key-like strings", () => {
		const text = "sk-abcdefghijklmnopqrstuv AIzaSyA1234567890abcdefghijklmnopqrstu Bearer abcdefghijklmnopqrstu https://x.test/?key=secret123 custom-secret-value";
		const redacted = redactSecrets(text, ["custom-secret-value"]);
		expect(redacted).not.toContain("sk-abcdefghijklmnopqrstuv");
		expect(redacted).not.toContain("AIzaSyA1234567890abcdefghijklmnopqrstu");
		expect(redacted).not.toContain("abcdefghijklmnopqrstu");
		expect(redacted).not.toContain("secret123");
		expect(redacted).not.toContain("custom-secret-value");
		expect(redacted).toContain("Bearer [redacted]");
	});

	test.each([
		["an error object", { error: { message: "Model not found" } }, "Model not found"],
		["an error string, as LM Studio and some gateways send", { error: "Model not found" }, "Model not found"],
		["a top-level message", { message: "Model not found" }, "Model not found"],
		["a detail string, as FastAPI-based servers send", { detail: "Model not found" }, "Model not found"],
		["an object error without a message", { error: { code: 7 } }, ""],
		["a blank string", { error: "  " }, ""],
		["an unrelated body", { id: "x" }, ""]
	])("reads a provider error from %s", (_name: string, body: Record<string, unknown>, expected: string) => {
		expect(extractProviderError(body, "")).toBe(expected);
	});

	test("an HTTP error with a string error shows the message, not raw JSON", () => {
		expect(describeProviderErrorBody(json(404, { error: "model 'llama9' not found" }))).toBe("model 'llama9' not found");
	});

	test("a string error or top-level message in a 200 body is not read as a failure", () => {
		expect(buildChatCompletionsResult("X", "m", { error: "note", message: "hello", detail: "d", choices: [{ message: { content: "Hi" }, finish_reason: "stop" }] }).text).toBe("Hi");
	});

	test("caps long non-JSON bodies", () => {
		const detail = describeProviderErrorBody(raw(500, "x".repeat(1000)));
		expect(detail.length).toBeLessThanOrEqual(303);
		expect(detail.endsWith("...")).toBe(true);
	});

	test("model pagination stops when a cursor repeats", async () => {
		let requests = 0;
		const models = await collectModelPages(
			async () => {
				requests += 1;
				return { ids: [`m${requests}`], next: "same" };
			},
			(page) => page.ids,
			(page) => page.next
		);
		expect(requests).toBe(2);
		expect(models).toEqual(["m1", "m2"]);
	});
});

interface TestRuntimeOptions {
	apiKey?: string;
	model?: string;
	baseUrl?: string;
}

/** A runtime whose key and model can be blank, for the paths that validate them before any request. */
function configurableRuntime(
	responses: Array<AskMateHttpResponse<unknown>>,
	{ apiKey = API_KEY, model = "test-model", baseUrl = "https://example.test/v1" }: TestRuntimeOptions = {}
): { runtime: ProviderRuntime; calls: RecordedCall[] } {
	const { runtime, calls } = fakeRuntime(responses, baseUrl);
	return {
		runtime: {
			...runtime,
			getProviderSettings: (_providerId: TextProviderId): ProviderSettings => ({ apiKeySecretName: "", model, modelOptions: [], baseUrl }),
			getProviderApiKey: async () => apiKey
		},
		calls
	};
}

const AZURE_OPENAI_BASE = "https://res.openai.azure.com/openai/v1";
const AZURE_AI_BASE = "https://res.services.ai.azure.com";

describe("Azure Test connection", () => {
	test("Azure OpenAI allows a slow deployment a full minute and says a slow one is not misconfigured", async () => {
		const { runtime, calls } = configurableRuntime([json(200, { choices: [{ message: { content: "OK" } }] })], { baseUrl: AZURE_OPENAI_BASE });
		await testAzureOpenAIConnection(runtime);
		expect(calls[0]?.options.timeoutMs).toBe(60000);
		expect(calls[0]?.options.timeoutMessage).toContain("1 minute");
		expect(calls[0]?.options.timeoutMessage).toContain("not necessarily misconfigured");
	});

	test("Azure AI Foundry allows a slow deployment a full minute and says a slow one is not misconfigured", async () => {
		const { runtime, calls } = configurableRuntime([json(200, { choices: [{ message: { content: "OK" }, finish_reason: "stop" }] })], { baseUrl: AZURE_AI_BASE });
		await testAzureAIConnection(runtime);
		expect(calls[0]?.options.timeoutMs).toBe(60000);
		expect(calls[0]?.options.timeoutMessage).toContain("1 minute");
		expect(calls[0]?.options.timeoutMessage).toContain("not necessarily misconfigured");
	});

	test("Azure OpenAI reports the key and deployment problems before sending anything", async () => {
		const noKey = configurableRuntime([], { apiKey: "", baseUrl: AZURE_OPENAI_BASE });
		await expect(testAzureOpenAIConnection(noKey.runtime)).rejects.toThrow(/Add an Azure OpenAI API key/);
		const noModel = configurableRuntime([], { model: " ", baseUrl: AZURE_OPENAI_BASE });
		await expect(testAzureOpenAIConnection(noModel.runtime)).rejects.toThrow(/deployment name/);
		expect(noKey.calls).toHaveLength(0);
		expect(noModel.calls).toHaveLength(0);
	});

	test("Azure OpenAI sends the key in the api-key header and redacts it from a 401", async () => {
		const { runtime, calls } = configurableRuntime([json(401, { error: { message: `Bad key ${API_KEY}` } })], { baseUrl: AZURE_OPENAI_BASE });
		const error = await testAzureOpenAIConnection(runtime).catch((caught: unknown) => caught);
		const message = error instanceof Error ? error.message : "";
		expect(calls[0]?.options.headers?.["api-key"]).toBe(API_KEY);
		expect(message).toContain("authentication failed");
		expect(message).not.toContain(API_KEY);
	});

	test("Azure OpenAI completion posts the deployment name to chat completions", async () => {
		const { runtime, calls } = configurableRuntime([json(200, { choices: [{ message: { content: "Hi" }, finish_reason: "stop" }] })], { baseUrl: AZURE_OPENAI_BASE });
		const result = await completeAzureOpenAIText(runtime, ref("azure-openai", "Azure OpenAI", "my-deployment"), "sys", "q");
		expect(calls[0]?.url).toBe(`${AZURE_OPENAI_BASE}/chat/completions`);
		expect(parsedBody(calls[0]).model).toBe("my-deployment");
		expect(result.text).toBe("Hi");
	});
});
