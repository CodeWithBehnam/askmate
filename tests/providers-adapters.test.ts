import { describe, expect, test } from "bun:test";
import { ANTHROPIC_DEFAULT_MAX_TOKENS, completeAnthropicText, fetchAnthropicModels } from "../src/providers/anthropic";
import { completeAzureAIText, getAzureAIBaseUrl } from "../src/providers/azure-ai";
import { fetchAzureOpenAIModels } from "../src/providers/azure-open-ai";
import {
	collectModelPages,
	describeProviderErrorBody,
	formatProviderHttpError,
	redactSecrets
} from "../src/providers/common";
import { completeGeminiText, fetchGeminiModels, GEMINI_DEFAULT_MAX_OUTPUT_TOKENS } from "../src/providers/google-gemini";
import { fetchProviderModels } from "../src/providers/index";
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
		expect(calls[0]?.options.timeoutMs).toBe(300000);
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
		expect(parsedBody(calls[0])).toEqual({
			systemInstruction: { parts: [{ text: "sys" }] },
			contents: [{ role: "user", parts: [{ text: "q" }] }],
			generationConfig: { maxOutputTokens: GEMINI_DEFAULT_MAX_OUTPUT_TOKENS }
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

	test("a refusal message with no content raises a clear error", async () => {
		const { runtime } = fakeRuntime([
			json(200, { choices: [{ message: { content: null, refusal: "I can't help with that." }, finish_reason: "stop" }] })
		]);
		await expect(completeOpenRouterText(runtime, ref("openrouter", "OpenRouter"), "sys", "q")).rejects.toThrow(
			"OpenRouter refused the request. Provider message: I can't help with that."
		);
	});
});

describe("Azure OpenAI model refresh", () => {
	test("does not offer base models as deployment names", async () => {
		const { runtime, calls } = fakeRuntime([]);
		await expect(fetchAzureOpenAIModels(runtime)).rejects.toThrow(/deployments cannot be listed with an API key/);
		expect(calls).toHaveLength(0);
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
