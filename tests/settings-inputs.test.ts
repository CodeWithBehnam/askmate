import { describe, expect, test } from "bun:test";
import { DEFAULT_SETTINGS } from "../src/settings/defaults";
import { normalizeAskMateSettings } from "../src/settings/normalize";
import type { AskMateSettings } from "../src/shared/types";
import {
	RESET_TO_RECOMMENDED_KEYS,
	SKILL_MATCHING_OPTIONS,
	buildRecommendedSettingsPatch,
	checkTemplate,
	closestTemplateVariable,
	describeNoteMemory,
	describePromptLength,
	describePromptNormalisation,
	describeStoredTextDeletion,
	normalizeNoteMemoryMode,
	readNoteMemoryMode,
	readSettingControl,
	resolveBatchWorkflowId,
	writeNoteMemoryMode,
	writeSettingControl
} from "../src/ui/settings/settingsInputs";

const fresh = (): AskMateSettings => structuredClone(DEFAULT_SETTINGS);

// Every key a settings control can read or write, with a value that is valid for it and differs from the default.
const NEW_KEY_SAMPLES: ReadonlyArray<[key: string, value: unknown, check: (settings: AskMateSettings) => unknown]> = [
	["noteMemoryMode", "keep-and-use", (s) => [s.noteHistoryEnabled, s.noteHistoryIncludeInContext]],
	["skillsEnabled", false, (s) => s.skills.enabled],
	["skillsMatching", "all-auto", (s) => s.skills.matching],
	["skillsFolder", "Notes/My skills", (s) => s.skills.folder],
	["diagramsEnabled", false, (s) => s.diagrams.enabled],
	["diagramDefaultType", "sequence", (s) => s.diagrams.defaultType],
	["diagramDefaultStyle", "blueprint", (s) => s.diagrams.defaultStyle],
	["diagramAllowRepair", false, (s) => s.diagrams.allowRepairTurn],
	["mcpEnabled", true, (s) => s.mcp.enabled]
];

describe("registry round trip for every new key", () => {
	for (const [key, value, check] of NEW_KEY_SAMPLES) {
		test(`${key} writes through its normaliser and reads back`, () => {
			const settings = fresh();
			writeSettingControl(settings, key, value);
			const stored = check(settings);
			expect(stored).not.toEqual(check(fresh()));
			// Reading what was written, then writing that again, changes nothing.
			const read = readSettingControl(settings, key);
			writeSettingControl(settings, key, read);
			expect(check(settings)).toEqual(stored);
		});

		test(`${key} survives the settings loader unchanged`, () => {
			const settings = fresh();
			writeSettingControl(settings, key, value);
			const reloaded = normalizeAskMateSettings(structuredClone(settings), "load");
			expect(check(reloaded)).toEqual(check(settings));
		});
	}

	test("an unusable value falls back instead of being stored", () => {
		const settings = fresh();
		writeSettingControl(settings, "skillsMatching", "everything");
		expect(settings.skills.matching).toBe(DEFAULT_SETTINGS.skills.matching);
		writeSettingControl(settings, "skillsFolder", ".hidden/skills");
		expect(settings.skills.folder).toBe(DEFAULT_SETTINGS.skills.folder);
		writeSettingControl(settings, "diagramDefaultType", "../../etc");
		expect(settings.diagrams.defaultType).toBe("auto");
		writeSettingControl(settings, "mcpEnabled", "true");
		expect(settings.mcp.enabled).toBe(false);
	});

	test("changing one skills field keeps the others, including ones a newer build added", () => {
		const settings = fresh();
		settings.skills = { ...settings.skills, disabledIds: ["vault:a"], trustedHashes: { "vault:a": "a".repeat(64) }, futureField: 7 } as AskMateSettings["skills"];
		writeSettingControl(settings, "skillsEnabled", false);
		expect(settings.skills.disabledIds).toEqual(["vault:a"]);
		expect(settings.skills.trustedHashes["vault:a"]).toBe("a".repeat(64));
		expect(Reflect.get(settings.skills, "futureField")).toBe(7);
	});

	test("turning tools on keeps the servers", () => {
		const settings = fresh();
		settings.mcp = { ...settings.mcp, servers: [{ id: "a", label: "A", enabled: false, approval: "always-ask", trustsAnnotations: false, trustedConfigHash: null, transport: "http", url: "https://example.com", headers: {}, bearerSecretId: null }] };
		writeSettingControl(settings, "mcpEnabled", true);
		expect(settings.mcp.servers).toHaveLength(1);
		expect(settings.mcp.enabled).toBe(true);
	});

	test("matching modes offer every stored mode with a plain label", () => {
		expect(Object.keys(SKILL_MATCHING_OPTIONS)).toEqual(["off", "suggest", "builtin-auto", "all-auto"]);
		expect(Object.values(SKILL_MATCHING_OPTIONS).every((label) => label.length > 0)).toBe(true);
	});
});

describe("per-note memory", () => {
	test("folds the two stored switches into one choice and back", () => {
		const settings = fresh();
		for (const mode of ["off", "keep", "keep-and-use"] as const) {
			writeNoteMemoryMode(settings, mode);
			expect(readNoteMemoryMode(settings)).toBe(mode);
		}
	});

	test("keep-and-use cannot exist while nothing is kept", () => {
		expect(readNoteMemoryMode({ noteHistoryEnabled: false, noteHistoryIncludeInContext: true })).toBe("off");
	});

	test("an unknown value turns memory off", () => {
		expect(normalizeNoteMemoryMode("always")).toBe("off");
		const settings = fresh();
		writeNoteMemoryMode(settings, "always");
		expect(settings.noteHistoryEnabled).toBe(false);
		expect(settings.noteHistoryIncludeInContext).toBe(false);
	});

	test("the description states both caps", () => {
		expect(describeNoteMemory(12)).toContain("12 turns per note");
		expect(describeNoteMemory(12)).toContain("200 in total");
	});
});

describe("checkTemplate", () => {
	test("accepts the default templates", () => {
		expect(checkTemplate("result-note", DEFAULT_SETTINGS.resultNoteTemplate)).toBeNull();
		expect(checkTemplate("image-note", DEFAULT_SETTINGS.imageResultNoteTemplate)).toBeNull();
		expect(checkTemplate("image-folder", DEFAULT_SETTINGS.imageFolderTemplate)).toBeNull();
		expect(checkTemplate("image-file-name", DEFAULT_SETTINGS.imageFileNameTemplate)).toBeNull();
	});

	test("warns when a result template drops the answer", () => {
		const warning = checkTemplate("result-note", "# {{title}}\n\n{{request}}");
		expect(warning).toContain("{{response}}");
		expect(warning).toContain("would not contain the answer");
	});

	test("names a misspelt variable and suggests the right one", () => {
		const warning = checkTemplate("result-note", "# {{title}}\n\n{{respnse}}");
		expect(warning).toContain("{{respnse}} is not a variable");
		expect(warning).toContain("Did you mean {{response}}?");
	});

	test("warns when an image template has no image", () => {
		expect(checkTemplate("image-note", "# {{title}}\n{{imagePrompt}}")).toContain("{{imageEmbed}}");
	});

	test("an empty workflow template is fine because it means use the global one", () => {
		expect(checkTemplate("workflow-result-note", "   ")).toBeNull();
		expect(checkTemplate("workflow-result-note", "no variables here")).toContain("{{response}}");
	});

	test("folder templates have no required variable but still flag unknown ones", () => {
		expect(checkTemplate("image-folder", "Images")).toBeNull();
		expect(checkTemplate("image-folder", "{{resultFoldr}}/Images")).toContain("{{resultFoldr}}");
	});

	test("does not suggest a variable when nothing is close", () => {
		expect(closestTemplateVariable("zzzzzz", ["title", "response"])).toBeNull();
		expect(checkTemplate("image-folder", "{{zzzzzz}}")).toContain("will be empty.");
	});
});

describe("reset to recommended settings", () => {
	test("covers options only, never keys, content or consent", () => {
		const protectedKeys: Array<keyof AskMateSettings> = [
			"providers", "providerRoles", "selectedTextProvider", "openAiApiKeySecretName", "customWorkflows", "globalInstructions", "folderInstructions",
			"workflowCustomInstructions", "threadStore", "noteHistoryStore", "reviewQueue", "tokenUsageStats", "skills", "diagrams", "mcp",
			"translationTargetLanguage", "additionalContextPaths", "folderContextPath", "styleGuideContextPath", "glossaryContextPath", "batchWorkflowFolderPath"
		];
		for (const key of protectedKeys) {
			expect(RESET_TO_RECOMMENDED_KEYS).not.toContain(key);
		}
	});

	test("puts every option back and leaves everything else as it was", () => {
		const settings = fresh();
		settings.composerLayout = "expanded";
		settings.outputMode = "apply";
		settings.requestPrivacyDefaults.includeNoteContext = false;
		settings.resultNoteTemplate = "changed";
		settings.usageDailyTokenBudget = 99;
		settings.globalInstructions = "Keep me";
		settings.skills.disabledIds = ["vault:x"];
		Object.assign(settings, buildRecommendedSettingsPatch());
		expect<string>(settings.composerLayout).toBe("compact");
		expect<string>(settings.outputMode).toBe(DEFAULT_SETTINGS.outputMode);
		expect(settings.requestPrivacyDefaults.includeNoteContext).toBe(true);
		expect(settings.resultNoteTemplate).toBe(DEFAULT_SETTINGS.resultNoteTemplate);
		expect(settings.usageDailyTokenBudget).toBe(0);
		expect(settings.globalInstructions).toBe("Keep me");
		expect(settings.skills.disabledIds).toEqual(["vault:x"]);
	});

	test("hands out copies, so applying it never edits the defaults", () => {
		const patch = buildRecommendedSettingsPatch();
		expect(patch.requestPrivacyDefaults).not.toBe(DEFAULT_SETTINGS.requestPrivacyDefaults);
		patch.requestPrivacyDefaults!.includeNoteContext = false;
		expect(DEFAULT_SETTINGS.requestPrivacyDefaults.includeNoteContext).toBe(true);
	});

	test("every key it writes is a real setting", () => {
		const settings = fresh();
		for (const key of RESET_TO_RECOMMENDED_KEYS) {
			expect(key in settings).toBe(true);
		}
	});
});

describe("length counters and normalisation messages", () => {
	test("counts characters and warns before the cut", () => {
		expect(describePromptLength(1234, 12000)).toBe("1,234 of 12,000 characters");
		expect(describePromptLength(12001, 12000)).toContain("AskMate will keep the first 12,000");
	});

	test("reports a cut or a replacement, and trims quietly", () => {
		expect(describePromptNormalisation("  fine  ", 10, "replaced")).toBeNull();
		expect(describePromptNormalisation("   ", 10, "replaced")).toBe("replaced");
		expect(describePromptNormalisation("   ", 10, null)).toBeNull();
		expect(describePromptNormalisation("x".repeat(11), 10, null)).toBe("Shortened to 10 characters.");
	});
});

describe("resolveBatchWorkflowId", () => {
	test("keeps the saved workflow while it exists", () => {
		expect(resolveBatchWorkflowId("b", ["a", "b"])).toBe("b");
	});

	test("falls back to the first workflow when the saved one was deleted", () => {
		expect(resolveBatchWorkflowId("custom-gone", ["study-summary", "b"])).toBe("study-summary");
	});

	test("keeps the saved id when there is nothing to choose from", () => {
		expect(resolveBatchWorkflowId("x", [])).toBe("x");
	});
});

describe("describeStoredTextDeletion", () => {
	test("reports success only when every store was cleared", () => {
		expect(describeStoredTextDeletion({ conversations: true, otherStores: true })).toEqual({
			ok: true,
			message: "AskMate deleted all saved conversations, note history and queued reviews."
		});
	});

	test("says which part failed", () => {
		expect(describeStoredTextDeletion({ conversations: false, otherStores: true }).message).toContain("could not delete the saved conversations");
		expect(describeStoredTextDeletion({ conversations: true, otherStores: false }).message).toContain("could not clear note history");
		const nothing = describeStoredTextDeletion({ conversations: false, otherStores: false });
		expect(nothing.ok).toBe(false);
		expect(nothing.message).toContain("nothing was changed");
	});
});
