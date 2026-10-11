import { describe, expect, test } from "bun:test";
import {
	applyChatSelection,
	buildModelChoices,
	listProviderModels,
	matchIdentifier,
	parseModelQuery,
	providerNeedsApiKey,
	resolveModelQuery,
	resolveProviderQuery
} from "../src/ui/sidebar/modelSwitch";
import { DEFAULT_PROVIDER_SETTINGS } from "../src/settings/constants";
import type { AskMateSettings } from "../src/shared/types";

const models = ["gpt-5.5", "gpt-5.5-mini", "gpt-image-2", "o3"];

function settings(): AskMateSettings {
	return structuredClone({
		providers: DEFAULT_PROVIDER_SETTINGS,
		providerRoles: { chatProviderId: "openai", imagePromptPlanningProviderId: "same-as-chat" },
		selectedTextProvider: "openai"
	}) as unknown as AskMateSettings;
}

describe("matchIdentifier", () => {
	test("exact beats prefix even when the exact ID is a prefix of another", () => {
		expect(matchIdentifier("gpt-5.5", models)).toEqual({ kind: "exact", value: "gpt-5.5" });
	});

	test("case-insensitive exact", () => {
		expect(matchIdentifier("GPT-5.5-MINI", models)).toEqual({ kind: "exact", value: "gpt-5.5-mini" });
	});

	test("unique prefix and unique substring", () => {
		expect(matchIdentifier("gpt-i", models)).toEqual({ kind: "match", value: "gpt-image-2" });
		expect(matchIdentifier("mini", models)).toEqual({ kind: "match", value: "gpt-5.5-mini" });
	});

	test("ambiguous prefixes list the candidates", () => {
		expect(matchIdentifier("gpt", models)).toEqual({ kind: "ambiguous", candidates: ["gpt-5.5", "gpt-5.5-mini", "gpt-image-2"] });
	});

	test("unknown and empty", () => {
		expect(matchIdentifier("claude", models)).toEqual({ kind: "none" });
		expect(matchIdentifier("  ", models)).toEqual({ kind: "none" });
	});
});

describe("resolveModelQuery", () => {
	test("listed models resolve", () => {
		expect(resolveModelQuery("o3", models)).toEqual({ kind: "use", model: "o3", listed: true });
		expect(resolveModelQuery("image", models)).toEqual({ kind: "use", model: "gpt-image-2", listed: true });
	});

	test("ambiguous input is refused", () => {
		expect(resolveModelQuery("gpt", models)).toEqual({ kind: "ambiguous", candidates: ["gpt-5.5", "gpt-5.5-mini", "gpt-image-2"] });
	});

	test("unknown IDs need a trailing !", () => {
		expect(resolveModelQuery("my-finetune", models)).toEqual({ kind: "unknown", query: "my-finetune" });
		expect(resolveModelQuery("my-finetune!", models)).toEqual({ kind: "use", model: "my-finetune", listed: false });
	});

	test("a lone ! is not a model", () => {
		expect(parseModelQuery("!")).toEqual({ query: "!", force: false });
		expect(resolveModelQuery("!", models).kind).toBe("unknown");
	});
});

describe("resolveProviderQuery", () => {
	test("matches ids, labels and prefixes", () => {
		expect(resolveProviderQuery("anthropic")).toEqual({ kind: "exact", value: "anthropic" });
		expect(resolveProviderQuery("Google")).toEqual({ kind: "match", value: "google-gemini" });
		expect(resolveProviderQuery("openai")).toEqual({ kind: "exact", value: "openai" });
	});

	test("ambiguous and unknown", () => {
		expect(resolveProviderQuery("azure").kind).toBe("ambiguous");
		expect(resolveProviderQuery("mistral")).toEqual({ kind: "none" });
	});
});

describe("model listing and selection", () => {
	test("lists the selected model first without duplicates", () => {
		const current = settings();
		current.providers.anthropic.model = "claude-opus-5-5";
		const list = listProviderModels("anthropic", current);
		expect(list[0]).toBe("claude-opus-5-5");
		expect(new Set(list).size).toBe(list.length);
		expect(list).toContain("claude-sonnet-5-5");
	});

	test("providers without a key are skipped in the picker unless current", () => {
		const current = settings();
		current.providers.anthropic.apiKeySecretName = "anthropic-key";
		const providers = new Set(buildModelChoices(current, "openai").map((choice) => choice.providerId));
		expect(providers.has("anthropic")).toBe(true);
		expect(providers.has("openrouter")).toBe(false);
		expect(providers.has("openai")).toBe(true);
		expect(providers.has("openai-compatible")).toBe(true);
	});

	test("key warnings exclude local servers", () => {
		const current = settings();
		expect(providerNeedsApiKey("openai-compatible", current)).toBe(false);
		expect(providerNeedsApiKey("openai", current)).toBe(true);
		current.providers.openai.apiKeySecretName = "k";
		expect(providerNeedsApiKey("openai", current)).toBe(false);
	});

	test("applyChatSelection switches provider and keeps the model listed", () => {
		const current = settings();
		applyChatSelection(current, "anthropic", "custom-claude");
		expect(current.providerRoles.chatProviderId).toBe("anthropic");
		expect(current.selectedTextProvider).toBe("anthropic");
		expect(current.providers.anthropic.model).toBe("custom-claude");
		expect(current.providers.anthropic.modelOptions).toContain("custom-claude");
		expect(DEFAULT_PROVIDER_SETTINGS.anthropic.modelOptions).not.toContain("custom-claude");
	});

	test("switching provider alone keeps that provider's saved model", () => {
		const current = settings();
		applyChatSelection(current, "google-gemini");
		expect(current.providers["google-gemini"].model).toBe("gemini-2.5-pro");
	});
});
