import { Editor, MarkdownView, Notice, Plugin, TFile, normalizePath, requestUrl } from "obsidian";
import {
	ApiEndpoint,
	ApplyScope,
	ASKMATE_PROMPT_VERSION,
	ASKMATE_VIEW_TYPE,
	AskMateHttpResponse,
	AskMateResult,
	AskMateSettings,
	AskRequest,
	BatchWorkflowProgress,
	BatchWorkflowRunOptions,
	BatchWorkflowSummary,
	BuildRequestOptions,
	ChatMessage,
	ContextAttachment,
	ContextAttachmentKind,
	ContextBudgetMode,
	CustomWorkflow,
	DEFAULT_ADDITIONAL_CONTEXT_MAX_CHARACTERS,
	DEFAULT_BATCH_WORKFLOW_MAX_FILES,
	DEFAULT_EVIDENCE_MAX_SOURCES,
	DEFAULT_EXCALIDRAW_SUMMARY_MAX_CHARACTERS,
	DEFAULT_FOLDER_CONTEXT_MAX_CHARACTERS,
	DEFAULT_FOLDER_CONTEXT_MAX_FILES,
	DEFAULT_IMAGE_FILE_NAME_TEMPLATE,
	DEFAULT_IMAGE_FOLDER_TEMPLATE,
	DEFAULT_IMAGE_PROMPT,
	DEFAULT_IMAGE_RESULT_NOTE_TEMPLATE,
	DEFAULT_MODEL_OPTIONS,
	DEFAULT_NOTE_HISTORY_MAX_TURNS_PER_NOTE,
	DEFAULT_PROVIDER_SETTINGS,
	DEFAULT_RESULT_NOTE_TEMPLATE,
	DEFAULT_REVIEW_QUEUE_MAX_ITEMS,
	DEFAULT_ROLE_CONTEXT_MAX_CHARACTERS,
	DEFAULT_SETTINGS,
	DEFAULT_THREADED_CHAT_MAX_TURNS,
	DEFAULT_USAGE_PER_REQUEST_WARNING_TOKENS,
	estimateTokenCount,
	EvidenceCitation,
	EvidenceSource,
	findExactOccurrences,
	FolderContextOptions,
	formatOperationStatus,
	formatOutputMode,
	formatRequestIntent,
	formatTokenCount,
	FrontmatterApplyResult,
	FrontmatterBlock,
	getContextBudgetOption,
	getModelCapability,
	getNonNegativeInteger,
	getProviderLabel,
	GPT_IMAGE_2_MODEL_ID,
	IMAGE_FILE_EXTENSIONS,
	IMAGE_MIME_TYPE,
	IMAGE_WORKFLOW_MESSAGE,
	ImageAskMateResult,
	ImagePromptExtraction,
	ImagePromptPlan,
	ImageReferenceInfo,
	isAbortError,
	isGpt55Model,
	isImageReferencePath,
	MarkdownHeadingSection,
	MAX_CONTEXT_IMAGE_PREVIEWS,
	MAX_CONTEXT_PATH_LENGTH,
	MAX_NOTE_HISTORY_ANSWER_CHARACTERS,
	MAX_NOTE_HISTORY_QUESTION_CHARACTERS,
	MAX_NOTE_HISTORY_TURNS,
	MAX_REVIEW_QUEUE_TEXT_CHARACTERS,
	MAX_TOKEN_USAGE_RECORDS,
	MAX_WORKFLOW_CUSTOM_INSTRUCTIONS_LENGTH,
	ModelCapability,
	normalizeApplyApprovalMode,
	normalizeApplyScope,
	normalizeBatchWorkflowOutputMode,
	normalizeBoolean,
	normalizeBoundedInteger,
	normalizeBudgetEnforcementMode,
	normalizeComposerLayout,
	normalizeContextBudgetMode,
	normalizeContextPathList,
	normalizeCustomWorkflow,
	normalizeCustomWorkflows,
	normalizeFrontmatterApplyPolicy,
	normalizeNoteHistoryStore,
	normalizeNullableIsoDate,
	normalizeOptionalString,
	normalizePlannedPrompt,
	normalizeProviderModelOptions,
	normalizeProviderRoleSettings,
	normalizeProviderSettings,
	normalizeReasoningEffort,
	normalizeRequestPrivacyOptions,
	normalizeReviewQueueItems,
	normalizeSendShortcut,
	normalizeTemplateString,
	normalizeTextProviderId,
	normalizeTokenUsageStats,
	normalizeTranslationTargetLanguage,
	normalizeWorkflowDisplayPreferences,
	NoteContext,
	NoteHistoryTurn,
	offsetToEditorPosition,
	OpenAITokenUsage,
	OperationKind,
	OperationStatus,
	PromptContextResult,
	PromptInspection,
	ProviderModelRef,
	ProviderSettings,
	ReasoningEffort,
	RequestIntentKind,
	RequestPrivacyOptions,
	ReviewQueueItem,
	summarizeTokenUsage,
	TextApplyPreviewScope,
	TextProviderId,
	TokenUsageRecord,
	TokenUsageSummary,
	UsageGuardrailResult,
	validateAzureOpenAIBaseUrl,
	Workflow,
	WorkflowDisplayPreference,
	WORKFLOWS
} from "../shared/core";
import {
	completeProviderTextRequest,
	extractOpenAIText,
	fetchProviderModels,
	formatProviderHttpError,
	getProviderTextEndpoint,
	normalizeOpenAIModelOptions,
	requestOpenAIImageGeneration,
	requestOpenAIResponses,
	testProviderConnection as testProviderConnectionWithProvider
} from "../providers";
import type { ProviderRequestOptions, ProviderRuntime } from "../providers";
import { askMateConfirm, askMateDiffConfirm } from "../ui/modals/modals";
import { AskMateView } from "../ui/sidebar/AskMateView";
import { AskMateSettingTab } from "../ui/settings/AskMateSettingTab";

export class AskMatePlugin extends Plugin {
	settings: AskMateSettings;
	private lastMarkdownView: MarkdownView | null = null;
	private lastMarkdownFile: TFile | null = null;
	private lastNoteContext: NoteContext | null = null;

	private getProviderRuntime(): ProviderRuntime {
		return {
			getProviderSettings: (providerId) => this.getProviderSettings(providerId),
			getProviderApiKey: (providerId) => this.getProviderApiKey(providerId),
			requestJson: async <T>(url: string, options?: ProviderRequestOptions) => await this.requestJson<T>(url, options)
		};
	}

	async onload(): Promise<void> {
		await this.loadSettings();

		this.registerView(ASKMATE_VIEW_TYPE, (leaf) => new AskMateView(leaf, this));
		this.registerEvent(
			this.app.workspace.on("active-leaf-change", () => {
				this.rememberActiveMarkdownContext();
			})
		);
		this.registerEvent(
			this.app.workspace.on("file-open", (file) => {
				this.rememberMarkdownFile(file);
				this.rememberActiveMarkdownContext();
			})
		);
		this.registerEvent(
			this.app.workspace.on("editor-change", (editor, info) => {
				this.rememberEditorContext(editor, info.file ?? null);
			})
		);
		this.app.workspace.onLayoutReady(() => {
			this.rememberActiveMarkdownContext();
		});

		this.addRibbonIcon("bot", "Open AskMate", () => {
			void this.activateView();
		});

		this.addCommand({
			id: "open-sidebar",
			name: "Open sidebar",
			callback: () => {
				void this.activateView();
			}
		});

		this.addCommand({
			id: "ask-current-note",
			name: "Ask about current note",
			editorCallback: (editor, ctx) => {
				this.rememberEditorContext(editor, ctx.file ?? null);
				void this.activateView();
			}
		});

		this.addCommand({
			id: "generate-image-current-note",
			name: "Generate image from current note",
			editorCallback: (editor, ctx) => {
				this.rememberEditorContext(editor, ctx.file ?? null);
				void this.runImageFromCommand(editor, ctx.file ?? null);
			}
		});

		for (const workflow of WORKFLOWS) {
			this.addCommand({
				id: workflow.commandId,
				name: workflow.name,
				editorCallback: async (editor, ctx) => {
					await this.runWorkflowFromCommand(workflow, editor, ctx.file ?? null);
				}
			});
		}

		this.addCommand({
			id: "test-provider-connection",
			name: "Test provider connection",
			callback: async () => {
				try {
					const message = await this.testSelectedProviderConnection();
					new Notice(message);
				} catch (error) {
					new Notice(this.getErrorMessage(error));
				}
			}
		});

		this.addSettingTab(new AskMateSettingTab(this.app, this));
	}

	async loadSettings(): Promise<void> {
		const raw = await this.loadData() as Partial<AskMateSettings> | null;
		const loaded = Object.assign({}, DEFAULT_SETTINGS, raw) as AskMateSettings;
		const legacy = {
			openAiApiKeySecretName: typeof loaded.openAiApiKeySecretName === "string" ? loaded.openAiApiKeySecretName : "",
			model: typeof loaded.model === "string" ? loaded.model : DEFAULT_SETTINGS.model,
			modelOptions: Array.isArray(loaded.modelOptions) ? loaded.modelOptions : DEFAULT_MODEL_OPTIONS
		};
		this.settings = loaded;
		this.settings.selectedTextProvider = normalizeTextProviderId(loaded.selectedTextProvider);
		this.settings.providerRoles = normalizeProviderRoleSettings(raw?.providerRoles, raw?.selectedTextProvider ?? this.settings.selectedTextProvider);
		this.settings.selectedTextProvider = this.settings.providerRoles.chatProviderId;
		this.settings.providers = normalizeProviderSettings(loaded.providers, legacy);
		this.settings.openAiApiKeySecretName = this.settings.providers.openai.apiKeySecretName;
		this.settings.model = this.settings.providers.openai.model;
		this.settings.modelOptions = normalizeOpenAIModelOptions(
			this.settings.providers.openai.modelOptions,
			DEFAULT_MODEL_OPTIONS,
			this.settings.providers.openai.model
		);
		this.settings.providers.openai.modelOptions = this.settings.modelOptions;
		this.settings.customWorkflows = normalizeCustomWorkflows(this.settings.customWorkflows);
		this.settings.requestPrivacyDefaults = normalizeRequestPrivacyOptions(this.settings.requestPrivacyDefaults);
		this.settings.contextBudgetMode = normalizeContextBudgetMode(this.settings.contextBudgetMode);
		this.settings.workflowDisplayPreferences = normalizeWorkflowDisplayPreferences(this.settings.workflowDisplayPreferences);
		this.settings.showRequestPreview = this.settings.showRequestPreview !== false;
		this.settings.applyApprovalMode = normalizeApplyApprovalMode(raw?.applyApprovalMode, raw?.showApplyPreview);
		this.settings.showApplyPreview = this.settings.applyApprovalMode === "manual";
		this.settings.reasoningEffort = normalizeReasoningEffort(this.settings.reasoningEffort);
		this.settings.sendShortcut = normalizeSendShortcut(this.settings.sendShortcut);
		this.settings.translationTargetLanguage = normalizeTranslationTargetLanguage(this.settings.translationTargetLanguage);
		this.settings.workflowCustomInstructions = normalizeOptionalString(this.settings.workflowCustomInstructions, MAX_WORKFLOW_CUSTOM_INSTRUCTIONS_LENGTH);
		this.settings.resultNoteTemplate = normalizeTemplateString(this.settings.resultNoteTemplate, DEFAULT_RESULT_NOTE_TEMPLATE);
		this.settings.imageResultNoteTemplate = normalizeTemplateString(this.settings.imageResultNoteTemplate, DEFAULT_IMAGE_RESULT_NOTE_TEMPLATE);
		this.settings.imageFolderTemplate = normalizeTemplateString(this.settings.imageFolderTemplate, DEFAULT_IMAGE_FOLDER_TEMPLATE);
		this.settings.imageFileNameTemplate = normalizeTemplateString(this.settings.imageFileNameTemplate, DEFAULT_IMAGE_FILE_NAME_TEMPLATE);
		this.settings.composerLayout = normalizeComposerLayout(this.settings.composerLayout);
		this.settings.showOnboardingTips = this.settings.showOnboardingTips !== false;
		this.settings.onboardingTipsDismissedAt = normalizeNullableIsoDate(this.settings.onboardingTipsDismissedAt);
		this.settings.threadedChatEnabled = normalizeBoolean(this.settings.threadedChatEnabled, false);
		this.settings.threadedChatMaxTurns = normalizeBoundedInteger(this.settings.threadedChatMaxTurns, DEFAULT_THREADED_CHAT_MAX_TURNS, 1, 12);
		this.settings.additionalContextPaths = normalizeContextPathList(this.settings.additionalContextPaths);
		this.settings.additionalContextMaxCharacters = normalizeBoundedInteger(this.settings.additionalContextMaxCharacters, DEFAULT_ADDITIONAL_CONTEXT_MAX_CHARACTERS, 1000, 100000);
		this.settings.folderContextEnabled = normalizeBoolean(this.settings.folderContextEnabled, false);
		this.settings.folderContextPath = normalizeOptionalString(this.settings.folderContextPath, MAX_CONTEXT_PATH_LENGTH);
		this.settings.folderContextMaxFiles = normalizeBoundedInteger(this.settings.folderContextMaxFiles, DEFAULT_FOLDER_CONTEXT_MAX_FILES, 1, 100);
		this.settings.folderContextMaxCharacters = normalizeBoundedInteger(this.settings.folderContextMaxCharacters, DEFAULT_FOLDER_CONTEXT_MAX_CHARACTERS, 1000, 200000);
		this.settings.includeExcalidrawSummaries = normalizeBoolean(this.settings.includeExcalidrawSummaries, false);
		this.settings.excalidrawSummaryMaxCharacters = normalizeBoundedInteger(this.settings.excalidrawSummaryMaxCharacters, DEFAULT_EXCALIDRAW_SUMMARY_MAX_CHARACTERS, 1000, 100000);
		this.settings.includeImageManifests = normalizeBoolean(this.settings.includeImageManifests, false);
		this.settings.partialApplyDefaultScope = normalizeApplyScope(this.settings.partialApplyDefaultScope);
		this.settings.evidenceLinkedAnswersEnabled = normalizeBoolean(this.settings.evidenceLinkedAnswersEnabled, true);
		this.settings.evidenceMaxSources = normalizeBoundedInteger(this.settings.evidenceMaxSources, DEFAULT_EVIDENCE_MAX_SOURCES, 1, 200);
		this.settings.frontmatterApplyPolicy = normalizeFrontmatterApplyPolicy(this.settings.frontmatterApplyPolicy);
		this.settings.batchWorkflowFolderPath = normalizeOptionalString(this.settings.batchWorkflowFolderPath, MAX_CONTEXT_PATH_LENGTH);
		this.settings.batchWorkflowId = normalizeOptionalString(this.settings.batchWorkflowId, 120) || "study-summary";
		this.settings.batchWorkflowMaxFiles = normalizeBoundedInteger(this.settings.batchWorkflowMaxFiles, DEFAULT_BATCH_WORKFLOW_MAX_FILES, 1, 100);
		this.settings.batchWorkflowOutputMode = normalizeBatchWorkflowOutputMode(this.settings.batchWorkflowOutputMode);
		this.settings.noteHistoryEnabled = normalizeBoolean(this.settings.noteHistoryEnabled, true);
		this.settings.noteHistoryIncludeInContext = normalizeBoolean(this.settings.noteHistoryIncludeInContext, false);
		this.settings.noteHistoryMaxTurnsPerNote = normalizeBoundedInteger(this.settings.noteHistoryMaxTurnsPerNote, DEFAULT_NOTE_HISTORY_MAX_TURNS_PER_NOTE, 1, 40);
		this.settings.noteHistoryStore = normalizeNoteHistoryStore(this.settings.noteHistoryStore);
		this.settings.includeStyleGuideContext = normalizeBoolean(this.settings.includeStyleGuideContext, false);
		this.settings.styleGuideContextPath = normalizeOptionalString(this.settings.styleGuideContextPath, MAX_CONTEXT_PATH_LENGTH);
		this.settings.styleGuideMaxCharacters = normalizeBoundedInteger(this.settings.styleGuideMaxCharacters, DEFAULT_ROLE_CONTEXT_MAX_CHARACTERS, 1000, 100000);
		this.settings.includeGlossaryContext = normalizeBoolean(this.settings.includeGlossaryContext, false);
		this.settings.glossaryContextPath = normalizeOptionalString(this.settings.glossaryContextPath, MAX_CONTEXT_PATH_LENGTH);
		this.settings.glossaryMaxCharacters = normalizeBoundedInteger(this.settings.glossaryMaxCharacters, DEFAULT_ROLE_CONTEXT_MAX_CHARACTERS, 1000, 100000);
		this.settings.reviewQueueMaxItems = normalizeBoundedInteger(this.settings.reviewQueueMaxItems, DEFAULT_REVIEW_QUEUE_MAX_ITEMS, 1, 200);
		this.settings.reviewQueue = normalizeReviewQueueItems(this.settings.reviewQueue, this.settings.reviewQueueMaxItems);
		this.settings.smartResultPlacementEnabled = normalizeBoolean(this.settings.smartResultPlacementEnabled, false);
		this.settings.appendResultBacklinkToSource = normalizeBoolean(this.settings.appendResultBacklinkToSource, false);
		this.settings.usageGuardrailsEnabled = normalizeBoolean(this.settings.usageGuardrailsEnabled, false);
		this.settings.usageDailyTokenBudget = normalizeBoundedInteger(this.settings.usageDailyTokenBudget, 0, 0, 10000000);
		this.settings.usageMonthlyTokenBudget = normalizeBoundedInteger(this.settings.usageMonthlyTokenBudget, 0, 0, 100000000);
		this.settings.usagePerRequestWarningTokens = normalizeBoundedInteger(this.settings.usagePerRequestWarningTokens, DEFAULT_USAGE_PER_REQUEST_WARNING_TOKENS, 0, 10000000);
		this.settings.usagePerRequestHardLimitTokens = normalizeBoundedInteger(this.settings.usagePerRequestHardLimitTokens, 0, 0, 10000000);
		this.settings.usageBudgetEnforcement = normalizeBudgetEnforcementMode(this.settings.usageBudgetEnforcement);
		this.settings.tokenUsageStats = normalizeTokenUsageStats(this.settings.tokenUsageStats);
	}

	async saveSettings(): Promise<void> {
		this.settings.providerRoles = normalizeProviderRoleSettings(this.settings.providerRoles, this.settings.selectedTextProvider);
		this.settings.selectedTextProvider = this.settings.providerRoles.chatProviderId;
		this.settings.openAiApiKeySecretName = this.settings.providers.openai.apiKeySecretName;
		this.settings.model = this.settings.providers.openai.model;
		this.settings.modelOptions = normalizeOpenAIModelOptions(
			this.settings.providers.openai.modelOptions,
			[],
			this.settings.providers.openai.model
		);
		this.settings.providers.openai.modelOptions = this.settings.modelOptions;
		this.settings.customWorkflows = normalizeCustomWorkflows(this.settings.customWorkflows);
		this.settings.requestPrivacyDefaults = normalizeRequestPrivacyOptions(this.settings.requestPrivacyDefaults);
		this.settings.contextBudgetMode = normalizeContextBudgetMode(this.settings.contextBudgetMode);
		this.settings.workflowDisplayPreferences = normalizeWorkflowDisplayPreferences(this.settings.workflowDisplayPreferences);
		this.settings.applyApprovalMode = normalizeApplyApprovalMode(this.settings.applyApprovalMode, this.settings.showApplyPreview);
		this.settings.showApplyPreview = this.settings.applyApprovalMode === "manual";
		this.settings.workflowCustomInstructions = normalizeOptionalString(this.settings.workflowCustomInstructions, MAX_WORKFLOW_CUSTOM_INSTRUCTIONS_LENGTH);
		this.settings.resultNoteTemplate = normalizeTemplateString(this.settings.resultNoteTemplate, DEFAULT_RESULT_NOTE_TEMPLATE);
		this.settings.imageResultNoteTemplate = normalizeTemplateString(this.settings.imageResultNoteTemplate, DEFAULT_IMAGE_RESULT_NOTE_TEMPLATE);
		this.settings.imageFolderTemplate = normalizeTemplateString(this.settings.imageFolderTemplate, DEFAULT_IMAGE_FOLDER_TEMPLATE);
		this.settings.imageFileNameTemplate = normalizeTemplateString(this.settings.imageFileNameTemplate, DEFAULT_IMAGE_FILE_NAME_TEMPLATE);
		this.settings.composerLayout = normalizeComposerLayout(this.settings.composerLayout);
		this.settings.onboardingTipsDismissedAt = normalizeNullableIsoDate(this.settings.onboardingTipsDismissedAt);
		this.settings.threadedChatEnabled = normalizeBoolean(this.settings.threadedChatEnabled, false);
		this.settings.threadedChatMaxTurns = normalizeBoundedInteger(this.settings.threadedChatMaxTurns, DEFAULT_THREADED_CHAT_MAX_TURNS, 1, 12);
		this.settings.additionalContextPaths = normalizeContextPathList(this.settings.additionalContextPaths);
		this.settings.additionalContextMaxCharacters = normalizeBoundedInteger(this.settings.additionalContextMaxCharacters, DEFAULT_ADDITIONAL_CONTEXT_MAX_CHARACTERS, 1000, 100000);
		this.settings.folderContextEnabled = normalizeBoolean(this.settings.folderContextEnabled, false);
		this.settings.folderContextPath = normalizeOptionalString(this.settings.folderContextPath, MAX_CONTEXT_PATH_LENGTH);
		this.settings.folderContextMaxFiles = normalizeBoundedInteger(this.settings.folderContextMaxFiles, DEFAULT_FOLDER_CONTEXT_MAX_FILES, 1, 100);
		this.settings.folderContextMaxCharacters = normalizeBoundedInteger(this.settings.folderContextMaxCharacters, DEFAULT_FOLDER_CONTEXT_MAX_CHARACTERS, 1000, 200000);
		this.settings.includeExcalidrawSummaries = normalizeBoolean(this.settings.includeExcalidrawSummaries, false);
		this.settings.excalidrawSummaryMaxCharacters = normalizeBoundedInteger(this.settings.excalidrawSummaryMaxCharacters, DEFAULT_EXCALIDRAW_SUMMARY_MAX_CHARACTERS, 1000, 100000);
		this.settings.includeImageManifests = normalizeBoolean(this.settings.includeImageManifests, false);
		this.settings.partialApplyDefaultScope = normalizeApplyScope(this.settings.partialApplyDefaultScope);
		this.settings.evidenceLinkedAnswersEnabled = normalizeBoolean(this.settings.evidenceLinkedAnswersEnabled, true);
		this.settings.evidenceMaxSources = normalizeBoundedInteger(this.settings.evidenceMaxSources, DEFAULT_EVIDENCE_MAX_SOURCES, 1, 200);
		this.settings.frontmatterApplyPolicy = normalizeFrontmatterApplyPolicy(this.settings.frontmatterApplyPolicy);
		this.settings.batchWorkflowFolderPath = normalizeOptionalString(this.settings.batchWorkflowFolderPath, MAX_CONTEXT_PATH_LENGTH);
		this.settings.batchWorkflowId = normalizeOptionalString(this.settings.batchWorkflowId, 120) || "study-summary";
		this.settings.batchWorkflowMaxFiles = normalizeBoundedInteger(this.settings.batchWorkflowMaxFiles, DEFAULT_BATCH_WORKFLOW_MAX_FILES, 1, 100);
		this.settings.batchWorkflowOutputMode = normalizeBatchWorkflowOutputMode(this.settings.batchWorkflowOutputMode);
		this.settings.noteHistoryEnabled = normalizeBoolean(this.settings.noteHistoryEnabled, true);
		this.settings.noteHistoryIncludeInContext = normalizeBoolean(this.settings.noteHistoryIncludeInContext, false);
		this.settings.noteHistoryMaxTurnsPerNote = normalizeBoundedInteger(this.settings.noteHistoryMaxTurnsPerNote, DEFAULT_NOTE_HISTORY_MAX_TURNS_PER_NOTE, 1, 40);
		this.settings.noteHistoryStore = normalizeNoteHistoryStore(this.settings.noteHistoryStore);
		this.settings.includeStyleGuideContext = normalizeBoolean(this.settings.includeStyleGuideContext, false);
		this.settings.styleGuideContextPath = normalizeOptionalString(this.settings.styleGuideContextPath, MAX_CONTEXT_PATH_LENGTH);
		this.settings.styleGuideMaxCharacters = normalizeBoundedInteger(this.settings.styleGuideMaxCharacters, DEFAULT_ROLE_CONTEXT_MAX_CHARACTERS, 1000, 100000);
		this.settings.includeGlossaryContext = normalizeBoolean(this.settings.includeGlossaryContext, false);
		this.settings.glossaryContextPath = normalizeOptionalString(this.settings.glossaryContextPath, MAX_CONTEXT_PATH_LENGTH);
		this.settings.glossaryMaxCharacters = normalizeBoundedInteger(this.settings.glossaryMaxCharacters, DEFAULT_ROLE_CONTEXT_MAX_CHARACTERS, 1000, 100000);
		this.settings.reviewQueueMaxItems = normalizeBoundedInteger(this.settings.reviewQueueMaxItems, DEFAULT_REVIEW_QUEUE_MAX_ITEMS, 1, 200);
		this.settings.reviewQueue = normalizeReviewQueueItems(this.settings.reviewQueue, this.settings.reviewQueueMaxItems);
		this.settings.smartResultPlacementEnabled = normalizeBoolean(this.settings.smartResultPlacementEnabled, false);
		this.settings.appendResultBacklinkToSource = normalizeBoolean(this.settings.appendResultBacklinkToSource, false);
		this.settings.usageGuardrailsEnabled = normalizeBoolean(this.settings.usageGuardrailsEnabled, false);
		this.settings.usageDailyTokenBudget = normalizeBoundedInteger(this.settings.usageDailyTokenBudget, 0, 0, 10000000);
		this.settings.usageMonthlyTokenBudget = normalizeBoundedInteger(this.settings.usageMonthlyTokenBudget, 0, 0, 100000000);
		this.settings.usagePerRequestWarningTokens = normalizeBoundedInteger(this.settings.usagePerRequestWarningTokens, DEFAULT_USAGE_PER_REQUEST_WARNING_TOKENS, 0, 10000000);
		this.settings.usagePerRequestHardLimitTokens = normalizeBoundedInteger(this.settings.usagePerRequestHardLimitTokens, 0, 0, 10000000);
		this.settings.usageBudgetEnforcement = normalizeBudgetEnforcementMode(this.settings.usageBudgetEnforcement);
		this.settings.tokenUsageStats = normalizeTokenUsageStats(this.settings.tokenUsageStats);
		await this.saveData(this.settings);
	}

	async activateView(): Promise<void> {
		this.rememberActiveMarkdownContext();

		const existing = this.app.workspace.getLeavesOfType(ASKMATE_VIEW_TYPE)[0];

		if (existing) {
			await this.app.workspace.revealLeaf(existing);
			return;
		}

		const leaf = this.app.workspace.getRightLeaf(false);

		if (!leaf) {
			new Notice("AskMate could not open the right sidebar.");
			return;
		}

		await leaf.setViewState({
			type: ASKMATE_VIEW_TYPE,
			active: true
		});
		await this.app.workspace.revealLeaf(leaf);
	}

	rememberActiveMarkdownContext(): void {
		const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
		this.rememberMarkdownFile(this.app.workspace.getActiveFile());

		if (!activeView) {
			return;
		}

		this.lastMarkdownView = activeView;
		this.rememberEditorContext(activeView.editor, activeView.file ?? null);
	}

	async getNoteContext(editor?: Editor, file?: TFile | null): Promise<NoteContext> {
		const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);

		if (editor) {
			const context = this.tryCreateNoteContext(editor, file ?? activeView?.file ?? null);

			if (context) {
				this.rememberEditorContext(editor, context.file);
				return context;
			}

			this.lastNoteContext = null;
		}

		if (activeView) {
			const context = this.tryCreateNoteContext(activeView.editor, activeView.file ?? null);
			this.lastMarkdownView = activeView;
			this.rememberMarkdownFile(activeView.file ?? null);
			this.lastNoteContext = context;

			if (context) {
				return context;
			}
		}

		const lastOpenView = this.getLastOpenMarkdownView();

		if (
			this.lastNoteContext?.source === "Selected text" &&
			(!lastOpenView || this.lastNoteContext.file === lastOpenView.file)
		) {
			return this.lastNoteContext;
		}

		if (lastOpenView) {
			const context = this.tryCreateNoteContext(lastOpenView.editor, lastOpenView.file ?? null);
			this.lastNoteContext = context;

			if (context) {
				return context;
			}
		}

		const fileContext = await this.tryCreateFileContext(file ?? lastOpenView?.file ?? this.lastMarkdownFile);

		if (fileContext) {
			this.lastNoteContext = fileContext;
			return fileContext;
		}

		throw new Error("Open a Markdown note or select text before using AskMate.");
	}

	private rememberEditorContext(editor: Editor, file: TFile | null): void {
		const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);

		if (activeView?.editor === editor) {
			this.lastMarkdownView = activeView;
		}

		this.rememberMarkdownFile(file);
		this.lastNoteContext = this.tryCreateNoteContext(editor, file);
	}

	private rememberMarkdownFile(file: TFile | null): void {
		if (file?.extension === "md") {
			this.lastMarkdownFile = file;
		}
	}

	private tryCreateNoteContext(editor: Editor | undefined, file: TFile | null): NoteContext | null {
		const selectedText = editor?.getSelection().trim() ?? "";

		if (selectedText.length > 0) {
			const fullValue = editor?.getValue() ?? "";
			const from = editor?.getCursor("from");
			const to = editor?.getCursor("to");
			return {
				content: selectedText,
				file,
				source: "Selected text",
				activeHeadingPath: editor ? this.getActiveHeadingPath(fullValue, editor.getCursor().line) : null,
				selectionStartLine: from ? from.line + 1 : null,
				selectionEndLine: to ? to.line + 1 : null
			};
		}

		if (!editor) {
			return null;
		}

		const fullNote = editor.getValue().trim();

		if (fullNote.length > 0 || file?.extension === "md") {
			return {
				content: fullNote,
				file,
				source: "Current note",
				activeHeadingPath: this.getActiveHeadingPath(editor.getValue(), editor.getCursor().line),
				selectionStartLine: null,
				selectionEndLine: null
			};
		}

		return null;
	}

	private async tryCreateFileContext(file: TFile | null | undefined): Promise<NoteContext | null> {
		if (!file || file.extension !== "md") {
			return null;
		}

		return await this.getFileNoteContext(file);
	}

	private async getFileNoteContext(file: TFile): Promise<NoteContext> {
		const content = (await this.app.vault.cachedRead(file)).trim();
		return {
			content,
			file,
			source: "Current note",
			selectionStartLine: null,
			selectionEndLine: null
		};
	}

	private getLastOpenMarkdownView(): MarkdownView | null {
		if (!this.lastMarkdownView) {
			return null;
		}

		const isStillOpen = this.app.workspace
			.getLeavesOfType("markdown")
			.some((leaf) => leaf.view === this.lastMarkdownView);

		if (!isStillOpen) {
			this.lastMarkdownView = null;
			this.lastNoteContext = null;
			return null;
		}

		return this.lastMarkdownView;
	}

	private getOpenMarkdownViewForFile(file: TFile | null | undefined): MarkdownView | null {
		if (!file) {
			return null;
		}

		for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
			if (leaf.view instanceof MarkdownView && leaf.view.file?.path === file.path) {
				return leaf.view;
			}
		}

		return null;
	}

	private getActiveHeadingPath(markdown: string, cursorLine: number): string | null {
		const sections = this.parseMarkdownHeadingSections(markdown);
		const active = sections
			.filter((section) => section.headingLine <= cursorLine)
			.sort((a, b) => b.headingLine - a.headingLine)[0];
		return active?.path ?? null;
	}

	classifyRequestIntent(question: string, options: Pick<BuildRequestOptions, "forceImage" | "workflow" | "intentKind" | "autoImage"> = {}): RequestIntentKind {
		if (options.intentKind) {
			return options.intentKind;
		}

		if (options.workflow) {
			return "workflow";
		}

		if (options.forceImage === true || this.getSelectedProviderModelRef().capability === "image") {
			return "explicit_image";
		}

		if (options.autoImage === true || this.shouldGenerateImageFromQuestion(question)) {
			return "auto_image";
		}

		return "freeform_text";
	}

	private formatSourceLink(file: TFile | null): string {
		return file ? `[[${file.path}|${file.basename}]]` : "No active note";
	}

	private throwIfAborted(abortSignal?: AbortSignal): void {
		if (abortSignal?.aborted) {
			throw new Error("Request was stopped.");
		}
	}

	private async requestJson<T>(
		url: string,
		options: ProviderRequestOptions = {}
	): Promise<AskMateHttpResponse<T>> {
		this.throwIfAborted(options.abortSignal);
		let timer: number | null = null;
		const request = requestUrl({
			url,
			method: options.method ?? "GET",
			headers: options.headers,
			body: options.body,
			throw: false
		});
		const timedRequest = options.timeoutMs
			? Promise.race([
				request,
				new Promise<never>((_resolve, reject) => {
					timer = window.setTimeout(() => reject(new Error(options.timeoutMessage ?? "Request timed out.")), options.timeoutMs);
				})
			])
			: request;

		try {
			const response = await timedRequest;
			this.throwIfAborted(options.abortSignal);
			const text = typeof response.text === "string" ? response.text : "";
			let body: T | null = null;

			if (response.json && typeof response.json === "object") {
				body = response.json as T;
			} else if (text.trim()) {
				try {
					body = JSON.parse(text) as T;
				} catch {
					body = null;
				}
			}

			return {
				status: response.status,
				ok: response.status >= 200 && response.status < 300,
				body,
				text
			};
		} finally {
			if (timer !== null) {
				window.clearTimeout(timer);
			}
		}
	}

	async askOpenAI(request: AskRequest): Promise<string> {
		if (request.metadata.modelCapability !== "text") {
			throw new Error(IMAGE_WORKFLOW_MESSAGE);
		}

		const result = await this.runOpenAIRequest(request);
		if (result.kind !== "text") {
			throw new Error(IMAGE_WORKFLOW_MESSAGE);
		}

		return result.text.trim();
	}

	async runOpenAIRequest(
		request: AskRequest,
		options: {
			onTextDelta?: (delta: string) => void;
			abortSignal?: AbortSignal;
			forceImage?: boolean;
		} = {}
	): Promise<AskMateResult> {
		const model = request.metadata.selectedModel;
		const shouldGenerateImage = options.forceImage === true
			|| request.metadata.forceImage
			|| request.metadata.autoImage
			|| request.metadata.modelCapability === "image";

		if (shouldGenerateImage) {
			if (!(await this.getOpenAiApiKey())) {
				throw new Error("Add an OpenAI API key in AskMate settings before generating an image with gpt-image-2.");
			}
			const imagePromptPlan = await this.prepareImagePrompt(request, options.abortSignal);
			return await this.generateOpenAIImage(request, options.abortSignal, imagePromptPlan);
		}

		const onDelta = options.onTextDelta ?? (() => undefined);
		const providerId = normalizeTextProviderId(request.metadata.providerId);
		const text = providerId === "openai"
			? await this.streamOpenAI(request, onDelta, options.abortSignal)
			: await this.completeProviderText(
				request,
				{
					providerId,
					providerName: getProviderLabel(providerId),
					model,
					capability: "text"
				},
				this.buildTextInstructions(),
				this.buildPrompt(request),
				"text_response",
				options.abortSignal,
				onDelta
			);
		return {
			kind: "text",
			model,
			text
		};
	}

	async streamOpenAI(
		request: AskRequest,
		onDelta: (delta: string) => void,
		abortSignal?: AbortSignal
	): Promise<string> {
		const apiKey = await this.getOpenAiApiKey();

		if (!apiKey) {
			throw new Error("Add an OpenAI API key in AskMate settings before asking a question.");
		}

		const model = request.metadata.selectedModel;

		if (getModelCapability(model) !== "text") {
			throw new Error("gpt-image-2 generates images and does not support AskMate text streaming.");
		}

		const reasoningEffort = request.metadata.reasoningEffort;
		const instructions = this.buildTextInstructions();
		const input = this.buildPrompt(request);
		const startedAt = new Date();
		let answer = "";
		let usageRecorded = false;

		try {
			const response = await requestOpenAIResponses(this.getProviderRuntime(), {
				apiKey,
				model,
				instructions,
				input,
				reasoningEffort,
				abortSignal,
			});
			const body = response.body;

			if (!response.ok) {
				const message = formatProviderHttpError("OpenAI", response.status, body?.error?.message ?? "");
				await this.recordOperationUsage({
					request,
					operationKind: "text_response",
					endpoint: "responses",
					status: "failed",
					model,
					instructions,
					input,
					responseText: "",
					usage: body?.usage ?? null,
					startedAt,
					errorMessage: message
				});
				usageRecorded = true;
				throw new Error(message);
			}

			answer = extractOpenAIText(body);

			if (!answer) {
				throw new Error("OpenAI returned a response, but no text output was found.");
			}

			onDelta(answer);
			await this.recordOperationUsage({
				request,
				operationKind: "text_response",
				endpoint: "responses",
				status: "completed",
				model,
				instructions,
				input,
				responseText: answer,
				usage: body?.usage ?? null,
				startedAt
			});
			usageRecorded = true;
			return answer.trim();
		} catch (error) {
			if (!usageRecorded) {
				const status: OperationStatus = isAbortError(error) ? "aborted" : "failed";
				await this.recordOperationUsage({
					request,
					operationKind: "text_response",
					endpoint: "responses",
					status,
					model,
					instructions,
					input,
					responseText: answer,
					usage: null,
					startedAt,
					errorMessage: this.getErrorMessage(error)
				});
			}

			throw error;
		}
	}

	private async completeProviderText(
		request: AskRequest,
		providerRef: ProviderModelRef,
		instructions: string,
		input: string,
		operationKind: OperationKind,
		abortSignal: AbortSignal | undefined,
		onDelta: (delta: string) => void = () => undefined
	): Promise<string> {
		const startedAt = new Date();
		let answer = "";
		let usage: OpenAITokenUsage | null = null;
		let endpoint: ApiEndpoint = "chat_completions";
		let usageRecorded = false;

		try {
			const result = await completeProviderTextRequest(this.getProviderRuntime(), providerRef, instructions, input, abortSignal);
			answer = result.text;
			usage = result.usage;
			endpoint = result.endpoint;

			if (!answer.trim() && operationKind !== "image_prompt_planning") {
				throw new Error(`${providerRef.providerName} returned a response, but no text output was found.`);
			}

			onDelta(answer);
			if (operationKind !== "image_prompt_planning") {
				await this.recordOperationUsage({
					request,
					providerId: providerRef.providerId,
					providerName: providerRef.providerName,
					operationKind,
					endpoint,
					status: "completed",
					model: providerRef.model,
					instructions,
					input,
					responseText: answer,
					usage,
					startedAt
				});
				usageRecorded = true;
			}
			return answer.trim();
		} catch (error) {
			if (!usageRecorded) {
				await this.recordOperationUsage({
					request,
					providerId: providerRef.providerId,
					providerName: providerRef.providerName,
					operationKind,
					endpoint,
					status: isAbortError(error) ? "aborted" : "failed",
					model: providerRef.model,
					instructions,
					input,
					responseText: answer,
					usage,
					startedAt,
					errorMessage: this.getErrorMessage(error)
				});
			}

			throw error;
		}
	}

	private async completeOpenAIPlanningText(
		request: AskRequest,
		providerRef: ProviderModelRef,
		instructions: string,
		input: string,
		abortSignal?: AbortSignal
	): Promise<string> {
		const apiKey = await this.getOpenAiApiKey();

		if (!apiKey) {
			throw new Error("Add an OpenAI API key in AskMate settings before generating an image.");
		}

		const startedAt = new Date();
		let usageRecorded = false;

		try {
			const response = await requestOpenAIResponses(this.getProviderRuntime(), {
				apiKey,
				model: providerRef.model,
				instructions,
				input,
				reasoningEffort: request.metadata.reasoningEffort,
				abortSignal,
			});
			const body = response.body;

			if (!response.ok) {
				const message = formatProviderHttpError("OpenAI", response.status, body?.error?.message ?? "");
				await this.recordOperationUsage({
					request,
					providerId: providerRef.providerId,
					providerName: providerRef.providerName,
					operationKind: "image_prompt_planning",
					endpoint: "responses",
					status: "failed",
					model: providerRef.model,
					instructions,
					input,
					responseText: "",
					usage: body?.usage ?? null,
					startedAt,
					errorMessage: message
				});
				usageRecorded = true;
				throw new Error(message);
			}

			return extractOpenAIText(body);
		} catch (error) {
			if (!usageRecorded) {
				await this.recordOperationUsage({
					request,
					providerId: providerRef.providerId,
					providerName: providerRef.providerName,
					operationKind: "image_prompt_planning",
					endpoint: "responses",
					status: isAbortError(error) ? "aborted" : "failed",
					model: providerRef.model,
					instructions,
					input,
					responseText: "",
					usage: null,
					startedAt,
					errorMessage: this.getErrorMessage(error)
				});
			}

			throw error;
		}
	}

	async generateOpenAIImage(
		request: AskRequest,
		abortSignal?: AbortSignal,
		imagePromptPlan?: ImagePromptPlan
	): Promise<ImageAskMateResult> {
		const apiKey = await this.getOpenAiApiKey();

		if (!apiKey) {
			throw new Error("Add an OpenAI API key in AskMate settings before generating an image.");
		}

		const model = GPT_IMAGE_2_MODEL_ID;
		const promptPlan = imagePromptPlan ?? {
			prompt: this.buildImagePrompt(request),
			planningModel: this.getImagePlanningModel(),
			status: "fallback" as const,
			fallbackReason: "Image prompt planning was not available."
		};
		const prompt = promptPlan.prompt.trim() || this.buildImagePrompt(request);
		const startedAt = new Date();
		let usageRecorded = false;

		try {
			const response = await requestOpenAIImageGeneration(this.getProviderRuntime(), {
				apiKey,
				model,
				prompt,
				abortSignal
			});
			const body = response.body;

			if (!response.ok) {
				const message = formatProviderHttpError("OpenAI", response.status, body?.error?.message ?? "");
				await this.recordOperationUsage({
					request,
					providerId: "openai",
					providerName: getProviderLabel("openai"),
					operationKind: "image_generation",
					endpoint: "images_generations",
					status: "failed",
					model,
					instructions: "OpenAI Images API generation",
					input: prompt,
					responseText: "",
					usage: null,
					startedAt,
					errorMessage: message
				});
				usageRecorded = true;
				throw new Error(message);
			}

			const image = body?.data?.find((item) => typeof item.b64_json === "string" && item.b64_json.trim());
			const base64 = image?.b64_json?.trim() ?? "";

			if (!base64) {
				throw new Error("OpenAI returned an image response, but no base64 image data was found.");
			}

			this.decodeBase64Image(base64);
			await this.recordOperationUsage({
				request,
				providerId: "openai",
				providerName: getProviderLabel("openai"),
				operationKind: "image_generation",
				endpoint: "images_generations",
				status: "completed",
				model,
				instructions: "OpenAI Images API generation",
				input: prompt,
				responseText: image?.revised_prompt?.trim() ?? "",
				usage: null,
				startedAt
			});
			usageRecorded = true;

			return {
				kind: "image",
				model,
				promptPlan,
				image: {
					mimeType: IMAGE_MIME_TYPE,
					base64,
					prompt,
					revisedPrompt: image?.revised_prompt?.trim() || null,
					createdAt: new Date().toISOString(),
					savedImagePath: null
				}
			};
		} catch (error) {
			if (!usageRecorded) {
				await this.recordOperationUsage({
					request,
					providerId: "openai",
					providerName: getProviderLabel("openai"),
					operationKind: "image_generation",
					endpoint: "images_generations",
					status: isAbortError(error) ? "aborted" : "failed",
					model,
					instructions: "OpenAI Images API generation",
					input: prompt,
					responseText: "",
					usage: null,
					startedAt,
					errorMessage: this.getErrorMessage(error)
				});
			}

			throw error;
		}
	}

	async prepareImagePrompt(request: AskRequest, abortSignal?: AbortSignal): Promise<ImagePromptPlan> {
		const providerRef = this.getImagePlanningProviderRef();
		const instructions = this.buildImagePromptPlanningInstructions();
		const input = this.buildImagePromptPlanningInput(request);
		const startedAt = new Date();
		const endpoint: ApiEndpoint = getProviderTextEndpoint(providerRef.providerId);

		try {
			const plannedText = providerRef.providerId === "openai"
				? await this.completeOpenAIPlanningText(request, providerRef, instructions, input, abortSignal)
				: await this.completeProviderText(request, providerRef, instructions, input, "image_prompt_planning", abortSignal);
			const extraction = this.extractPlannedImagePrompt(plannedText);
			const prompt = extraction.prompt || this.buildImagePrompt(request);
			const status: OperationStatus = extraction.prompt ? "completed" : "fallback";
			await this.recordOperationUsage({
				request,
				providerId: providerRef.providerId,
				providerName: providerRef.providerName,
				operationKind: "image_prompt_planning",
				endpoint,
				status,
				model: providerRef.model,
				instructions,
				input,
				responseText: plannedText,
				usage: null,
				startedAt,
				errorMessage: extraction.fallbackReason ?? ""
			});

			return {
				prompt,
				planningModel: `${providerRef.providerName}: ${providerRef.model}`,
				status: extraction.prompt ? "completed" : "fallback",
				fallbackReason: extraction.fallbackReason
			};
		} catch (error) {
			if (isAbortError(error)) {
				throw error;
			}

			console.warn("AskMate image prompt planning failed. Falling back to the direct image prompt.", error);
			return {
				prompt: this.buildImagePrompt(request),
				planningModel: `${providerRef.providerName}: ${providerRef.model}`,
				status: "fallback",
				fallbackReason: this.getErrorMessage(error)
			};
		}
	}

	private buildImagePromptPlanningInput(request: AskRequest): string {
		const sourcePath = request.context.file?.path ?? "Untitled or unsaved note";
		const promptContext = this.getPromptContextContent(request);

		return [
			`Prompt version: ${request.metadata.promptVersion}`,
			`Intent: ${formatRequestIntent(request.metadata.intentKind)}`,
			`Workflow: ${request.metadata.workflowName ?? "None"}`,
			`Source: ${sourcePath}`,
			`Context type: ${request.context.source}`,
			"",
			"<note_context>",
			promptContext,
			"</note_context>",
			"",
			"<user_request>",
			request.question,
			"</user_request>"
		].join("\n");
	}

	private extractPlannedImagePrompt(text: string): ImagePromptExtraction {
		const value = text.trim();

		if (!value) {
			return {
				prompt: "",
				fallbackReason: "The planning response was empty."
			};
		}

		const jsonMatch = value.match(/^```json\s*([\s\S]*?)```$/i) ?? value.match(/^```\s*([\s\S]*?)```$/i);
		const candidate = jsonMatch?.[1]?.trim() ?? value;

		try {
			const parsed = JSON.parse(candidate) as { prompt?: unknown };
			const prompt = typeof parsed.prompt === "string" ? normalizePlannedPrompt(parsed.prompt) : "";

			if (!prompt) {
				return {
					prompt: "",
					fallbackReason: "The planning JSON did not include a non-empty prompt string."
				};
			}

			return {
				prompt,
				fallbackReason: null
			};
		} catch {
			return {
				prompt: "",
				fallbackReason: "The planning response was not valid JSON."
			};
		}
	}

	private buildImagePrompt(request: AskRequest): string {
		const sourcePath = request.context.file?.path ?? "Untitled or unsaved note";
		const promptContext = this.getPromptContextContent(request);

		return [
			"Goal: Generate one image that satisfies the user request, using the note context as source material and inspiration.",
			"",
			"Success criteria:",
			"- Match the user's visual request directly.",
			"- Preserve source-backed names, dates, numbers, terminology, and visual constraints when they appear in the note context.",
			"- Use generic visual placeholders when evidence is insufficient for exact real-world details.",
			"- Make the image useful for an Obsidian note.",
			"",
			"Constraints: Do not invent logos, exact portraits, private details, metrics, dates, or product claims that are not present in the note context or user request.",
			"",
			"Output: Return only the generated image.",
			"",
			`Prompt version: ${request.metadata.promptVersion}`,
			`Intent: ${formatRequestIntent(request.metadata.intentKind)}`,
			`Workflow: ${request.metadata.workflowName ?? "None"}`,
			`Source: ${sourcePath}`,
			`Context type: ${request.context.source}`,
			"",
			"<note_context>",
			promptContext,
			"</note_context>",
			"",
			"<image_request>",
			request.question,
			"</image_request>"
		].join("\n");
	}

	async refreshOpenAIModels(): Promise<string[]> {
		return await this.refreshProviderModels("openai");
	}

	async testOpenAIConnection(): Promise<string> {
		return await this.testProviderConnection("openai");
	}

	async refreshSelectedProviderModels(): Promise<string[]> {
		return await this.refreshProviderModels(this.getSelectedTextProviderId());
	}

	async testSelectedProviderConnection(): Promise<string> {
		return await this.testProviderConnection(this.getSelectedTextProviderId());
	}

	async refreshProviderModels(providerId: TextProviderId): Promise<string[]> {
		const provider = this.getProviderSettings(providerId);
		let models: string[];
		try {
			models = await fetchProviderModels(this.getProviderRuntime(), providerId);
		} catch (error) {
			const message = this.getErrorMessage(error);
			if (providerId === "azure-openai" && !message.includes("API key") && !message.includes("base URL")) {
				throw new Error("Azure OpenAI model listing is unavailable for this endpoint. Keep using a manual deployment name.");
			}
			throw error;
		}

		if (providerId === "azure-openai") {
			if (models.length === 0) {
				throw new Error("Azure OpenAI did not return model IDs. Keep using a manual deployment name.");
			}

			provider.modelOptions = normalizeProviderModelOptions(models, provider.modelOptions, provider.model);
			await this.saveSettings();
			return provider.modelOptions;
		}

		const options = providerId === "openai"
			? normalizeOpenAIModelOptions(models, [], "")
			: normalizeProviderModelOptions(models, DEFAULT_PROVIDER_SETTINGS[providerId].modelOptions, provider.model);

		if (options.length === 0) {
			throw new Error(`${getProviderLabel(providerId)} did not return model IDs.`);
		}

		provider.modelOptions = options;
		if (!provider.modelOptions.includes(provider.model)) {
			provider.model = provider.modelOptions[0] ?? DEFAULT_PROVIDER_SETTINGS[providerId].model;
		}

		await this.saveSettings();
		return provider.modelOptions;
	}

	async testProviderConnection(providerId: TextProviderId): Promise<string> {
		return await testProviderConnectionWithProvider(this.getProviderRuntime(), providerId);
	}

	private renderTemplate(template: string, variables: Record<string, string>): string {
		const rendered = template.replace(/{{\s*([a-zA-Z0-9_]+)\s*}}/g, (_match, key: string) => {
			return variables[key] ?? "";
		});

		return rendered
			.split("\n")
			.filter((line, index, lines) => {
				if (!line.trim()) {
					return true;
				}
				return !/^\s*$/.test(line) && !(line.trim().startsWith("{{") && line.trim().endsWith("}}")) && (line.trim() !== "" || index < lines.length);
			})
			.join("\n")
			.replace(/\n{4,}/g, "\n\n\n")
			.trim();
	}

	private buildCommonTemplateVariables(
		context: NoteContext,
		values: {
			title: string;
			request: string;
			response: string;
			model: string;
			workflowName?: string | null;
			date?: string;
			dateTime?: string;
		}
	): Record<string, string> {
		const now = new Date();
		const sourcePath = context.file?.path ?? "";
		const noteTitle = context.file?.basename ?? "Untitled";
		const workflowName = values.workflowName ?? "";
		return {
			title: values.title,
			sourceLink: this.formatSourceLink(context.file),
			sourcePath,
			noteTitle,
			contextSource: context.source,
			selectedText: context.source === "Selected text" ? context.content : "",
			providerName: getProviderLabel(this.getSelectedTextProviderId()),
			model: values.model,
			promptVersion: ASKMATE_PROMPT_VERSION,
			intent: "",
			outputMode: "",
			workflowName,
			workflowLine: workflowName ? `Workflow: ${workflowName}` : "",
			request: values.request,
			response: values.response,
			date: values.date ?? this.formatDate(now),
			dateTime: values.dateTime ?? now.toISOString(),
			currentDate: values.date ?? this.formatDate(now),
			currentDateTime: values.dateTime ?? now.toISOString(),
			customInstructions: this.settings.workflowCustomInstructions.trim(),
			resultFolder: this.cleanFolderPath(this.settings.resultFolder)
		};
	}

	private buildRequestTemplateVariables(request: AskRequest, responseText: string, model: string): Record<string, string> {
		return {
			...this.buildCommonTemplateVariables(request.context, {
				title: request.title,
				request: request.question,
				response: responseText.trim(),
				model,
				workflowName: request.metadata.workflowName
			}),
			providerName: request.metadata.providerName,
			promptVersion: request.metadata.promptVersion,
			intent: formatRequestIntent(request.metadata.intentKind),
			outputMode: formatOutputMode(request.metadata.outputMode)
		};
	}

	private formatDate(date: Date): string {
		const year = date.getFullYear();
		const month = String(date.getMonth() + 1).padStart(2, "0");
		const day = String(date.getDate()).padStart(2, "0");
		return `${year}-${month}-${day}`;
	}

	private renderTextResultNoteContent(request: AskRequest, responseText: string, model: string): string {
		const variables = this.buildRequestTemplateVariables(request, responseText, model);
		const rendered = this.renderTemplate(this.getWorkflowResultNoteTemplate(request.metadata.workflowId), variables);
		if (rendered.trim()) {
			return `${rendered.trim()}\n`;
		}

		return this.renderTemplate(DEFAULT_RESULT_NOTE_TEMPLATE, variables);
	}

	private getWorkflowResultNoteTemplate(workflowId: string | null): string {
		if (workflowId) {
			const customWorkflow = this.settings.customWorkflows.find((workflow) => workflow.id === workflowId);
			const template = customWorkflow?.resultNoteTemplate?.trim() ?? "";
			if (template) {
				return template;
			}
		}

		return this.settings.resultNoteTemplate;
	}

	private renderImageResultNoteContent(request: AskRequest, result: ImageAskMateResult, imageFile: TFile): string {
		const variables = {
			...this.buildRequestTemplateVariables(request, "", result.model),
			providerName: "OpenAI",
			imageEmbed: this.createImageEmbed(imageFile),
			imagePrompt: result.image.prompt,
			revisedPrompt: result.image.revisedPrompt ?? "",
			revisedPromptSection: result.image.revisedPrompt ? `\n\n## Revised prompt\n\n${result.image.revisedPrompt}` : "",
			planningModel: result.promptPlan.planningModel,
			planningStatus: formatOperationStatus(result.promptPlan.status),
			planningFallback: result.promptPlan.fallbackReason ?? "",
			planningFallbackLine: result.promptPlan.fallbackReason ? `Planning fallback: ${result.promptPlan.fallbackReason}` : "",
			imageGenerationProviderName: "OpenAI"
		};
		const rendered = this.renderTemplate(this.settings.imageResultNoteTemplate, variables);
		if (rendered.trim()) {
			return `${rendered.trim()}\n`;
		}

		return `${this.renderTemplate(DEFAULT_IMAGE_RESULT_NOTE_TEMPLATE, variables).trim()}\n`;
	}

	async createResultNote(request: AskRequest, responseText: string, options: { model?: string } = {}): Promise<TFile> {
		const folder = this.getResultNoteFolder(request);
		await this.ensureFolder(folder);

		const baseName = this.sanitizeFileName(request.title);
		const path = await this.createUniqueMarkdownPath(folder, baseName);
		const model = options.model ?? request.metadata.selectedModel;
		const content = this.renderTextResultNoteContent(request, responseText, model);

		const file = await this.app.vault.create(path, content);
		await this.maybeAppendResultBacklinkToSource(request, file);
		return file;
	}

	async createImageResultNote(
		request: AskRequest,
		result: ImageAskMateResult
	): Promise<{ noteFile: TFile; imageFile: TFile }> {
		const folder = this.getResultNoteFolder(request);
		await this.ensureFolder(folder);

		const imageFile = await this.saveGeneratedImage(request, result);
		const baseName = this.sanitizeFileName(`${request.title} Image`);
		const path = await this.createUniqueMarkdownPath(folder, baseName);
		const content = this.renderImageResultNoteContent(request, result, imageFile);

		const noteFile = await this.app.vault.create(path, content);
		await this.maybeAppendResultBacklinkToSource(request, noteFile);
		return { noteFile, imageFile };
	}

	async saveGeneratedImage(request: AskRequest, result: ImageAskMateResult): Promise<TFile> {
		const existingPath = result.image.savedImagePath;

		if (existingPath) {
			const existing = this.app.vault.getAbstractFileByPath(existingPath);

			if (existing instanceof TFile) {
				return existing;
			}
		}

		const folder = this.getImageResultFolder(request, result);
		await this.ensureFolder(folder);
		const title = request.title === "AskMate Answer" ? "AskMate Image" : `${request.title} Image`;
		const variables = {
			...this.buildRequestTemplateVariables(request, "", result.model),
			title,
			imagePrompt: result.image.prompt,
			revisedPrompt: result.image.revisedPrompt ?? "",
			planningModel: result.promptPlan.planningModel,
			planningStatus: formatOperationStatus(result.promptPlan.status),
			planningFallback: result.promptPlan.fallbackReason ?? ""
		};
		const baseName = this.sanitizeFileName(this.renderTemplate(this.settings.imageFileNameTemplate, variables) || title);
		const path = await this.createUniquePath(folder, baseName, "png");
		const bytes = this.decodeBase64Image(result.image.base64);
		const file = await this.app.vault.createBinary(path, bytes);
		result.image.savedImagePath = file.path;
		return file;
	}

	async applyImageToContext(request: AskRequest, result: ImageAskMateResult): Promise<string> {
		const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
		const targetView = request.context.file
			? this.getOpenMarkdownViewForFile(request.context.file)
			: activeView ?? this.getLastOpenMarkdownView();

		if (targetView) {
			const editor = targetView.editor;
			const file = targetView.file ?? request.context.file;
			const selectedText = editor.getSelection().trim();

			if (request.context.source === "Selected text" && !selectedText) {
				throw new Error("AskMate could not find the original selection to place the image after. Select the text again, then insert the image.");
			}

			const imageFile = await this.saveGeneratedImage(request, result);
			const insertion = `\n\n${this.createImageEmbed(imageFile)}\n`;

			if (request.context.source === "Selected text") {
				editor.replaceRange(insertion, editor.getCursor("to"));
			} else {
				editor.replaceRange(insertion, editor.getCursor());
			}

			this.rememberEditorContext(editor, file ?? null);
			return `Inserted image in ${file?.path ?? "the current note"}. Use Obsidian undo immediately if needed.`;
		}

		if (request.context.source === "Selected text") {
			throw new Error("AskMate could not find the original selection to place the image after. Select the text again, then insert the image.");
		}

		const file = request.context.file ?? this.lastMarkdownFile;

		if (file?.extension === "md") {
			const imageFile = await this.saveGeneratedImage(request, result);
			const insertion = `\n\n${this.createImageEmbed(imageFile)}\n`;
			const content = await this.app.vault.cachedRead(file);
			await this.app.vault.modify(file, `${content.trimEnd()}${insertion}`);
			this.rememberMarkdownFile(file);
			return `Inserted image in ${file.path}. Use Obsidian undo immediately if needed.`;
		}

		throw new Error("Open a Markdown note before inserting an image.");
	}

	private parseMarkdownHeadingSections(markdown: string): MarkdownHeadingSection[] {
		const lines = markdown.split(/\r?\n/);
		const sections: MarkdownHeadingSection[] = [];
		const stack: MarkdownHeadingSection[] = [];

		for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
			const match = lines[lineIndex].match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
			if (!match) {
				continue;
			}

			const level = match[1].length;
			const title = match[2].trim();
			while (stack.length > 0 && stack[stack.length - 1].level >= level) {
				const completed = stack.pop();
				if (completed) {
					completed.endLineExclusive = lineIndex;
				}
			}

			const path = [...stack.map((section) => section.title), title].join(" > ");
			const section: MarkdownHeadingSection = {
				level,
				title,
				path,
				headingLine: lineIndex,
				bodyStartLine: lineIndex + 1,
				endLineExclusive: lines.length
			};
			sections.push(section);
			stack.push(section);
		}

		return sections;
	}

	private async applyResponseToHeadingSection(request: AskRequest, output: string, headingPath: string): Promise<string> {
		const target = headingPath.trim();
		if (!target) {
			throw new Error("Enter a heading title or heading path before applying to a section.");
		}

		const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
		const targetView = request.context.file
			? this.getOpenMarkdownViewForFile(request.context.file)
			: activeView ?? this.getLastOpenMarkdownView();
		const file = targetView?.file ?? request.context.file ?? null;
		const content = targetView ? targetView.editor.getValue() : file?.extension === "md" ? await this.app.vault.cachedRead(file) : "";

		if (!content || !file) {
			throw new Error("Open the original Markdown note before applying to a heading.");
		}

		const sections = this.parseMarkdownHeadingSections(content);
		const matches = sections.filter((section) => section.path === target || section.title === target);

		if (matches.length === 0) {
			throw new Error(`AskMate could not find heading "${target}" in ${file.path}.`);
		}

		if (matches.length > 1) {
			throw new Error(`Heading "${target}" is ambiguous. Use the full heading path, for example Parent > Child.`);
		}

		const section = matches[0];
		const lines = content.split(/\r?\n/);
		const before = lines.slice(section.bodyStartLine, section.endLineExclusive).join("\n").trim();

		if (!(await this.confirmTruncatedContextFullApply(request, `${file.path} > ${section.path}`))) {
			return "Apply cancelled. No note was changed.";
		}

		if (!(await this.confirmTextApplyPreview({
			scope: "heading-section",
			targetLabel: `${file.path} > ${section.path}`,
			before,
			after: output
		}))) {
			return "Apply cancelled. No note was changed.";
		}

		const replacementLines = output.split(/\r?\n/);
		const nextLines = [
			...lines.slice(0, section.bodyStartLine),
			...replacementLines,
			...lines.slice(section.endLineExclusive)
		];
		const nextContent = nextLines.join("\n");

		if (targetView) {
			targetView.editor.setValue(nextContent);
			this.rememberEditorContext(targetView.editor, file);
		} else {
			await this.app.vault.modify(file, nextContent);
			this.rememberMarkdownFile(file);
		}

		return `Applied to heading "${section.path}" in ${file.path}. Use Obsidian undo or file history immediately if needed.`;
	}

	private appendMarkdownBlockToContent(existing: string, block: string): string {
		const cleanBlock = block.trim();
		const newline = existing.includes("\r\n") ? "\r\n" : "\n";

		if (!existing) {
			return `${cleanBlock}${newline}`;
		}

		const trailingLineBreaks = existing.match(/(?:\r\n|\n|\r)+$/u)?.[0].match(/\r\n|\n|\r/gu)?.length ?? 0;
		const separator = trailingLineBreaks >= 2 ? "" : trailingLineBreaks === 1 ? newline : `${newline}${newline}`;
		return `${existing}${separator}${cleanBlock}${newline}`;
	}

	private async appendResponseToCapturedNote(request: AskRequest, output: string, targetView: MarkdownView | null, file: TFile | null): Promise<string> {
		if (targetView) {
			const editor = targetView.editor;
			const targetLabel = file?.path ?? "the current note";
			const before = editor.getValue();
			const after = this.appendMarkdownBlockToContent(before, output);

			if (!(await this.confirmTextApplyPreview({
				scope: "append",
				targetLabel,
				before,
				after
			}))) {
				return "Apply cancelled. No note was changed.";
			}

			editor.setValue(after);
			this.rememberEditorContext(editor, file);
			return `Appended to ${targetLabel}. Use Obsidian undo or file history immediately if needed.`;
		}

		if (file?.extension === "md") {
			const content = await this.app.vault.cachedRead(file);
			const after = this.appendMarkdownBlockToContent(content, output);

			if (!(await this.confirmTextApplyPreview({
				scope: "append",
				targetLabel: file.path,
				before: content,
				after
			}))) {
				return "Apply cancelled. No note was changed.";
			}

			await this.app.vault.modify(file, after);
			this.rememberMarkdownFile(file);
			return `Appended to ${file.path}. Use Obsidian undo or file history immediately if needed.`;
		}

		throw new Error("Open the original Markdown note before appending changes.");
	}

	async applyResponseToContext(request: AskRequest, responseText: string, options: { scope?: ApplyScope; headingPath?: string } = {}): Promise<string> {
		const output = responseText.trim();

		if (!output) {
			throw new Error("AskMate has nothing to apply yet.");
		}

		const scope = normalizeApplyScope(options.scope ?? this.settings.partialApplyDefaultScope);

		if (scope === "heading-section") {
			return await this.applyResponseToHeadingSection(request, output, options.headingPath ?? request.context.activeHeadingPath ?? "");
		}

		if (scope === "selected-block" && request.context.source !== "Selected text") {
			throw new Error("AskMate can only apply to a selected block when the original request used selected text.");
		}

		const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
		const targetView = request.context.file
			? this.getOpenMarkdownViewForFile(request.context.file)
			: activeView ?? this.getLastOpenMarkdownView();
		const file = targetView?.file ?? request.context.file ?? null;

		if (request.context.source === "Selected text" && scope !== "full-note") {
			const originalText = request.context.content.trim();

			if (!originalText) {
				throw new Error("AskMate could not find the original selected text. Select the text again, then apply.");
			}

			if (targetView) {
				const editor = targetView.editor;
				const selectedText = editor.getSelection().trim();

				if (selectedText === originalText) {
					if (!(await this.confirmTextApplyPreview({
						scope: "selected-text",
						targetLabel: file?.path ?? "the current note",
						before: originalText,
						after: output
					}))) {
						return "Apply cancelled. No note was changed.";
					}
					editor.replaceSelection(output);
					this.rememberEditorContext(editor, file);
					return `Applied to selected text in ${file?.path ?? "the current note"}. Use Obsidian undo immediately if needed.`;
				}

				const value = editor.getValue();
				const occurrences = findExactOccurrences(value, originalText);

				if (occurrences.length === 1) {
					const start = occurrences[0];
					if (!(await this.confirmTextApplyPreview({
						scope: "selected-text",
						targetLabel: file?.path ?? "the current note",
						before: originalText,
						after: output
					}))) {
						return "Apply cancelled. No note was changed.";
					}
					editor.replaceRange(
						output,
						offsetToEditorPosition(value, start),
						offsetToEditorPosition(value, start + originalText.length)
					);
					this.rememberEditorContext(editor, file);
					return `Applied to selected text in ${file?.path ?? "the current note"}. Use Obsidian undo immediately if needed.`;
				}

				throw new Error("AskMate could not safely find the original selected text. Select the text again, then apply.");
			}

			if (file?.extension === "md") {
				const content = await this.app.vault.cachedRead(file);
				const occurrences = findExactOccurrences(content, originalText);

				if (occurrences.length === 1) {
					const start = occurrences[0];
					if (!(await this.confirmTextApplyPreview({
						scope: "selected-text",
						targetLabel: file.path,
						before: originalText,
						after: output
					}))) {
						return "Apply cancelled. No note was changed.";
					}
					await this.app.vault.modify(file, `${content.slice(0, start)}${output}${content.slice(start + originalText.length)}`);
					this.rememberMarkdownFile(file);
					return `Applied to selected text in ${file.path}. Use Obsidian undo immediately if needed.`;
				}
			}

			throw new Error("AskMate could not safely find the original selected text. Select the text again, then apply.");
		}

		if (scope !== "full-note") {
			return await this.appendResponseToCapturedNote(request, output, targetView, file);
		}

		if (targetView) {
			const editor = targetView.editor;
			const targetLabel = file?.path ?? "the current note";

			if (!(await this.confirmTruncatedContextFullApply(request, targetLabel))) {
				return "Apply cancelled. No note was changed.";
			}

			const before = editor.getValue();
			const prepared = await this.prepareFrontmatterAwareApply(before, output);
			if (prepared.cancelled) {
				return "Apply cancelled. No note was changed.";
			}

			if (!(await this.confirmTextApplyPreview({
				scope: "full-note",
				targetLabel,
				before,
				after: prepared.text,
				warning: prepared.warning
			}))) {
				return "Apply cancelled. No note was changed.";
			}

			editor.setValue(prepared.text);
			this.rememberEditorContext(editor, file);
			return `Applied to ${targetLabel}. Use Obsidian undo or file history immediately if needed.`;
		}

		if (file?.extension === "md") {
			const content = await this.app.vault.cachedRead(file);
			if (!(await this.confirmTruncatedContextFullApply(request, file.path))) {
				return "Apply cancelled. No note was changed.";
			}

			const prepared = await this.prepareFrontmatterAwareApply(content, output);
			if (prepared.cancelled) {
				return "Apply cancelled. No note was changed.";
			}

			if (!(await this.confirmTextApplyPreview({
				scope: "full-note",
				targetLabel: file.path,
				before: content,
				after: prepared.text,
				warning: prepared.warning
			}))) {
				return "Apply cancelled. No note was changed.";
			}

			await this.app.vault.modify(file, prepared.text);
			this.rememberMarkdownFile(file);
			return `Applied to ${file.path}. Use Obsidian undo or file history immediately if needed.`;
		}

		throw new Error("Open the original Markdown note before applying changes.");
	}

	private async confirmTruncatedContextFullApply(request: AskRequest, targetLabel: string): Promise<boolean> {
		if (!request.metadata.contextTruncated) {
			return true;
		}

		return await askMateConfirm(this.app, [
			`Apply to the full note "${targetLabel}" even though AskMate only sent part of the note context?`,
			"",
			`Context budget: ${getContextBudgetOption(request.metadata.contextBudgetMode).label}`,
			`Sent: ${request.metadata.promptContextCharacters.toLocaleString()} characters`,
			`Captured note: ${request.metadata.contextCharacters.toLocaleString()} characters`,
			"",
			"To reduce risk, cancel and switch the context budget to Expanded before asking AskMate to rewrite the whole note."
		].join("\n"));
	}

	private shouldUseDiffApproval(scope: TextApplyPreviewScope): boolean {
		const mode = normalizeApplyApprovalMode(this.settings.applyApprovalMode, this.settings.showApplyPreview);

		if (mode === "manual") {
			return true;
		}

		if (mode === "full") {
			return scope === "full-note" || scope === "heading-section";
		}

		return false;
	}

	private async confirmTextApplyPreview({
		scope,
		targetLabel,
		before,
		after,
		warning
	}: {
		scope: TextApplyPreviewScope;
		targetLabel: string;
		before: string;
		after: string;
		warning?: string;
	}): Promise<boolean> {
		if (this.shouldUseDiffApproval(scope)) {
			return await askMateDiffConfirm(this.app, {
				scope,
				targetLabel,
				before,
				after,
				warning
			});
		}

		if (scope === "full-note") {
			const warningText = warning ? `\n\nWarning: ${warning}` : "";
			return await askMateConfirm(this.app, `Apply AskMate output by replacing the full contents of "${targetLabel}"? This cannot be undone by AskMate.${warningText}`);
		}

		return true;
	}


	private splitMarkdownFrontmatter(markdown: string): FrontmatterBlock {
		const lines = markdown.split(/\r?\n/);
		if (lines[0]?.trim() !== "---") {
			return { exists: false, malformed: false, frontmatter: "", body: markdown, endLineExclusive: 0 };
		}
		for (let index = 1; index < lines.length; index += 1) {
			if (lines[index].trim() === "---") {
				return {
					exists: true,
					malformed: false,
					frontmatter: lines.slice(0, index + 1).join("\n"),
					body: lines.slice(index + 1).join("\n").replace(/^\n+/, ""),
					endLineExclusive: index + 1
				};
			}
		}
		return { exists: true, malformed: true, frontmatter: markdown, body: "", endLineExclusive: lines.length };
	}

	private async prepareFrontmatterAwareApply(before: string, proposed: string): Promise<FrontmatterApplyResult> {
		const beforeBlock = this.splitMarkdownFrontmatter(before);
		const proposedBlock = this.splitMarkdownFrontmatter(proposed);
		if (!beforeBlock.exists && !proposedBlock.exists) {
			return { text: proposed, warning: "", cancelled: false };
		}
		if (beforeBlock.malformed) {
			const confirmed = await askMateConfirm(this.app, "The existing YAML frontmatter appears malformed. Continue with the AI replacement?");
			return { text: proposed, warning: "Existing YAML frontmatter looked malformed.", cancelled: !confirmed };
		}
		if (this.settings.frontmatterApplyPolicy === "replace") {
			return { text: proposed, warning: proposedBlock.exists ? "AskMate will replace YAML frontmatter from the AI output." : "", cancelled: false };
		}
		if (this.settings.frontmatterApplyPolicy === "confirm" && beforeBlock.frontmatter !== proposedBlock.frontmatter) {
			const confirmed = await askMateConfirm(this.app, "AskMate output changes YAML frontmatter. Continue with the replacement?");
			return { text: proposed, warning: "YAML frontmatter differs from the original note.", cancelled: !confirmed };
		}
		if (this.settings.frontmatterApplyPolicy === "preserve" && beforeBlock.exists) {
			const body = proposedBlock.exists ? proposedBlock.body : proposed;
			return {
				text: `${beforeBlock.frontmatter}\n\n${body.trimStart()}`,
				warning: proposedBlock.exists ? "AskMate preserved the original YAML frontmatter and removed AI-proposed frontmatter." : "AskMate preserved the original YAML frontmatter.",
				cancelled: false
			};
		}
		if (this.settings.frontmatterApplyPolicy === "preserve" && proposedBlock.exists) {
			return {
				text: proposedBlock.body.trimStart(),
				warning: "AskMate preserved the original no-frontmatter state and removed AI-proposed frontmatter.",
				cancelled: false
			};
		}
		return { text: proposed, warning: "", cancelled: false };
	}

	buildPromptInspectionForRequest(request: AskRequest): PromptInspection {
		const shouldGenerateImage = request.metadata.forceImage || request.metadata.autoImage || request.metadata.modelCapability === "image";
		const instructions = shouldGenerateImage ? this.buildImagePromptPlanningInstructions() : this.buildTextInstructions();
		const input = shouldGenerateImage ? this.buildImagePromptPlanningInput(request) : this.buildPrompt(request);
		const secondaryInput = shouldGenerateImage ? this.buildImagePrompt(request) : "";
		const estimatedInputTokens = estimateTokenCount([instructions, input, secondaryInput].filter(Boolean).join("\n\n"));
		return {
			request,
			providerName: shouldGenerateImage ? this.getImagePlanningProviderRef().providerName : request.metadata.providerName,
			model: shouldGenerateImage ? this.getImagePlanningProviderRef().model : request.metadata.selectedModel,
			capability: request.metadata.modelCapability,
			instructions,
			input,
			secondaryInput,
			estimatedInputTokens,
			warnings: this.evaluateUsageGuardrails(request, estimatedInputTokens).warnings
		};
	}

	async inspectFinalPrompt(question: string, title: string, options: BuildRequestOptions = {}): Promise<PromptInspection> {
		const request = await this.buildRequest(question, title, options);
		return this.buildPromptInspectionForRequest(request);
	}

	private buildImagePromptPlanningInstructions(): string {
		return [
			"Role: You prepare high-quality prompts for an image generation model inside Obsidian.",
			"",
			"Goal: Analyze the user request and note context, then produce one concise image prompt suitable for gpt-image-2.",
			"",
			"Success criteria: Preserve source-backed details, infer a clear visual composition, specify style only when helpful, and avoid unsupported exact claims, logos, private details, dates, numbers, or identities.",
			"",
			"Constraints: Treat the note context and user request as source material. Do not answer the user in prose. Do not include Markdown. If the request is sparse, create a useful visual direction from the note context.",
			"",
			"Output: Return JSON only with this shape: {\"prompt\":\"...\"}. Stop after the JSON object."
		].join("\n");
	}

	evaluateUsageGuardrails(request: AskRequest, estimatedInputTokens?: number): UsageGuardrailResult {
		const estimate = estimatedInputTokens ?? this.buildPromptInspectionForRequest(request).estimatedInputTokens;
		const now = new Date();
		const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
		const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
		const dayUsedTokens = this.getUsageTokensSince(dayStart);
		const monthUsedTokens = this.getUsageTokensSince(monthStart);
		const warnings: string[] = [];
		const blockers: string[] = [];
		if (!this.settings.usageGuardrailsEnabled) {
			return { estimatedInputTokens: estimate, dayUsedTokens, monthUsedTokens, warnings, blockers };
		}
		if (this.settings.usagePerRequestWarningTokens > 0 && estimate >= this.settings.usagePerRequestWarningTokens) {
			warnings.push(`This request is estimated at ${formatTokenCount(estimate)} input tokens.`);
		}
		if (this.settings.usagePerRequestHardLimitTokens > 0 && estimate >= this.settings.usagePerRequestHardLimitTokens) {
			blockers.push(`Request estimate exceeds the hard limit of ${formatTokenCount(this.settings.usagePerRequestHardLimitTokens)} tokens.`);
		}
		const addBudgetMessage = (label: string, used: number, budget: number): void => {
			if (budget <= 0 || used + estimate <= budget) {
				return;
			}
			const message = `${label} budget would exceed ${formatTokenCount(budget)} tokens. Used: ${formatTokenCount(used)}, estimate: ${formatTokenCount(estimate)}.`;
			if (this.settings.usageBudgetEnforcement === "block") {
				blockers.push(message);
			} else {
				warnings.push(message);
			}
		};
		addBudgetMessage("Daily", dayUsedTokens, this.settings.usageDailyTokenBudget);
		addBudgetMessage("Monthly", monthUsedTokens, this.settings.usageMonthlyTokenBudget);
		return { estimatedInputTokens: estimate, dayUsedTokens, monthUsedTokens, warnings, blockers };
	}

	async confirmUsageGuardrails(request: AskRequest): Promise<void> {
		const inspection = this.buildPromptInspectionForRequest(request);
		const guardrails = this.evaluateUsageGuardrails(request, inspection.estimatedInputTokens);
		if (guardrails.blockers.length > 0) {
			throw new Error(guardrails.blockers.join(" "));
		}
		if (guardrails.warnings.length > 0 && !(await askMateConfirm(this.app, `${guardrails.warnings.join("\n\n")}\n\nContinue with this AskMate request?`))) {
			throw new Error("AskMate request cancelled by usage guardrails.");
		}
	}

	private getUsageTokensSince(startIso: string): number {
		const startMs = Date.parse(startIso);
		return this.getTokenUsageRecords()
			.filter((record) => Date.parse(record.timestamp) >= startMs)
			.reduce((sum, record) => sum + record.totalTokens, 0);
	}

	extractEvidenceCitations(responseText: string, sources: EvidenceSource[]): EvidenceCitation[] {
		const byId = new Map(sources.map((source) => [source.id, source]));
		const citations: EvidenceCitation[] = [];
		const seen = new Set<string>();
		for (const match of responseText.matchAll(/\[(S\d+)]/g)) {
			const sourceId = match[1];
			const source = byId.get(sourceId);
			if (!source || seen.has(sourceId)) {
				continue;
			}
			seen.add(sourceId);
			citations.push({ sourceId, source });
		}
		return citations;
	}

	async openEvidenceSource(source: EvidenceSource): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(source.sourcePath);
		if (!(file instanceof TFile) || file.extension !== "md") {
			new Notice(`AskMate could not open evidence source ${source.sourcePath}.`);
			return;
		}
		let leaf = this.app.workspace.getLeavesOfType("markdown").find((item) => item.view instanceof MarkdownView && item.view.file?.path === file.path);
		if (!leaf) {
			leaf = this.app.workspace.getLeaf(false);
			await leaf.openFile(file);
		}
		await this.app.workspace.revealLeaf(leaf);
		if (leaf.view instanceof MarkdownView) {
			const editor = leaf.view.editor;
			const start = { line: Math.max(0, source.lineStart - 1), ch: 0 };
			const end = { line: Math.max(0, source.lineEnd - 1), ch: Math.max(0, editor.getLine(Math.max(0, source.lineEnd - 1)).length) };
			editor.setSelection(start, end);
			editor.scrollIntoView({ from: start, to: end }, true);
		}
	}

	async recordNoteHistoryTurn(request: AskRequest, answer: string, model: string): Promise<void> {
		if (!this.settings.noteHistoryEnabled || !request.context.file?.path) {
			return;
		}
		const turn: NoteHistoryTurn = {
			id: `history-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
			sourcePath: request.context.file.path,
			createdAt: new Date().toISOString(),
			title: request.title,
			question: request.question.slice(0, MAX_NOTE_HISTORY_QUESTION_CHARACTERS),
			answer: answer.slice(0, MAX_NOTE_HISTORY_ANSWER_CHARACTERS),
			providerName: request.metadata.providerName,
			model,
			outputMode: request.metadata.outputMode,
			intentKind: request.metadata.intentKind
		};
		const existing = normalizeNoteHistoryStore(this.settings.noteHistoryStore).turns.filter((item) => item.sourcePath !== turn.sourcePath);
		const forNote = this.getNoteHistoryForPath(turn.sourcePath).concat(turn).slice(-this.settings.noteHistoryMaxTurnsPerNote);
		this.settings.noteHistoryStore = { turns: [...existing, ...forNote].slice(-MAX_NOTE_HISTORY_TURNS) };
		await this.saveSettings();
	}

	getNoteHistoryForPath(sourcePath: string): NoteHistoryTurn[] {
		if (!sourcePath) {
			return [];
		}
		return normalizeNoteHistoryStore(this.settings.noteHistoryStore).turns.filter((turn) => turn.sourcePath === sourcePath);
	}

	async clearNoteHistoryForPath(sourcePath: string): Promise<void> {
		this.settings.noteHistoryStore = {
			turns: normalizeNoteHistoryStore(this.settings.noteHistoryStore).turns.filter((turn) => turn.sourcePath !== sourcePath)
		};
		await this.saveSettings();
	}

	async queueReviewItemFromRequest(request: AskRequest, proposedText: string, model: string, scope: ApplyScope = "auto"): Promise<ReviewQueueItem> {
		const file = request.context.file;
		if (!file || file.extension !== "md") {
			throw new Error("Review queue requires a source Markdown note.");
		}
		const normalizedScope = scope === "auto" ? request.context.source === "Selected text" ? "selected-block" : "full-note" : normalizeApplyScope(scope);
		const currentContent = await this.app.vault.cachedRead(file);
		const beforeText = normalizedScope === "selected-block" ? request.context.content : currentContent;
		if (proposedText.length > MAX_REVIEW_QUEUE_TEXT_CHARACTERS || beforeText.length > MAX_REVIEW_QUEUE_TEXT_CHARACTERS) {
			throw new Error("Review queue item is too large. Apply it directly or reduce the output size.");
		}
		const now = new Date().toISOString();
		const item: ReviewQueueItem = {
			id: `review-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
			createdAt: now,
			updatedAt: now,
			status: "pending",
			sourcePath: file.path,
			title: request.title,
			question: request.question.slice(0, 2000),
			proposedText: proposedText.trim(),
			beforeText,
			scope: normalizedScope,
			headingPath: normalizedScope === "heading-section" ? request.context.activeHeadingPath ?? "" : "",
			providerName: request.metadata.providerName,
			model,
			workflowId: request.metadata.workflowId,
			workflowName: request.metadata.workflowName
		};
		this.settings.reviewQueue = normalizeReviewQueueItems([...this.settings.reviewQueue, item], this.settings.reviewQueueMaxItems);
		await this.saveSettings();
		return item;
	}

	getPendingReviewQueueItems(): ReviewQueueItem[] {
		return normalizeReviewQueueItems(this.settings.reviewQueue, this.settings.reviewQueueMaxItems).filter((item) => item.status === "pending");
	}

	async applyReviewQueueItem(id: string): Promise<string> {
		const items = normalizeReviewQueueItems(this.settings.reviewQueue, this.settings.reviewQueueMaxItems);
		const item = items.find((candidate) => candidate.id === id);
		if (!item) {
			throw new Error("Review queue item was not found.");
		}
		const file = this.app.vault.getAbstractFileByPath(item.sourcePath);
		if (!(file instanceof TFile) || file.extension !== "md") {
			throw new Error("Review queue source note was not found.");
		}
		const content = await this.app.vault.cachedRead(file);
		let nextContent = content;
		if (item.scope === "selected-block") {
			const occurrences = findExactOccurrences(content, item.beforeText);
			if (occurrences.length !== 1) {
				throw new Error("AskMate could not safely find the original queued text in the current note.");
			}
			const start = occurrences[0];
			nextContent = `${content.slice(0, start)}${item.proposedText}${content.slice(start + item.beforeText.length)}`;
		} else {
			if (content !== item.beforeText) {
				throw new Error("The source note changed since this review item was queued. Re-run or requeue the suggestion before applying it.");
			}
			const prepared = await this.prepareFrontmatterAwareApply(content, item.proposedText);
			if (prepared.cancelled) {
				return "Review item apply cancelled. No note was changed.";
			}
			nextContent = prepared.text;
		}
		if (!(await this.confirmTextApplyPreview({ scope: item.scope === "selected-block" ? "selected-text" : "full-note", targetLabel: file.path, before: content, after: nextContent }))) {
			return "Review item apply cancelled. No note was changed.";
		}
		await this.app.vault.modify(file, nextContent);
		item.status = "applied";
		item.updatedAt = new Date().toISOString();
		this.settings.reviewQueue = items;
		await this.saveSettings();
		return `Applied queued AskMate change to ${file.path}.`;
	}

	async dismissReviewQueueItem(id: string): Promise<void> {
		this.settings.reviewQueue = normalizeReviewQueueItems(this.settings.reviewQueue, this.settings.reviewQueueMaxItems).map((item) => item.id === id ? { ...item, status: "dismissed", updatedAt: new Date().toISOString() } : item);
		await this.saveSettings();
	}

	private getResultNoteFolder(request: AskRequest): string {
		if (this.settings.smartResultPlacementEnabled && request.context.file?.parent?.path) {
			const parentPath = request.context.file.parent.path === "/" ? "" : request.context.file.parent.path;
			return this.cleanFolderPath(parentPath ? `${parentPath}/AskMate` : "AskMate");
		}
		return this.cleanFolderPath(this.settings.resultFolder);
	}

	private async maybeAppendResultBacklinkToSource(request: AskRequest, resultFile: TFile): Promise<void> {
		if (!this.settings.appendResultBacklinkToSource || !request.context.file || request.context.file.path === resultFile.path) {
			return;
		}
		const sourceFile = request.context.file;
		const content = await this.app.vault.cachedRead(sourceFile);
		const bullet = `- [[${resultFile.path}|${resultFile.basename}]] created ${this.formatDate(new Date())}`;
		if (content.includes(bullet)) {
			return;
		}
		const heading = "## AskMate results";
		const next = content.includes(heading)
			? content.replace(heading, `${heading}\n\n${bullet}`)
			: `${content.trimEnd()}\n\n${heading}\n\n${bullet}\n`;
		await this.app.vault.modify(sourceFile, next);
	}

	private isVisibleMarkdownPath(path: string): boolean {
		return path.endsWith(".md")
			&& !path.startsWith(`${this.app.vault.configDir}/`)
			&& !path.startsWith(".trash/")
			&& !path.includes("/.");
	}

	private async listMarkdownFilesInFolder(folderPath: string, maxFiles: number, excludePath = ""): Promise<TFile[]> {
		const folder = this.cleanFolderPath(folderPath);
		if (!folder) {
			return [];
		}

		const limit = normalizeBoundedInteger(maxFiles, DEFAULT_BATCH_WORKFLOW_MAX_FILES, 1, 100);
		const paths: string[] = [];

		const visit = async (currentFolder: string): Promise<void> => {
			if (paths.length >= limit) {
				return;
			}

			let listed: { files: string[]; folders: string[] };
			try {
				listed = await this.app.vault.adapter.list(currentFolder);
			} catch {
				return;
			}

			for (const path of listed.files.slice().sort((a, b) => a.localeCompare(b))) {
				const normalizedPath = normalizePath(path);
				if (paths.length >= limit) {
					return;
				}
				if (normalizedPath !== excludePath && this.isVisibleMarkdownPath(normalizedPath)) {
					paths.push(normalizedPath);
				}
			}

			for (const path of listed.folders.slice().sort((a, b) => a.localeCompare(b))) {
				await visit(normalizePath(path));
				if (paths.length >= limit) {
					return;
				}
			}
		};

		await visit(folder);
		return paths
			.map((path) => this.app.vault.getAbstractFileByPath(path))
			.filter((file): file is TFile => file instanceof TFile && file.extension === "md");
	}

	async getBatchWorkflowTargetFiles(folderPath: string, maxFiles: number): Promise<TFile[]> {
		return await this.listMarkdownFilesInFolder(folderPath, maxFiles);
	}

	async runBatchWorkflow(
		options: BatchWorkflowRunOptions,
		onProgress?: (progress: BatchWorkflowProgress) => void,
		abortSignal?: AbortSignal
	): Promise<BatchWorkflowSummary> {
		if (this.getSelectedProviderModelRef().capability !== "text") {
			throw new Error(IMAGE_WORKFLOW_MESSAGE);
		}
		const workflow = this.getAllWorkflows().find((item) => item.id === options.workflowId) ?? this.getAllWorkflows()[0];
		if (!workflow) {
			throw new Error("No AskMate workflow is available for batch processing.");
		}
		const files = await this.getBatchWorkflowTargetFiles(options.folderPath, options.maxFiles);
		const summary: BatchWorkflowSummary = { total: files.length, completed: 0, failed: 0, createdNotes: [], queuedReviews: 0 };
		for (const file of files) {
			this.throwIfAborted(abortSignal);
			onProgress?.({ total: files.length, completed: summary.completed, failed: summary.failed, currentPath: file.path, message: `Running ${workflow.name} on ${file.path}` });
			try {
				const request = await this.buildRequest(this.getWorkflowPrompt(workflow), workflow.name, {
					file,
					forceFileContext: true,
					workflow,
					outputMode: "note",
					contextBudgetMode: options.contextBudgetMode,
					commandSource: "command_palette"
				});
				const guardrails = this.evaluateUsageGuardrails(request);
				if (guardrails.blockers.length > 0) {
					throw new Error(guardrails.blockers.join(" "));
				}
				const result = await this.runOpenAIRequest(request, { abortSignal, forceImage: false });
				if (result.kind !== "text") {
					throw new Error("Batch workflows support text responses only.");
				}
				if (options.outputMode === "review-queue") {
					await this.queueReviewItemFromRequest(request, result.text, result.model, "full-note");
					summary.queuedReviews += 1;
				} else {
					const note = await this.createResultNote(request, result.text, { model: result.model });
					summary.createdNotes.push(note.path);
				}
				summary.completed += 1;
			} catch (error) {
				if (isAbortError(error)) {
					throw error;
				}
				summary.failed += 1;
				onProgress?.({ total: files.length, completed: summary.completed, failed: summary.failed, currentPath: file.path, message: this.getErrorMessage(error) });
			}
		}
		onProgress?.({ total: files.length, completed: summary.completed, failed: summary.failed, currentPath: "", message: "Batch workflow complete." });
		return summary;
	}

	async getOpenAiApiKey(): Promise<string> {
		return await this.getProviderApiKey("openai");
	}

	async getProviderApiKey(providerId: TextProviderId = this.getSelectedTextProviderId()): Promise<string> {
		const secretName = this.getProviderSettings(providerId).apiKeySecretName.trim();

		if (!secretName) {
			return "";
		}

		const secret = await Promise.resolve(this.app.secretStorage.getSecret(secretName));
		return secret ?? "";
	}

	getSelectedTextProviderId(): TextProviderId {
		return this.getChatProviderId();
	}

	getChatProviderId(): TextProviderId {
		const roles = normalizeProviderRoleSettings(this.settings.providerRoles, this.settings.selectedTextProvider);
		return roles.chatProviderId;
	}

	getProviderSettings(providerId: TextProviderId = this.getSelectedTextProviderId()): ProviderSettings {
		return this.settings.providers?.[providerId] ?? DEFAULT_PROVIDER_SETTINGS[providerId];
	}

	getSelectedProviderModelRef(): ProviderModelRef {
		return this.getChatProviderModelRef();
	}

	getChatProviderModelRef(): ProviderModelRef {
		const providerId = this.getChatProviderId();
		const provider = this.getProviderSettings(providerId);
		const model = provider.model.trim() || (providerId === "azure-openai" ? "" : DEFAULT_PROVIDER_SETTINGS[providerId].model);
		return {
			providerId,
			providerName: getProviderLabel(providerId),
			model,
			capability: this.getProviderModelCapability(providerId, model)
		};
	}

	getProviderModelCapability(providerId: TextProviderId, model: string): ModelCapability {
		if (providerId === "openai") {
			return getModelCapability(model);
		}

		return "text";
	}

	supportsSelectedReasoningEffort(): boolean {
		const ref = this.getSelectedProviderModelRef();
		return ref.providerId === "openai" && isGpt55Model(ref.model);
	}

	async isSelectedProviderConfigured(): Promise<boolean> {
		const ref = this.getSelectedProviderModelRef();
		const provider = this.getProviderSettings(ref.providerId);
		const hasModel = ref.model.trim().length > 0;

		if (ref.providerId === "openai-compatible") {
			return hasModel && provider.baseUrl.trim().length > 0;
		}

		if (ref.providerId === "azure-openai") {
			try {
				validateAzureOpenAIBaseUrl(provider.baseUrl, DEFAULT_PROVIDER_SETTINGS["azure-openai"].baseUrl);
			} catch {
				return false;
			}
			return hasModel && (await this.getProviderApiKey(ref.providerId)).trim().length > 0;
		}

		return hasModel && (await this.getProviderApiKey(ref.providerId)).trim().length > 0;
	}

	getSelectedModel(): string {
		return this.getSelectedProviderModelRef().model;
	}

	shouldGenerateImageFromQuestion(question: string): boolean {
		const normalized = question.toLowerCase().replace(/\s+/g, " ").trim();

		if (!normalized) {
			return false;
		}

		if (/^\/(?:image|img)\b/.test(normalized)) {
			return true;
		}

		const excludedTextRequest = /\b(?:image prompt|prompt for (?:an? )?image|cover letter|alt text|caption|markdown|mermaid|workflow|wikilink)\b/;

		if (excludedTextRequest.test(normalized)) {
			return false;
		}

		const imageNoun = "(?:image|picture|photo|illustration|artwork|poster|thumbnail|logo|graphic|wallpaper|banner|mockup|drawing|painting)";
		const createVerb = "(?:create|generate|make|draw|design|illustrate|paint|render|produce)";
		const directImageRequest = new RegExp(`\\b${createVerb}\\b.{0,48}\\b${imageNoun}\\b`);
		const imageFirstRequest = new RegExp(`\\b${imageNoun}\\b.{0,48}\\b${createVerb}\\b`);
		return directImageRequest.test(normalized) || imageFirstRequest.test(normalized);
	}

	private getImagePlanningModel(): string {
		const ref = this.getImagePlanningProviderRef();
		return ref.model;
	}

	private getImagePlanningProviderRef(): ProviderModelRef {
		const roles = normalizeProviderRoleSettings(this.settings.providerRoles, this.settings.selectedTextProvider);
		const selected = this.getChatProviderModelRef();

		if (roles.imagePromptPlanningProviderId === "same-as-chat" && selected.capability === "text") {
			return selected;
		}

		if (roles.imagePromptPlanningProviderId !== "same-as-chat") {
			const providerId = normalizeTextProviderId(roles.imagePromptPlanningProviderId);
			const provider = this.getProviderSettings(providerId);
			const model = provider.model.trim() || DEFAULT_PROVIDER_SETTINGS[providerId].model;
			const capability = this.getProviderModelCapability(providerId, model);
			if (capability === "text") {
				return {
					providerId,
					providerName: getProviderLabel(providerId),
					model,
					capability
				};
			}
		}

		const openAi = this.getProviderSettings("openai");
		const model = openAi.modelOptions.find(isGpt55Model) ?? DEFAULT_PROVIDER_SETTINGS.openai.model;
		return {
			providerId: "openai",
			providerName: getProviderLabel("openai"),
			model,
			capability: "text"
		};
	}

	getSelectedReasoningEffort(): ReasoningEffort {
		return normalizeReasoningEffort(this.settings.reasoningEffort);
	}

	async setReasoningEffort(value: unknown): Promise<void> {
		const reasoningEffort = normalizeReasoningEffort(value);

		if (this.settings.reasoningEffort === reasoningEffort) {
			return;
		}

		this.settings.reasoningEffort = reasoningEffort;
		await this.saveSettings();
	}

	getWorkflowPrompt(workflow: Workflow): string {
		if (typeof workflow.prompt === "function") {
			return workflow.prompt(this.settings);
		}

		return workflow.prompt;
	}

	private expandWorkflowPrompt(workflow: Workflow, context: NoteContext, sanitizedContextContent: string): string {
		const now = new Date();
		const variables = this.buildCommonTemplateVariables(context, {
			title: workflow.name,
			request: this.getWorkflowPrompt(workflow),
			response: "",
			model: this.getSelectedModel(),
			workflowName: workflow.name,
			date: this.formatDate(now),
			dateTime: now.toISOString()
		});
		variables.customInstructions = this.settings.workflowCustomInstructions.trim();
		variables.selectedText = context.source === "Selected text" ? sanitizedContextContent : "";
		return this.renderTemplate(this.getWorkflowPrompt(workflow), variables).trim() || this.getWorkflowPrompt(workflow);
	}

	exportCustomWorkflowPresets(): string {
		return JSON.stringify({
			version: 1,
			exportedAt: new Date().toISOString(),
			source: "AskMate",
			workflows: this.settings.customWorkflows
		}, null, 2);
	}

	async importCustomWorkflowPresets(rawValue: string): Promise<number> {
		const raw = rawValue.trim();
		if (!raw) {
			throw new Error("Paste a workflow preset JSON export before importing.");
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			throw new Error("AskMate could not parse that workflow JSON.");
		}

		const workflowsValue = Array.isArray(parsed)
			? parsed
			: parsed && typeof parsed === "object" && Array.isArray((parsed as { workflows?: unknown }).workflows)
				? (parsed as { workflows: unknown[] }).workflows
				: [];

		if (workflowsValue.length === 0) {
			throw new Error("No workflows were found in that preset JSON.");
		}

		const existingIds = new Set(this.settings.customWorkflows.map((workflow) => workflow.id));
		const imported: CustomWorkflow[] = [];

		for (const [index, workflowValue] of workflowsValue.entries()) {
			const workflow = normalizeCustomWorkflow(workflowValue, index);
			if (!workflow) {
				continue;
			}

			if (existingIds.has(workflow.id)) {
				workflow.id = `custom-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 7)}`;
			}
			existingIds.add(workflow.id);
			imported.push(workflow);
		}

		if (imported.length === 0) {
			throw new Error("No valid custom workflows were found in that preset JSON.");
		}

		this.settings.customWorkflows = normalizeCustomWorkflows([
			...this.settings.customWorkflows,
			...imported
		]);
		await this.saveSettings();
		this.refreshOpenAskMateViews();
		return imported.length;
	}

	getAllWorkflows(): Workflow[] {
		return [
			...WORKFLOWS,
			...this.settings.customWorkflows.map((workflow): Workflow => ({
				id: workflow.id,
				commandId: `custom:${workflow.id}`,
				name: workflow.name,
				shortName: workflow.shortName,
				description: workflow.description,
				icon: workflow.icon,
				accent: workflow.accent,
				prompt: workflow.prompt,
				resultNoteTemplate: workflow.resultNoteTemplate,
				isCustom: true
			}))
		];
	}

	getVisibleWorkflows(): Workflow[] {
		const hiddenCustomIds = new Set(this.settings.customWorkflows.filter((workflow) => workflow.hidden).map((workflow) => workflow.id));
		return this.sortWorkflowsForSidebar(this.getAllWorkflows())
			.filter((workflow) => !hiddenCustomIds.has(workflow.id))
			.filter((workflow) => !this.getWorkflowDisplayPreference(workflow.id)?.hidden);
	}

	getWorkflowDisplayPreference(id: string): WorkflowDisplayPreference | null {
		return this.settings.workflowDisplayPreferences.find((preference) => preference.id === id) ?? null;
	}

	async updateWorkflowDisplayPreference(id: string, updates: Partial<WorkflowDisplayPreference>): Promise<void> {
		const existing = this.getWorkflowDisplayPreference(id);
		const fallbackOrder = this.getAllWorkflows().findIndex((workflow) => workflow.id === id);
		const next: WorkflowDisplayPreference = {
			id,
			favorite: updates.favorite ?? existing?.favorite ?? false,
			hidden: updates.hidden ?? existing?.hidden ?? false,
			order: updates.order ?? existing?.order ?? Math.max(0, fallbackOrder)
		};
		const others = this.settings.workflowDisplayPreferences.filter((preference) => preference.id !== id);
		this.settings.workflowDisplayPreferences = normalizeWorkflowDisplayPreferences([...others, next]);
		await this.saveSettings();
		this.refreshOpenAskMateViews();
	}

	async moveWorkflowDisplayPreference(id: string, direction: "up" | "down"): Promise<void> {
		const workflows = this.sortWorkflowsForSidebar(this.getAllWorkflows());
		const ids = workflows.map((workflow) => workflow.id);
		const index = ids.indexOf(id);
		const targetIndex = direction === "up" ? index - 1 : index + 1;

		if (index < 0 || targetIndex < 0 || targetIndex >= ids.length) {
			return;
		}

		[ids[index], ids[targetIndex]] = [ids[targetIndex], ids[index]];
		const existing = new Map(this.settings.workflowDisplayPreferences.map((preference) => [preference.id, preference]));
		this.settings.workflowDisplayPreferences = ids.map((workflowId, order): WorkflowDisplayPreference => {
			const preference = existing.get(workflowId);
			return {
				id: workflowId,
				favorite: preference?.favorite ?? false,
				hidden: preference?.hidden ?? false,
				order
			};
		});
		await this.saveSettings();
		this.refreshOpenAskMateViews();
	}

	private sortWorkflowsForSidebar(workflows: Workflow[]): Workflow[] {
		return workflows
			.map((workflow, index) => ({
				workflow,
				index,
				preference: this.getWorkflowDisplayPreference(workflow.id)
			}))
			.sort((a, b) => {
				const aFavorite = a.preference?.favorite ? 1 : 0;
				const bFavorite = b.preference?.favorite ? 1 : 0;

				if (aFavorite !== bFavorite) {
					return bFavorite - aFavorite;
				}

				const aOrder = a.preference?.order ?? a.index;
				const bOrder = b.preference?.order ?? b.index;
				return aOrder - bOrder || a.index - b.index;
			})
			.map((item) => item.workflow);
	}

	async addCustomWorkflow(): Promise<void> {
		const now = new Date().toISOString();
		this.settings.customWorkflows = [
			...this.settings.customWorkflows,
			{
				id: `custom-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
				name: "New custom workflow",
				shortName: "Custom",
				description: "Custom workflow",
				icon: "wand-2",
				accent: "slate",
				prompt: "Goal: Help improve the current note.\n\nOutput: Return useful Obsidian Markdown.",
				resultNoteTemplate: "",
				hidden: false,
				createdAt: now,
				updatedAt: now
			}
		];
		await this.saveSettings();
		this.refreshOpenAskMateViews();
	}

	async updateCustomWorkflow(id: string, updates: Partial<CustomWorkflow>): Promise<void> {
		const now = new Date().toISOString();
		this.settings.customWorkflows = normalizeCustomWorkflows(this.settings.customWorkflows.map((workflow) => {
			if (workflow.id !== id) {
				return workflow;
			}

			return {
				...workflow,
				...updates,
				id: workflow.id,
				createdAt: workflow.createdAt,
				updatedAt: now
			};
		}));
		await this.saveSettings();
		this.refreshOpenAskMateViews();
	}

	async deleteCustomWorkflow(id: string): Promise<void> {
		this.settings.customWorkflows = this.settings.customWorkflows.filter((workflow) => workflow.id !== id);
		await this.saveSettings();
		this.refreshOpenAskMateViews();
	}

	getSidebarWorkflowOrderForSettings(): Workflow[] {
		return this.sortWorkflowsForSidebar(this.getAllWorkflows());
	}

	refreshOpenAskMateViews(): void {
		for (const leaf of this.app.workspace.getLeavesOfType(ASKMATE_VIEW_TYPE)) {
			if (leaf.view instanceof AskMateView) {
				leaf.view.refreshSettingsSensitiveUi();
			}
		}
	}

	private async buildContextAttachments(
		context: NoteContext,
		options: BuildRequestOptions,
		privacy: RequestPrivacyOptions
	): Promise<ContextAttachment[]> {
		const attachments: ContextAttachment[] = [];

		if (options.includeThreadHistory && options.threadMessages?.length) {
			const thread = this.buildThreadHistoryAttachment(options.threadMessages, this.settings.threadedChatMaxTurns);
			if (thread) {
				attachments.push(thread);
			}
		}

		const noteHistory = this.buildNoteHistoryAttachment(context.file?.path ?? "");
		if (noteHistory) {
			attachments.push(noteHistory);
		}

		const additionalPaths = options.additionalContextPaths ?? this.settings.additionalContextPaths;
		attachments.push(...await this.buildAdditionalNoteAttachments(
			additionalPaths,
			context.file?.path ?? "",
			this.settings.additionalContextMaxCharacters
		));

		const folderContext = options.folderContext ?? {
			enabled: this.settings.folderContextEnabled,
			path: this.settings.folderContextPath,
			maxFiles: this.settings.folderContextMaxFiles,
			maxCharacters: this.settings.folderContextMaxCharacters
		};
		attachments.push(...await this.buildFolderContextAttachments(folderContext, context.file?.path ?? ""));

		const styleGuide = this.settings.includeStyleGuideContext
			? await this.buildRoleContextAttachment("style_guide", this.settings.styleGuideContextPath, context.file?.path ?? "", this.settings.styleGuideMaxCharacters)
			: null;
		if (styleGuide) {
			attachments.push(styleGuide);
		}
		const glossary = this.settings.includeGlossaryContext
			? await this.buildRoleContextAttachment("glossary", this.settings.glossaryContextPath, context.file?.path ?? "", this.settings.glossaryMaxCharacters)
			: null;
		if (glossary) {
			attachments.push(glossary);
		}

		if (this.settings.includeExcalidrawSummaries) {
			attachments.push(...await this.buildExcalidrawSummaryAttachments(context));
		}

		if (privacy.includeImageReferences && this.settings.includeImageManifests) {
			attachments.push(...this.buildImageManifestAttachments(context));
		}

		return attachments;
	}

	private buildThreadHistoryAttachment(messages: ChatMessage[], maxTurns: number): ContextAttachment | null {
		const maxMessages = Math.max(2, maxTurns * 2);
		const history = messages
			.filter((message) => (message.role === "user" || message.role === "assistant") && message.text.trim())
			.slice(-maxMessages);

		if (history.length === 0) {
			return null;
		}

		const content = [
			"Chat history included by AskMate threaded mode.",
			"Use this only to clarify follow-up requests. Keep factual claims grounded in the note and attached context.",
			"",
			...history.map((message) => `${message.role === "user" ? "User" : "AskMate"}: ${message.text.trim()}`)
		].join("\n");
		return this.createContextAttachment("thread_history", "Threaded chat history", "AskMate chat", content, content.length);
	}

	private buildNoteHistoryAttachment(sourcePath: string): ContextAttachment | null {
		if (!this.settings.noteHistoryEnabled || !this.settings.noteHistoryIncludeInContext || !sourcePath) {
			return null;
		}
		const turns = this.getNoteHistoryForPath(sourcePath).slice(-this.settings.noteHistoryMaxTurnsPerNote);
		if (turns.length === 0) {
			return null;
		}
		const content = [
			"Prior AskMate history for this same note. Use it as conversation memory, not as primary factual evidence.",
			"",
			...turns.map((turn) => [`User: ${turn.question}`, `AskMate: ${turn.answer}`].join("\n"))
		].join("\n\n");
		return this.createContextAttachment("note_history", "AskMate note history", sourcePath, content, content.length);
	}

	private async buildRoleContextAttachment(
		kind: "style_guide" | "glossary",
		path: string,
		sourcePath: string,
		maxCharacters: number
	): Promise<ContextAttachment | null> {
		const file = this.resolveMarkdownPath(path, sourcePath);
		if (!file) {
			return null;
		}
		const raw = (await this.app.vault.cachedRead(file)).trim();
		if (!raw) {
			return null;
		}
		const limit = normalizeBoundedInteger(maxCharacters, DEFAULT_ROLE_CONTEXT_MAX_CHARACTERS, 1000, 100000);
		const role = kind === "style_guide" ? "Style guide" : "Glossary";
		const guidance = kind === "style_guide"
			? "Use this attachment for tone, formatting, naming, and writing conventions."
			: "Use this attachment for domain terms, aliases, acronyms, and definitions.";
		const content = [`${role} role context. ${guidance}`, "", raw.slice(0, limit)].join("\n");
		return this.createContextAttachment(kind, `${role}: ${file.path}`, file.path, content, raw.length);
	}

	private createContextAttachment(
		kind: ContextAttachmentKind,
		title: string,
		sourcePath: string,
		content: string,
		originalCharacters = content.length
	): ContextAttachment {
		const normalized = content.trim();
		return {
			kind,
			title,
			sourcePath,
			content: normalized,
			originalCharacters,
			finalCharacters: normalized.length,
			truncated: normalized.length < originalCharacters
		};
	}

	private async buildAdditionalNoteAttachments(paths: string[], sourcePath: string, maxCharacters: number): Promise<ContextAttachment[]> {
		const attachments: ContextAttachment[] = [];
		let remaining = maxCharacters;

		for (const path of normalizeContextPathList(paths)) {
			if (remaining <= 0) {
				break;
			}

			const file = this.resolveMarkdownPath(path, sourcePath);
			if (!file || file.path === sourcePath) {
				continue;
			}

			const raw = (await this.app.vault.cachedRead(file)).trim();
			const content = raw.slice(0, remaining);
			remaining -= content.length;
			attachments.push(this.createContextAttachment(
				"additional_note",
				`Additional note: ${file.path}`,
				file.path,
				content,
				raw.length
			));
		}

		return attachments;
	}

	private async buildFolderContextAttachments(options: FolderContextOptions, excludePath: string): Promise<ContextAttachment[]> {
		if (!options.enabled || !options.path.trim()) {
			return [];
		}

		const folder = this.cleanFolderPath(options.path);
		if (!folder) {
			return [];
		}

		const maxFiles = normalizeBoundedInteger(options.maxFiles, DEFAULT_FOLDER_CONTEXT_MAX_FILES, 1, 100);
		let remaining = normalizeBoundedInteger(options.maxCharacters, DEFAULT_FOLDER_CONTEXT_MAX_CHARACTERS, 1000, 200000);
		const attachments: ContextAttachment[] = [];
		const files = await this.listMarkdownFilesInFolder(folder, maxFiles, excludePath);

		for (const file of files) {
			if (attachments.length >= maxFiles || remaining <= 0) {
				break;
			}

			const raw = (await this.app.vault.cachedRead(file)).trim();
			const content = raw.slice(0, remaining);
			remaining -= content.length;
			attachments.push(this.createContextAttachment(
				"folder_note",
				`Folder note ${attachments.length + 1}: ${file.path}`,
				file.path,
				content,
				raw.length
			));
		}

		return attachments;
	}

	private resolveMarkdownPath(path: string, sourcePath: string): TFile | null {
		const cleanPath = normalizeContextPathList([path])[0] ?? "";
		if (!cleanPath) {
			return null;
		}

		const direct = this.app.vault.getAbstractFileByPath(cleanPath);
		if (direct instanceof TFile && direct.extension === "md") {
			return direct;
		}

		const linked = this.app.metadataCache.getFirstLinkpathDest(cleanPath, sourcePath);
		return linked?.extension === "md" ? linked : null;
	}

	private async buildExcalidrawSummaryAttachments(context: NoteContext): Promise<ContextAttachment[]> {
		const sourcePath = context.file?.path ?? "";
		const files = new Map<string, TFile>();

		if (context.file && this.isExcalidrawPath(context.file.path)) {
			files.set(context.file.path, context.file);
		}

		for (const reference of this.extractLinkedReferences(context.content)) {
			const file = this.app.metadataCache.getFirstLinkpathDest(reference, sourcePath);
			if (file instanceof TFile && this.isExcalidrawPath(file.path)) {
				files.set(file.path, file);
			}
		}

		const attachments: ContextAttachment[] = [];
		for (const file of files.values()) {
			const raw = await this.app.vault.cachedRead(file);
			const summary = this.extractExcalidrawSummary(raw, file.path);
			if (!summary.trim()) {
				continue;
			}
			attachments.push(this.createContextAttachment(
				"excalidraw_summary",
				`Excalidraw summary: ${file.path}`,
				file.path,
				summary,
				raw.length
			));
		}

		return attachments;
	}

	private extractExcalidrawSummary(raw: string, sourcePath: string): string {
		const lines = new Set<string>();
		const addLine = (value: unknown): void => {
			if (typeof value !== "string") {
				return;
			}
			const clean = value.replace(/\s+/g, " ").trim();
			if (clean) {
				lines.add(clean);
			}
		};

		try {
			const parsed = JSON.parse(raw) as { elements?: Array<{ type?: unknown; text?: unknown }> };
			for (const element of parsed.elements ?? []) {
				if (element?.type === "text") {
					addLine(element.text);
				}
			}
		} catch {
			for (const match of raw.matchAll(/"text"\s*:\s*"([^"]+)"/g)) {
				addLine(match[1].replace(/\\"/g, "\""));
			}
		}

		for (const match of raw.matchAll(/!\[\[([^\]]+)\]\]|\[\[([^\]]+)\]\]/g)) {
			addLine(match[1] ?? match[2]);
		}

		const body = Array.from(lines).slice(0, 80).join("\n");
		const content = [
			`Excalidraw text extraction for ${sourcePath}.`,
			"This is not pixel-level visual analysis. It includes readable drawing text, labels, and embedded references when available.",
			"",
			body || "No readable text elements were found."
		].join("\n");
		return content.slice(0, this.settings.excalidrawSummaryMaxCharacters).trim();
	}

	private isExcalidrawPath(path: string): boolean {
		const clean = path.toLowerCase();
		return clean.endsWith(".excalidraw.md") || clean.endsWith(".excalidraw") || clean.endsWith(".excalidraw.json");
	}

	private buildImageManifestAttachments(context: NoteContext): ContextAttachment[] {
		const references = this.extractImageReferenceInfos(context.content);
		if (references.length === 0) {
			return [];
		}

		const sourcePath = context.file?.path ?? "";
		const lines = [
			"Image manifest only. AskMate did not send image pixels to the text provider.",
			"Use paths, labels, captions, and surrounding note text only. Do not claim visual details that are not present in metadata or note context.",
			""
		];

		for (const reference of references.slice(0, MAX_CONTEXT_IMAGE_PREVIEWS * 3)) {
			const clean = reference.target;
			const file = this.app.metadataCache.getFirstLinkpathDest(clean, sourcePath);
			if (file instanceof TFile && IMAGE_FILE_EXTENSIONS.has(file.extension.toLowerCase())) {
				lines.push(`- Local image: ${file.path} (${file.extension}, ${formatTokenCount(file.stat.size)} bytes)`);
			} else {
				lines.push(`- Image reference: ${clean}`);
			}
			if (reference.label) {
				lines.push(`  - Label or alt text: ${reference.label}`);
			}
			if (reference.line) {
				lines.push(`  - Reference line: ${reference.line}`);
			}
		}

		const content = lines.join("\n");
		return [this.createContextAttachment("image_manifest", "Image reference manifest", sourcePath, content, content.length)];
	}

	private extractImageReferenceInfos(markdown: string): ImageReferenceInfo[] {
		const infos: ImageReferenceInfo[] = [];
		for (const line of markdown.split(/\r?\n/)) {
			for (const match of line.matchAll(/!?\[\[([^\]]+)\]\]/g)) {
				const raw = match[1] ?? "";
				const [target, label = ""] = raw.split("|");
				const cleanTarget = this.cleanReferenceText(target ?? "");
				if (cleanTarget && isImageReferencePath(cleanTarget)) {
					infos.push({
						target: cleanTarget,
						label: label.trim(),
						line: line.trim().slice(0, 240)
					});
				}
			}

			for (const match of line.matchAll(/!\[([^\]]*)]\(([^)]+)\)/g)) {
				const cleanTarget = this.cleanReferenceText(match[2] ?? "");
				if (cleanTarget && isImageReferencePath(cleanTarget)) {
					infos.push({
						target: cleanTarget,
						label: (match[1] ?? "").trim(),
						line: line.trim().slice(0, 240)
					});
				}
			}
		}

		return infos;
	}

	private extractLinkedReferences(markdown: string): string[] {
		const references: string[] = [];
		for (const match of markdown.matchAll(/!?\[\[([^\]]+)\]\]/g)) {
			references.push(this.cleanReferenceText(match[1]));
		}
		for (const match of markdown.matchAll(/!?\[[^\]]*]\(([^)]+)\)/g)) {
			references.push(this.cleanReferenceText(match[1]));
		}
		return references.filter(Boolean);
	}

	private extractImageReferencesFromMarkdown(markdown: string): string[] {
		return this.extractImageReferenceInfos(markdown).map((reference) => reference.target);
	}

	private cleanReferenceText(reference: string): string {
		let clean = reference.trim();
		clean = clean.replace(/^<(.+)>$/, "$1");
		clean = clean.replace(/^['"](.+)['"]$/, "$1");
		clean = clean.split("|")[0]?.split("#")[0]?.trim() ?? "";
		try {
			return decodeURI(clean);
		} catch {
			return clean;
		}
	}

	async buildRequest(question: string, title: string, options: BuildRequestOptions = {}): Promise<AskRequest> {
		const intentKind = this.classifyRequestIntent(question, options);
		const providerRef = this.getSelectedProviderModelRef();
		const selectedModel = providerRef.model;
		const forceImage = options.forceImage === true || intentKind === "explicit_image";
		const autoImage = options.autoImage === true || intentKind === "auto_image";
		const context = options.forceFileContext && options.file instanceof TFile && options.file.extension === "md"
			? await this.getFileNoteContext(options.file)
			: await this.getNoteContext(options.editor, options.file);
		const privacy = normalizeRequestPrivacyOptions({ ...this.settings.requestPrivacyDefaults, ...options.privacy });
		const contextBudgetMode = normalizeContextBudgetMode(options.contextBudgetMode ?? this.settings.contextBudgetMode);
		const attachments = await this.buildContextAttachments(context, options, privacy);
		const contextWithAttachments: NoteContext = {
			...context,
			attachments
		};
		const promptContext = this.buildPromptContextContent(contextWithAttachments, privacy, contextBudgetMode);
		const primaryPromptContext = this.buildPromptContextContent({ ...context, attachments: [] }, privacy, contextBudgetMode);
		const workflowVariableContext = privacy.includeNoteContext ? primaryPromptContext.text : "";
		const requestQuestion = options.workflow ? this.expandWorkflowPrompt(options.workflow, contextWithAttachments, workflowVariableContext) : question;
		const folderAttachments = attachments.filter((attachment) => attachment.kind === "folder_note");
		const evidenceSources = privacy.includeNoteContext && providerRef.capability === "text" && !forceImage && !autoImage
			? this.buildEvidenceSources(contextWithAttachments)
			: [];

		return {
			context: contextWithAttachments,
			question: requestQuestion,
			title,
			evidenceSources,
			metadata: {
				intentKind,
				commandSource: options.commandSource ?? "sidebar",
				outputMode: options.outputMode ?? this.settings.outputMode,
				promptVersion: ASKMATE_PROMPT_VERSION,
				providerId: providerRef.providerId,
				providerName: providerRef.providerName,
				selectedModel,
				modelCapability: providerRef.capability,
				reasoningEffort: this.getSelectedReasoningEffort(),
				privacy,
				contextBudgetMode,
				contextBudgetLimitCharacters: promptContext.limitCharacters,
				contextTruncated: promptContext.truncated,
				contextCharacters: promptContext.originalCharacters,
				promptContextCharacters: promptContext.finalCharacters,
				contextAttachmentCount: attachments.length,
				contextAttachmentSources: attachments.map((attachment) => attachment.sourcePath || attachment.title).slice(0, 20),
				threadHistoryIncluded: attachments.some((attachment) => attachment.kind === "thread_history"),
				folderContextPath: folderAttachments.length > 0 ? (options.folderContext?.path ?? this.settings.folderContextPath) : null,
				folderContextFilesIncluded: folderAttachments.length,
				evidenceEnabled: evidenceSources.length > 0,
				evidenceSourceCount: evidenceSources.length,
				forceImage,
				autoImage,
				workflowId: options.workflow?.id ?? null,
				workflowName: options.workflow?.name ?? null,
				createdAt: new Date().toISOString()
			}
		};
	}

	private buildEvidenceSources(context: NoteContext): EvidenceSource[] {
		if (!this.settings.evidenceLinkedAnswersEnabled) {
			return [];
		}
		const sources: EvidenceSource[] = [];
		const addSources = (kind: EvidenceSource["kind"], title: string, sourcePath: string, markdown: string, startLine = 1): void => {
			for (const source of this.buildEvidenceSourcesFromMarkdown(kind, title, sourcePath, markdown, startLine, sources.length)) {
				sources.push(source);
				if (sources.length >= this.settings.evidenceMaxSources) {
					return;
				}
			}
		};
		addSources(
			"primary_note",
			context.source,
			context.file?.path ?? "Untitled or unsaved note",
			context.content,
			context.source === "Selected text" ? context.selectionStartLine ?? 1 : 1
		);
		for (const attachment of context.attachments ?? []) {
			if (!["additional_note", "folder_note", "excalidraw_summary"].includes(attachment.kind)) {
				continue;
			}
			addSources(attachment.kind, attachment.title, attachment.sourcePath, attachment.content, 1);
			if (sources.length >= this.settings.evidenceMaxSources) {
				break;
			}
		}
		return sources.slice(0, this.settings.evidenceMaxSources).map((source, index) => ({ ...source, id: `S${index + 1}` }));
	}

	private buildEvidenceSourcesFromMarkdown(
		kind: EvidenceSource["kind"],
		title: string,
		sourcePath: string,
		markdown: string,
		startLine: number,
		offset: number
	): EvidenceSource[] {
		const sources: EvidenceSource[] = [];
		const lines = markdown.split(/\r?\n/);
		let blockStart = 0;
		let blockLines: string[] = [];
		const flush = (): void => {
			const excerpt = blockLines.join("\n").replace(/\s+/g, " ").trim().slice(0, 240);
			if (excerpt) {
				sources.push({
					id: `S${offset + sources.length + 1}`,
					kind,
					sourcePath,
					title,
					lineStart: startLine + blockStart,
					lineEnd: startLine + blockStart + Math.max(0, blockLines.length - 1),
					excerpt
				});
			}
			blockLines = [];
		};
		for (let index = 0; index < lines.length; index += 1) {
			const line = lines[index];
			if (!line.trim()) {
				flush();
				blockStart = index + 1;
				continue;
			}
			if (/^#{1,6}\s+/.test(line) && blockLines.length > 0) {
				flush();
				blockStart = index;
			}
			if (blockLines.length === 0) {
				blockStart = index;
			}
			blockLines.push(line);
		}
		flush();
		return sources;
	}

	private formatEvidenceSources(request: AskRequest): string {
		if (request.evidenceSources.length === 0) {
			return "";
		}
		return request.evidenceSources
			.map((source) => `[${source.id}] ${source.sourcePath}#L${source.lineStart}-L${source.lineEnd}: ${source.excerpt}`)
			.join("\n");
	}

	private getPromptContextContent(request: AskRequest): string {
		return this.buildPromptContextContent(
			request.context,
			request.metadata.privacy,
			request.metadata.contextBudgetMode
		).text;
	}

	private buildPromptContextContent(
		context: NoteContext,
		privacy: RequestPrivacyOptions,
		contextBudgetMode: ContextBudgetMode
	): PromptContextResult {
		if (!privacy.includeNoteContext) {
			const text = "[Note context omitted by AskMate privacy controls.]";
			return {
				text,
				originalCharacters: context.content.length,
				finalCharacters: text.length,
				truncated: false,
				limitCharacters: null
			};
		}

		const budget = getContextBudgetOption(contextBudgetMode);
		const attachmentText = (context.attachments ?? [])
			.filter((attachment) => attachment.content.trim())
			.map((attachment) => [
				"",
				`<context_attachment kind="${attachment.kind}" title="${attachment.title.replace(/"/g, "'")}" source="${attachment.sourcePath.replace(/"/g, "'")}">`,
				attachment.content,
				"</context_attachment>"
			].join("\n"))
			.join("\n");
		const assembledContent = [context.content, attachmentText].filter((part) => part.trim()).join("\n\n");
		const originalCharacters = assembledContent.length;
		let content = privacy.includeImageReferences
			? assembledContent
			: assembledContent
				.replace(/!?\[\[([^\]]+)\]\]/g, (match, reference: string) => {
					return isImageReferencePath(reference) ? "[Image reference omitted by AskMate privacy controls.]" : match;
				})
				.replace(/!?\[[^\]]*\]\(([^)]+)\)/g, (match, reference: string) => {
					return isImageReferencePath(reference) ? "[Image reference omitted by AskMate privacy controls.]" : match;
				});

		if (budget.maxCharacters !== null && content.length > budget.maxCharacters) {
			const marker = `\n\n[AskMate omitted ${formatTokenCount(content.length - budget.maxCharacters)} characters from the middle because the ${budget.label} context budget is selected. Switch to Expanded to include more.]\n\n`;
			const available = Math.max(0, budget.maxCharacters - marker.length);
			const headLength = Math.floor(available * 0.7);
			const tailLength = Math.max(0, available - headLength);
			content = `${content.slice(0, headLength).trimEnd()}${marker}${content.slice(content.length - tailLength).trimStart()}`;

			return {
				text: content,
				originalCharacters,
				finalCharacters: content.length,
				truncated: true,
				limitCharacters: budget.maxCharacters
			};
		}

		return {
			text: content,
			originalCharacters,
			finalCharacters: content.length,
			truncated: false,
			limitCharacters: budget.maxCharacters
		};
	}

	private buildPrompt(request: AskRequest): string {
		const sourcePath = request.context.file?.path ?? "Untitled or unsaved note";
		const promptContext = this.getPromptContextContent(request);
		const evidenceSourceText = request.metadata.privacy.includeNoteContext ? this.formatEvidenceSources(request) : "";

		return [
			"Goal: Complete the user request using the note context below.",
			"",
			"Success criteria:",
			"- Address the requested task directly.",
			"- Use the note context as the evidence source.",
			"- State what is missing if the note context is insufficient.",
			"- Keep the final output useful as Obsidian Markdown.",
			"",
			"Stop rules: Answer once the core request is satisfied. Do not add unrelated sections.",
			"",
			`Prompt version: ${request.metadata.promptVersion}`,
			`Intent: ${formatRequestIntent(request.metadata.intentKind)}`,
			`Workflow: ${request.metadata.workflowName ?? "None"}`,
			`Source: ${sourcePath}`,
			`Context type: ${request.context.source}`,
			"",
			"<note_context>",
			promptContext,
			"</note_context>",
			evidenceSourceText ? "" : "",
			evidenceSourceText ? "<evidence_sources>" : "",
			evidenceSourceText,
			evidenceSourceText ? "</evidence_sources>" : "",
			"",
			"<user_request>",
			request.question,
			"</user_request>"
		].join("\n");
	}

	private buildTextInstructions(): string {
		return [
			"Role: You are AskMate, a concise AI assistant inside Obsidian for working with the user's notes.",
			"",
			"Goal: Complete the user's request using the provided note context, whether the task is Q&A, translation, summarization, analysis, rewriting, extraction, or another note workflow.",
			"",
			"Success criteria: Address the exact request, preserve important source details, make factual claims traceable to the note context, and produce clear Markdown that can be pasted into an Obsidian note.",
			"",
			"Constraints: Do not invent details. If the context is insufficient, say what is missing. Thread history and note history can clarify follow-up intent, but factual claims must still be grounded in the note context or explicit context attachments. Style guide and glossary attachments are guidance roles for tone, terminology, and formatting, not primary evidence. Image manifests are metadata only, not pixel-level vision. When evidence sources are provided, cite factual claims with source IDs like [S1] or [S2] when useful. For translation, preserve meaning, tone, structure, names, numbers, terminology, and formatting unless asked to adapt. For summaries, include quotes or timestamps only when present. For analysis, separate observations from recommendations when useful and label uncertainty.",
			"",
			"Output: Stay concise and direct. Use headings, bullets, or numbered lists only when they improve readability. Stop when the user's request is answered."
		].join("\n");
	}

	private async recordOperationUsage({
		request,
		providerId,
		providerName,
		operationKind,
		endpoint,
		status,
		model,
		instructions,
		input,
		responseText,
		usage,
		startedAt,
		errorMessage = ""
	}: {
		request: AskRequest;
		providerId?: TextProviderId;
		providerName?: string;
		operationKind: OperationKind;
		endpoint: ApiEndpoint;
		status: OperationStatus;
		model: string;
		instructions: string;
		input: string;
		responseText: string;
		usage: OpenAITokenUsage | null;
		startedAt: Date;
		errorMessage?: string;
	}): Promise<void> {
		try {
			const inputUsage = endpoint === "images_generations" ? 0 : getNonNegativeInteger(usage?.input_tokens);
			const outputUsage = endpoint === "images_generations" ? 0 : getNonNegativeInteger(usage?.output_tokens);
			const totalUsage = endpoint === "images_generations" ? 0 : getNonNegativeInteger(usage?.total_tokens);
			const inputTokens = inputUsage ?? estimateTokenCount(`${instructions}\n\n${input}`);
			const outputTokens = outputUsage ?? estimateTokenCount(responseText);
			const componentTotal = inputTokens + outputTokens;
			const totalTokens = Math.max(totalUsage ?? componentTotal, componentTotal);
			const record: TokenUsageRecord = {
				id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
				timestamp: new Date().toISOString(),
				providerId: providerId ?? normalizeTextProviderId(request.metadata.providerId),
				providerName: (providerName ?? request.metadata.providerName ?? getProviderLabel(normalizeTextProviderId(request.metadata.providerId))).trim(),
				model,
				title: request.title.trim() || "AskMate request",
				contextSource: request.context.source,
				sourcePath: request.context.file?.path ?? "",
				inputTokens,
				outputTokens,
				totalTokens,
				cachedInputTokens: getNonNegativeInteger(usage?.input_tokens_details?.cached_tokens) ?? 0,
				reasoningOutputTokens: getNonNegativeInteger(usage?.output_tokens_details?.reasoning_tokens) ?? 0,
				durationMs: Math.max(0, Date.now() - startedAt.getTime()),
				estimated: endpoint === "images_generations" || inputUsage === null || outputUsage === null || totalUsage === null,
				operationKind,
				outputMode: request.metadata.outputMode,
				promptVersion: request.metadata.promptVersion,
				status,
				endpoint,
				errorMessage: errorMessage.trim().slice(0, 240)
			};

			const existing = normalizeTokenUsageStats(this.settings.tokenUsageStats).records;
			this.settings.tokenUsageStats = {
				records: [...existing, record].slice(-MAX_TOKEN_USAGE_RECORDS)
			};
			await this.saveSettings();
		} catch (error) {
			console.warn("AskMate could not save token usage statistics.", error);
		}
	}

	getTokenUsageRecords(): TokenUsageRecord[] {
		return [...normalizeTokenUsageStats(this.settings.tokenUsageStats).records];
	}

	getTokenUsageSummary(): TokenUsageSummary {
		return summarizeTokenUsage(this.getTokenUsageRecords());
	}

	async resetTokenUsageStats(): Promise<void> {
		this.settings.tokenUsageStats = { records: [] };
		await this.saveSettings();
	}

	private async runWorkflowFromCommand(workflow: Workflow, editor: Editor, noteFile: TFile | null): Promise<void> {
		try {
			if (this.getSelectedProviderModelRef().capability !== "text") {
				throw new Error(IMAGE_WORKFLOW_MESSAGE);
			}

			const request = await this.buildRequest(this.getWorkflowPrompt(workflow), workflow.name, {
				editor,
				file: noteFile,
				workflow,
				commandSource: "command_palette",
				outputMode: "note"
			});
			await this.confirmUsageGuardrails(request);
			new Notice(`AskMate is running "${workflow.name}"...`);
			const result = await this.runOpenAIRequest(request);

			if (result.kind !== "text") {
				throw new Error(IMAGE_WORKFLOW_MESSAGE);
			}

			const resultFile = await this.createResultNote(request, result.text, { model: result.model });
			new Notice(`AskMate created ${resultFile.path}`);
		} catch (error) {
			new Notice(this.getErrorMessage(error));
		}
	}

	private async runImageFromCommand(editor: Editor, noteFile: TFile | null): Promise<void> {
		try {
			const request = await this.buildRequest(DEFAULT_IMAGE_PROMPT, "AskMate Image", {
				editor,
				file: noteFile,
				commandSource: "command_palette",
				outputMode: "note",
				forceImage: true
			});
			await this.confirmUsageGuardrails(request);
			new Notice("AskMate is generating an image...");
			const result = await this.runOpenAIRequest(request, { forceImage: true });

			if (result.kind !== "image") {
				throw new Error(IMAGE_WORKFLOW_MESSAGE);
			}

			const { noteFile: resultNote } = await this.createImageResultNote(request, result);
			new Notice(`AskMate created ${resultNote.path}`);
		} catch (error) {
			new Notice(this.getErrorMessage(error));
		}
	}

	private getImageResultFolder(request?: AskRequest, result?: ImageAskMateResult): string {
		const fallbackFolder = this.cleanFolderPath(this.settings.resultFolder);
		if (!request || !result) {
			return fallbackFolder ? `${fallbackFolder}/Images` : "AskMate Images";
		}

		const variables = {
			...this.buildRequestTemplateVariables(request, "", result.model),
			imagePrompt: result.image.prompt,
			revisedPrompt: result.image.revisedPrompt ?? "",
			planningModel: result.promptPlan.planningModel,
			planningStatus: formatOperationStatus(result.promptPlan.status),
			planningFallback: result.promptPlan.fallbackReason ?? ""
		};
		const rendered = this.renderTemplate(this.settings.imageFolderTemplate, variables);
		const folder = this.cleanFolderPath(rendered);
		return folder || (fallbackFolder ? `${fallbackFolder}/Images` : "AskMate Images");
	}

	private createImageEmbed(file: TFile): string {
		return `![[${file.path}]]`;
	}

	private decodeBase64Image(base64: string): ArrayBuffer {
		const cleanBase64 = base64
			.replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, "")
			.replace(/\s/g, "");

		if (!cleanBase64) {
			throw new Error("OpenAI returned empty image data.");
		}

		try {
			const binary = window.atob(cleanBase64);
			const bytes = new Uint8Array(binary.length);

			for (let index = 0; index < binary.length; index += 1) {
				bytes[index] = binary.charCodeAt(index);
			}

			return bytes.buffer;
		} catch {
			throw new Error("OpenAI returned invalid base64 image data.");
		}
	}

	private cleanFolderPath(folder: string): string {
		return normalizePath(folder.trim()).replace(/^\/+|\/+$/g, "");
	}

	private async ensureFolder(folder: string): Promise<void> {
		if (!folder) {
			return;
		}

		const parts = folder.split("/").filter(Boolean);
		let current = "";

		for (const part of parts) {
			current = current ? `${current}/${part}` : part;
			const existing = this.app.vault.getAbstractFileByPath(current);

			if (existing instanceof TFile) {
				throw new Error(`Cannot create folder "${current}" because a file already exists there.`);
			}

			if (!existing) {
				await this.app.vault.createFolder(current);
			}
		}
	}

	private async createUniqueMarkdownPath(folder: string, baseName: string): Promise<string> {
		return await this.createUniquePath(folder, baseName, "md");
	}

	private async createUniquePath(folder: string, baseName: string, extension: string): Promise<string> {
		const stamp = this.formatTimestamp(new Date());
		const safeExtension = extension.replace(/^\.+/, "");
		const basePath = folder ? `${folder}/${baseName} ${stamp}` : `${baseName} ${stamp}`;
		let path = `${basePath}.${safeExtension}`;
		let suffix = 2;

		while (this.app.vault.getAbstractFileByPath(path)) {
			path = `${basePath} ${suffix}.${safeExtension}`;
			suffix += 1;
		}

		return path;
	}

	private sanitizeFileName(name: string): string {
		const clean = name
			.replace(/[\\/:*?"<>|#^[\]]/g, "")
			.replace(/\s+/g, " ")
			.trim()
			.slice(0, 80);

		return clean || "AskMate Response";
	}

	private formatTimestamp(date: Date): string {
		const year = date.getFullYear();
		const month = String(date.getMonth() + 1).padStart(2, "0");
		const day = String(date.getDate()).padStart(2, "0");
		const hour = String(date.getHours()).padStart(2, "0");
		const minute = String(date.getMinutes()).padStart(2, "0");
		return `${year}-${month}-${day} ${hour}${minute}`;
	}

	getErrorMessage(error: unknown): string {
		if (error instanceof DOMException && error.name === "AbortError") {
			return "AskMate request stopped.";
		}

		if (error instanceof Error) {
			return error.message;
		}

		return "AskMate failed because of an unknown error.";
	}
}

export default AskMatePlugin;
