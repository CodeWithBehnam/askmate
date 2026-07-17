import { describe, expect, test } from "bun:test";
import { ANTHROPIC_DEFAULT_MAX_TOKENS } from "../src/providers/anthropic";
import { GEMINI_DEFAULT_MAX_OUTPUT_TOKENS } from "../src/providers/google-gemini";
import { completeProviderTextRequest, getProviderTextEndpoint } from "../src/providers/index";
import { joinOpenAIUrl, requestOpenAIImageGeneration, requestOpenAIResponses } from "../src/providers/open-ai";
import type { ProviderRuntime } from "../src/providers/types";
import type { ProviderModelRef, ProviderSettings, TextProviderId } from "../src/shared/types";

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
});

describe("provider generation defaults", () => {
	test("Anthropic max tokens is a named non-tiny default", () => {
		expect(ANTHROPIC_DEFAULT_MAX_TOKENS).toBeGreaterThanOrEqual(4096);
	});

	test("Gemini max output tokens is a named non-tiny default", () => {
		expect(GEMINI_DEFAULT_MAX_OUTPUT_TOKENS).toBeGreaterThanOrEqual(4096);
	});
});
