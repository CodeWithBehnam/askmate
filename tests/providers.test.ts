import { describe, expect, test } from "bun:test";
import { ANTHROPIC_DEFAULT_MAX_TOKENS, getAnthropicMaxTokens } from "../src/providers/anthropic";
import { formatTimeoutDuration } from "../src/providers/common";
import { completeProviderTextRequest, getProviderTextEndpoint } from "../src/providers/index";
import { joinOpenAIUrl, requestOpenAIImageGeneration, requestOpenAIResponses } from "../src/providers/open-ai";
import { streamOpenAIResponses } from "../src/providers/open-ai-stream";
import type { ProviderRuntime } from "../src/providers/types";
import type { ProviderModelRef, ProviderSettings, ReasoningEffort, TextProviderId } from "../src/shared/types";

function mockRuntime(): ProviderRuntime {
	return {
		getProviderSettings: (_providerId: TextProviderId): ProviderSettings => ({
			apiKeySecretName: "",
			model: "test",
			modelOptions: [],
			baseUrl: "https://example.test/v1"
		}),
		getProviderApiKey: async () => "test-key",
		requestJson: async () => ({ status: 200, ok: true, body: null, text: "" })
	};
}

function providerRef(providerId: TextProviderId): ProviderModelRef {
	return {
		providerId,
		providerName: providerId,
		model: "test-model",
		capability: "text"
	};
}

describe("joinOpenAIUrl", () => {
	test("joins base and path without double slashes", () => {
		expect(joinOpenAIUrl("https://api.openai.com/v1", "responses")).toBe("https://api.openai.com/v1/responses");
		expect(joinOpenAIUrl("https://api.openai.com/v1/", "/images/generations")).toBe(
			"https://api.openai.com/v1/images/generations"
		);
		expect(joinOpenAIUrl("https://proxy.example/openai/v1/", "responses")).toBe(
			"https://proxy.example/openai/v1/responses"
		);
	});
});

describe("completeProviderTextRequest routing", () => {
	test("refuses openai fallthrough to chat/completions", async () => {
		await expect(
			completeProviderTextRequest(mockRuntime(), providerRef("openai"), "sys", "user")
		).rejects.toThrow(/Responses API/i);
	});

	test("maps endpoints by provider", () => {
		expect(getProviderTextEndpoint("openai")).toBe("responses");
		expect(getProviderTextEndpoint("anthropic")).toBe("anthropic_messages");
		expect(getProviderTextEndpoint("google-gemini")).toBe("gemini_generate_content");
		expect(getProviderTextEndpoint("openai-compatible")).toBe("chat_completions");
	});
});

describe("provider generation timeouts", () => {
	test("OpenAI text and image generation use long timeouts", async () => {
		const calls: Array<{ timeoutMs?: number; timeoutMessage?: string }> = [];
		const runtime: ProviderRuntime = {
			...mockRuntime(),
			requestJson: async (_url, options) => {
				calls.push(options ?? {});
				return { status: 200, ok: true, body: null, text: "" };
			}
		};
		await requestOpenAIResponses(runtime, {
			apiKey: "key",
			model: "model",
			instructions: "instructions",
			input: "input",
			reasoningEffort: "low"
		});
		await requestOpenAIImageGeneration(runtime, { apiKey: "key", model: "image", prompt: "prompt" });
		expect(calls[0].timeoutMs).toBe(120000);
		expect(calls[1].timeoutMs).toBe(300000);
	});

	test.each([
		["gpt-5.5", "none", 120000, "OpenAI generation timed out after 2 minutes."],
		["gpt-5.5", "low", 120000, "OpenAI generation timed out after 2 minutes."],
		["gpt-5.5", "medium", 300000, "OpenAI generation timed out after 5 minutes."],
		["gpt-5.5", "high", 600000, "OpenAI generation timed out after 10 minutes."],
		["gpt-5.5", "xhigh", 600000, "OpenAI generation timed out after 10 minutes."],
		["o3", "xhigh", 600000, "OpenAI generation timed out after 10 minutes."],
		// A model that takes no reasoning parameter never thinks for minutes, whatever the setting says.
		["gpt-4.1", "high", 120000, "OpenAI generation timed out after 2 minutes."]
	])("buffered %s at %s effort waits %p ms and says so", async (model: string, effort: string, timeoutMs: number, message: string) => {
		const calls: Array<{ timeoutMs?: number; timeoutMessage?: string }> = [];
		const runtime: ProviderRuntime = {
			...mockRuntime(),
			requestJson: async (_url, options) => {
				calls.push(options ?? {});
				return { status: 200, ok: true, body: null, text: "" };
			}
		};
		await requestOpenAIResponses(runtime, { apiKey: "key", model, instructions: "i", input: "q", reasoningEffort: effort as ReasoningEffort });
		expect(calls[0].timeoutMs).toBe(timeoutMs);
		expect(calls[0].timeoutMessage).toBe(message);
	});

	test.each([
		["gpt-5.5", "low", 120000],
		["gpt-5.5", "medium", 300000],
		["gpt-5.5", "high", 600000],
		["gpt-4.1", "xhigh", 120000]
	])("streamed %s at %s effort allows %p ms of silence", async (model: string, effort: string, idleTimeoutMs: number) => {
		let seen: number | undefined;
		const runtime: ProviderRuntime = {
			...mockRuntime(),
			streamSse: async (_url, options) => {
				seen = options.idleTimeoutMs;
				return { kind: "unavailable", reason: "test" };
			}
		};
		await streamOpenAIResponses(runtime, { apiKey: "key", model, instructions: "i", input: "q", reasoningEffort: effort as ReasoningEffort, onDelta: () => undefined });
		expect(seen).toBe(idleTimeoutMs);
	});
});

describe("formatTimeoutDuration", () => {
	test.each([
		[10000, "10 seconds"],
		[45000, "45 seconds"],
		[60000, "1 minute"],
		[120000, "2 minutes"],
		[300000, "5 minutes"],
		[600000, "10 minutes"],
		[90000, "90 seconds"]
	])("%p ms reads as %s", (ms: number, expected: string) => {
		expect(formatTimeoutDuration(ms)).toBe(expected);
	});
});

describe("provider generation defaults", () => {
	test("Anthropic max tokens default leaves room for a long rewrite plus thinking", () => {
		expect(ANTHROPIC_DEFAULT_MAX_TOKENS).toBeGreaterThanOrEqual(32000);
	});

	test.each([
		["claude-sonnet-5-5", ANTHROPIC_DEFAULT_MAX_TOKENS],
		["claude-opus-5-5", ANTHROPIC_DEFAULT_MAX_TOKENS],
		["claude-sonnet-4-5", ANTHROPIC_DEFAULT_MAX_TOKENS],
		["claude-opus-4-1-20250805", ANTHROPIC_DEFAULT_MAX_TOKENS],
		["claude-3-7-sonnet-20250219", ANTHROPIC_DEFAULT_MAX_TOKENS],
		["a-model-that-does-not-exist-yet", ANTHROPIC_DEFAULT_MAX_TOKENS],
		// Older models answer HTTP 400 when max_tokens exceeds their own output limit.
		["claude-3-5-haiku-20241022", 8192],
		["claude-3-5-sonnet-20241022", 8192],
		["claude-3-haiku-20240307", 4096],
		["claude-3-opus-20240229", 4096],
		["claude-2.1", 4096]
	])("Anthropic max_tokens for %s is %p", (model: string, expected: number) => {
		expect(getAnthropicMaxTokens(model)).toBe(expected);
	});
});
