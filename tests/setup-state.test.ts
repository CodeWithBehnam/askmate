import { describe, expect, test } from "bun:test";
import { DEFAULT_SETTINGS } from "../src/settings/defaults";
import { validateAzureOpenAIBaseUrl } from "../src/settings/normalize";
import type { AskMateSettings, ProviderSettings, TextProviderId } from "../src/shared/types";
import {
	ASSUME_SECRET_PRESENT,
	deriveProviderSetupState,
	deriveSetupState,
	describeSetupStage,
	isReadyToSend,
	listSetupIssues,
	mapProviderErrorToSetupCopy,
	providerKeyIssue,
	type SetupTestState
} from "../src/setup";

function settingsFor(providerId: TextProviderId, patch: Partial<ProviderSettings> = {}): AskMateSettings {
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.providerRoles.chatProviderId = providerId;
	settings.selectedTextProvider = providerId;
	settings.providers[providerId] = { ...settings.providers[providerId], ...patch };
	return settings;
}

const hasKey = (): boolean => true;
const hasNoKey = (): boolean => false;

describe("deriveSetupState", () => {
	test("a fresh install needs a key", () => {
		const stage = deriveSetupState(structuredClone(DEFAULT_SETTINGS), hasKey);
		expect(stage.kind).toBe("needs-key");
		expect(stage.label).toBe("OpenAI");
		expect(isReadyToSend(stage)).toBe(false);
	});

	test("a saved key name with a stored value is untested until a test passes", () => {
		const settings = settingsFor("openai", { apiKeySecretName: "askmate-openai-key" });
		const stage = deriveSetupState(settings, hasKey);
		expect(stage.kind).toBe("untested");
		expect(isReadyToSend(stage)).toBe(true);
		expect(stage.model).toBe("gpt-5.5");
	});

	test("a saved key name whose secret is absent on this device is key-missing", () => {
		const settings = settingsFor("openai", { apiKeySecretName: "askmate-openai-key" });
		const seen: string[] = [];
		const stage = deriveSetupState(settings, (name) => {
			seen.push(name);
			return false;
		});
		expect(stage.kind).toBe("key-missing");
		expect(seen).toEqual(["askmate-openai-key"]);
		expect(isReadyToSend(stage)).toBe(false);
	});

	test("without a predicate a saved name is assumed to have a value, as before", () => {
		const settings = settingsFor("anthropic", { apiKeySecretName: "k" });
		expect(deriveSetupState(settings).kind).toBe("untested");
		expect(ASSUME_SECRET_PRESENT("anything")).toBe(true);
	});

	test("local providers need no key but do need an address", () => {
		expect(deriveSetupState(settingsFor("openai-compatible"), hasNoKey).kind).toBe("untested");
		const stage = deriveSetupState(settingsFor("openai-compatible", { baseUrl: " " }), hasNoKey);
		expect(stage.kind).toBe("needs-endpoint");
		expect(stage.kind === "needs-endpoint" ? stage.issues[0]?.message : "").toBe("Set the local or self-hosted base URL.");
	});

	test("Azure OpenAI reports every gap in a stable order and needs a valid address", () => {
		const issues = listSetupIssues("azure-openai", settingsFor("azure-openai"), hasKey);
		expect(issues.map((issue) => issue.kind)).toEqual(["needs-key", "needs-endpoint", "needs-model"]);
		expect(issues.map((issue) => issue.message)).toEqual([
			"Add an API key for Azure OpenAI.",
			"Set the Azure OpenAI base URL.",
			"Enter your Azure OpenAI deployment name."
		]);

		// A path the validator can never complete, so the fixture does not depend on whether a bare resource address is accepted.
		const wrongSuffix = settingsFor("azure-openai", { apiKeySecretName: "k", baseUrl: "https://example.openai.azure.com/openai", model: "deploy" });
		const stage = deriveSetupState(wrongSuffix, hasKey);
		expect(stage.kind).toBe("needs-endpoint");
		expect(stage.kind === "needs-endpoint" ? stage.issues[0]?.message : "").toContain("/openai/v1");

		const complete = settingsFor("azure-openai", { apiKeySecretName: "k", baseUrl: "https://example.openai.azure.com/openai/v1", model: "deploy" });
		expect(deriveSetupState(complete, hasKey).kind).toBe("untested");
	});

	test("a bare Azure OpenAI resource address is judged by the provider's own validator, whichever way it rules", () => {
		const bare = "https://example.openai.azure.com";
		const accepted = (() => {
			try {
				validateAzureOpenAIBaseUrl(bare, "");
				return true;
			} catch {
				return false;
			}
		})();
		const stage = deriveSetupState(settingsFor("azure-openai", { apiKeySecretName: "k", baseUrl: bare, model: "deploy" }), hasKey);
		expect(stage.kind).toBe(accepted ? "untested" : "needs-endpoint");
	});

	test("Azure AI Foundry needs an endpoint but keeps its default model", () => {
		const stage = deriveSetupState(settingsFor("azure-ai", { apiKeySecretName: "k" }), hasKey);
		expect(stage.kind).toBe("needs-endpoint");
		expect(stage.model).toBe("mistral-large");
	});

	test("a blank model falls back to the provider default", () => {
		const stage = deriveSetupState(settingsFor("google-gemini", { apiKeySecretName: "k", model: "  " }), hasKey);
		expect(stage.kind).toBe("untested");
		expect(stage.model).toBe("gemini-2.5-pro");
	});

	test("the chat provider comes from the provider roles, not the legacy selection", () => {
		const settings = settingsFor("anthropic", { apiKeySecretName: "k" });
		settings.selectedTextProvider = "openai";
		expect(deriveSetupState(settings, hasKey).providerId).toBe("anthropic");
	});

	test("a missing providers object falls back to the defaults", () => {
		const settings = structuredClone(DEFAULT_SETTINGS);
		Reflect.deleteProperty(settings, "providers");
		expect(deriveSetupState(settings, hasKey).kind).toBe("needs-key");
	});
});

describe("test results", () => {
	const settings = settingsFor("openai", { apiKeySecretName: "k" });
	const copy = mapProviderErrorToSetupCopy(new Error("OpenAI authentication failed. Check the API key secret in AskMate settings."), { providerId: "openai" });

	test("testing, ok and failed apply to the provider and model they ran for", () => {
		const testing: SetupTestState = { status: "testing", providerId: "openai", model: "gpt-5.5" };
		const ok: SetupTestState = { status: "ok", providerId: "openai", model: "gpt-5.5" };
		const failed: SetupTestState = { status: "failed", providerId: "openai", model: "gpt-5.5", copy };
		expect(deriveSetupState(settings, hasKey, testing).kind).toBe("testing");
		expect(deriveSetupState(settings, hasKey, ok).kind).toBe("ready");
		const stage = deriveSetupState(settings, hasKey, failed);
		expect(stage.kind).toBe("test-failed");
		expect(stage.kind === "test-failed" ? stage.copy.category : "").toBe("auth");
		expect(isReadyToSend(stage)).toBe(true);
	});

	test("a result for another model or provider is ignored", () => {
		const otherModel: SetupTestState = { status: "ok", providerId: "openai", model: "gpt-4.1" };
		const otherProvider: SetupTestState = { status: "ok", providerId: "anthropic", model: "gpt-5.5" };
		expect(deriveSetupState(settings, hasKey, otherModel).kind).toBe("untested");
		expect(deriveSetupState(settings, hasKey, otherProvider).kind).toBe("untested");
	});

	test("a missing key outranks any test result", () => {
		const ok: SetupTestState = { status: "ok", providerId: "openai", model: "gpt-5.5" };
		expect(deriveSetupState(settings, hasNoKey, ok).kind).toBe("key-missing");
	});
});

describe("providerKeyIssue", () => {
	test("distinguishes no name, name without value, and present", () => {
		expect(providerKeyIssue("openai", settingsFor("openai"), hasKey)).toBe("needs-key");
		expect(providerKeyIssue("openai", settingsFor("openai", { apiKeySecretName: "k" }), hasNoKey)).toBe("key-missing");
		expect(providerKeyIssue("openai", settingsFor("openai", { apiKeySecretName: "k" }), hasKey)).toBeNull();
		expect(providerKeyIssue("openai-compatible", settingsFor("openai-compatible"), hasNoKey)).toBeNull();
	});

	test("evaluates a provider other than the chat provider", () => {
		const settings = settingsFor("openai");
		settings.providers.anthropic.apiKeySecretName = "claude";
		expect(deriveProviderSetupState("anthropic", settings, hasKey).kind).toBe("untested");
	});
});

describe("describeSetupStage", () => {
	test("every stage has a headline, a tone and, where something must be done, one action", () => {
		const base = settingsFor("openai");
		const copy = mapProviderErrorToSetupCopy(new Error("HTTP 429"), { providerId: "openai" });
		const stages = [
			deriveSetupState(base, hasKey),
			deriveSetupState(settingsFor("openai", { apiKeySecretName: "k" }), hasNoKey),
			deriveSetupState(settingsFor("openai-compatible", { baseUrl: "" }), hasNoKey),
			deriveSetupState(settingsFor("azure-openai", { apiKeySecretName: "k", baseUrl: "https://a.openai.azure.com/openai/v1" }), hasKey),
			deriveSetupState(settingsFor("openai", { apiKeySecretName: "k" }), hasKey),
			deriveSetupState(settingsFor("openai", { apiKeySecretName: "k" }), hasKey, { status: "testing", providerId: "openai", model: "gpt-5.5" }),
			deriveSetupState(settingsFor("openai", { apiKeySecretName: "k" }), hasKey, { status: "failed", providerId: "openai", model: "gpt-5.5", copy }),
			deriveSetupState(settingsFor("openai", { apiKeySecretName: "k" }), hasKey, { status: "ok", providerId: "openai", model: "gpt-5.5" })
		];
		expect(stages.map((stage) => stage.kind)).toEqual(["needs-key", "key-missing", "needs-endpoint", "needs-model", "untested", "testing", "test-failed", "ready"]);
		const copies = stages.map(describeSetupStage);
		expect(copies.map((entry) => entry.tone)).toEqual(["warning", "warning", "warning", "warning", "ok", "busy", "error", "ok"]);
		expect(copies.every((entry) => entry.headline.length > 0)).toBe(true);
		expect(copies.map((entry) => entry.action?.kind ?? null)).toEqual(["update-key", "update-key", "check-address", "choose-model", "test", null, "retry", null]);
		expect(copies[6]?.headline).toBe(copy.message);
	});
});
