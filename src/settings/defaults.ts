import { CURRENT_SETTINGS_VERSION, DEFAULT_ADDITIONAL_CONTEXT_MAX_CHARACTERS, DEFAULT_BATCH_WORKFLOW_MAX_FILES, DEFAULT_DIAGRAM_SETTINGS, DEFAULT_EVIDENCE_MAX_SOURCES, DEFAULT_EXCALIDRAW_SUMMARY_MAX_CHARACTERS, DEFAULT_FOLDER_CONTEXT_MAX_CHARACTERS, DEFAULT_FOLDER_CONTEXT_MAX_FILES, DEFAULT_IMAGE_FILE_NAME_TEMPLATE, DEFAULT_IMAGE_FOLDER_TEMPLATE, DEFAULT_IMAGE_RESULT_NOTE_TEMPLATE, DEFAULT_MCP_SETTINGS, DEFAULT_MODEL_OPTIONS, DEFAULT_NOTE_HISTORY_MAX_TURNS_PER_NOTE, DEFAULT_PROVIDER_ROLE_SETTINGS, DEFAULT_PROVIDER_SETTINGS, DEFAULT_REASONING_EFFORT, DEFAULT_REQUEST_PRIVACY_OPTIONS, DEFAULT_RESULT_NOTE_TEMPLATE, DEFAULT_REVIEW_QUEUE_MAX_ITEMS, DEFAULT_ROLE_CONTEXT_MAX_CHARACTERS, DEFAULT_SEND_SHORTCUT, DEFAULT_SKILLS_SETTINGS, DEFAULT_THREADED_CHAT_MAX_TURNS, DEFAULT_TRANSLATION_TARGET_LANGUAGE, DEFAULT_USAGE_PER_REQUEST_WARNING_TOKENS, MAX_TRANSLATION_TARGET_LANGUAGE_LENGTH } from "./constants";
import type { AskMateSettings } from "../shared/types";

export const DEFAULT_SETTINGS: AskMateSettings = {
	settingsVersion: CURRENT_SETTINGS_VERSION,
	openAiApiKeySecretName: "",
	model: "gpt-5.5",
	modelOptions: DEFAULT_MODEL_OPTIONS,
	selectedTextProvider: "openai",
	providerRoles: DEFAULT_PROVIDER_ROLE_SETTINGS,
	providers: DEFAULT_PROVIDER_SETTINGS,
	customWorkflows: [],
	requestPrivacyDefaults: DEFAULT_REQUEST_PRIVACY_OPTIONS,
	contextBudgetMode: "expanded",
	workflowDisplayPreferences: [],
	showRequestPreview: true,
	applyApprovalMode: "manual",
	showApplyPreview: true,
	outputMode: "chat",
	reasoningEffort: DEFAULT_REASONING_EFFORT,
	sendShortcut: DEFAULT_SEND_SHORTCUT,
	resultFolder: "AskMate",
	resultNoteTemplate: DEFAULT_RESULT_NOTE_TEMPLATE,
	imageResultNoteTemplate: DEFAULT_IMAGE_RESULT_NOTE_TEMPLATE,
	imageFolderTemplate: DEFAULT_IMAGE_FOLDER_TEMPLATE,
	imageFileNameTemplate: DEFAULT_IMAGE_FILE_NAME_TEMPLATE,
	translationTargetLanguage: DEFAULT_TRANSLATION_TARGET_LANGUAGE,
	workflowCustomInstructions: "",
	globalInstructions: "",
	folderInstructions: [],
	editorContextMenuEnabled: true,
	// The documented default, used for a missing or invalid value. A fresh install starts in Compact instead (see getFreshInstallDefaults).
	composerLayout: "console",
	consoleLayoutMigrated: true,
	showOnboardingTips: true,
	autoImageIntentEnabled: true,
	streamResponses: true,
	onboardingTipsDismissedAt: null,
	threadedChatEnabled: false,
	threadedChatMaxTurns: DEFAULT_THREADED_CHAT_MAX_TURNS,
	additionalContextPaths: [],
	additionalContextMaxCharacters: DEFAULT_ADDITIONAL_CONTEXT_MAX_CHARACTERS,
	folderContextEnabled: false,
	folderContextPath: "",
	folderContextMaxFiles: DEFAULT_FOLDER_CONTEXT_MAX_FILES,
	folderContextMaxCharacters: DEFAULT_FOLDER_CONTEXT_MAX_CHARACTERS,
	includeExcalidrawSummaries: false,
	excalidrawSummaryMaxCharacters: DEFAULT_EXCALIDRAW_SUMMARY_MAX_CHARACTERS,
	includeImageManifests: false,
	partialApplyDefaultScope: "auto",
	evidenceLinkedAnswersEnabled: true,
	evidenceMaxSources: DEFAULT_EVIDENCE_MAX_SOURCES,
	frontmatterApplyPolicy: "preserve",
	batchWorkflowFolderPath: "",
	batchWorkflowId: "study-summary",
	batchWorkflowMaxFiles: DEFAULT_BATCH_WORKFLOW_MAX_FILES,
	batchWorkflowOutputMode: "note",
	noteHistoryEnabled: true,
	noteHistoryIncludeInContext: false,
	noteHistoryMaxTurnsPerNote: DEFAULT_NOTE_HISTORY_MAX_TURNS_PER_NOTE,
	noteHistoryStore: { turns: [] },
	saveConversations: true,
	threadStore: { activeId: null, threads: [] },
	includeStyleGuideContext: false,
	styleGuideContextPath: "",
	styleGuideMaxCharacters: DEFAULT_ROLE_CONTEXT_MAX_CHARACTERS,
	includeGlossaryContext: false,
	glossaryContextPath: "",
	glossaryMaxCharacters: DEFAULT_ROLE_CONTEXT_MAX_CHARACTERS,
	reviewQueue: [],
	reviewQueueMaxItems: DEFAULT_REVIEW_QUEUE_MAX_ITEMS,
	smartResultPlacementEnabled: false,
	appendResultBacklinkToSource: false,
	usageGuardrailsEnabled: false,
	usageDailyTokenBudget: 0,
	usageMonthlyTokenBudget: 0,
	usagePerRequestWarningTokens: DEFAULT_USAGE_PER_REQUEST_WARNING_TOKENS,
	usagePerRequestHardLimitTokens: 0,
	usageBudgetEnforcement: "warn",
	tokenUsageStats: {
		records: []
	},
	skills: DEFAULT_SKILLS_SETTINGS,
	diagrams: DEFAULT_DIAGRAM_SETTINGS,
	mcp: DEFAULT_MCP_SETTINGS,
	firstRunCompletedAt: null,
	lastSeenVersion: null
};

/**
 * The language to translate into when the user has not chosen one, taken from the interface locale (for example "de" or "pt-BR").
 * An English, unknown or malformed locale gives English, so the result is always safe to use as the setting's value.
 */
export function defaultTranslationLanguage(locale: string | null | undefined): string {
	const tag = typeof locale === "string" ? locale.trim().replace(/_/g, "-") : "";
	const language = tag.split("-")[0].toLowerCase();
	// Intl.DisplayNames is missing from some older mobile WebViews, where English is the safe answer.
	if (!/^[a-z]{2,3}$/.test(language) || language === "en" || !("DisplayNames" in Intl)) {
		return DEFAULT_TRANSLATION_TARGET_LANGUAGE;
	}

	try {
		// "none" makes an unknown code return undefined instead of echoing the code back as if it were a language name.
		const label = new Intl.DisplayNames(["en"], { type: "language", fallback: "none" }).of(tag);
		return label?.trim() ? label.trim().slice(0, MAX_TRANSLATION_TARGET_LANGUAGE_LENGTH) : DEFAULT_TRANSLATION_TARGET_LANGUAGE;
	} catch (error: unknown) {
		// A structurally invalid tag (for example "de-@@") throws RangeError; any other error is a real problem.
		if (error instanceof RangeError) {
			return DEFAULT_TRANSLATION_TARGET_LANGUAGE;
		}
		throw error;
	}
}

/**
 * Defaults that apply only when no data.json existed, so existing users keep every choice they made.
 * Compact has a visible Send button and shows what is being sent. Follow-ups keep the thread for the default four turns.
 * Guardrails warn about large requests but never block, and no budget is set.
 */
export function getFreshInstallDefaults(options: { locale?: string | null } = {}): Partial<AskMateSettings> {
	return {
		composerLayout: "compact",
		threadedChatEnabled: true,
		usageGuardrailsEnabled: true,
		usageBudgetEnforcement: "warn",
		translationTargetLanguage: defaultTranslationLanguage(options.locale)
	};
}
