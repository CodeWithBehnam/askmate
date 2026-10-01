import { describe, expect, test } from "bun:test";
import { DEFAULT_SETTINGS } from "../src/settings/defaults";
import {
	buildTranslatePreservePrompt,
	capReviewQueueItems,
	isLocalNetworkHost,
	normalizeAskMateSettings,
	normalizeBoundedInteger,
	normalizeContextPathList,
	normalizeCustomWorkflows,
	normalizeReviewQueueItems,
	normalizeTokenUsageStats,
	normalizeTranslationTargetLanguage,
	normalizeUsageTotalsByDay,
	validateProviderBaseUrl
} from "../src/settings/normalize";
import type { AskMateSettings, ReviewQueueItem, ReviewQueueStatus } from "../src/shared/types";

function load(raw: Record<string, unknown>): AskMateSettings {
	return normalizeAskMateSettings(raw as Partial<AskMateSettings>, "load");
}

function queueItem(id: string, minute: number, status: ReviewQueueStatus): ReviewQueueItem {
	return {
		id,
		createdAt: new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString(),
		updatedAt: new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString(),
		status,
		sourcePath: "Note.md",
		title: "Review",
		question: "",
		proposedText: "text",
		beforeText: "",
		scope: "append",
		headingPath: "",
		selectionIdentity: null,
		providerName: "OpenAI",
		model: "gpt-5.5",
		workflowId: null,
		workflowName: null
	};
}

describe("legacy settings migration", () => {
	test("a legacy selectedTextProvider survives when providerRoles was never saved", () => {
		const settings = load({ selectedTextProvider: "anthropic" });
		expect(settings.providerRoles.chatProviderId).toBe("anthropic");
		expect(settings.selectedTextProvider).toBe("anthropic");
	});

	test("legacy OpenAI key name and model move into providers.openai", () => {
		const settings = load({ openAiApiKeySecretName: "my-key", model: "gpt-4.1" });
		expect(settings.providers.openai.apiKeySecretName).toBe("my-key");
		expect(settings.providers.openai.model).toBe("gpt-4.1");
	});

	test("saved providers win over legacy fields", () => {
		const settings = load({
			openAiApiKeySecretName: "old",
			providers: { openai: { apiKeySecretName: "new", model: "gpt-5.5", modelOptions: [], baseUrl: "" } }
		});
		expect(settings.providers.openai.apiKeySecretName).toBe("new");
	});

	test("retired Claude models are migrated to the current default", () => {
		const settings = load({
			providers: {
				anthropic: {
					apiKeySecretName: "claude",
					model: "claude-3-5-sonnet-latest",
					modelOptions: ["claude-3-5-sonnet-latest", "claude-3-5-haiku-latest", "my-custom-model"],
					baseUrl: ""
				}
			}
		});
		expect(settings.providers.anthropic.model).toBe("claude-sonnet-5-5");
		expect(settings.providers.anthropic.modelOptions).not.toContain("claude-3-5-sonnet-latest");
		expect(settings.providers.anthropic.modelOptions).not.toContain("claude-3-5-haiku-latest");
		expect(settings.providers.anthropic.modelOptions).toContain("my-custom-model");
		expect(settings.providers.anthropic.apiKeySecretName).toBe("claude");
	});

	test("unknown and obsolete keys are dropped, including a plain-text API key", () => {
		const settings = load({ openAiApiKey: "sk-secret", legacyJunk: 1 }) as unknown as Record<string, unknown>;
		expect("openAiApiKey" in settings).toBe(false);
		expect("legacyJunk" in settings).toBe(false);
	});

	test("save normalises the same fields as load", () => {
		const loaded = load({});
		const corrupted = { ...loaded, reasoningEffort: "extreme", sendShortcut: "alt", showOnboardingTips: "no", autoImageIntentEnabled: "yes" };
		const saved = normalizeAskMateSettings(corrupted as unknown as AskMateSettings, "save");
		expect(saved.reasoningEffort).toBe(DEFAULT_SETTINGS.reasoningEffort);
		expect(saved.sendShortcut).toBe(DEFAULT_SETTINGS.sendShortcut);
		expect(saved.showOnboardingTips).toBe(true);
		expect(saved.autoImageIntentEnabled).toBe(true);
	});
});

describe("corrupt values", () => {
	test("a non-string resultFolder falls back to the default and an empty string is kept", () => {
		expect(load({ resultFolder: 42 }).resultFolder).toBe(DEFAULT_SETTINGS.resultFolder);
		expect(load({ resultFolder: null }).resultFolder).toBe(DEFAULT_SETTINGS.resultFolder);
		expect(load({ resultFolder: "" }).resultFolder).toBe("");
		expect(load({ resultFolder: "  Results  " }).resultFolder).toBe("Results");
	});

	test("folder paths with dot segments are rejected", () => {
		expect(load({ resultFolder: "../Outside" }).resultFolder).toBe(DEFAULT_SETTINGS.resultFolder);
		expect(load({ folderContextPath: "Notes/../../x" }).folderContextPath).toBe("");
		expect(load({ batchWorkflowFolderPath: "./Inbox" }).batchWorkflowFolderPath).toBe("");
		expect(load({ folderContextPath: "Notes/2024..review" }).folderContextPath).toBe("Notes/2024..review");
	});

	test.each([
		[null, 12000],
		["", 12000],
		[false, 12000],
		["abc", 12000],
		[Number.NaN, 12000],
		["500", 500],
		[1e12, 10000000],
		[-5, 0]
	])("normalizeBoundedInteger(%p) gives %p", (value: unknown, expected: number) => {
		expect(normalizeBoundedInteger(value, 12000, 0, 10000000)).toBe(expected);
	});

	test("autoImageIntentEnabled defaults to true and keeps an explicit false", () => {
		expect(load({}).autoImageIntentEnabled).toBe(true);
		expect(load({ autoImageIntentEnabled: false }).autoImageIntentEnabled).toBe(false);
		expect(load({ autoImageIntentEnabled: "false" }).autoImageIntentEnabled).toBe(true);
	});

	test("huge token counts stay finite", () => {
		const stats = normalizeTokenUsageStats({
			records: [{ timestamp: "2026-01-01T00:00:00.000Z", inputTokens: 1e308, outputTokens: 1e308 }]
		});
		expect(Number.isFinite(stats.records[0].totalTokens)).toBe(true);
	});
});

describe("collection normalisers", () => {
	test("context paths split on new lines only, so commas in names survive", () => {
		expect(normalizeContextPathList("Notes, 2024.md\n[[Other note|alias]]\n\nNotes, 2024.md")).toEqual(["Notes, 2024.md", "Other note"]);
	});

	test("the review queue cap never evicts pending items", () => {
		const items = [
			queueItem("p1", 1, "pending"),
			queueItem("p2", 2, "pending"),
			queueItem("p3", 3, "pending"),
			...Array.from({ length: 7 }, (_, index) => queueItem(`a${index}`, 10 + index, "applied"))
		];
		const kept = capReviewQueueItems(items, 5);
		expect(kept.filter((item) => item.status === "pending").map((item) => item.id)).toEqual(["p1", "p2", "p3"]);
		expect(kept.filter((item) => item.status === "applied").map((item) => item.id)).toEqual(["a5", "a6"]);
	});

	test("pending items may exceed the cap, and reviewed items are dropped first", () => {
		const items = [queueItem("d1", 1, "dismissed"), ...Array.from({ length: 4 }, (_, index) => queueItem(`p${index}`, 5 + index, "pending"))];
		const kept = normalizeReviewQueueItems(items, 2);
		expect(kept.map((item) => item.id)).toEqual(["p0", "p1", "p2", "p3"]);
	});

	test("custom workflows get stable fallback ids, de-duplicated ids and an output kind", () => {
		const raw = [
			{ name: "Polish", prompt: "Polish it" },
			{ id: "custom-1", name: "A", prompt: "a", outputKind: "note-edit" },
			{ id: "custom-1", name: "B", prompt: "b", outputKind: "bogus" }
		];
		const first = normalizeCustomWorkflows(raw);
		const second = normalizeCustomWorkflows(raw);
		expect(first[0].id).toBe(second[0].id);
		expect(first[0].id.startsWith("custom-")).toBe(true);
		expect(new Set(first.map((workflow) => workflow.id)).size).toBe(3);
		// Legacy workflows without a kind keep the old full-note batch behaviour; only an explicit "new-content" appends.
		expect(first.map((workflow) => workflow.outputKind)).toEqual(["note-edit", "note-edit", "note-edit"]);
		expect(normalizeCustomWorkflows([{ name: "S", prompt: "s", outputKind: "new-content" }])[0].outputKind).toBe("new-content");
	});

	test("usage totals keep valid days only and cap the history", () => {
		const totals = normalizeUsageTotalsByDay({ "2026-01-01": 10, "bad-key": 5, "2026-01-02": -1, "2026-01-03": "7" });
		expect(totals).toEqual({ "2026-01-01": 10 });
		const many = Object.fromEntries(Array.from({ length: 500 }, (_, index) => [new Date(Date.UTC(2025, 0, 1 + index)).toISOString().slice(0, 10), 1]));
		expect(Object.keys(normalizeUsageTotalsByDay(many))).toHaveLength(400);
	});
});

describe("base URL policy", () => {
	test.each(["localhost", "127.0.0.1", "::1", "[::1]", "10.0.0.5", "172.16.0.1", "192.168.1.20", "box.local", "ollama", "homeserver.lan", "host.docker.internal", "nas.home.arpa", "100.101.102.103", "169.254.1.2", "fd12:3456::1", "fe80::1"])("%s counts as local", (host: string) => {
		expect(isLocalNetworkHost(host)).toBe(true);
	});

	test.each(["api.openai.com", "172.32.0.1", "8.8.8.8", "example.localhost.com", "100.128.0.1", "2001:db8::1", "12345"])("%s does not count as local", (host: string) => {
		expect(isLocalNetworkHost(host)).toBe(false);
	});

	test("plain http is rejected for remote hosts and allowed locally", () => {
		expect(() => validateProviderBaseUrl("http://proxy.example.com/v1", "https://api.openai.com/v1", "OpenAI")).toThrow("must use https://");
		expect(validateProviderBaseUrl("http://192.168.1.20:8080/v1/", "", "Local")).toBe("http://192.168.1.20:8080/v1");
		expect(validateProviderBaseUrl("https://api.openai.com/v1", "", "OpenAI")).toBe("https://api.openai.com/v1");
		expect(() => validateProviderBaseUrl("ftp://x", "", "OpenAI")).toThrow("must start with http:// or https://");
	});
});

describe("translation prompt", () => {
	test("braces are stripped from the target language so it cannot become a template placeholder", () => {
		expect(normalizeTranslationTargetLanguage("{{selectedText}}")).toBe("selectedText");
	});

	test("the prompt protects Obsidian syntax and forbids translator notes", () => {
		const prompt = buildTranslatePreservePrompt("French");
		expect(prompt).toContain("\"French\"");
		expect(prompt).toContain("callout type keywords");
		expect(prompt).toContain("Text already in the target language stays unchanged");
		expect(prompt).toContain("no preamble, translator notes, closing remarks or source IDs such as [S1]");
		expect(prompt).not.toContain("{{");
	});
});
