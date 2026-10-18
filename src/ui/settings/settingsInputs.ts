import { MAX_CONTEXT_PATH_LENGTH, MAX_NOTE_HISTORY_TURNS, SKILL_MATCHING_MODES } from "../../settings/constants";
import { DEFAULT_SETTINGS, getFreshInstallDefaults } from "../../settings/defaults";
import {
	hasUnsafePathSegment,
	normalizeApplyApprovalMode,
	normalizeApplyScope,
	normalizeBudgetEnforcementMode,
	normalizeComposerLayout,
	normalizeContextBudgetMode,
	normalizeDiagramSettings,
	normalizeFrontmatterApplyPolicy,
	normalizeImagePromptPlanningProviderId,
	normalizeOptionalString,
	normalizeOutputMode,
	normalizeReasoningEffort,
	normalizeSendShortcut,
	normalizeSkillsSettings
} from "../../settings/normalize";
import { analyzeTemplate } from "../../output/templates";
import type { AskMateSettings, SkillMatchingMode } from "../../shared/types";

export interface IntegerBounds {
	min: number;
	max: number;
}

export type IntegerInputResult =
	| { kind: "ignored" }
	| { kind: "accepted"; value: number; clamped: boolean };

export type BaseUrlInputResult =
	| { kind: "restore-default"; value: string }
	| { kind: "accepted"; value: string }
	| { kind: "invalid"; message: string };

export type FolderPathInputResult =
	| { kind: "accepted"; value: string }
	| { kind: "unsafe" };

/**
 * Empty or non-numeric input is ignored rather than saved as 0 or the minimum,
 * because 0 disables usage guardrails and a low minimum can shrink limits the user did not mean to change.
 */
/** The zero of each digit set people commonly type: Arabic-Indic, Persian, Devanagari and full-width. */
const DIGIT_ZEROS = [0x0660, 0x06f0, 0x0966, 0xff10] as const;

/** Writes other digit sets as ASCII digits and drops thousands separators, so "۱٬۲۰۰" and "1,200" both read as 1200. */
export function toAsciiDigits(text: string): string {
	return text
		.replace(/[\u0660-\u0669\u06f0-\u06f9\u0966-\u096f\uff10-\uff19]/g, (digit) => {
			const code = digit.charCodeAt(0);
			const zero = DIGIT_ZEROS.find((start) => code >= start && code <= start + 9) ?? 0x30;
			return String(code - zero);
		})
		.replace(/[,\u066c\u2019' ]/g, "");
}

export function resolveIntegerInput(raw: string, bounds: IntegerBounds): IntegerInputResult {
	const trimmed = toAsciiDigits(raw.trim());
	const numeric = trimmed ? Number(trimmed) : NaN;
	if (!Number.isFinite(numeric)) {
		return { kind: "ignored" };
	}

	const rounded = Math.round(numeric);
	const value = Math.max(bounds.min, Math.min(bounds.max, rounded));
	return { kind: "accepted", value, clamped: value !== rounded };
}

export function formatIntegerRange(bounds: IntegerBounds): string {
	return `${bounds.min.toLocaleString("en-GB")} to ${bounds.max.toLocaleString("en-GB")}`;
}

/**
 * Mirrors the save-time folder normaliser, so the field can show the value that is kept
 * and refuse "." or ".." segments instead of letting the save silently replace them.
 */
export function resolveFolderPathInput(raw: string): FolderPathInputResult {
	const value = normalizeOptionalString(raw, MAX_CONTEXT_PATH_LENGTH);
	return hasUnsafePathSegment(value) ? { kind: "unsafe" } : { kind: "accepted", value };
}

/** An empty field is an explicit request for the default, so the caller can tell the user instead of saving it silently. */
export function resolveBaseUrlInput(raw: string, fallback: string, validate: (value: string, fallback: string) => string): BaseUrlInputResult {
	if (!raw.trim()) {
		return { kind: "restore-default", value: fallback };
	}

	try {
		return { kind: "accepted", value: validate(raw, fallback) };
	} catch (error) {
		return { kind: "invalid", message: error instanceof Error ? error.message : String(error) };
	}
}

/**
 * Obsidian keys settings rows and pages by their name, and duplicate names within a group break re-rendering
 * and page navigation, so repeated labels (two custom workflows called "New custom workflow") get a counter.
 */
export function uniqueLabels(labels: readonly string[]): string[] {
	const used = new Set<string>();
	return labels.map((label) => {
		let candidate = label;
		for (let counter = 2; used.has(candidate); counter += 1) {
			candidate = `${label} (${counter})`;
		}
		used.add(candidate);
		return candidate;
	});
}

interface SettingControlBinding {
	read: (settings: AskMateSettings) => unknown;
	write: (settings: AskMateSettings, value: unknown) => void;
}

type BooleanSettingKey = { [K in keyof AskMateSettings]: AskMateSettings[K] extends boolean ? K : never }[keyof AskMateSettings];

function booleanControl(key: BooleanSettingKey): SettingControlBinding {
	return {
		read: (settings) => settings[key],
		write: (settings, value) => {
			settings[key] = value === true;
		}
	};
}

// Declarative controls address settings by key; nested settings get a flat key here, and every write is normalised
// so a stale or unexpected value from the control cannot reach data.json.
const SETTING_CONTROLS = {
	sendShortcut: {
		read: (settings) => settings.sendShortcut,
		write: (settings, value) => {
			settings.sendShortcut = normalizeSendShortcut(value);
		}
	},
	composerLayout: {
		read: (settings) => settings.composerLayout,
		write: (settings, value) => {
			settings.composerLayout = normalizeComposerLayout(value);
		}
	},
	outputMode: {
		read: (settings) => settings.outputMode,
		write: (settings, value) => {
			settings.outputMode = normalizeOutputMode(value);
		}
	},
	contextBudgetMode: {
		read: (settings) => settings.contextBudgetMode,
		write: (settings, value) => {
			settings.contextBudgetMode = normalizeContextBudgetMode(value);
		}
	},
	reasoningEffort: {
		read: (settings) => settings.reasoningEffort,
		write: (settings, value) => {
			settings.reasoningEffort = normalizeReasoningEffort(value);
		}
	},
	partialApplyDefaultScope: {
		read: (settings) => settings.partialApplyDefaultScope,
		write: (settings, value) => {
			settings.partialApplyDefaultScope = normalizeApplyScope(value);
		}
	},
	applyApprovalMode: {
		read: (settings) => settings.applyApprovalMode,
		write: (settings, value) => {
			settings.applyApprovalMode = normalizeApplyApprovalMode(value, settings.showApplyPreview);
		}
	},
	frontmatterApplyPolicy: {
		read: (settings) => settings.frontmatterApplyPolicy,
		write: (settings, value) => {
			settings.frontmatterApplyPolicy = normalizeFrontmatterApplyPolicy(value);
		}
	},
	usageBudgetEnforcement: {
		read: (settings) => settings.usageBudgetEnforcement,
		write: (settings, value) => {
			settings.usageBudgetEnforcement = normalizeBudgetEnforcementMode(value);
		}
	},
	imagePromptPlanningProviderId: {
		read: (settings) => settings.providerRoles.imagePromptPlanningProviderId,
		write: (settings, value) => {
			settings.providerRoles.imagePromptPlanningProviderId = normalizeImagePromptPlanningProviderId(value);
		}
	},
	includeNoteContext: {
		read: (settings) => settings.requestPrivacyDefaults.includeNoteContext,
		write: (settings, value) => {
			settings.requestPrivacyDefaults.includeNoteContext = value === true;
		}
	},
	includeImageReferences: {
		read: (settings) => settings.requestPrivacyDefaults.includeImageReferences,
		write: (settings, value) => {
			settings.requestPrivacyDefaults.includeImageReferences = value === true;
		}
	},
	autoImageIntentEnabled: booleanControl("autoImageIntentEnabled"),
	editorContextMenuEnabled: booleanControl("editorContextMenuEnabled"),
	streamResponses: booleanControl("streamResponses"),
	showRequestPreview: booleanControl("showRequestPreview"),
	threadedChatEnabled: booleanControl("threadedChatEnabled"),
	folderContextEnabled: booleanControl("folderContextEnabled"),
	includeExcalidrawSummaries: booleanControl("includeExcalidrawSummaries"),
	includeImageManifests: booleanControl("includeImageManifests"),
	evidenceLinkedAnswersEnabled: booleanControl("evidenceLinkedAnswersEnabled"),
	noteHistoryEnabled: booleanControl("noteHistoryEnabled"),
	noteHistoryIncludeInContext: booleanControl("noteHistoryIncludeInContext"),
	saveConversations: booleanControl("saveConversations"),
	includeStyleGuideContext: booleanControl("includeStyleGuideContext"),
	includeGlossaryContext: booleanControl("includeGlossaryContext"),
	smartResultPlacementEnabled: booleanControl("smartResultPlacementEnabled"),
	appendResultBacklinkToSource: booleanControl("appendResultBacklinkToSource"),
	usageGuardrailsEnabled: booleanControl("usageGuardrailsEnabled"),
	noteMemoryMode: {
		read: (settings) => readNoteMemoryMode(settings),
		write: (settings, value) => {
			writeNoteMemoryMode(settings, value);
		}
	},
	// The skills, diagrams and MCP groups are rewritten through their own normalisers, which keep fields this build does not know.
	skillsEnabled: {
		read: (settings) => settings.skills.enabled,
		write: (settings, value) => {
			settings.skills = normalizeSkillsSettings({ ...settings.skills, enabled: value === true }, true);
		}
	},
	skillsMatching: {
		read: (settings) => settings.skills.matching,
		write: (settings, value) => {
			settings.skills = normalizeSkillsSettings({ ...settings.skills, matching: value }, true);
		}
	},
	skillsFolder: {
		read: (settings) => settings.skills.folder,
		write: (settings, value) => {
			settings.skills = normalizeSkillsSettings({ ...settings.skills, folder: value }, true);
		}
	},
	diagramsEnabled: {
		read: (settings) => settings.diagrams.enabled,
		write: (settings, value) => {
			settings.diagrams = normalizeDiagramSettings({ ...settings.diagrams, enabled: value === true }, true);
		}
	},
	diagramDefaultType: {
		read: (settings) => settings.diagrams.defaultType,
		write: (settings, value) => {
			settings.diagrams = normalizeDiagramSettings({ ...settings.diagrams, defaultType: value }, true);
		}
	},
	diagramDefaultStyle: {
		read: (settings) => settings.diagrams.defaultStyle,
		write: (settings, value) => {
			settings.diagrams = normalizeDiagramSettings({ ...settings.diagrams, defaultStyle: value }, true);
		}
	},
	diagramAllowRepair: {
		read: (settings) => settings.diagrams.allowRepairTurn,
		write: (settings, value) => {
			settings.diagrams = normalizeDiagramSettings({ ...settings.diagrams, allowRepairTurn: value === true }, true);
		}
	},
	// Only an explicit true turns tools on. The servers themselves are edited on the MCP page.
	mcpEnabled: {
		read: (settings) => settings.mcp.enabled,
		write: (settings, value) => {
			settings.mcp = { ...settings.mcp, enabled: value === true };
		}
	}
} satisfies Record<string, SettingControlBinding>;

export type SettingControlKey = keyof typeof SETTING_CONTROLS;

// A Map, so a key such as "toString" cannot resolve through the object prototype.
const SETTING_CONTROL_MAP: ReadonlyMap<string, SettingControlBinding> = new Map(Object.entries(SETTING_CONTROLS));

function getSettingControl(key: string): SettingControlBinding {
	const binding = SETTING_CONTROL_MAP.get(key);
	if (!binding) {
		throw new Error(`AskMate has no settings control named "${key}".`);
	}
	return binding;
}

export function readSettingControl(settings: AskMateSettings, key: string): unknown {
	return getSettingControl(key).read(settings);
}

export function writeSettingControl(settings: AskMateSettings, key: string, value: unknown): void {
	getSettingControl(key).write(settings, value);
}

// ---------------------------------------------------------------------------------------------------------------------
// Per-note memory: two stored switches shown as one choice
// ---------------------------------------------------------------------------------------------------------------------

export type NoteMemoryMode = "off" | "keep" | "keep-and-use";

export const NOTE_MEMORY_LABELS: Readonly<Record<NoteMemoryMode, string>> = {
	off: "Off",
	keep: "Keep only",
	"keep-and-use": "Keep and use"
};

type NoteMemorySettings = Pick<AskMateSettings, "noteHistoryEnabled" | "noteHistoryIncludeInContext">;

/** Keeping history is the switch that matters: using it as context is meaningless while nothing is recorded. */
export function readNoteMemoryMode(settings: NoteMemorySettings): NoteMemoryMode {
	if (!settings.noteHistoryEnabled) {
		return "off";
	}
	return settings.noteHistoryIncludeInContext ? "keep-and-use" : "keep";
}

export function normalizeNoteMemoryMode(value: unknown): NoteMemoryMode {
	return value === "keep" || value === "keep-and-use" ? value : "off";
}

export function writeNoteMemoryMode(settings: NoteMemorySettings, value: unknown): void {
	const mode = normalizeNoteMemoryMode(value);
	settings.noteHistoryEnabled = mode !== "off";
	settings.noteHistoryIncludeInContext = mode === "keep-and-use";
}

/** The description of the per-note memory control, which states the caps the store enforces. */
export function describeNoteMemory(perNoteTurns: number): string {
	return `Keep past answers for each note, and optionally send them as context. AskMate keeps the latest ${perNoteTurns.toLocaleString("en-GB")} turns per note and ${MAX_NOTE_HISTORY_TURNS.toLocaleString("en-GB")} in total.`;
}

// ---------------------------------------------------------------------------------------------------------------------
// Skills matching choices
// ---------------------------------------------------------------------------------------------------------------------

const SKILL_MATCHING_LABELS: Readonly<Record<SkillMatchingMode, string>> = {
	off: "Off, only skills I choose",
	suggest: "Suggest one skill",
	"builtin-auto": "Use built-in skills automatically",
	"all-auto": "Use built-in and approved vault skills automatically"
};

export const SKILL_MATCHING_OPTIONS: Readonly<Record<string, string>> = Object.fromEntries(SKILL_MATCHING_MODES.map((mode) => [mode, SKILL_MATCHING_LABELS[mode]]));

// ---------------------------------------------------------------------------------------------------------------------
// Template checks
// ---------------------------------------------------------------------------------------------------------------------

export type TemplateKind = "result-note" | "image-note" | "image-folder" | "image-file-name" | "workflow-result-note";

// These are the variables the plugin fills in when it renders each template (see buildCommonTemplateVariables and the image
// renderers). Anything else renders as nothing.
const COMMON_TEMPLATE_VARIABLES: readonly string[] = [
	"title", "sourceLink", "sourcePath", "noteTitle", "contextSource", "selectedText", "providerName", "model", "promptVersion",
	"intent", "outputMode", "workflowName", "workflowLine", "request", "response", "date", "dateTime", "currentDate", "currentDateTime",
	"customInstructions", "resultFolder"
];
const IMAGE_PLAN_VARIABLES: readonly string[] = ["imagePrompt", "revisedPrompt", "planningModel", "planningStatus", "planningFallback"];

export const TEMPLATE_RULES: Readonly<Record<TemplateKind, { known: readonly string[]; required: readonly string[]; consequence: string }>> = {
	"result-note": { known: COMMON_TEMPLATE_VARIABLES, required: ["response"], consequence: "New notes would not contain the answer." },
	"workflow-result-note": { known: COMMON_TEMPLATE_VARIABLES, required: ["response"], consequence: "New notes would not contain the answer." },
	"image-note": {
		known: [...COMMON_TEMPLATE_VARIABLES, ...IMAGE_PLAN_VARIABLES, "imageEmbed", "revisedPromptSection", "planningFallbackLine", "imageGenerationProviderName"],
		required: ["imageEmbed"],
		consequence: "New image notes would not show the image."
	},
	"image-folder": { known: [...COMMON_TEMPLATE_VARIABLES, ...IMAGE_PLAN_VARIABLES], required: [], consequence: "" },
	"image-file-name": { known: [...COMMON_TEMPLATE_VARIABLES, ...IMAGE_PLAN_VARIABLES], required: [], consequence: "" }
};

function editDistance(a: string, b: string): number {
	const row = Array.from({ length: b.length + 1 }, (_, index) => index);
	for (let i = 1; i <= a.length; i += 1) {
		let diagonal = row[0];
		row[0] = i;
		for (let j = 1; j <= b.length; j += 1) {
			const above = row[j];
			row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
			diagonal = above;
		}
	}
	return row[b.length];
}

/** The known variable a misspelt one most likely meant, or null when nothing is close. */
export function closestTemplateVariable(name: string, known: readonly string[]): string | null {
	const best = known
		.map((candidate) => ({ candidate, distance: editDistance(name.toLowerCase(), candidate.toLowerCase()) }))
		.sort((left, right) => left.distance - right.distance)[0];
	return best && best.distance <= Math.max(1, Math.floor(name.length / 3)) ? best.candidate : null;
}

/**
 * A warning for a template that would render badly, or null when it looks fine. An unknown variable renders as nothing and a
 * missing required one drops the answer, and both go unnoticed until a note is created, after the tokens were spent.
 * An empty workflow template is fine: it means "use the global template".
 */
export function checkTemplate(kind: TemplateKind, template: string): string | null {
	if (kind === "workflow-result-note" && !template.trim()) {
		return null;
	}
	const rules = TEMPLATE_RULES[kind];
	const analysis = analyzeTemplate(template, rules.known, rules.required);
	const parts: string[] = [];
	if (analysis.missingRequired.length > 0) {
		parts.push(`This template does not use ${analysis.missingRequired.map((name) => `{{${name}}}`).join(" or ")}. ${rules.consequence}`.trim());
	}
	if (analysis.unknown.length > 0) {
		parts.push(analysis.unknown.map((name) => {
			const suggestion = closestTemplateVariable(name, rules.known);
			return `{{${name}}} is not a variable and will be empty${suggestion ? `. Did you mean {{${suggestion}}}?` : "."}`;
		}).join(" "));
	}
	return parts.length > 0 ? parts.join(" ") : null;
}

// ---------------------------------------------------------------------------------------------------------------------
// Reset to recommended settings
// ---------------------------------------------------------------------------------------------------------------------

// Options only. Providers, keys, instructions, paths the person chose, workflows, saved text, usage records, skills, diagrams and
// tool servers are their content or their consent, so a reset never touches them.
const RESET_KEYS = [
	"sendShortcut", "composerLayout", "outputMode", "contextBudgetMode", "reasoningEffort", "showRequestPreview", "applyApprovalMode",
	"showApplyPreview", "partialApplyDefaultScope", "frontmatterApplyPolicy", "editorContextMenuEnabled", "showOnboardingTips",
	"onboardingTipsDismissedAt", "autoImageIntentEnabled", "streamResponses", "threadedChatEnabled", "threadedChatMaxTurns",
	"additionalContextMaxCharacters", "folderContextEnabled", "folderContextMaxFiles", "folderContextMaxCharacters",
	"includeExcalidrawSummaries", "excalidrawSummaryMaxCharacters", "includeImageManifests", "evidenceLinkedAnswersEnabled",
	"evidenceMaxSources", "noteHistoryEnabled", "noteHistoryIncludeInContext", "noteHistoryMaxTurnsPerNote", "saveConversations",
	"includeStyleGuideContext", "includeGlossaryContext", "reviewQueueMaxItems", "smartResultPlacementEnabled",
	"appendResultBacklinkToSource", "usageGuardrailsEnabled", "usageDailyTokenBudget", "usageMonthlyTokenBudget",
	"usagePerRequestWarningTokens", "usagePerRequestHardLimitTokens", "usageBudgetEnforcement", "resultFolder", "resultNoteTemplate",
	"imageResultNoteTemplate", "imageFolderTemplate", "imageFileNameTemplate", "requestPrivacyDefaults"
] as const satisfies readonly (keyof AskMateSettings)[];

export const RESET_TO_RECOMMENDED_KEYS: readonly (keyof AskMateSettings)[] = RESET_KEYS;

/**
 * The values "Reset to recommended settings" writes: the documented defaults with the fresh-install choices on top (Compact
 * layout, follow-ups on, guardrails warning), the way a new vault starts. The result is a copy, so applying it never shares
 * objects with the defaults.
 */
export function buildRecommendedSettingsPatch(): Partial<AskMateSettings> {
	const recommended: AskMateSettings = { ...structuredClone(DEFAULT_SETTINGS), ...structuredClone(getFreshInstallDefaults()) };
	return RESET_KEYS.reduce<Partial<AskMateSettings>>((patch, key) => ({ ...patch, [key]: recommended[key] }), {});
}

// ---------------------------------------------------------------------------------------------------------------------
// Length counters and what the saved value became
// ---------------------------------------------------------------------------------------------------------------------

/** The live counter under a long text field. It says so when the text is over the limit, before anything is cut. */
export function describePromptLength(length: number, max: number): string {
	const count = `${length.toLocaleString("en-GB")} of ${max.toLocaleString("en-GB")} characters`;
	return length > max ? `${count}. AskMate will keep the first ${max.toLocaleString("en-GB")}.` : count;
}

/**
 * What the saved prompt differs from what was typed, or null when they are the same. Surrounding spaces are trimmed without
 * comment; a cut or a replacement is reported, because the field would otherwise keep showing text that is not what is stored.
 */
export function describePromptNormalisation(typed: string, max: number, emptyReplacement: string | null): string | null {
	const trimmed = typed.trim();
	if (!trimmed && emptyReplacement !== null) {
		return emptyReplacement;
	}
	return trimmed.length > max ? `Shortened to ${max.toLocaleString("en-GB")} characters.` : null;
}

/** The workflow the batch runner should show: the saved one while it exists, otherwise the first one that does. */
export function resolveBatchWorkflowId(current: string, availableIds: readonly string[]): string {
	return availableIds.includes(current) ? current : availableIds[0] ?? current;
}

// ---------------------------------------------------------------------------------------------------------------------
// Which part of a stored-text deletion worked
// ---------------------------------------------------------------------------------------------------------------------

/** Wording for "Delete all stored AskMate text", which clears several stores and must say when one of them failed. */
export function describeStoredTextDeletion(outcome: { conversations: boolean; otherStores: boolean }): { ok: boolean; message: string } {
	if (outcome.conversations && outcome.otherStores) {
		return { ok: true, message: "AskMate deleted all saved conversations, note history and queued reviews." };
	}
	if (!outcome.conversations && !outcome.otherStores) {
		return { ok: false, message: "AskMate could not delete the stored text, so nothing was changed. Try again." };
	}
	return outcome.conversations
		? { ok: false, message: "AskMate deleted the saved conversations but could not clear note history and queued reviews. Try again." }
		: { ok: false, message: "AskMate cleared note history and queued reviews but could not delete the saved conversations. Try again." };
}
