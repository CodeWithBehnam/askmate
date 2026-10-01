import { describe, expect, test } from "bun:test";
import { DEFAULT_SETTINGS } from "../src/settings/defaults";
import { formatTokenCount } from "../src/settings/normalize";
import type { AskMateSettings, CustomWorkflow, ProviderSettings, TextProviderId } from "../src/shared/types";
import {
	getUsageGuardrailStatus,
	pluralise,
	summarizeContextSources,
	summarizeOutputApply,
	summarizeProviderSetup,
	summarizeRequestDefaults,
	summarizeUsageGuardrails,
	summarizeWorkflows
} from "../src/ui/settings/settingsSummaries";

function makeSettings(overrides: Partial<AskMateSettings> = {}): AskMateSettings {
	return { ...structuredClone(DEFAULT_SETTINGS), ...overrides };
}

function makeProviderSettings(providerId: TextProviderId, patch: Partial<ProviderSettings> = {}): AskMateSettings {
	const settings = makeSettings();
	settings.providerRoles.chatProviderId = providerId;
	settings.providers[providerId] = { ...settings.providers[providerId], ...patch };
	return settings;
}

function makeWorkflow(id: string): CustomWorkflow {
	return {
		id,
		name: id,
		shortName: id,
		description: "",
		icon: "sparkles",
		accent: "blue",
		prompt: "Do the thing.",
		resultNoteTemplate: "",
		hidden: false,
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z"
	};
}

describe("pluralise", () => {
	test("uses the singular for exactly one", () => {
		expect(pluralise(1, "workflow")).toBe("1 workflow");
	});

	test("adds an s for zero and for more than one", () => {
		expect(pluralise(0, "workflow")).toBe("0 workflows");
		expect(pluralise(2, "workflow")).toBe("2 workflows");
	});

	test("respects an explicit plural", () => {
		expect(pluralise(1, "index", "indices")).toBe("1 index");
		expect(pluralise(3, "index", "indices")).toBe("3 indices");
	});

	test("formats large counts with UK thousands separators", () => {
		expect(pluralise(1234, "token")).toBe("1,234 tokens");
	});
});

describe("summarizeProviderSetup", () => {
	test("shows the default provider and model, and warns that it has no API key", () => {
		const summary = summarizeProviderSetup(makeSettings());
		expect(summary.displayValue).toBe("OpenAI · setup needed");
		expect(summary.issues).toEqual(["Add an API key for OpenAI."]);
		expect(summary.status).toBe("warning");
	});

	test("is clear of warnings once the API key secret is named", () => {
		const summary = summarizeProviderSetup(makeProviderSettings("openai", { apiKeySecretName: "openai-key" }));
		expect(summary.displayValue).toBe("OpenAI · gpt-5.5");
		expect(summary.issues).toEqual([]);
		expect(summary.status).toBeNull();
	});

	test("treats a whitespace-only secret name as missing", () => {
		const summary = summarizeProviderSetup(makeProviderSettings("anthropic", { apiKeySecretName: "   " }));
		expect(summary.issues).toEqual(["Add an API key for Anthropic Claude."]);
	});

	test("resolves the chat provider from provider roles, not the legacy selection", () => {
		const settings = makeProviderSettings("anthropic", { apiKeySecretName: "claude-key" });
		settings.selectedTextProvider = "openai";
		expect(summarizeProviderSetup(settings).displayValue).toBe("Anthropic Claude · claude-sonnet-5-5");
	});

	test("falls back to the legacy selection when no chat role is stored", () => {
		const settings = makeSettings({ selectedTextProvider: "openrouter" });
		Reflect.deleteProperty(settings, "providerRoles");
		settings.providers.openrouter.apiKeySecretName = "key";
		expect(summarizeProviderSetup(settings).displayValue).toBe("OpenRouter · openai/gpt-5.5");
	});

	test("falls back to the provider default model when the model is blank", () => {
		const summary = summarizeProviderSetup(makeProviderSettings("google-gemini", { apiKeySecretName: "key", model: "  " }));
		expect(summary.displayValue).toBe("Google Gemini · gemini-2.5-pro");
		expect(summary.issues).toEqual([]);
	});

	test("shows a custom model", () => {
		const summary = summarizeProviderSetup(makeProviderSettings("openai", { apiKeySecretName: "key", model: " gpt-custom " }));
		expect(summary.displayValue).toBe("OpenAI · gpt-custom");
	});

	test("does not ask local or self-hosted providers for an API key", () => {
		const summary = summarizeProviderSetup(makeProviderSettings("openai-compatible"));
		expect(summary.displayValue).toBe("Local or self-hosted · llama3.1");
		expect(summary.issues).toEqual([]);
		expect(summary.status).toBeNull();
	});

	test("asks for a base URL when a local provider has none", () => {
		const summary = summarizeProviderSetup(makeProviderSettings("openai-compatible", { baseUrl: " " }));
		expect(summary.displayValue).toBe("Local or self-hosted · setup needed");
		expect(summary.issues).toEqual(["Set the local or self-hosted base URL."]);
		expect(summary.status).toBe("warning");
	});

	test("calls the Azure AI address an endpoint", () => {
		const summary = summarizeProviderSetup(makeProviderSettings("azure-ai", { apiKeySecretName: "key" }));
		expect(summary.displayValue).toBe("Azure AI Foundry · setup needed");
		expect(summary.issues).toEqual(["Set the Azure AI Foundry endpoint."]);
	});

	test("reports every Azure OpenAI gap in a stable order", () => {
		const summary = summarizeProviderSetup(makeProviderSettings("azure-openai"));
		expect(summary.displayValue).toBe("Azure OpenAI · setup needed");
		expect(summary.issues).toEqual([
			"Add an API key for Azure OpenAI.",
			"Set the Azure OpenAI base URL.",
			"Enter your Azure OpenAI deployment name."
		]);
		expect(summary.status).toBe("warning");
	});

	test("accepts a fully configured Azure OpenAI deployment", () => {
		const summary = summarizeProviderSetup(makeProviderSettings("azure-openai", {
			apiKeySecretName: "azure-key",
			baseUrl: "https://example.openai.azure.com",
			model: "my-deployment"
		}));
		expect(summary.displayValue).toBe("Azure OpenAI · my-deployment");
		expect(summary.issues).toEqual([]);
		expect(summary.status).toBeNull();
	});

	test("does not ask built-in endpoint providers for a base URL", () => {
		const summary = summarizeProviderSetup(makeProviderSettings("openrouter", { apiKeySecretName: "key", baseUrl: "" }));
		expect(summary.issues).toEqual([]);
	});

	test("falls back to default provider settings when the provider entry is missing", () => {
		const settings = makeSettings();
		Reflect.deleteProperty(settings, "providers");
		expect(summarizeProviderSetup(settings).displayValue).toBe("OpenAI · setup needed");
		expect(summarizeProviderSetup(settings).issues).toEqual(["Add an API key for OpenAI."]);
	});
});

describe("summarizeRequestDefaults", () => {
	test("combines layout and output labels", () => {
		expect(summarizeRequestDefaults(makeSettings({ composerLayout: "console", outputMode: "chat" }))).toBe("Console layout · Sidebar chat");
		expect(summarizeRequestDefaults(makeSettings({ composerLayout: "compact", outputMode: "note" }))).toBe("Compact layout · New note");
		expect(summarizeRequestDefaults(makeSettings({ composerLayout: "expanded", outputMode: "apply" }))).toBe("Expanded layout · Apply to note");
	});

	test("says when new requests leave out the note", () => {
		const settings = makeSettings({ composerLayout: "console", outputMode: "chat" });
		settings.requestPrivacyDefaults.includeNoteContext = false;
		expect(summarizeRequestDefaults(settings)).toBe("Console layout · Sidebar chat · Note context off");
	});
});

describe("summarizeContextSources", () => {
	// Evidence-linked answers are on by default, so each test starts from an explicit all-off baseline.
	const noExtraSources: Partial<AskMateSettings> = {
		threadedChatEnabled: false,
		additionalContextPaths: [],
		folderContextEnabled: false,
		includeExcalidrawSummaries: false,
		includeImageManifests: false,
		evidenceLinkedAnswersEnabled: false,
		noteHistoryIncludeInContext: false,
		includeStyleGuideContext: false,
		includeGlossaryContext: false
	};

	test("says the note alone is sent when no optional source is on", () => {
		expect(summarizeContextSources(makeSettings(noExtraSources))).toBe("Note only");
	});

	test("uses the singular for one extra source", () => {
		const settings = makeSettings({ ...noExtraSources, folderContextEnabled: true, folderContextPath: "Projects" });
		expect(summarizeContextSources(settings)).toBe("Note + 1 extra source");
	});

	test("does not count sources that would attach nothing", () => {
		const settings = makeSettings({
			...noExtraSources,
			folderContextEnabled: true,
			folderContextPath: " ",
			includeStyleGuideContext: true,
			styleGuideContextPath: "",
			includeGlossaryContext: true,
			glossaryContextPath: "",
			noteHistoryEnabled: false,
			noteHistoryIncludeInContext: true,
			includeImageManifests: true
		});
		settings.requestPrivacyDefaults.includeImageReferences = false;
		expect(summarizeContextSources(settings)).toBe("Note only");
	});

	test("says when the note itself is left out by default", () => {
		const settings = makeSettings(noExtraSources);
		settings.requestPrivacyDefaults.includeNoteContext = false;
		expect(summarizeContextSources(settings)).toBe("No note context");
		settings.threadedChatEnabled = true;
		expect(summarizeContextSources(settings)).toBe("No note context · 1 extra source");
	});

	test("counts additional context paths as one source however many paths there are", () => {
		const settings = makeSettings({ ...noExtraSources, additionalContextPaths: ["Notes/A.md", "Notes/B.md"] });
		expect(summarizeContextSources(settings)).toBe("Note + 1 extra source");
	});

	test("counts every optional source when all are on", () => {
		const settings = makeSettings({
			threadedChatEnabled: true,
			additionalContextPaths: ["Notes/A.md"],
			folderContextEnabled: true,
			folderContextPath: "Projects",
			includeExcalidrawSummaries: true,
			includeImageManifests: true,
			evidenceLinkedAnswersEnabled: true,
			noteHistoryEnabled: true,
			noteHistoryIncludeInContext: true,
			includeStyleGuideContext: true,
			styleGuideContextPath: "Style.md",
			includeGlossaryContext: true,
			glossaryContextPath: "Glossary.md"
		});
		settings.requestPrivacyDefaults.includeImageReferences = true;
		expect(summarizeContextSources(settings)).toBe("Note + 9 extra sources");
	});
});

describe("summarizeOutputApply", () => {
	test("labels each approval mode", () => {
		expect(summarizeOutputApply(makeSettings({ applyApprovalMode: "auto-approve" }), 0)).toBe("Auto approve");
		expect(summarizeOutputApply(makeSettings({ applyApprovalMode: "full" }), 0)).toBe("Full approval");
		expect(summarizeOutputApply(makeSettings({ applyApprovalMode: "manual" }), 0)).toBe("Manual approval");
	});

	test("adds the pending review count only when there is one", () => {
		const settings = makeSettings({ applyApprovalMode: "manual" });
		expect(summarizeOutputApply(settings, 1)).toBe("Manual approval · 1 pending review");
		expect(summarizeOutputApply(settings, 3)).toBe("Manual approval · 3 pending reviews");
	});
});

describe("summarizeWorkflows", () => {
	test("covers none, one and many custom workflows", () => {
		expect(summarizeWorkflows(makeSettings({ customWorkflows: [] }))).toBe("No custom workflows");
		expect(summarizeWorkflows(makeSettings({ customWorkflows: [makeWorkflow("a")] }))).toBe("1 custom workflow");
		expect(summarizeWorkflows(makeSettings({ customWorkflows: [makeWorkflow("a"), makeWorkflow("b")] }))).toBe("2 custom workflows");
	});
});

describe("summarizeUsageGuardrails", () => {
	test("says guardrails are off whatever the budgets are", () => {
		const settings = makeSettings({ usageGuardrailsEnabled: false, usageDailyTokenBudget: 1000 });
		expect(summarizeUsageGuardrails(settings, 500)).toBe("Guardrails off");
	});

	test("shows warn mode with today's usage and no budget", () => {
		const settings = makeSettings({ usageGuardrailsEnabled: true, usageBudgetEnforcement: "warn", usageDailyTokenBudget: 0 });
		expect(summarizeUsageGuardrails(settings, 500)).toBe("Warn · 500 tokens today");
	});

	test("shows block mode against a daily budget", () => {
		const settings = makeSettings({ usageGuardrailsEnabled: true, usageBudgetEnforcement: "block", usageDailyTokenBudget: 800 });
		expect(summarizeUsageGuardrails(settings, 250)).toBe("Block · 250 of 800 tokens today");
	});

	test("formats large counts with the shared token formatter", () => {
		const settings = makeSettings({ usageGuardrailsEnabled: true, usageBudgetEnforcement: "warn", usageDailyTokenBudget: 200000 });
		expect(summarizeUsageGuardrails(settings, 12345)).toBe(`Warn · ${formatTokenCount(12345)} of ${formatTokenCount(200000)} tokens today`);
	});

	test("says in words when a daily or monthly budget is used up", () => {
		const settings = makeSettings({ usageGuardrailsEnabled: true, usageBudgetEnforcement: "warn", usageDailyTokenBudget: 800, usageMonthlyTokenBudget: 900 });
		expect(summarizeUsageGuardrails(settings, 800)).toBe("Warn · 800 of 800 tokens today · over budget");
		expect(summarizeUsageGuardrails(settings, 10, 900)).toBe("Warn · 10 of 800 tokens today · over budget");
		expect(summarizeUsageGuardrails(settings, 10, 899)).toBe("Warn · 10 of 800 tokens today");
	});
});

describe("getUsageGuardrailStatus", () => {
	const guarded = makeSettings({ usageGuardrailsEnabled: true, usageDailyTokenBudget: 1000, usageMonthlyTokenBudget: 5000 });

	test("is null when guardrails are off, even over budget", () => {
		const off = makeSettings({ usageGuardrailsEnabled: false, usageDailyTokenBudget: 1000, usageMonthlyTokenBudget: 5000 });
		expect(getUsageGuardrailStatus(off, 9999, 99999)).toBeNull();
	});

	test("is null while both budgets have headroom", () => {
		expect(getUsageGuardrailStatus(guarded, 999, 4999)).toBeNull();
	});

	test("warns when today reaches the daily budget", () => {
		expect(getUsageGuardrailStatus(guarded, 1000, 1000)).toBe("warning");
	});

	test("warns when the month reaches the monthly budget", () => {
		expect(getUsageGuardrailStatus(guarded, 10, 5000)).toBe("warning");
	});

	test("ignores a budget of 0, which means no limit", () => {
		const unlimited = makeSettings({ usageGuardrailsEnabled: true, usageDailyTokenBudget: 0, usageMonthlyTokenBudget: 0 });
		expect(getUsageGuardrailStatus(unlimited, 9999, 99999)).toBeNull();
	});

	test("checks each budget independently", () => {
		const dailyOnly = makeSettings({ usageGuardrailsEnabled: true, usageDailyTokenBudget: 1000, usageMonthlyTokenBudget: 0 });
		expect(getUsageGuardrailStatus(dailyOnly, 10, 99999)).toBeNull();
		expect(getUsageGuardrailStatus(dailyOnly, 1000, 0)).toBe("warning");
	});
});
