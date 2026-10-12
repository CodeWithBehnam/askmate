import { describe, expect, test } from "bun:test";
import type { App } from "obsidian";
import {
	applyChatSelection,
	buildModelChoices,
	formatProviderListing,
	listProviderModels,
	matchIdentifier,
	parseModelQuery,
	providerNeedsApiKey,
	resolveModelQuery,
	resolveProviderQuery,
	type ModelChoice
} from "../src/ui/sidebar/modelSwitch";
import { ModelPickerModal } from "../src/ui/sidebar/ModelPickerModal";
import { DEFAULT_PROVIDER_SETTINGS } from "../src/settings/constants";
import type { AskMateSettings } from "../src/shared/types";
import { createFakeEl, createFakeMouseEvent } from "./support/fake-dom";
import { FuzzySuggestModal as FakeFuzzySuggestModal } from "./support/obsidian-fakes";

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

describe("readiness takes the secret store into account (CTX-07)", () => {
	const hasKey = (): boolean => true;
	const hasNoKey = (): boolean => false;

	test("a saved secret name with no stored value still needs a key", () => {
		const current = settings();
		current.providers.openai.apiKeySecretName = "askmate-openai-key";
		expect(providerNeedsApiKey("openai", current, hasKey)).toBe(false);
		expect(providerNeedsApiKey("openai", current, hasNoKey)).toBe(true);
		expect(providerNeedsApiKey("openai", current)).toBe(false);
	});

	test("the predicate is asked about the saved secret name", () => {
		const current = settings();
		current.providers.anthropic.apiKeySecretName = "my-claude-key";
		const asked: string[] = [];
		providerNeedsApiKey("anthropic", current, (name) => {
			asked.push(name);
			return true;
		});
		expect(asked).toEqual(["my-claude-key"]);
	});

	test("local providers never need a key, whatever the predicate says", () => {
		expect(providerNeedsApiKey("openai-compatible", settings(), hasNoKey)).toBe(false);
	});

	test("the picker leaves out a provider whose key is missing, unless it is the current one", () => {
		const current = settings();
		current.providers.anthropic.apiKeySecretName = "claude";
		current.providers.openrouter.apiKeySecretName = "router";
		const ids = (predicate: (name: string) => boolean, provider: "openai" | "anthropic" = "openai") =>
			new Set(buildModelChoices(current, provider, predicate).map((choice) => choice.providerId));
		expect(ids(hasKey).has("anthropic")).toBe(true);
		expect(ids((name) => name !== "claude").has("anthropic")).toBe(false);
		expect(ids((name) => name !== "claude").has("openrouter")).toBe(true);
		expect(ids((name) => name !== "claude", "anthropic").has("anthropic")).toBe(true);
	});

	test("the provider list marks missing and absent keys differently", () => {
		const current = settings();
		current.providers.anthropic.apiKeySecretName = "claude";
		current.providers.openrouter.apiKeySecretName = "router";
		const listing = formatProviderListing("openai", current, (name) => name === "router");
		expect(listing).toMatch(/openai\s+OpenAI \(no API key set\)/);
		expect(listing).toMatch(/anthropic\s+Anthropic Claude \(key not stored on this device\)/);
		expect(listing).toMatch(/openrouter\s+OpenRouter\n/);
		expect(listing).toMatch(/openai-compatible\s+Local or self-hosted\n/);
		expect(formatProviderListing("openai", current)).not.toContain("not stored");
	});
});

describe("ModelPickerModal", () => {
	const choices: ModelChoice[] = [
		{ providerId: "openai", providerName: "OpenAI", model: "gpt-5.5" },
		{ providerId: "anthropic", providerName: "Anthropic Claude", model: "claude-sonnet-5-5" }
	];

	function open(onChoose: (choice: ModelChoice) => void = () => undefined) {
		// The class extends the shared fake at runtime, which also offers the helpers used below.
		const modal = new ModelPickerModal({} as App, choices, { providerId: "openai", model: "gpt-5.5" }, onChoose) as unknown as FakeFuzzySuggestModal<ModelChoice>;
		modal.open();
		return modal;
	}

	test("lists every choice and filters by what is typed, without the current marker in the searchable text", async () => {
		const modal = open();
		expect(modal.getItemText(choices[0])).toBe("OpenAI: gpt-5.5");
		expect((await modal.suggestionsFor("")).map((match) => match.item.model)).toEqual(["gpt-5.5", "claude-sonnet-5-5"]);
		expect((await modal.suggestionsFor("claude")).map((match) => match.item.model)).toEqual(["claude-sonnet-5-5"]);
		expect((await modal.suggestionsFor("current")).map((match) => match.item.model)).toEqual([]);
		modal.close();
	});

	test("marks the current choice when it is drawn", async () => {
		const modal = open();
		const [current, other] = await modal.suggestionsFor("");
		const currentEl = createFakeEl("div");
		const otherEl = createFakeEl("div");
		modal.renderSuggestion(current, currentEl);
		modal.renderSuggestion(other, otherEl);
		expect(currentEl.textContent).toBe("OpenAI: gpt-5.5 (current)");
		expect(otherEl.textContent).toBe("Anthropic Claude: claude-sonnet-5-5");
		modal.close();
	});

	test("explains an empty list and gives keyboard instructions", () => {
		const modal = open();
		expect(modal.emptyStateText).toContain("/model <id>!");
		expect(modal.instructions.map((entry) => entry.purpose)).toEqual(["to navigate", "to switch", "to dismiss"]);
		modal.close();
	});

	test("choosing a row reports the choice", () => {
		const chosen: ModelChoice[] = [];
		const modal = open((choice) => chosen.push(choice));
		modal.onChooseSuggestion({ item: choices[1], match: { score: 0, matches: [] } }, createFakeMouseEvent("click"));
		expect(chosen).toEqual([choices[1]]);
		modal.close();
	});
});
