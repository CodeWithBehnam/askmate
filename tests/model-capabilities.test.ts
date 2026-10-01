import { describe, expect, test } from "bun:test";
import { getSupportedReasoningEffort } from "../src/shared/modelCapabilities";
import type { ReasoningEffort } from "../src/shared/types";

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
