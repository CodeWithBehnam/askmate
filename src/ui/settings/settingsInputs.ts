import { MAX_CONTEXT_PATH_LENGTH } from "../../settings/constants";
import {
	hasUnsafePathSegment,
	normalizeApplyApprovalMode,
	normalizeApplyScope,
	normalizeBudgetEnforcementMode,
	normalizeComposerLayout,
	normalizeContextBudgetMode,
	normalizeFrontmatterApplyPolicy,
	normalizeImagePromptPlanningProviderId,
	normalizeOptionalString,
	normalizeOutputMode,
	normalizeReasoningEffort,
	normalizeSendShortcut
} from "../../settings/normalize";
import type { AskMateSettings } from "../../shared/types";

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
export function resolveIntegerInput(raw: string, bounds: IntegerBounds): IntegerInputResult {
	const trimmed = raw.trim();
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
	showRequestPreview: booleanControl("showRequestPreview"),
	threadedChatEnabled: booleanControl("threadedChatEnabled"),
	folderContextEnabled: booleanControl("folderContextEnabled"),
	includeExcalidrawSummaries: booleanControl("includeExcalidrawSummaries"),
	includeImageManifests: booleanControl("includeImageManifests"),
	evidenceLinkedAnswersEnabled: booleanControl("evidenceLinkedAnswersEnabled"),
	noteHistoryEnabled: booleanControl("noteHistoryEnabled"),
	noteHistoryIncludeInContext: booleanControl("noteHistoryIncludeInContext"),
	includeStyleGuideContext: booleanControl("includeStyleGuideContext"),
	includeGlossaryContext: booleanControl("includeGlossaryContext"),
	smartResultPlacementEnabled: booleanControl("smartResultPlacementEnabled"),
	appendResultBacklinkToSource: booleanControl("appendResultBacklinkToSource"),
	usageGuardrailsEnabled: booleanControl("usageGuardrailsEnabled")
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
