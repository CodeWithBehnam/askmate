import { describe, expect, test } from "bun:test";
import { CURRENT_SETTINGS_VERSION, DEFAULT_PROVIDER_SETTINGS, DEFAULT_TRANSLATION_TARGET_LANGUAGE, RETIRED_ANTHROPIC_MODELS } from "../src/settings/constants";
import { DEFAULT_SETTINGS, defaultTranslationLanguage } from "../src/settings/defaults";
import {
	buildTranslatePreservePrompt,
	capReviewQueueItems,
	isLocalNetworkHost,
	isRetiredAnthropicModel,
	normalizeApplyApprovalMode,
	normalizeAskMateSettings,
	normalizeAskMateSettingsWithDiagnostics,
	normalizeBoundedInteger,
	normalizeComposerLayout,
	normalizeContextPathList,
	normalizeCustomWorkflows,
	normalizeReviewQueueItems,
	normalizeTokenUsageStats,
	normalizeTranslationTargetLanguage,
	normalizeUsageTotalsByDay,
	validateAzureOpenAIBaseUrl,
	validateProviderBaseUrl
} from "../src/settings/normalize";
import type { ApplyApprovalMode, AskMateSettings, ReviewQueueItem, ReviewQueueStatus, TextProviderId } from "../src/shared/types";

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

	test("an explicit denylist of legacy plain-text secret keys is dropped, other unknown keys are kept", () => {
		const settings = load({ openAiApiKey: "sk-secret", apiKey: "sk-other", legacyJunk: 1 }) as unknown as Record<string, unknown>;
		expect("openAiApiKey" in settings).toBe(false);
		expect("apiKey" in settings).toBe(false);
		expect(settings.legacyJunk).toBe(1);
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

	test("streamResponses defaults to true and keeps an explicit false", () => {
		expect(load({}).streamResponses).toBe(true);
		expect(load({ streamResponses: false }).streamResponses).toBe(false);
		expect(load({ streamResponses: "false" }).streamResponses).toBe(true);
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

	test("the tool-derived flag is kept on a pending item only, and only when it is exactly true", () => {
		const flagged = { ...queueItem("p1", 1, "pending"), toolDerived: true };
		const [kept] = normalizeReviewQueueItems([flagged]);
		expect(kept?.toolDerived).toBe(true);
		// A reviewed item is only a log entry and is never applied again.
		expect(normalizeReviewQueueItems([{ ...flagged, status: "applied" }])[0]).not.toHaveProperty("toolDerived");
		for (const value of ["true", 1, null, false, {}]) {
			expect(normalizeReviewQueueItems([{ ...queueItem("p2", 2, "pending"), toolDerived: value }])[0]).not.toHaveProperty("toolDerived");
		}
		expect(normalizeReviewQueueItems([queueItem("p3", 3, "pending")])[0]).not.toHaveProperty("toolDerived");
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

describe("composer layout", () => {
	test("fresh installs (no stored data) start in the Compact layout", () => {
		expect(normalizeAskMateSettings(null, "load").composerLayout).toBe("compact");
		expect(normalizeAskMateSettings(undefined, "load").composerLayout).toBe("compact");
	});

	test("the documented default for everything else stays Console", () => {
		expect(DEFAULT_SETTINGS.composerLayout).toBe("console");
		expect(load({}).composerLayout).toBe("console");
	});

	test("existing users keep the stored layout and the old one-time move to Console never fires", () => {
		expect(load({ composerLayout: "compact" }).composerLayout).toBe("compact");
		expect(load({ composerLayout: "expanded" }).composerLayout).toBe("expanded");
		expect(load({ composerLayout: "compact", consoleLayoutMigrated: false }).composerLayout).toBe("compact");
		expect(load({ composerLayout: "compact", consoleLayoutMigrated: true }).composerLayout).toBe("compact");
		expect(load({ composerLayout: "compact" }).consoleLayoutMigrated).toBe(true);
	});

	test("an invalid layout loads as Console, the documented default", () => {
		expect(load({ composerLayout: "weird", consoleLayoutMigrated: true }).composerLayout).toBe("console");
		expect(load({ composerLayout: 3 }).composerLayout).toBe("console");
		expect(normalizeComposerLayout("weird")).toBe("console");
		expect(normalizeComposerLayout("expanded")).toBe("expanded");
	});

	test("a layout chosen after install is kept on later loads and saves", () => {
		const first = normalizeAskMateSettings(null, "load");
		first.composerLayout = "expanded";
		const saved = normalizeAskMateSettings(first, "save");
		expect(saved.composerLayout).toBe("expanded");
		expect(normalizeAskMateSettings(structuredClone(saved), "load").composerLayout).toBe("expanded");
	});
});

describe("OpenAI model refresh", () => {
	test("a refreshed provider list is not re-extended from the stale legacy mirror on save", () => {
		const settings = normalizeAskMateSettings(
			{
				...DEFAULT_SETTINGS,
				modelOptions: ["gpt-5.5", "gpt-4.1", "stale-a", "stale-b", "gpt-image-2"],
				providers: {
					...DEFAULT_SETTINGS.providers,
					openai: { ...DEFAULT_SETTINGS.providers.openai, model: "gpt-5.5", modelOptions: ["gpt-5.5", "gpt-4.1"] }
				}
			},
			"save"
		);
		expect(settings.providers.openai.modelOptions).toEqual(["gpt-5.5", "gpt-4.1"]);
	});
});

describe("Apply approval mode", () => {
	test.each<[unknown, unknown, ApplyApprovalMode]>([
		["manual", false, "manual"],
		["full", false, "full"],
		["auto-approve", true, "auto-approve"],
		[undefined, false, "auto-approve"],
		[undefined, true, "manual"],
		[undefined, undefined, "manual"],
		["review-everything", false, "manual"],
		["FULL", false, "manual"],
		["", false, "manual"],
		[42, false, "manual"],
		[null, false, "manual"],
		[{}, false, "manual"],
		[["auto-approve"], false, "manual"]
	])("normalizeApplyApprovalMode(%p, legacy %p) gives %p", (value, legacy, expected) => {
		expect(normalizeApplyApprovalMode(value, legacy)).toBe(expected);
	});

	test("load only treats a missing mode with showApplyPreview false as the legacy auto-approve migration", () => {
		expect(load({ showApplyPreview: false }).applyApprovalMode).toBe("auto-approve");
		expect(load({ applyApprovalMode: "review-everything", showApplyPreview: false }).applyApprovalMode).toBe("manual");
		expect(load({ applyApprovalMode: 7, showApplyPreview: false }).applyApprovalMode).toBe("manual");
		expect(load({ applyApprovalMode: "full", showApplyPreview: false }).applyApprovalMode).toBe("full");
	});

	test("a corrupt mode never fails open on save", () => {
		const settings = load({});
		settings.applyApprovalMode = "whatever" as never;
		settings.showApplyPreview = false;
		expect(normalizeAskMateSettings(settings, "save").applyApprovalMode).toBe("manual");
	});
});

describe("settings schema version", () => {
	test("a build writes its own schema version", () => {
		expect(load({}).settingsVersion).toBe(CURRENT_SETTINGS_VERSION);
		expect(DEFAULT_SETTINGS.settingsVersion).toBe(CURRENT_SETTINGS_VERSION);
		expect(normalizeAskMateSettings(load({}), "save").settingsVersion).toBe(CURRENT_SETTINGS_VERSION);
	});

	test("data saved before versions existed, or with a junk version, is treated as legacy", () => {
		expect(load({ model: "gpt-4.1" }).settingsVersion).toBe(CURRENT_SETTINGS_VERSION);
		expect(load({ settingsVersion: "two" }).settingsVersion).toBe(CURRENT_SETTINGS_VERSION);
		expect(load({ settingsVersion: -3 }).settingsVersion).toBe(CURRENT_SETTINGS_VERSION);
		expect(load({ settingsVersion: 1.5 }).settingsVersion).toBe(CURRENT_SETTINGS_VERSION);
	});

	test("a newer stored version carries unknown keys through verbatim, on load and on save", () => {
		const future = { sync: { devices: ["a", "b"] }, flag: true };
		const loaded = load({ settingsVersion: CURRENT_SETTINGS_VERSION + 1, futureThing: future, composerLayout: "expanded" }) as unknown as Record<string, unknown>;
		expect(loaded.futureThing).toEqual(future);
		expect(loaded.settingsVersion).toBe(CURRENT_SETTINGS_VERSION + 1);
		const saved = normalizeAskMateSettings(loaded as unknown as AskMateSettings, "save") as unknown as Record<string, unknown>;
		expect(saved.futureThing).toEqual(future);
		expect(saved.settingsVersion).toBe(CURRENT_SETTINGS_VERSION + 1);
		expect(saved.composerLayout).toBe("expanded");
	});

	test("known keys are still normalised when a newer version is stored", () => {
		const loaded = load({ settingsVersion: CURRENT_SETTINGS_VERSION + 1, reasoningEffort: "extreme", sendShortcut: "alt" });
		expect(loaded.reasoningEffort).toBe(DEFAULT_SETTINGS.reasoningEffort);
		expect(loaded.sendShortcut).toBe(DEFAULT_SETTINGS.sendShortcut);
	});

	test("unknown keys inside the namespaced groups survive only when a newer build saved the file", () => {
		const newer = load({ settingsVersion: CURRENT_SETTINGS_VERSION + 1, skills: { enabled: false, futureMode: "x" }, mcp: { enabled: false, futureLimit: 3 } });
		expect((newer.skills as unknown as Record<string, unknown>).futureMode).toBe("x");
		expect((newer.mcp as unknown as Record<string, unknown>).futureLimit).toBe(3);
		const current = load({ skills: { enabled: false, futureMode: "x" }, mcp: { futureLimit: 3 } });
		expect((current.skills as unknown as Record<string, unknown>).futureMode).toBeUndefined();
		expect((current.mcp as unknown as Record<string, unknown>).futureLimit).toBeUndefined();
	});

	test("a __proto__ key in the stored file is never copied onto the settings", () => {
		const raw = JSON.parse('{"__proto__": {"polluted": true}, "settingsVersion": 99, "keep": 1}') as Record<string, unknown>;
		const loaded = load(raw) as unknown as Record<string, unknown>;
		expect(Object.prototype.hasOwnProperty.call(loaded, "__proto__")).toBe(false);
		expect((loaded as { polluted?: unknown }).polluted).toBeUndefined();
		expect(loaded.keep).toBe(1);
	});

	test("an older data.json loads unchanged: every stored value survives and only new groups appear", () => {
		// Start from a loaded file, not DEFAULT_SETTINGS, because normalisation trims templates and a real data.json is already normalised.
		const base = structuredClone(load({})) as unknown as Record<string, unknown>;
		for (const key of ["settingsVersion", "skills", "diagrams", "mcp", "firstRunCompletedAt", "lastSeenVersion"]) {
			delete base[key];
		}
		const stored = {
			...base,
			composerLayout: "compact",
			consoleLayoutMigrated: true,
			threadedChatEnabled: false,
			translationTargetLanguage: "Persian",
			resultFolder: "Answers",
			globalInstructions: "Be brief.",
			providers: {
				...DEFAULT_SETTINGS.providers,
				openai: { ...DEFAULT_SETTINGS.providers.openai, apiKeySecretName: "my-openai", model: "gpt-4.1", modelOptions: ["gpt-4.1", "gpt-4o"] }
			},
			customWorkflows: [{ id: "custom-a", name: "Mine", shortName: "Mine", description: "d", icon: "wand-2", accent: "blue", prompt: "Goal: x", resultNoteTemplate: "", hidden: false, outputKind: "new-content", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z" }]
		} as Record<string, unknown>;
		const loaded = load(structuredClone(stored)) as unknown as Record<string, unknown>;
		for (const [key, value] of Object.entries(stored)) {
			if (key === "openAiApiKeySecretName" || key === "model" || key === "modelOptions") {
				continue;
			}
			expect(loaded[key]).toEqual(value);
		}
		expect(loaded.model).toBe("gpt-4.1");
		expect(loaded.openAiApiKeySecretName).toBe("my-openai");
		expect(loaded.settingsVersion).toBe(CURRENT_SETTINGS_VERSION);
		expect(loaded.skills).toEqual(DEFAULT_SETTINGS.skills);
		expect(loaded.diagrams).toEqual(DEFAULT_SETTINGS.diagrams);
		expect(loaded.mcp).toEqual(DEFAULT_SETTINGS.mcp);
	});
});

describe("first-party endpoint pinning", () => {
	const FIRST_PARTY: TextProviderId[] = ["openai", "anthropic", "google-gemini", "openrouter"];
	const hostile = [
		"https://attacker.example/v1",
		"http://attacker.example",
		"https://api.openai.com.attacker.example/v1",
		"https://api.openai.com@attacker.example/v1",
		"https://attacker.example/https://api.openai.com/v1",
		"//attacker.example/v1",
		"ftp://attacker.example",
		"not a url"
	];

	// Strings whose origin is the vendor's under the WHATWG parser but whose host depends on who reads them: WHATWG ends the authority
	// at a backslash and drops tabs and newlines, RFC 3986 parsers do not. Userinfo, query and fragment never belong in a vendor URL.
	function ambiguousShapes(vendorUrl: string): string[] {
		const origin = new URL(vendorUrl).origin;
		const host = new URL(vendorUrl).host;
		return [
			`${origin}\\@attacker.example/v1`,
			`${origin}\\attacker.example/v1`,
			`${origin}#@attacker.example/`,
			`${origin}?@attacker.example/v1`,
			`https://u:p@${host}/v1`,
			`https://user@${host}/v1`,
			`https://:p@${host}/v1`,
			`${vendorUrl}?x=1`,
			`${vendorUrl}#frag`,
			`${vendorUrl}?`,
			`${vendorUrl} /x`,
			`${vendorUrl}\n.attacker.example`,
			`${origin}\t@attacker.example/v1`,
			`https://${host}:8443/v1`,
			`http://${host}/v1`
		];
	}

	function withBaseUrl(providerId: TextProviderId, baseUrl: unknown): Record<string, unknown> {
		return { providers: { [providerId]: { ...DEFAULT_SETTINGS.providers[providerId], apiKeySecretName: "shared-secret", baseUrl } } };
	}

	test.each(FIRST_PARTY)("%s resets a stored base URL on another origin to the vendor default", (providerId) => {
		for (const baseUrl of [...hostile, ...ambiguousShapes(DEFAULT_PROVIDER_SETTINGS[providerId].baseUrl)]) {
			const settings = load(withBaseUrl(providerId, baseUrl));
			expect(settings.providers[providerId].baseUrl).toBe(DEFAULT_PROVIDER_SETTINGS[providerId].baseUrl);
			// The secret name is kept: only the destination is pinned, so the key can never be sent elsewhere.
			expect(settings.providers[providerId].apiKeySecretName).toBe("shared-secret");
		}
	});

	test.each(FIRST_PARTY)("%s keeps a same-origin base URL, trimmed of trailing slashes", (providerId) => {
		const origin = new URL(DEFAULT_PROVIDER_SETTINGS[providerId].baseUrl).origin;
		expect(load(withBaseUrl(providerId, `${DEFAULT_PROVIDER_SETTINGS[providerId].baseUrl}/`)).providers[providerId].baseUrl).toBe(DEFAULT_PROVIDER_SETTINGS[providerId].baseUrl);
		expect(load(withBaseUrl(providerId, `${origin}/custom/v1`)).providers[providerId].baseUrl).toBe(`${origin}/custom/v1`);
	});

	test("a missing or blank base URL still falls back to the default without a diagnostic", () => {
		const { settings, diagnostics } = normalizeAskMateSettingsWithDiagnostics({ providers: { openai: { baseUrl: "  " } } } as unknown as Partial<AskMateSettings>, "load");
		expect(settings.providers.openai.baseUrl).toBe(DEFAULT_PROVIDER_SETTINGS.openai.baseUrl);
		expect(diagnostics.filter((item) => item.code === "provider-endpoint-reset")).toEqual([]);
	});

	test.each(FIRST_PARTY)("%s stores a same-origin base URL in canonical form", (providerId) => {
		const defaultUrl = new URL(DEFAULT_PROVIDER_SETTINGS[providerId].baseUrl);
		const loud = `${defaultUrl.protocol.toUpperCase()}//${defaultUrl.host.toUpperCase()}:443${defaultUrl.pathname}///`;
		const stored = load(withBaseUrl(providerId, loud)).providers[providerId].baseUrl;
		expect(stored).toBe(DEFAULT_PROVIDER_SETTINGS[providerId].baseUrl);
		// Whatever is kept parses to the same host under WHATWG and carries nothing a looser parser could read as another host.
		const kept = load(withBaseUrl(providerId, `${defaultUrl.origin}/custom/path/./x/responses`)).providers[providerId].baseUrl;
		expect(kept).toBe(`${defaultUrl.origin}/custom/path/x`);
		expect(new URL(kept).host).toBe(defaultUrl.host);
		expect(kept).not.toMatch(/[\\\s?#@]/);
	});

	test("a kept first-party URL has no userinfo, backslash, query or fragment, for every candidate", () => {
		for (const providerId of FIRST_PARTY) {
			const defaultOrigin = new URL(DEFAULT_PROVIDER_SETTINGS[providerId].baseUrl).origin;
			for (const baseUrl of [...hostile, ...ambiguousShapes(DEFAULT_PROVIDER_SETTINGS[providerId].baseUrl)]) {
				const kept = load(withBaseUrl(providerId, baseUrl)).providers[providerId].baseUrl;
				const parsed = new URL(kept);
				expect(parsed.origin).toBe(defaultOrigin);
				expect(parsed.username + parsed.password + parsed.search + parsed.hash).toBe("");
				expect(kept).not.toMatch(/[\\\s?#@]/);
			}
		}
	});

	test("the backslash and userinfo shapes are reported as endpoint resets", () => {
		for (const baseUrl of ambiguousShapes(DEFAULT_PROVIDER_SETTINGS.openai.baseUrl)) {
			const { settings, diagnostics } = normalizeAskMateSettingsWithDiagnostics(withBaseUrl("openai", baseUrl) as Partial<AskMateSettings>, "load");
			expect(settings.providers.openai.baseUrl).toBe(DEFAULT_PROVIDER_SETTINGS.openai.baseUrl);
			expect(diagnostics.filter((item) => item.code === "provider-endpoint-reset").map((item) => item.subject)).toEqual(["openai"]);
		}
	});

	test("the reset is reported once and the saved result is stable", () => {
		const first = normalizeAskMateSettingsWithDiagnostics(withBaseUrl("anthropic", "https://attacker.example/v1") as Partial<AskMateSettings>, "load");
		const resets = first.diagnostics.filter((item) => item.code === "provider-endpoint-reset");
		expect(resets).toHaveLength(1);
		expect(resets[0].subject).toBe("anthropic");
		expect(normalizeAskMateSettingsWithDiagnostics(first.settings, "save").diagnostics).toEqual([]);
	});

	test("custom and self-hosted providers are not pinned", () => {
		const settings = load({
			providers: {
				"openai-compatible": { apiKeySecretName: "", model: "m", modelOptions: ["m"], baseUrl: "http://192.168.1.5:8080/v1" },
				"azure-openai": { apiKeySecretName: "", model: "", modelOptions: [], baseUrl: "https://resource.openai.azure.com/openai/v1" },
				"azure-ai": { apiKeySecretName: "", model: "mistral-large", modelOptions: [], baseUrl: "https://resource.services.ai.azure.com" }
			}
		});
		expect(settings.providers["openai-compatible"].baseUrl).toBe("http://192.168.1.5:8080/v1");
		expect(settings.providers["azure-openai"].baseUrl).toBe("https://resource.openai.azure.com/openai/v1");
		expect(settings.providers["azure-ai"].baseUrl).toBe("https://resource.services.ai.azure.com");
	});

	// The setup state and provider summaries treat a bare portal endpoint as "needs an endpoint", so the validator must keep rejecting it.
	test("the Azure OpenAI validator still requires the /openai/v1 path and does not complete a bare endpoint", () => {
		expect(validateAzureOpenAIBaseUrl("https://resource.openai.azure.com/openai/v1", "")).toBe("https://resource.openai.azure.com/openai/v1");
		expect(validateAzureOpenAIBaseUrl("https://resource.openai.azure.com/openai/v1/", "")).toBe("https://resource.openai.azure.com/openai/v1");
		expect(() => validateAzureOpenAIBaseUrl("https://resource.openai.azure.com", "")).toThrow("must end with /openai/v1");
		expect(() => validateAzureOpenAIBaseUrl("https://resource.openai.azure.com/", "")).toThrow("must end with /openai/v1");
		expect(() => validateAzureOpenAIBaseUrl("https://resource.openai.azure.com/custom", "")).toThrow("must end with /openai/v1");
		expect(() => validateAzureOpenAIBaseUrl("https://proxy.example.com", "")).toThrow("must end with /openai/v1");
	});
});

describe("model lists", () => {
	function openAiList(options: unknown, model = "gpt-4.1"): Record<string, unknown> {
		return { providers: { openai: { apiKeySecretName: "", model, modelOptions: options, baseUrl: "" } } };
	}

	test("load keeps a refreshed OpenAI list exactly as saved instead of re-adding the defaults", () => {
		expect(load(openAiList(["gpt-4.1", "gpt-4o"])).providers.openai.modelOptions).toEqual(["gpt-4.1", "gpt-4o"]);
		expect(load(openAiList(["gpt-4.1"])).providers.openai.modelOptions).toEqual(["gpt-4.1"]);
	});

	test("a list that shrank survives load then save then load", () => {
		const loaded = load(openAiList(["gpt-4.1", "gpt-4o"]));
		const saved = normalizeAskMateSettings(structuredClone(loaded), "save");
		expect(saved.providers.openai.modelOptions).toEqual(["gpt-4.1", "gpt-4o"]);
		expect(load(structuredClone(saved) as unknown as Record<string, unknown>).providers.openai.modelOptions).toEqual(["gpt-4.1", "gpt-4o"]);
		expect(saved.modelOptions).toEqual(["gpt-4.1", "gpt-4o"]);
	});

	test("an empty saved OpenAI list falls back to the built-in defaults", () => {
		const options = load(openAiList([], "gpt-5.5")).providers.openai.modelOptions;
		expect(options).toEqual(["gpt-5.5", ...DEFAULT_SETTINGS.providers.openai.modelOptions.filter((model) => model !== "gpt-5.5")]);
		expect(load(openAiList([" ", ""], "gpt-5.5")).providers.openai.modelOptions).toContain(DEFAULT_SETTINGS.providers.openai.modelOptions[0]);
	});

	test("a missing OpenAI list uses the built-in defaults", () => {
		const options = load({}).providers.openai.modelOptions;
		expect(options).toEqual(DEFAULT_SETTINGS.providers.openai.modelOptions);
	});

	test("a missing provider list still honours the legacy top-level mirror", () => {
		const settings = load({ model: "gpt-4.1", modelOptions: ["gpt-4.1", "legacy-b"] });
		expect(settings.providers.openai.modelOptions).toEqual(["gpt-4.1", "legacy-b"]);
	});

	test("built-in defaults of the other providers are suggestions that stay in the list", () => {
		const settings = load({ providers: { "openai-compatible": { apiKeySecretName: "", model: "gemma3", modelOptions: ["gemma3"], baseUrl: "http://localhost:11434/v1" } } });
		expect(settings.providers["openai-compatible"].modelOptions).toEqual(["gemma3", ...DEFAULT_SETTINGS.providers["openai-compatible"].modelOptions]);
	});
});

describe("retired Claude models", () => {
	const RETIRED = [
		"claude-3-sonnet-20240229",
		"claude-3-opus-20240229",
		"claude-3-5-sonnet-20240620",
		"claude-3-5-sonnet-20241022",
		"claude-3-5-sonnet-latest",
		"claude-3-5-haiku-20241022",
		"claude-3-5-haiku-latest",
		"claude-3-7-sonnet-20250219",
		"claude-3-7-sonnet-latest",
		"claude-3-haiku-20240307",
		"claude-sonnet-4-20250514",
		"claude-opus-4-20250514",
		"claude-opus-4-1-20250805"
	];
	const CURRENT = [
		"claude-sonnet-5-5",
		"claude-sonnet-5",
		"claude-opus-5-5",
		"claude-opus-5",
		"claude-opus-4-8",
		"claude-opus-4-6",
		"claude-sonnet-4-6",
		"claude-opus-4-5-20251101",
		// Deprecated but still served until 30 November 2026, so it must not be migrated yet.
		"claude-sonnet-4-5-20250929",
		"claude-haiku-4-5-20251001",
		"claude-haiku-5-5",
		"claude-fable-5-1",
		"my-custom-model",
		"gpt-4.1",
		"anthropic/claude-3-7-sonnet"
	];

	test.each(RETIRED)("%s is retired", (id) => {
		expect(isRetiredAnthropicModel(id)).toBe(true);
	});

	test.each(CURRENT)("%s is not retired", (id) => {
		expect(isRetiredAnthropicModel(id)).toBe(false);
	});

	test("matching ignores case and surrounding spaces", () => {
		expect(isRetiredAnthropicModel("  Claude-3-7-Sonnet-20250219 ")).toBe(true);
		expect(isRetiredAnthropicModel("")).toBe(false);
	});

	test("the list is explicit, dated and has no duplicates", () => {
		expect(RETIRED_ANTHROPIC_MODELS.length).toBeGreaterThanOrEqual(RETIRED.length);
		for (const entry of RETIRED_ANTHROPIC_MODELS) {
			expect(entry.retired).toMatch(/^\d{4}-\d{2}-\d{2}$/);
			expect(entry.id).toBe(entry.id.toLowerCase());
		}
		const ids = RETIRED_ANTHROPIC_MODELS.map((entry) => entry.id);
		expect(new Set(ids).size).toBe(ids.length);
		for (const id of RETIRED) {
			expect(ids).toContain(id);
		}
	});

	test("a saved retired model is migrated to the default and a current model is kept", () => {
		const anthropic = (model: string, modelOptions: string[]) => load({ providers: { anthropic: { apiKeySecretName: "claude", model, modelOptions, baseUrl: "" } } }).providers.anthropic;
		const retired = anthropic("claude-3-7-sonnet-20250219", ["claude-3-7-sonnet-20250219", "claude-opus-4-1-20250805", "my-custom-model"]);
		expect(retired.model).toBe(DEFAULT_PROVIDER_SETTINGS.anthropic.model);
		expect(retired.modelOptions).not.toContain("claude-3-7-sonnet-20250219");
		expect(retired.modelOptions).not.toContain("claude-opus-4-1-20250805");
		expect(retired.modelOptions).toContain("my-custom-model");
		const current = anthropic("claude-sonnet-4-5-20250929", ["claude-sonnet-4-5-20250929"]);
		expect(current.model).toBe("claude-sonnet-4-5-20250929");
		expect(current.modelOptions).toContain("claude-sonnet-4-5-20250929");
	});

	test("only the Anthropic provider is migrated", () => {
		const settings = load({ providers: { openrouter: { apiKeySecretName: "", model: "claude-3-7-sonnet-20250219", modelOptions: [], baseUrl: "" } } });
		expect(settings.providers.openrouter.model).toBe("claude-3-7-sonnet-20250219");
	});
});

describe("translation target language", () => {
	test("defaults to English for everyone", () => {
		expect(DEFAULT_TRANSLATION_TARGET_LANGUAGE).toBe("English");
		expect(DEFAULT_SETTINGS.translationTargetLanguage).toBe("English");
		expect(load({}).translationTargetLanguage).toBe("English");
		expect(normalizeTranslationTargetLanguage("")).toBe("English");
		expect(normalizeTranslationTargetLanguage(null)).toBe("English");
	});

	test("existing users keep the language they saved, even Persian", () => {
		expect(load({ translationTargetLanguage: "Persian" }).translationTargetLanguage).toBe("Persian");
		expect(normalizeAskMateSettings(load({ translationTargetLanguage: "German" }), "save").translationTargetLanguage).toBe("German");
	});

	test.each<[string | undefined | null, string]>([
		["de", "German"],
		["fr", "French"],
		["ja", "Japanese"],
		["en", "English"],
		["en-GB", "English"],
		["", "English"],
		[undefined, "English"],
		[null, "English"],
		["xx", "English"],
		["???", "English"],
		["{{selectedText}}", "English"]
	])("defaultTranslationLanguage(%p) gives %p", (locale, expected) => {
		expect(defaultTranslationLanguage(locale)).toBe(expected);
	});

	test("regional locales give a label the model can use", () => {
		expect(defaultTranslationLanguage("de-AT")).toMatch(/German/);
		expect(defaultTranslationLanguage("es_MX")).toMatch(/Spanish/);
		expect(defaultTranslationLanguage("pt-BR")).toMatch(/Portuguese/);
		expect(defaultTranslationLanguage("zh-TW")).toMatch(/Chinese/);
	});

	test("the locale only seeds fresh installs", () => {
		expect(normalizeAskMateSettings(null, "load", { locale: "de" }).translationTargetLanguage).toBe("German");
		expect(normalizeAskMateSettings(null, "load").translationTargetLanguage).toBe("English");
		expect(normalizeAskMateSettings({}, "load", { locale: "de" }).translationTargetLanguage).toBe("English");
		expect(normalizeAskMateSettings({ translationTargetLanguage: "Persian" } as Partial<AskMateSettings>, "load", { locale: "de" }).translationTargetLanguage).toBe("Persian");
	});
});

describe("fresh install defaults", () => {
	const fresh = (): AskMateSettings => normalizeAskMateSettings(null, "load", { locale: "fr" });

	test("follow-up questions remember the conversation with a 4 turn cap", () => {
		expect(fresh().threadedChatEnabled).toBe(true);
		expect(fresh().threadedChatMaxTurns).toBe(4);
	});

	test("usage guardrails start in warn-only mode with no budgets and no hard limit", () => {
		const settings = fresh();
		expect(settings.usageGuardrailsEnabled).toBe(true);
		expect(settings.usageBudgetEnforcement).toBe("warn");
		expect(settings.usageDailyTokenBudget).toBe(0);
		expect(settings.usageMonthlyTokenBudget).toBe(0);
		expect(settings.usagePerRequestHardLimitTokens).toBe(0);
	});

	test("saved conversations stay on by default", () => {
		expect(fresh().saveConversations).toBe(true);
		expect(DEFAULT_SETTINGS.saveConversations).toBe(true);
	});

	test("the first run does not change what an existing file gets", () => {
		const existing = load({});
		expect(existing.threadedChatEnabled).toBe(false);
		expect(existing.usageGuardrailsEnabled).toBe(false);
		expect(existing.composerLayout).toBe("console");
	});

	test("the choices survive the first save and the next load", () => {
		const saved = normalizeAskMateSettings(fresh(), "save");
		expect(saved.threadedChatEnabled).toBe(true);
		expect(saved.usageGuardrailsEnabled).toBe(true);
		expect(saved.composerLayout).toBe("compact");
		const reloaded = normalizeAskMateSettings(structuredClone(saved), "load", { locale: "de" });
		expect(reloaded.threadedChatEnabled).toBe(true);
		expect(reloaded.translationTargetLanguage).toBe("French");
	});

	test("fresh defaults never leak into DEFAULT_SETTINGS", () => {
		const before = JSON.stringify(DEFAULT_SETTINGS);
		const settings = fresh();
		settings.threadedChatEnabled = false;
		settings.providers.openai.modelOptions.push("x");
		settings.skills.disabledIds.push("y");
		settings.mcp.servers.length = 0;
		settings.diagrams.enabled = false;
		expect(JSON.stringify(DEFAULT_SETTINGS)).toBe(before);
	});
});

describe("load and save round trips", () => {
	const messy: Array<[string, Record<string, unknown> | null]> = [
		["empty", {}],
		["fresh", null],
		["local model list", { providers: { "openai-compatible": { apiKeySecretName: "", model: "gemma3", modelOptions: ["gemma3"], baseUrl: "http://localhost:11434/v1/" } } }],
		["blank azure", { providers: { "azure-openai": { apiKeySecretName: "", model: "", modelOptions: [], baseUrl: "" } } }],
		["workflows", { customWorkflows: [{ name: "A", prompt: "p" }, { id: "custom-x", name: "B", prompt: "q", skillIds: ["built-in:mermaid-diagrams", "built-in:mermaid-diagrams", 5] }], workflowDisplayPreferences: [{ id: "x" }] }],
		["anthropic", { selectedTextProvider: "anthropic" }],
		["compact", { composerLayout: "compact" }],
		["legacy mirror", { model: "gpt-4.1", modelOptions: ["gpt-4.1", "stale"], openAiApiKeySecretName: "k" }],
		["tampered endpoint", { providers: { openai: { apiKeySecretName: "k", model: "gpt-5.5", modelOptions: [], baseUrl: "https://attacker.example/v1" } } }],
		["groups", { skills: { enabled: false, folder: "My Skills", matching: "suggest", disabledIds: ["a", "a"], trustedHashes: { "vault:x": "A".repeat(64) } }, diagrams: { defaultType: "Sequence", defaultStyle: "blueprint" }, mcp: { enabled: true, maxToolRoundsPerTurn: 99, servers: [{ id: "git", label: "Git", transport: "stdio", command: "uvx", args: ["mcp-server-git"], env: { LEVEL: "1" } }] } }],
		["newer", { settingsVersion: 7, extra: { a: 1 } }],
		["junk", { threadedChatMaxTurns: "many", skills: "no", diagrams: [], mcp: 3, firstRunCompletedAt: "yesterday", lastSeenVersion: 12 }]
	];

	test.each(messy)("%s is stable under load then save then save", (_name, raw) => {
		const once = normalizeAskMateSettings(raw as Partial<AskMateSettings> | null, "load");
		const twice = normalizeAskMateSettings(structuredClone(once), "save");
		const thrice = normalizeAskMateSettings(structuredClone(twice), "save");
		expect(twice).toEqual(once);
		expect(thrice).toEqual(twice);
		expect(JSON.parse(JSON.stringify(twice))).toEqual(JSON.parse(JSON.stringify(once)));
	});

	test("a loaded file reloads to the same settings", () => {
		for (const [, raw] of messy) {
			const once = normalizeAskMateSettings(raw as Partial<AskMateSettings> | null, "load");
			const reloaded = normalizeAskMateSettings(structuredClone(once), "load");
			expect(reloaded).toEqual(once);
		}
	});
});

describe("context path anchors", () => {
	test("heading and block anchors are stripped because they never resolve to a file", () => {
		expect(normalizeContextPathList(["[[Note#Heading]]", "Folder/Other.md#^block", "[[Third^abc|alias]]", "Plain.md"])).toEqual(["Note", "Folder/Other.md", "Third", "Plain.md"]);
	});

	test("the style guide and glossary paths use the same normaliser", () => {
		const settings = load({ styleGuideContextPath: "[[Style guide#Tone]]", glossaryContextPath: " Terms.md#^t1 " });
		expect(settings.styleGuideContextPath).toBe("Style guide");
		expect(settings.glossaryContextPath).toBe("Terms.md");
	});
});
