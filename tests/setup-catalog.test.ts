import { describe, expect, test } from "bun:test";
import { DEFAULT_PROVIDER_SETTINGS, TEXT_PROVIDER_IDS, TEXT_PROVIDER_LABELS } from "../src/settings/constants";
import {
	FIRST_RUN_NOTICE,
	NO_NOTE_CHIP_REASON,
	PROVIDER_CATALOG,
	buildSecretId,
	checkApiKeyInput,
	deriveSetupState,
	getProviderCatalogEntry,
	isFirstRun,
	listSetupCardProviders,
	planConnect,
	shouldShowFirstRunNotice,
	starterChipsFor
} from "../src/setup";
import { DEFAULT_SETTINGS } from "../src/settings/defaults";

describe("provider catalogue", () => {
	test("covers every text provider with the labels and default models from the settings constants", () => {
		expect(PROVIDER_CATALOG.map((entry) => entry.id)).toEqual(TEXT_PROVIDER_IDS);
		for (const entry of PROVIDER_CATALOG) {
			expect(entry.label).toBe(TEXT_PROVIDER_LABELS[entry.id]);
			expect(entry.defaultModel).toBe(DEFAULT_PROVIDER_SETTINGS[entry.id].model);
		}
	});

	test("key pages are https URLs, and only the local provider has none", () => {
		for (const entry of PROVIDER_CATALOG) {
			if (entry.needsKey) {
				expect(entry.keyUrl?.startsWith("https://")).toBe(true);
			} else {
				expect(entry.keyUrl).toBeNull();
			}
		}
		expect(getProviderCatalogEntry("openai").keyUrl).toBe("https://platform.openai.com/api-keys");
		expect(getProviderCatalogEntry("anthropic").keyUrl).toBe("https://platform.claude.com/settings/keys");
		expect(getProviderCatalogEntry("google-gemini").keyUrl).toBe("https://aistudio.google.com/apikey");
	});

	test("the Connect card offers OpenAI, Anthropic, Gemini and Local, in that order", () => {
		expect(listSetupCardProviders().map((entry) => entry.chipLabel)).toEqual(["OpenAI", "Anthropic", "Gemini", "Local"]);
	});

	test("the local provider needs an address, not a key, and prefills the Ollama address", () => {
		const local = getProviderCatalogEntry("openai-compatible");
		expect(local.needsKey).toBe(false);
		expect(local.needsEndpoint).toBe(true);
		expect(local.defaultBaseUrl).toBe("http://localhost:11434/v1");
	});
});

describe("secret IDs and key input", () => {
	test("generated IDs are valid Obsidian secret IDs and never clash", () => {
		expect(buildSecretId("openai", [])).toBe("askmate-openai-key");
		expect(buildSecretId("openai", ["askmate-openai-key"])).toBe("askmate-openai-key-2");
		expect(buildSecretId("openai", ["askmate-openai-key", "askmate-openai-key-2"])).toBe("askmate-openai-key-3");
		for (const id of TEXT_PROVIDER_IDS) {
			expect(buildSecretId(id, [])).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
		}
	});

	test("trims and unquotes a pasted key", () => {
		expect(checkApiKeyInput('  "sk-test-1234567890"\n')).toEqual({ ok: true, key: "sk-test-1234567890" });
	});

	test("rejects empty, multi-part and very short input", () => {
		expect(checkApiKeyInput("   ").ok).toBe(false);
		expect(checkApiKeyInput("sk-one sk-two").ok).toBe(false);
		expect(checkApiKeyInput("sk-1\nsk-2").ok).toBe(false);
		expect(checkApiKeyInput("abc").ok).toBe(false);
	});

	test("planConnect stores the key under a fresh ID and points the provider at it", () => {
		const result = planConnect("anthropic", " sk-ant-abcdefgh ", ["askmate-anthropic-key"]);
		expect(result).toEqual({
			ok: true,
			plan: {
				providerId: "anthropic",
				secretId: "askmate-anthropic-key-2",
				secret: "sk-ant-abcdefgh",
				settingsPatch: { apiKeySecretName: "askmate-anthropic-key-2" }
			}
		});
	});

	test("planConnect refuses a provider that needs no key and bad input", () => {
		expect(planConnect("openai-compatible", "abcdefghij", []).ok).toBe(false);
		expect(planConnect("openai", "", []).ok).toBe(false);
	});
});

describe("starter chips", () => {
	test("three chips, enabled when a note is open", () => {
		const chips = starterChipsFor(true);
		expect(chips.map((chip) => chip.label)).toEqual(["Summarise this note", "Make a diagram", "Find gaps"]);
		expect(chips.every((chip) => !chip.disabled && chip.disabledReason === null)).toBe(true);
		expect(chips[0]?.action).toMatchObject({ kind: "workflow", workflowId: "study-summary" });
		expect(chips[1]?.action).toEqual({ kind: "diagram" });
		expect(chips[2]?.action.kind).toBe("prompt");
	});

	test("every chip is disabled with a stated reason when no note is open", () => {
		const chips = starterChipsFor(false);
		expect(chips.every((chip) => chip.disabled && chip.disabledReason === NO_NOTE_CHIP_REASON)).toBe(true);
	});

	test("the chip ids are stable", () => {
		expect(starterChipsFor(true).map((chip) => chip.id)).toEqual(["summarise", "diagram", "gaps"]);
	});
});

describe("first run", () => {
	test("only a missing data.json is a first run", () => {
		expect(isFirstRun(null)).toBe(true);
		expect(isFirstRun(undefined)).toBe(true);
		expect(isFirstRun({})).toBe(false);
		expect(isFirstRun({ model: "gpt-5.5" })).toBe(false);
		expect(isFirstRun("")).toBe(false);
	});

	test("the notice shows on a fresh, unconnected install that was not dismissed", () => {
		const stage = deriveSetupState(structuredClone(DEFAULT_SETTINGS));
		expect(shouldShowFirstRunNotice({ firstRun: true, settings: {}, stage })).toBe(true);
		expect(shouldShowFirstRunNotice({ firstRun: false, settings: {}, stage })).toBe(false);
		expect(shouldShowFirstRunNotice({ firstRun: true, settings: { firstRunCompletedAt: "2026-10-12T09:00:00.000Z" }, stage })).toBe(false);
	});

	test("the notice stays quiet once a provider is connected", () => {
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.providers.openai.apiKeySecretName = "k";
		expect(shouldShowFirstRunNotice({ firstRun: true, settings: {}, stage: deriveSetupState(settings) })).toBe(false);
	});

	test("the notice copy is fixed", () => {
		expect(FIRST_RUN_NOTICE.message).toBe("AskMate is installed. Connect an AI provider to start.");
		expect(FIRST_RUN_NOTICE.actionLabel).toBe("Set up");
	});
});
