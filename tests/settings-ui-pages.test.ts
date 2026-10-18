import { describe, expect, test } from "bun:test";
import { DEFAULT_SETTINGS } from "../src/settings/defaults";
import { IDLE_SETUP_TEST, deriveSetupState } from "../src/setup";
import type { AskMateSettings, TextProviderId } from "../src/shared/types";
import {
	chatModelOptions,
	chooseSecretId,
	connectionChip,
	describeKeyField,
	describeKeyState,
	describeTestConnection,
	gatedBy,
	interpretConnectionTest,
	isImageOnlyModel,
	keyLinkFor,
	planKeySave,
	removeSavedModel,
	statusChipClass
} from "../src/ui/settings/connectionPage";
import {
	ADVANCED_REASSURANCE,
	PAGE_SUMMARY_MIN_VERSION,
	SETTINGS_PAGES,
	compareVersions,
	getSettingsPage,
	pageSummaryFields,
	summarizePrivacyMemory,
	summarizeProviderSetup,
	summarizeSidebarOutput,
	summarizeSkillsAndTools,
	supportsPageSummaries
} from "../src/ui/settings/settingsSummaries";

function settingsWith(providerId: TextProviderId, patch: Partial<AskMateSettings["providers"][TextProviderId]> = {}): AskMateSettings {
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.providerRoles.chatProviderId = providerId;
	settings.selectedTextProvider = providerId;
	settings.providers[providerId] = { ...settings.providers[providerId], ...patch };
	return settings;
}

describe("the six pages", () => {
	test("are the documented pages in the documented order", () => {
		expect(SETTINGS_PAGES.map((page) => page.name)).toEqual([
			"Connection",
			"Sidebar and output",
			"Privacy and memory",
			"Skills and tools",
			"Instructions",
			"Advanced"
		]);
	});

	test("headings avoid the plugin name and the word settings, and each description is one sentence", () => {
		for (const page of SETTINGS_PAGES) {
			expect(page.name.toLowerCase()).not.toContain("askmate");
			expect(page.name.toLowerCase()).not.toContain("settings");
			expect(page.desc.match(/[.!?](\s|$)/g)?.length).toBe(1);
			expect(page.desc.endsWith(".")).toBe(true);
		}
	});

	test("looks a page up by id and refuses an unknown one", () => {
		expect(getSettingsPage("advanced").name).toBe("Advanced");
		expect(() => getSettingsPage("nope" as never)).toThrow("no settings page");
	});

	test("the advanced page tells a new user they can skip it", () => {
		expect(ADVANCED_REASSURANCE).toBe("You do not need anything here to use AskMate.");
	});
});

describe("page summaries on older Obsidian versions", () => {
	test("detects the version that shows a value and a warning on a page entry", () => {
		expect(PAGE_SUMMARY_MIN_VERSION).toBe("1.13.1");
		expect(supportsPageSummaries("1.13.1")).toBe(true);
		expect(supportsPageSummaries("1.14.4")).toBe(true);
		expect(supportsPageSummaries("2.0.0")).toBe(true);
		expect(supportsPageSummaries("1.13.0")).toBe(false);
		expect(supportsPageSummaries("1.12.9")).toBe(false);
	});

	test("an unknown version counts as unsupported, so the words are never lost", () => {
		expect(supportsPageSummaries(null)).toBe(false);
		expect(supportsPageSummaries(undefined)).toBe(false);
		expect(supportsPageSummaries("nightly")).toBe(false);
		expect(compareVersions("1.13.0", "bad")).toBeNull();
	});

	test("a supported version gets the live value and the warning as functions", () => {
		const fields = pageSummaryFields(true, "Desc.", () => "OpenAI", () => "warning");
		expect(fields.desc).toBe("Desc.");
		expect(fields.displayValue?.()).toBe("OpenAI");
		expect(fields.status?.()).toBe("warning");
	});

	test("an older version gets the same words folded into the description", () => {
		const fields = pageSummaryFields(false, "Desc.", () => "OpenAI · gpt-5.5");
		expect(fields.displayValue).toBeUndefined();
		expect(fields.status).toBeUndefined();
		expect(fields.desc).toBe("Desc. Now: OpenAI · gpt-5.5.");
	});

	test("an older version spells the warning out when the summary does not", () => {
		const warned = pageSummaryFields(false, "Desc.", () => "3 skills", () => "warning");
		expect(warned.desc).toContain("Needs attention.");
		const alreadySaid = pageSummaryFields(false, "Desc.", () => "OpenAI · setup needed", () => "warning");
		expect(alreadySaid.desc).not.toContain("Needs attention.");
	});

	test("a page with no summary keeps its description alone", () => {
		expect(pageSummaryFields(true, "Desc.", null)).toEqual({ desc: "Desc." });
		expect(pageSummaryFields(false, "Desc.", null)).toEqual({ desc: "Desc." });
	});
});

describe("page summaries", () => {
	test("sidebar and output names the layout, the output and any pending reviews", () => {
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.composerLayout = "compact";
		expect(summarizeSidebarOutput(settings, 0)).toBe("Compact layout · Sidebar chat");
		expect(summarizeSidebarOutput(settings, 2)).toBe("Compact layout · Sidebar chat · 2 pending reviews");
	});

	test("privacy and memory says what is sent and what is kept", () => {
		const settings = structuredClone(DEFAULT_SETTINGS);
		expect(summarizePrivacyMemory(settings)).toBe("Note sent · Conversations saved");
		settings.requestPrivacyDefaults.includeNoteContext = false;
		settings.saveConversations = false;
		expect(summarizePrivacyMemory(settings)).toBe("Note not sent · Conversations not saved");
	});

	test("skills and tools warns when a skill needs review or a server needs attention", () => {
		const base = { skillsEnabled: true, skills: { total: 6, needsReview: 0, invalid: 0 }, mcpEnabled: false, servers: { total: 0, ready: 0, attention: 0 } };
		expect(summarizeSkillsAndTools(base)).toEqual({ displayValue: "6 skills · Tools off", status: null });
		expect(summarizeSkillsAndTools({ ...base, skills: { total: 6, needsReview: 2, invalid: 0 } })).toEqual({ displayValue: "6 skills, 2 need review · Tools off", status: "warning" });
		expect(summarizeSkillsAndTools({ ...base, mcpEnabled: true, servers: { total: 2, ready: 1, attention: 1 } })).toEqual({ displayValue: "6 skills · 2 servers, 1 need attention", status: "warning" });
		expect(summarizeSkillsAndTools({ ...base, mcpEnabled: true })).toEqual({ displayValue: "6 skills · No servers", status: null });
	});

	test("a switched-off feature never raises a warning", () => {
		expect(summarizeSkillsAndTools({
			skillsEnabled: false,
			skills: { total: 6, needsReview: 4, invalid: 0 },
			mcpEnabled: false,
			servers: { total: 3, ready: 0, attention: 3 }
		})).toEqual({ displayValue: "Skills off · Tools off", status: null });
	});
});

describe("setup state follows the keychain", () => {
	test("a saved key name with no key on this device is reported as setup needed", () => {
		const settings = settingsWith("openai", { apiKeySecretName: "askmate-openai-key" });
		expect(summarizeProviderSetup(settings, () => true).status).toBeNull();
		const missing = summarizeProviderSetup(settings, () => false);
		expect(missing.status).toBe("warning");
		expect(missing.displayValue).toContain("setup needed");
		expect(missing.issues[0]).toContain("not stored on this device");
	});

	test("the key row explains a missing key in the same words as the shared rules", () => {
		const settings = settingsWith("openai", { apiKeySecretName: "askmate-openai-key" });
		expect(describeKeyState("openai", settings, () => false)).toContain("this device has no key");
		expect(describeKeyState("openai", settings, () => true)).toBeNull();
		expect(describeKeyState("openai", settingsWith("openai", { apiKeySecretName: "" }), () => false)).toBeNull();
	});
});

describe("connection status chip", () => {
	test("every stage has a label, so colour is never the only signal", () => {
		const incomplete = deriveSetupState(settingsWith("openai", { apiKeySecretName: "" }));
		expect(connectionChip(incomplete)).toEqual({ tone: "warning", label: "Setup needed" });
		const missing = deriveSetupState(settingsWith("openai", { apiKeySecretName: "k" }), () => false);
		expect(connectionChip(missing)).toEqual({ tone: "warning", label: "Key missing" });
		const settings = settingsWith("openai", { apiKeySecretName: "k" });
		expect(connectionChip(deriveSetupState(settings, () => true, IDLE_SETUP_TEST))).toEqual({ tone: "off", label: "Not tested" });
		expect(connectionChip(deriveSetupState(settings, () => true, { status: "testing", providerId: "openai", model: "gpt-5.5" }))).toEqual({ tone: "busy", label: "Testing" });
		expect(connectionChip(deriveSetupState(settings, () => true, { status: "ok", providerId: "openai", model: "gpt-5.5" }))).toEqual({ tone: "ready", label: "Connected" });
	});

	test("builds the chip classes the stylesheet knows", () => {
		expect(statusChipClass("ready")).toBe("askmate-status-chip is-ready");
		expect(statusChipClass("warning")).toBe("askmate-status-chip is-warning");
	});
});

describe("interpretConnectionTest", () => {
	const base = { providerId: "openai" as const, model: "gpt-5.5" };

	test("a pass is a success and marks the stage ready", () => {
		const outcome = interpretConnectionTest({ ...base, result: { ok: true, message: "AskMate OpenAI test passed.", modelFound: true } });
		expect(outcome.feedback).toEqual({ kind: "success", message: "AskMate OpenAI test passed." });
		expect(outcome.test).toEqual({ status: "ok", providerId: "openai", model: "gpt-5.5" });
	});

	test("a model the provider does not list is a failure that names the closest one", () => {
		const outcome = interpretConnectionTest({ ...base, result: { ok: true, message: "connected", modelFound: false, suggestedModel: "gpt-5.4" } });
		expect(outcome.feedback.kind).toBe("error");
		expect(outcome.feedback.message).toContain("gpt-5.5");
		expect(outcome.feedback.message).toContain("The closest listed model is gpt-5.4.");
		expect(outcome.test.status).toBe("failed");
		if (outcome.test.status === "failed") {
			expect(outcome.test.copy.action.kind).toBe("choose-model");
		}
	});

	test("an unchecked model passes", () => {
		expect(interpretConnectionTest({ ...base, result: { ok: true, message: "ok", modelFound: null } }).feedback.kind).toBe("success");
	});

	test("a rejected key is explained in plain words with an action", () => {
		const outcome = interpretConnectionTest({ ...base, result: { ok: false, message: "Authentication failed (HTTP 401)." } });
		expect(outcome.feedback.kind).toBe("error");
		expect(outcome.feedback.message).toContain("rejected the API key");
		expect(outcome.test.status === "failed" && outcome.test.copy.action.kind).toBe("update-key");
	});

	test("an unreachable local server names the address", () => {
		const outcome = interpretConnectionTest({
			providerId: "openai-compatible",
			model: "llama3.1",
			baseUrl: "http://localhost:11434/v1",
			result: { ok: false, message: "net::ERR_CONNECTION_REFUSED" }
		});
		expect(outcome.feedback.message).toContain("localhost:11434");
	});
});

describe("key entry", () => {
	test("offers a key page for hosted providers and none for a local server", () => {
		expect(keyLinkFor("openai")).toEqual({ text: "Get an API key", href: "https://platform.openai.com/api-keys" });
		expect(keyLinkFor("anthropic")?.href).toBe("https://platform.claude.com/settings/keys");
		expect(keyLinkFor("google-gemini")?.href).toBe("https://aistudio.google.com/apikey");
		expect(keyLinkFor("openai-compatible")).toBeNull();
	});

	test("says where the key lives in plain words", () => {
		expect(describeKeyField("openai", false)).toBe("Paste your key once. Saved in Obsidian's secret storage on this device (your system keychain), never in your vault.");
		expect(describeKeyField("openai", true)).toContain("Paste a new one to replace it.");
		expect(describeKeyField("openai-compatible", false)).toStartWith("Optional for a local server.");
	});

	test("replaces its own earlier key in place and never overwrites another name", () => {
		expect(chooseSecretId("openai", "askmate-openai-key", ["askmate-openai-key"])).toBe("askmate-openai-key");
		expect(chooseSecretId("openai", "askmate-openai-key-2", [])).toBe("askmate-openai-key-2");
		expect(chooseSecretId("openai", "other-plugin-token", ["other-plugin-token"])).toBe("askmate-openai-key");
		expect(chooseSecretId("openai", "", ["askmate-openai-key"])).toBe("askmate-openai-key-2");
		// A key saved for a different provider is not this provider's to replace.
		expect(chooseSecretId("anthropic", "askmate-openai-key", ["askmate-openai-key"])).toBe("askmate-anthropic-key");
	});

	test("checks a pasted key before anything is stored", () => {
		expect(planKeySave("openai", "   ", "", [])).toEqual({ ok: false, message: "Paste your API key first." });
		expect(planKeySave("openai", "two words", "", []).ok).toBe(false);
		expect(planKeySave("openai", "short", "", []).ok).toBe(false);
		expect(planKeySave("openai", "  \"sk-test-0123456789\"  ", "", [])).toEqual({ ok: true, key: "sk-test-0123456789", secretId: "askmate-openai-key" });
	});
});

describe("models", () => {
	test("the chat list leaves image-only models out but keeps the selected one", () => {
		expect(isImageOnlyModel("gpt-image-2")).toBe(true);
		expect(isImageOnlyModel("gpt-5.5")).toBe(false);
		expect(chatModelOptions(["gpt-5.5", "gpt-image-2"], "gpt-5.5")).toEqual(["gpt-5.5"]);
		expect(chatModelOptions(["gpt-5.5", "gpt-image-2"], "gpt-image-2")).toEqual(["gpt-5.5", "gpt-image-2"]);
	});

	test("removes a saved deployment and picks the next one when it was selected", () => {
		expect(removeSavedModel(["a", "b", "c"], "b", "b")).toEqual({ options: ["a", "c"], model: "a" });
		expect(removeSavedModel(["a", "b", "c"], "a", "c")).toEqual({ options: ["a", "b"], model: "a" });
		expect(removeSavedModel(["a"], "a", "a")).toEqual({ options: [], model: "" });
	});

	test("the Azure test wording states how long it can take", () => {
		expect(describeTestConnection("azure-openai")).toContain("up to a minute");
		expect(describeTestConnection("azure-ai")).toContain("up to a minute");
		expect(describeTestConnection("openai")).toContain("10 seconds");
	});
});

describe("gatedBy", () => {
	test("a row shows only while both its gate and its own condition hold", () => {
		let gate = false;
		let own = true;
		const row = gatedBy({ name: "Row", visible: () => own }, () => gate);
		const visible = (): boolean => (typeof row.visible === "function" ? row.visible() : row.visible ?? true);
		expect(visible()).toBe(false);
		gate = true;
		expect(visible()).toBe(true);
		own = false;
		expect(visible()).toBe(false);
	});

	test("a row with no condition of its own follows the gate", () => {
		let gate = false;
		const row = gatedBy({ name: "Row" }, () => gate);
		const visible = (): boolean => (typeof row.visible === "function" ? row.visible() : row.visible ?? true);
		expect(visible()).toBe(false);
		gate = true;
		expect(visible()).toBe(true);
	});
});
