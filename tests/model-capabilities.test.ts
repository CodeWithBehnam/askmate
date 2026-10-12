import { describe, expect, test } from "bun:test";
import { getSupportedReasoningEffort, isOpenAITextModel } from "../src/shared/modelCapabilities";
import type { ReasoningEffort } from "../src/shared/types";

describe("isOpenAITextModel", () => {
	test.each(["o3-deep-research", "o4-mini-deep-research", "o3-deep-research-2025-06-26", "o4-mini-deep-research-2025-06-26"])(
		"%s needs a data-source tool, so it is not offered as a plain text model",
		(model: string) => {
			expect(isOpenAITextModel(model)).toBe(false);
		}
	);

	test.each(["gpt-5.5", "gpt-5-mini", "o3", "o3-pro", "o4-mini", "gpt-4.1", "chatgpt-4o-latest"])("%s stays a text model", (model: string) => {
		expect(isOpenAITextModel(model)).toBe(true);
	});

	test.each(["gpt-image-1", "text-embedding-3-large", "whisper-1", "gpt-4o-mini-tts", "omni-moderation-latest"])("%s is not a text model", (model: string) => {
		expect(isOpenAITextModel(model)).toBe(false);
	});
});

describe("getSupportedReasoningEffort", () => {
	test.each([
		["gpt-5.5", "none", "none"],
		["gpt-5.5", "xhigh", "xhigh"],
		["gpt-5", "none", "low"],
		["gpt-5-mini", "xhigh", "high"],
		["gpt-5-nano-2025-08-07", "none", "low"],
		["gpt-5-pro", "low", "high"],
		["gpt-5.2-pro", "none", "medium"],
		["gpt-5.2-pro", "xhigh", "xhigh"],
		["gpt-5.1", "xhigh", "high"],
		["gpt-5.1", "none", "none"],
		["gpt-5.1-codex-max", "xhigh", "xhigh"],
		["o3", "none", "low"],
		["o3", "xhigh", "high"]
	])("%s with %s sends %s", (model: string, effort: string, expected: string) => {
		expect(getSupportedReasoningEffort(model, effort as ReasoningEffort)).toBe(expected as ReasoningEffort);
	});

	test.each(["gpt-4.1", "gpt-5-chat-latest", "o1-mini"])("%s gets no reasoning parameter", (model: string) => {
		expect(getSupportedReasoningEffort(model, "medium")).toBeNull();
	});
});

describe("getSupportedReasoningEffort for the GPT-6 family", () => {
	test.each([
		["gpt-6-astra", "none", "low"],
		["gpt-6.1-sol", "none", "low"],
		["gpt-6-astra", "high", "high"],
		["gpt-6.1-sol", "xhigh", "xhigh"]
	])("%s with %s sends %s", (model: string, effort: string, expected: string) => {
		expect(getSupportedReasoningEffort(model, effort as ReasoningEffort)).toBe(expected as ReasoningEffort);
	});
});
