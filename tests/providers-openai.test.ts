import { describe, expect, test } from "bun:test";
import {
	buildOpenAIResponsesBody,
	extractOpenAIRefusal,
	extractOpenAIText,
	fetchOpenAIModels,
	requestOpenAIResponses
} from "../src/providers/open-ai";
import { parseOpenAIStreamEvent } from "../src/providers/open-ai-stream";
import type { ProviderRequestOptions, ProviderRuntime } from "../src/providers/types";
import {
	getModelCapability,
	getSupportedReasoningEffort,
	isOpenAITextModel
} from "../src/shared/modelCapabilities";
import type { AskMateHttpResponse, OpenAIResponseBody, ProviderSettings, TextProviderId } from "../src/shared/types";

function runtimeReturning(body: unknown, calls: Array<{ url: string; options: ProviderRequestOptions }>): ProviderRuntime {
	return {
		getProviderSettings: (_providerId: TextProviderId): ProviderSettings => ({
			apiKeySecretName: "",
			model: "gpt-5.5",
			modelOptions: [],
			baseUrl: "https://api.openai.com/v1"
		}),
		getProviderApiKey: async () => "sk-test",
		requestJson: async <T>(url: string, options?: ProviderRequestOptions): Promise<AskMateHttpResponse<T>> => {
			calls.push({ url, options: options ?? {} });
			const response: AskMateHttpResponse<unknown> = { status: 200, ok: true, body, text: JSON.stringify(body) };
			// The fake serves canned JSON; the generic only describes the caller's expected shape.
			return response as AskMateHttpResponse<T>;
		}
	};
}

describe("OpenAI Responses request body", () => {
	test("always disables server-side storage", () => {
		expect(buildOpenAIResponsesBody({ model: "gpt-5.5", instructions: "i", input: "q", reasoningEffort: "medium" })).toEqual({
			model: "gpt-5.5",
			instructions: "i",
			input: "q",
			store: false,
			reasoning: { effort: "medium" }
		});
	});

	test("omits reasoning for models that reject it", () => {
		for (const model of ["gpt-4.1", "gpt-4o", "gpt-5-chat-latest", "o1-mini"]) {
			const body = buildOpenAIResponsesBody({ model, instructions: "i", input: "q", reasoningEffort: "high" });
			expect(body.reasoning).toBeUndefined();
			expect(body.store).toBe(false);
		}
	});

	test("clamps effort to the o-series range", () => {
		expect(getSupportedReasoningEffort("o3", "none")).toBe("low");
		expect(getSupportedReasoningEffort("o4-mini", "xhigh")).toBe("high");
		expect(getSupportedReasoningEffort("o3", "medium")).toBe("medium");
		expect(getSupportedReasoningEffort("gpt-5.5", "xhigh")).toBe("xhigh");
		expect(getSupportedReasoningEffort("gpt-5-mini", "low")).toBe("low");
	});

	test("requestOpenAIResponses posts the built body with bearer auth", async () => {
		const calls: Array<{ url: string; options: ProviderRequestOptions }> = [];
		await requestOpenAIResponses(runtimeReturning({}, calls), {
			apiKey: "sk-test",
			model: "gpt-4.1",
			instructions: "i",
			input: "q",
			reasoningEffort: "low"
		});
		expect(calls[0]?.url).toBe("https://api.openai.com/v1/responses");
		expect(calls[0]?.options.headers?.Authorization).toBe("Bearer sk-test");
		expect(JSON.parse(calls[0]?.options.body ?? "{}")).toEqual({ model: "gpt-4.1", instructions: "i", input: "q", store: false });
	});
});

describe("OpenAI response parsing", () => {
	test("extracts output text and refusals", () => {
		const body: OpenAIResponseBody = {
			output: [{ content: [{ type: "output_text", text: "One" }, { type: "output_text", text: "Two" }] }]
		};
		expect(extractOpenAIText(body)).toBe("One\nTwo");
		expect(extractOpenAIRefusal(body)).toBe("");

		const refused: unknown = JSON.parse('{"output":[{"content":[{"type":"refusal","refusal":"No."}]}]}');
		expect(extractOpenAIRefusal(refused as OpenAIResponseBody)).toBe("No.");
	});
});

describe("OpenAI model refresh", () => {
	test("keeps text models and gpt-image-2 only", async () => {
		const calls: Array<{ url: string; options: ProviderRequestOptions }> = [];
		const ids = [
			"gpt-5.5", "gpt-4.1", "o3", "gpt-image-2", "gpt-image-1", "dall-e-3", "text-embedding-3-small", "tts-1",
			"whisper-1", "gpt-4o-transcribe", "omni-moderation-latest", "gpt-4o-realtime-preview", "gpt-4o-audio-preview",
			"gpt-4o-mini-search-preview", "gpt-3.5-turbo-instruct", "davinci-002", "sora-2"
		];
		const models = await fetchOpenAIModels(runtimeReturning({ data: ids.map((id) => ({ id })) }, calls));
		expect(models).toEqual(["gpt-4.1", "gpt-5.5", "gpt-image-2", "o3"]);
		expect(calls[0]?.url).toBe("https://api.openai.com/v1/models");
	});

	test("recognises the image model family", () => {
		expect(getModelCapability("gpt-image-2")).toBe("image");
		expect(getModelCapability("gpt-image-1")).toBe("image");
		expect(getModelCapability("dall-e-3")).toBe("image");
		expect(getModelCapability("gpt-5.5")).toBe("text");
		expect(isOpenAITextModel("gpt-image-1")).toBe(false);
		expect(isOpenAITextModel("chatgpt-4o-latest")).toBe(true);
	});
});

describe("OpenAI stream event parsing", () => {
	test("accepts data lines with or without a space", () => {
		expect(parseOpenAIStreamEvent('data:{"type":"response.output_text.delta","delta":"a"}')?.delta).toBe("a");
		expect(parseOpenAIStreamEvent('data: {"type":"response.output_text.delta","delta":"b"}')?.delta).toBe("b");
		expect(parseOpenAIStreamEvent("data: [DONE]")).toBeNull();
		expect(parseOpenAIStreamEvent("event: response.created")).toBeNull();
	});

	test("raises top-level error events", () => {
		expect(() => parseOpenAIStreamEvent('data: {"type":"error","code":"server_error","message":"Boom"}')).toThrow("Boom");
		expect(() => parseOpenAIStreamEvent('data: {"type":"error"}')).toThrow("OpenAI stream error.");
	});
});
