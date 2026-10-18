import { Editor, MarkdownView, Menu, Notice, Platform, Plugin, TAbstractFile, TFile, TFolder, addIcon, getLanguage, requestUrl, type WorkspaceLeaf } from "obsidian";
import {
	ApiEndpoint,
	ApplyScope,
	ASKMATE_ICON_ID,
	ASKMATE_PROMPT_VERSION,
	ASKMATE_VIEW_TYPE,
	AskMateHttpResponse,
	AskMateSettings,
	AskRequest,
	BatchWorkflowProgress,
	BatchWorkflowRunOptions,
	BatchWorkflowSummary,
	BuildRequestOptions,
	CustomWorkflow,
	DEFAULT_IMAGE_PROMPT,
	DEFAULT_IMAGE_RESULT_NOTE_TEMPLATE,
	DEFAULT_PROVIDER_SETTINGS,
	DEFAULT_RESULT_NOTE_TEMPLATE,
	estimateTokenCount,
	EvidenceCitation,
	EvidenceSource,
	FIRST_PARTY_PROVIDER_IDS,
	findExactOccurrences,
	formatOperationStatus,
	formatOutputMode,
	formatRequestIntent,
	getContextBudgetOption,
	getModelCapability,
	getProviderLabel,
	getSupportedReasoningEffort,
	GPT_IMAGE_2_MODEL_ID,
	IMAGE_WORKFLOW_MESSAGE,
	MarkdownHeadingSection,
	MAX_CUSTOM_WORKFLOWS,
	ImageAskMateResult,
	ImagePromptPlan,
	appendMarkdownBlockToContent,
	appliedMutation,
	assertNoteUnchangedDuringPreview,
	awaitWithAbortAndTimeout,
	cancelledMutation,
	normalizeAskMateSettings,
	normalizeAskMateSettingsWithDiagnostics,
	normalizeCustomWorkflows,
	createAbortError,
	isAbortError,
	isGpt55Model,
	ModelCapability,
	MutationOutcome,
	normalizeApplyApprovalMode,
	normalizeCustomWorkflowsWithDiagnostics,
	normalizeProviderModelOptions,
	normalizeProviderRoleSettings,
	normalizeReasoningEffort,
	normalizeReviewQueueItems,
	normalizeTextProviderId,
	normalizeWorkflowDisplayPreferences,
	NoteContext,
	NoteHistoryTurn,
	OpenAITokenUsage,
	OperationKind,
	OperationStatus,
	ProviderModelRef,
	ProviderSettings,
	ReasoningEffort,
	RequestIntentKind,
	RequestPrivacyOptions,
	ReviewQueueItem,
	resolveApplyScope,
	resolveSelectionIdentity,
	SelectionIdentity,
	SettingsDiagnostic,
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
	fetchProviderModels,
	normalizeOpenAIModelOptions,
	testProviderConnection as testProviderConnectionWithProvider,
	testProviderConnectionDetailed as testProviderConnectionDetailedWithProvider
} from "../providers";
import type { ProviderConnectionTestResult, ProviderRequestOptions, ProviderRuntime } from "../providers";
import { fetchSse } from "../providers/sseTransport";
import { UsageService, getLocalDayKey, sumUsageTotalsForMonth } from "../usage";
import { HistoryService } from "../history";
import { ThreadService, describeThreadStoreTrim, measureThreadStoreTrim } from "../threads";
import { ContextService, FolderNotFoundError, cleanFolderPath, describeSkippedContext } from "../context";
import { describeVaultMentionResolutions, rankVaultTags } from "../context/vaultMentions";
import { RequestRunner, buildFallbackImagePrompt } from "../requests";
import { buildRequestInput, buildRequestInstructions, APPLY_REFUSAL_PREFIX } from "../requests/requestBuilders";
import type { ContextReport } from "../requests/RequestRunner";
import type { DiagramPort, DiagramRuntime, ExtendedBuildOptions, RunFacts, RunOptions, RunResult, ToolApprovalCard, ToolApprovalChoice } from "../requests/runTypes";
import {
	appendWorkflowUserPreferences,
	applyTextInsertion,
	buildDateTemplateValues,
	buildUniquePathCandidate,
	chooseSmartResultFolder,
	closeOpenFencesInVariables,
	endsInsideOpenFence,
	getReplaceBlockReason,
	isOriginalSelectionNote,
	planRangeEdit,
	prepareFrontmatterAwareApply,
	getHeadingSectionCore,
	getParentPath,
	isSameNoteText,
	parseMarkdownHeadingSections,
	planResultBacklinkInsertion,
	renderTemplate,
	sanitizeFileName,
	sanitizePathTemplateValues,
	spliceHeadingSectionBody,
	trimOuterBlankLines
} from "../output";
import { buildEditorMenuEntries } from "./editorMenu";
import { syncObjectInPlace } from "../settings/syncInPlace";
import { shouldGenerateImage } from "../shared/imageIntent";
import { askMcpTrust } from "../ui/modals/McpTrustModal";
import { askToolApproval } from "../ui/modals/ToolApprovalModal";
import { askMateConfirm, askMateDiffConfirm } from "../ui/modals/modals";
import { AskMateView } from "../ui/sidebar/AskMateView";
import { registerAnswerCommands } from "./answerCommands";
import { AskMateSettingTab } from "../ui/settings/AskMateSettingTab";
import { ASKMATE_ICON_SVG } from "../brand/icons";
import { SkillService, type SkillConfig, type SkillHost } from "../skills";
import { McpService, forgetServerTrust, type McpHost, type TrustRequest } from "../mcp";
import { createScratchHost, supportedDiagrams, toMermaidApi, type MermaidApi } from "../diagrams";
import { guardSafetyCheck } from "../requests/diagramRun";
import { deriveSetupState, mapProviderErrorToSetupCopy, planConnect, shouldShowFirstRunNotice, FIRST_RUN_NOTICE, IDLE_SETUP_TEST, type SetupErrorCopy, type SetupStage, type SetupTestState } from "../setup";
import { CommandRunRegistry } from "./commandRuns";
import { INITIAL_BATCH_STATE, batchResultTitle, classifyBatchFailure, describeEmptyBatch, nextBatchDecision } from "./batchPolicy";
import { classifyStoredData, corruptBackupName, mergeAddsToIncoming, mergeExternalSettings, predatesSettingsSchema, trimBackupName } from "./settingsLoad";
import { deriveResultNoteTitle, ensureTemplateKeepsAnswer, withIncompleteCallout } from "./resultNoteModel";
import { describeActiveContentAdded, describeWriteChanges, joinWarnings, prepareReplyForWrite } from "./writeSafety";
import { McpApprovalRouter, createDeviceTrustStore, createHttpRequest, createMcpHost, createSecretReader, toApprovalDialogInput, type LaunchModule } from "./mcpHost";
import { askMateChoice } from "./choiceModal";
import { listFolderFiles } from "./folderFiles";
import { describeAddedAtSend, type InspectedPrompt } from "./promptInspection";
import { findLeafForFile } from "./leaves";
import { planEmbedInsertion, type EmbedPlan } from "./imagePlacement";
import { describeImportConcerns, findImportConcerns, withSafeImportDefaults } from "./importReview";
import { createObsidianApi, type ObsidianApi } from "./obsidianApi";
import type { PreparedWrite } from "./writeSafety";
import { endpointHost, needsKeyApproval } from "./keyApproval";

const NOTE_IDENTITY_WITHHELD = "[withheld by AskMate privacy controls]";
const MAX_UNIQUE_PATH_ATTEMPTS = 50;
/** Free-text template values that can contain model output or the user's question. */
const MODEL_DERIVED_TEMPLATE_KEYS = ["title", "request", "response", "imagePrompt", "revisedPrompt", "planningFallback"] as const;
/** Template values that hold text, so one with an unclosed code fence must not swallow the rest of the note. */
const FENCE_CLOSED_TEMPLATE_KEYS = ["request", "response", "selectedText"] as const;
const KEY_APPROVAL_PREFIX = "askmate-key-approval:";
const NOTICE_SECONDS = 1000;

const SETTINGS_TAB_ID = "askmate";

export interface BatchWorkflowRunSummary extends BatchWorkflowSummary {
	/** Why the batch ended before every file was processed, or null when it ran to the end. */
	stoppedReason: string | null;
	failures: { path: string; reason: string }[];
}

/** A connection test with the plain-language reading of a failure, ready for the setup card and the status bar. */
export interface ProviderConnectionResult extends ProviderConnectionTestResult {
	copy: SetupErrorCopy | null;
}

export class AskMatePlugin extends Plugin {
	settings!: AskMateSettings;
	private usageService!: UsageService;
	private historyService!: HistoryService;
	threads!: ThreadService;
	/** Built-in and vault skills. Scanned once the workspace is ready. */
	skillService!: SkillService;
	private contextService!: ContextService;
	private requestRunner!: RequestRunner;
	private reviewQueueMutationActive = false;
	private settingsSaveChain: Promise<void> = Promise.resolve();
	private viewActivation: Promise<void> | null = null;
	private settingTab: AskMateSettingTab | null = null;
	private batchRunActive = false;
	private readonly commandRuns = new CommandRunRegistry();
	private readonly mcpApprovals = new McpApprovalRouter();
	private mcpInstance: McpService | null = null;
	private launcher: LaunchModule | null = null;
	private launcherLoad: Promise<void> | null = null;
	private mermaidApi: MermaidApi | null = null;
	private diagramRuntime: Promise<DiagramRuntime | null> | null = null;
	private unloading: Promise<void> = Promise.resolve();
	private firstRun = false;
	private lastBuiltRequest: AskRequest | null = null;
	private lastSetupTest: SetupTestState = IDLE_SETUP_TEST;
	private lastMcpSignature = "";
	private lastSkillsSignature = "";
	/** Mermaid and the YAML parser, looked up when used. Replaced by fakes in tests. */
	obsidianApi: ObsidianApi = createObsidianApi();
	/**
	 * How the person is asked to trust an MCP server. The dialog shows the exact command or address in a block of its own
	 * and spells out characters that cannot be seen, so a look-alike program name cannot pass for the real one.
	 */
	readonly mcpPrompts: { confirmTrust: (request: TrustRequest) => Promise<boolean> } = {
		confirmTrust: async (request) => await askMcpTrust(this.app, request)
	};

	/**
	 * Asks about one tool call in a dialog, for a run that has no inline approval card of its own. A stopped run closes the
	 * dialog, which counts as a refusal.
	 */
	confirmToolCall(card: ToolApprovalCard, signal?: AbortSignal): Promise<ToolApprovalChoice> {
		return askToolApproval(this.app, toApprovalDialogInput(card), signal);
	}

	/**
	 * The MCP client, or null off the desktop and while MCP is switched off. Nothing starts when it is created: servers are
	 * trusted and started on first use. It stays reachable until unload so switching MCP off can still stop what runs.
	 */
	get mcpService(): McpService | null {
		if (!Platform.isDesktopApp || !this.settings?.mcp.enabled) {
			return null;
		}
		if (!this.mcpInstance) {
			this.mcpInstance = new McpService(this.buildMcpHost());
			void this.ensureLauncher();
		}
		return this.mcpInstance;
	}

	/**
	 * Forgets a server's trust on this device and stops it if it runs. It works whether tools are on or off, on the desktop or
	 * not: with no service it removes the trust record directly, so Revoke trust and Delete server never depend on tools being on.
	 */
	async revokeMcpTrust(serverId: string): Promise<void> {
		// The instance outlives switching tools off, so a server that is still running is stopped too.
		if (this.mcpInstance) {
			await this.mcpInstance.revokeTrust(serverId);
			return;
		}
		forgetServerTrust(createDeviceTrustStore(this.app), serverId);
	}

	private getProviderRuntime(): ProviderRuntime {
		return {
			getProviderSettings: (providerId) => this.getProviderSettings(providerId),
			getProviderApiKey: (providerId) => this.getProviderApiKey(providerId),
			requestJson: async <T>(url: string, options?: ProviderRequestOptions) => await this.requestJson<T>(url, options),
			// requestUrl buffers the whole body and cannot be cancelled, so streaming uses fetch; providers validate URLs before calling.
			...(this.settings.streamResponses
				? { streamSse: async (url, options, onEvent) => await fetchSse((input, init) => window.fetch(input, init), url, options, onEvent) }
				: {})
		};
	}

	async onload(): Promise<void> {
		await this.loadSettings();
		this.usageService = new UsageService({
			getSettings: () => this.settings,
			saveSettings: () => this.saveSettings()
		});
		this.historyService = new HistoryService({
			getSettings: () => this.settings,
			saveSettings: () => this.saveSettings(),
			readFileText: async (path) => {
				const file = this.app.vault.getAbstractFileByPath(path);
				if (!(file instanceof TFile) || file.extension !== "md") {
					throw new Error(`AskMate could not read ${path}.`);
				}
				return await this.app.vault.cachedRead(file);
			}
		});

		this.threads = new ThreadService({
			getSettings: () => this.settings,
			saveSettings: () => this.saveSettings(),
			// Without this a failing disk loses conversations without a word.
			notify: (message) => {
				new Notice(message);
			}
		});

		this.contextService = new ContextService({
			app: this.app,
			getSettings: () => this.settings,
			getNoteHistoryForPath: (path) => this.getNoteHistoryForPath(path)
		});
		this.skillService = new SkillService(this.buildSkillHost());
		this.requestRunner = new RequestRunner({
			getSettings: () => this.settings,
			getProviderRuntime: () => this.getProviderRuntime(),
			getOpenAiApiKey: () => this.getOpenAiApiKey(),
			getSelectedProviderModelRef: () => this.getSelectedProviderModelRef(),
			getSelectedReasoningEffort: () => this.getSelectedReasoningEffort(),
			getImagePlanningProviderRef: () => this.getImagePlanningProviderRef(),
			getImagePlanningModel: () => this.getImagePlanningModel(),
			shouldGenerateImageFromQuestion: (question) => this.shouldGenerateImageFromQuestion(question),
			recordOperationUsage: (params) => this.recordOperationUsage(params),
			getErrorMessage: (error) => this.getErrorMessage(error),
			expandWorkflowPrompt: (workflow, context, sanitized, privacy?: RequestPrivacyOptions) => this.expandWorkflowPrompt(workflow, context, sanitized, privacy),
			getNoteContext: async (editor, file, options) => options?.allowNoNote
				? await this.contextService.getNoteContext(editor, file, { allowNoNote: true })
				: await this.getNoteContext(editor, file),
			getFileNoteContext: (file) => this.getFileNoteContext(file),
			getFullNoteContext: (file) => this.contextService.getFullNoteContext(file),
			buildContextAttachments: (context, options, privacy) => this.contextService.buildContextAttachments(context, options, privacy),
			buildContextAttachmentsDetailed: (context, options, privacy) => this.contextService.buildContextAttachmentsDetailed(context, options, privacy),
			describeContextReport: (detail) => ({
				mentions: describeVaultMentionResolutions(detail.resolutions),
				skipped: describeSkippedContext(detail.skipped)
			}),
			getWorkflowSkillIds: (workflowId) => this.getAllWorkflows().find((workflow) => workflow.id === workflowId)?.skillIds ?? [],
			extensions: {
				skills: { resolve: (input) => this.skillService.resolve(input) },
				diagrams: this.buildDiagramPort(),
				tools: {
					getService: () => {
						const service = this.mcpService;
						// A local server cannot start before the launcher is loaded, so a run waits for it.
						return service
							? {
								prepareRun: async (signal) => {
									await this.ensureLauncher();
									return await service.prepareRun(signal);
								},
								callTool: (call, signal) => service.callTool(call, signal)
							}
							: null;
					},
					registerApproval: (signal, handler) => this.mcpApprovals.register(signal, handler),
					confirmCall: (card, signal) => this.confirmToolCall(card, signal)
				}
			},
			notify: (message) => {
				new Notice(message);
			},
			throwIfAborted: (abortSignal) => this.throwIfAborted(abortSignal)
		});

		// The icon must exist before the view that uses it is registered.
		addIcon(ASKMATE_ICON_ID, ASKMATE_ICON_SVG);
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
		this.registerEvent(
			this.app.workspace.on("quit", (tasks) => {
				// Saved conversations are debounced, so a quit inside that window would lose the last turn. Local MCP servers are
				// child processes: Obsidian ends without unloading plugins, so they are stopped here or they outlive it.
				tasks.add(async () => {
					await this.shutdownServices();
					await this.settingsSaveChain;
				});
			})
		);
		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				this.contextService.handleFileRenamed(file, oldPath);
				void this.historyService.handleFileRenamed(oldPath, file.path).catch((error: unknown) => {
					new Notice(`AskMate could not move saved history for ${oldPath}: ${this.getErrorMessage(error)}`);
				});
				void this.threads.handleFileRenamed(oldPath, file.path).catch((error: unknown) => {
					new Notice(`AskMate could not move saved conversations for ${oldPath}: ${this.getErrorMessage(error)}`);
				});
			})
		);
		this.registerEvent(
			this.app.vault.on("delete", (file) => {
				this.contextService.handleFileDeleted(file);
				void this.historyService.handleFileDeleted(file.path).then(({ removedPendingItems }) => {
					if (removedPendingItems > 0) {
						new Notice(`AskMate removed ${removedPendingItems} pending review suggestion${removedPendingItems === 1 ? "" : "s"} for the deleted note ${file.path}.`);
					}
				}).catch((error: unknown) => {
					new Notice(`AskMate could not remove saved history for ${file.path}: ${this.getErrorMessage(error)}`);
				});
				void this.threads.handleFileDeleted(file.path).catch((error: unknown) => {
					new Notice(`AskMate could not remove saved conversations for ${file.path}: ${this.getErrorMessage(error)}`);
				});
			})
		);
		this.app.workspace.onLayoutReady(() => {
			this.rememberActiveMarkdownContext();
			// The first scan reads the vault, so it waits until the workspace has finished loading.
			void this.skillService.scan();
			this.lastSkillsSignature = this.skillsSignature();
			this.showFirstRunNotice();
			if (Platform.isDesktopApp && this.settings.mcp.enabled) {
				void this.ensureLauncher();
			}
		});

		this.addRibbonIcon(ASKMATE_ICON_ID, "Open AskMate", () => {
			void this.openComposerWithText("");
		});

		registerAnswerCommands(this);

		this.addCommand({
			id: "open-sidebar",
			name: "Open sidebar",
			callback: () => {
				void this.openComposerWithText("");
			}
		});

		this.addCommand({
			id: "ask-current-note",
			name: "Ask about current note",
			editorCallback: (editor, ctx) => {
				this.rememberEditorContext(editor, ctx.file ?? null);
				void this.openComposerWithText("");
			}
		});

		this.addCommand({
			id: "draw-diagram",
			name: "Draw a diagram of the current note",
			editorCallback: (editor, ctx) => {
				this.rememberEditorContext(editor, ctx.file ?? null);
				void this.startDiagram();
			}
		});

		this.addCommand({
			id: "new-conversation",
			name: "New conversation",
			callback: () => {
				void this.startNewConversation();
			}
		});

		this.addCommand({
			id: "open-settings",
			name: "Open settings",
			callback: () => {
				this.openSettingsTab();
			}
		});

		this.addCommand({
			id: "stop-run",
			name: "Stop current run",
			callback: () => {
				if (!this.commandRuns.stop()) {
					new Notice("No AskMate command is running.");
				}
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
		this.registerCustomWorkflowCommands();

		this.registerEvent(
			this.app.workspace.on("editor-menu", (menu, editor, info) => {
				this.addEditorMenuItems(menu, editor, info.file ?? null);
			})
		);

		this.addCommand({
			id: "export-conversation",
			name: "Export conversation to note",
			callback: () => {
				void this.exportConversationFromCommand();
			}
		});

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

		this.lastMcpSignature = JSON.stringify(this.settings.mcp);
		this.settingTab = new AskMateSettingTab(this.app, this);
		this.addSettingTab(this.settingTab);
		// The tab stores its definitions when it is added, before the first scan, so the Skills page would list nothing while
		// its home summary (read live) counts the built-in skill. Redrawing when the catalogue changes keeps the two together.
		this.register(this.skillService.onChange(() => {
			this.refreshSettingTab();
		}));
	}

	onunload(): void {
		// A palette run keeps sending paid requests after the plugin is disabled unless it is stopped here.
		this.commandRuns.stop();
		this.skillService.dispose();
		// A batch does the same, and one tool call may be waiting on a server.
		this.settingTab?.abortActiveBatch();
		this.unloading = this.shutdownServices();
	}

	/** Resolves when the work started by unloading is done: MCP servers stopped and conversations saved. */
	whenUnloaded(): Promise<void> {
		return this.unloading;
	}

	private async shutdownServices(): Promise<void> {
		const results = await Promise.allSettled([this.mcpInstance?.shutdown(), this.threads.flush()]);
		for (const result of results) {
			if (result.status === "rejected") {
				console.warn("AskMate could not finish shutting down.", result.reason);
			}
		}
	}

	async loadSettings(): Promise<void> {
		let raw: unknown;
		try {
			raw = await this.loadData();
		} catch (error) {
			console.warn("AskMate could not read data.json.", error);
			raw = undefined;
		}
		const stored = classifyStoredData(raw);
		this.firstRun = stored.kind === "fresh";
		if (stored.kind === "corrupt") {
			await this.backUpCorruptData(stored.reason);
		}
		// A corrupt file starts from the defaults of an existing install, not from the first-run defaults.
		const source = stored.kind === "ok" ? stored.data : stored.kind === "corrupt" ? {} : null;
		const result = normalizeAskMateSettingsWithDiagnostics(source, "load", { locale: getLanguage() });
		const trim = measureThreadStoreTrim(source?.threadStore, result.settings.threadStore);
		const trimmed = describeThreadStoreTrim(trim, null) !== null;
		// The first save would replace the file with the cut version, so the person gets the original beside it first.
		const trimBackup = trimmed ? await this.copyDataFileAside(trimBackupName(new Date())) : null;
		this.settings = structuredClone(result.settings);
		this.reportSettingsDiagnostics(result.diagnostics);
		const trimNotice = describeThreadStoreTrim(trim, trimBackup);
		if (trimNotice !== null) {
			new Notice(trimNotice, 15 * NOTICE_SECONDS);
		}
	}

	/** Copies data.json to a file of its own in the plugin folder. Returns the copy's name, or null when none could be made. */
	private async copyDataFileAside(backupName: string): Promise<string | null> {
		const folder = this.manifest.dir;
		if (!folder) {
			return null;
		}
		try {
			await this.app.vault.adapter.copy(`${folder}/data.json`, `${folder}/${backupName}`);
			return backupName;
		} catch (error) {
			console.warn("AskMate could not copy data.json aside.", error);
			return null;
		}
	}

	/**
	 * data.json is about to be replaced by defaults, so what is left of it is copied aside first. The copy keeps whatever
	 * could not be read, for the person (or a support request) to look at.
	 */
	private async backUpCorruptData(reason: string): Promise<void> {
		const folder = this.manifest.dir;
		if (!folder) {
			new Notice(`AskMate could not read its saved settings (${reason}) and started with defaults.`, 15 * NOTICE_SECONDS);
			return;
		}
		const backupName = corruptBackupName(new Date());
		try {
			await this.app.vault.adapter.copy(`${folder}/data.json`, `${folder}/${backupName}`);
			new Notice(`AskMate could not read its saved settings (${reason}). A copy is saved as ${backupName} in the plugin folder, and AskMate started with defaults.`, 15 * NOTICE_SECONDS);
		} catch (error) {
			new Notice(`AskMate could not read its saved settings (${reason}) and could not back them up (${this.getErrorMessage(error)}). It started with defaults.`, 15 * NOTICE_SECONDS);
		}
	}

	private reportSettingsDiagnostics(diagnostics: readonly SettingsDiagnostic[]): void {
		const shown = diagnostics.slice(0, 3);
		for (const diagnostic of shown) {
			new Notice(diagnostic.message, 10 * NOTICE_SECONDS);
		}
		if (diagnostics.length > shown.length) {
			new Notice(`AskMate also changed ${diagnostics.length - shown.length} more saved setting${diagnostics.length - shown.length === 1 ? "" : "s"} when it loaded them.`, 10 * NOTICE_SECONDS);
		}
	}

	async saveSettings(): Promise<void> {
		// Normalise in place: the settings tab, services and running requests hold nested settings references across awaits.
		const normalized = normalizeAskMateSettings(this.settings, "save");
		syncObjectInPlace(this.settings, normalized);
		// Each write waits for the previous one, so overlapping saves cannot land out of order and persist older settings.
		const save = this.settingsSaveChain.then(async () => await this.saveData(this.settings));
		this.settingsSaveChain = save.catch(() => undefined);
		await save;
		this.applySettingsChanges();
	}

	/** Servers and skills follow their settings: a switch-off stops a running server, a new folder is scanned. */
	private applySettingsChanges(): void {
		const mcpSignature = JSON.stringify(this.settings.mcp);
		if (mcpSignature !== this.lastMcpSignature) {
			this.lastMcpSignature = mcpSignature;
			void this.mcpInstance?.reconcile();
		}
		const skillsSignature = this.skillsSignature();
		if (skillsSignature !== this.lastSkillsSignature && this.skillService) {
			this.lastSkillsSignature = skillsSignature;
			void this.skillService.scan();
		}
	}

	private skillsSignature(): string {
		return `${this.settings.skills.enabled}|${this.settings.skills.folder}`;
	}

	/**
	 * Another device saved data.json (a sync). The file decides ordinary settings; this device's own threads, history and
	 * queued suggestions are merged in by id instead of being overwritten. Pending local writes are dropped, because they
	 * were prepared against the data that was just replaced.
	 */
	async onExternalSettingsChange(): Promise<void> {
		await this.settingsSaveChain;
		let raw: unknown;
		try {
			raw = await this.loadData();
		} catch (error) {
			console.warn("AskMate could not read data.json after it changed.", error);
			return;
		}
		const stored = classifyStoredData(raw);
		if (stored.kind !== "ok") {
			// An unreadable or removed file is not news worth acting on: this device still holds the settings it loaded.
			return;
		}
		const incoming = normalizeAskMateSettingsWithDiagnostics(stored.data, "load", { locale: getLanguage() }).settings;
		const merged = mergeExternalSettings(this.settings, incoming, { incomingPredatesSchema: predatesSettingsSchema(stored.data) });
		// Adopting a file with nothing new for this device would still drop the conversation saves waiting and rebuild the sidebar.
		if (JSON.stringify(merged) !== JSON.stringify(this.settings)) {
			syncObjectInPlace(this.settings, merged);
			this.threads.reload(this.settings.threadStore);
			this.refreshOpenAskMateViews();
			this.refreshSettingTab();
			this.applySettingsChanges();
		}
		// The merge keeps what only this device had. Writing the union back means the other device receives it too.
		if (mergeAddsToIncoming(merged, incoming)) {
			await this.saveSettings();
		}
	}

	async activateView(): Promise<void> {
		this.rememberActiveMarkdownContext();
		// Ribbon clicks and hotkeys call this without awaiting; sharing the in-flight call stops a second sidebar leaf.
		this.viewActivation ??= this.openOrRevealView().finally(() => {
			this.viewActivation = null;
		});
		await this.viewActivation;
	}

	private async openOrRevealView(): Promise<void> {
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
		this.contextService.rememberActiveMarkdownContext();
	}

	async getNoteContext(editor?: Editor, file?: TFile | null): Promise<NoteContext> {
		return await this.contextService.getNoteContext(editor, file);
	}

	rememberEditorContext(editor: Editor, file: TFile | null): void {
		this.contextService.rememberEditorContext(editor, file);
	}

	rememberMarkdownFile(file: TFile | null): void {
		this.contextService.rememberMarkdownFile(file);
	}

	async getFileNoteContext(file: TFile): Promise<NoteContext> {
		return await this.contextService.getFileNoteContext(file);
	}

	getLastOpenMarkdownView(): MarkdownView | null {
		return this.contextService.getLastOpenMarkdownView();
	}

	getOpenMarkdownViewForFile(file: TFile | null | undefined): MarkdownView | null {
		return this.contextService.getOpenMarkdownViewForFile(file);
	}

	classifyRequestIntent(question: string, options: Pick<BuildRequestOptions, "forceImage" | "workflow" | "intentKind" | "autoImage"> = {}): RequestIntentKind {
		return this.requestRunner.classifyRequestIntent(question, options);
	}

	private formatSourceLink(file: TFile | null): string {
		return file ? `[[${file.path}|${file.basename}]]` : "No active note";
	}

	private throwIfAborted(abortSignal?: AbortSignal): void {
		if (abortSignal?.aborted) {
			throw createAbortError("Request was stopped.");
		}
	}

	private async requestJson<T>(
		url: string,
		options: ProviderRequestOptions = {}
	): Promise<AskMateHttpResponse<T>> {
		this.throwIfAborted(options.abortSignal);
		const request = requestUrl({
			url,
			method: options.method ?? "GET",
			headers: options.headers,
			body: options.body,
			throw: false
		});
		const response = await awaitWithAbortAndTimeout(request, options);
		const text = typeof response.text === "string" ? response.text : "";
		let body: T | null = null;

		// response.json parses lazily and throws on HTML or plain-text error pages, which would hide the HTTP status.
		if (text.trim()) {
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
	}

	/**
	 * Runs a built request. Optional options add skills, tools and diagram checks; without them this is the plain text or
	 * image run it always was. Tools run only when `toolsEnabled` is true.
	 */
	async runOpenAIRequest(request: AskRequest, options: RunOptions = {}): Promise<RunResult> {
		return await this.requestRunner.runOpenAIRequest(request, options);
	}

	/** What a finished run learnt about its reply: a diagram that failed, a diagram that passed, an answer built from tool results. */
	getRunFacts(request: AskRequest): RunFacts {
		return this.requestRunner.getRunFacts(request);
	}

	/** The lines /context prints for a built request: what each vault mention selected and which notes were skipped. */
	getContextReport(request: AskRequest): ContextReport {
		return this.requestRunner.getContextReport(request);
	}

	async generateOpenAIImage(
		request: AskRequest,
		abortSignal?: AbortSignal,
		imagePromptPlan?: ImagePromptPlan
	): Promise<ImageAskMateResult> {
		return await this.requestRunner.generateOpenAIImage(request, abortSignal, imagePromptPlan);
	}

	async prepareImagePrompt(request: AskRequest, abortSignal?: AbortSignal): Promise<ImagePromptPlan> {
		return await this.requestRunner.prepareImagePrompt(request, abortSignal);
	}

	// Setup -------------------------------------------------------------------------------------------------------------

	/** True when SecretStorage holds a value under this name on this device. A secret name alone proves nothing: keys are per device. */
	hasSecret(secretName: string): boolean {
		if (!secretName.trim()) {
			return false;
		}
		try {
			const value: unknown = this.app.secretStorage.getSecret(secretName);
			// A storage that answers later (a promise) cannot be read here, so the name is taken as present.
			return typeof value === "string" ? value.length > 0 : value !== null && value !== undefined;
		} catch {
			return false;
		}
	}

	/** One answer to "is AskMate set up?", read by the setup card, the status bar and the settings page. */
	getSetupState(): SetupStage {
		return deriveSetupState(this.settings, (name) => this.hasSecret(name), this.lastSetupTest);
	}

	/**
	 * Stores the key in SecretStorage under a generated id, points the provider at it and refreshes the open views. The key
	 * never goes into data.json. Typing a key for the provider's current address also approves that address for the key on
	 * this device.
	 */
	async saveProviderApiKey(providerId: TextProviderId, apiKey: string): Promise<void> {
		const provider = this.settings.providers[providerId];
		const current = provider.apiKeySecretName.trim();
		const reusable = new RegExp(`^askmate-${providerId}-key(?:-\\d+)?$`).test(current);
		const planned = planConnect(providerId, apiKey, this.app.secretStorage.listSecrets());
		if (!planned.ok) {
			throw new Error(planned.message);
		}
		// Replacing the key of the same provider overwrites its own secret instead of piling up a new one each time.
		const secretId = reusable ? current : planned.plan.secretId;
		this.app.secretStorage.setSecret(secretId, planned.plan.secret);
		provider.apiKeySecretName = secretId;
		this.approveKeyHost(providerId);
		this.lastSetupTest = IDLE_SETUP_TEST;
		await this.saveSettings();
		this.refreshOpenAskMateViews();
	}

	/** Tests the selected provider and model, and keeps the result so every surface shows the same stage. */
	async testProviderConnectionDetailed(): Promise<ProviderConnectionResult> {
		const providerId = this.getSelectedTextProviderId();
		const ref = this.getChatProviderModelRef();
		this.lastSetupTest = { status: "testing", providerId, model: ref.model };
		this.refreshOpenAskMateViews();
		const result = await testProviderConnectionDetailedWithProvider(this.getProviderRuntime(), providerId);
		const context = { providerId, baseUrl: this.getProviderSettings(providerId).baseUrl, model: ref.model };
		const copy = result.ok ? null : mapProviderErrorToSetupCopy(new Error(result.message), context);
		// A server that answers but does not have the model cannot answer a question either, so every surface says it failed.
		const stageCopy = result.ok && result.modelFound === false
			? mapProviderErrorToSetupCopy(new Error(`The model "${ref.model}" was not found.`), context)
			: copy;
		this.lastSetupTest = stageCopy
			? { status: "failed", providerId, model: ref.model, copy: stageCopy }
			: { status: "ok", providerId, model: ref.model };
		this.refreshOpenAskMateViews();
		return { ...result, copy };
	}

	/**
	 * Opens AskMate's page in Obsidian's settings. The settings object is not part of the public API, so it is looked up
	 * defensively and the written instruction is the fallback.
	 */
	openSettingsTab(): void {
		const setting: unknown = Reflect.get(this.app, "setting");
		const open: unknown = typeof setting === "object" && setting !== null ? Reflect.get(setting, "open") : undefined;
		const openTab: unknown = typeof setting === "object" && setting !== null ? Reflect.get(setting, "openTabById") : undefined;
		if (typeof open === "function" && typeof openTab === "function") {
			Reflect.apply(open, setting, []);
			Reflect.apply(openTab, setting, [this.manifest.id || SETTINGS_TAB_ID]);
			return;
		}
		new Notice("Open Obsidian settings, then choose AskMate under community plugins.");
	}

	// Diagrams ----------------------------------------------------------------------------------------------------------

	/** Obsidian's own Mermaid, narrowed to the two methods AskMate uses. Null when this build cannot provide it. */
	async loadMermaidApi(): Promise<MermaidApi | null> {
		if (this.mermaidApi) {
			return this.mermaidApi;
		}
		try {
			this.mermaidApi = toMermaidApi(await this.obsidianApi.loadMermaid());
		} catch (error) {
			console.warn("AskMate could not load Mermaid.", error);
			this.mermaidApi = null;
		}
		return this.mermaidApi;
	}

	/** Mermaid plus the diagram families this build can parse, probed once per session. */
	getDiagramRuntime(): Promise<DiagramRuntime | null> {
		this.diagramRuntime ??= (async (): Promise<DiagramRuntime | null> => {
			const api = await this.loadMermaidApi();
			return api ? { api, supported: await supportedDiagrams(api) } : null;
		})();
		return this.diagramRuntime;
	}

	private buildDiagramPort(): DiagramPort {
		return {
			isEnabled: () => this.settings.diagrams.enabled,
			allowRepairTurn: () => this.settings.diagrams.allowRepairTurn,
			getRuntime: () => this.getDiagramRuntime(),
			createScratch: () => createScratchHost(activeDocument.body),
			checkSafety: guardSafetyCheck,
			// The repair is a second paid turn, so a guardrail that blocks requests blocks it too.
			canSendRepair: (request, estimatedInputTokens) => this.usageService.evaluateUsageGuardrails(request, estimatedInputTokens).blockers.length === 0
		};
	}

	// Skills ------------------------------------------------------------------------------------------------------------

	private buildSkillHost(): SkillHost {
		return {
			getConfig: (): SkillConfig => {
				const skills = this.settings.skills;
				return { enabled: skills.enabled, folder: skills.folder, matchMode: skills.matching, disabledIds: skills.disabledIds, trusted: skills.trustedHashes };
			},
			listFiles: (folder) => Promise.resolve(listFolderFiles(this.app.vault.getFolderByPath(folder))),
			readFile: async (path) => {
				const file = this.app.vault.getAbstractFileByPath(path);
				if (!(file instanceof TFile)) {
					throw new Error(`AskMate could not read ${path}.`);
				}
				return await this.app.vault.cachedRead(file);
			},
			parseYaml: (text) => this.obsidianApi.parseYaml(text),
			saveTrust: async (id, hash) => {
				const trusted = { ...this.settings.skills.trustedHashes };
				if (hash === null) {
					Reflect.deleteProperty(trusted, id);
				} else {
					trusted[id] = hash;
				}
				this.settings.skills.trustedHashes = trusted;
				await this.saveSettings();
			},
			watch: (callback) => {
				const refs = [
					this.app.vault.on("create", (file) => callback(file.path)),
					this.app.vault.on("modify", (file) => callback(file.path)),
					this.app.vault.on("delete", (file) => callback(file.path)),
					this.app.vault.on("rename", (file, oldPath) => {
						callback(oldPath);
						callback(file.path);
					})
				];
				refs.forEach((ref) => {
					this.registerEvent(ref);
				});
				return () => {
					refs.forEach((ref) => {
						this.app.vault.offref(ref);
					});
				};
			},
			warn: (message, error) => {
				console.warn(`AskMate: ${message}`, error);
			}
		};
	}

	// MCP ---------------------------------------------------------------------------------------------------------------

	private buildMcpHost(): McpHost {
		return createMcpHost({
			version: this.manifest.version,
			getSettings: () => this.settings.mcp,
			platform: { isDesktopApp: Platform.isDesktopApp, isWin: Platform.isWin, isMacOS: Platform.isMacOS },
			env: typeof process === "undefined" ? {} : process.env,
			secrets: createSecretReader(this.app.secretStorage),
			deviceTrust: createDeviceTrustStore(this.app),
			requestHttp: createHttpRequest(async (params) => {
				const response = await requestUrl(params);
				return { status: response.status, headers: response.headers, text: response.text };
			}),
			getLauncher: () => this.launcher,
			approvals: this.mcpApprovals,
			confirmTrust: (request) => this.mcpPrompts.confirmTrust(request)
		});
	}

	/**
	 * Loads the desktop-only launcher, the one module that starts programs. It is imported on demand and only on desktop, so
	 * a phone never evaluates it.
	 */
	private ensureLauncher(): Promise<void> {
		if (!Platform.isDesktopApp || this.launcher) {
			return Promise.resolve();
		}
		this.launcherLoad ??= import("../mcp/launch").then((module) => {
			this.launcher = module;
		}).catch((error: unknown) => {
			console.warn("AskMate could not load the launcher for local servers.", error);
			this.launcherLoad = null;
		});
		return this.launcherLoad;
	}

	// First run ---------------------------------------------------------------------------------------------------------

	/** Once, on a fresh install that is not connected yet: say where to start and offer the button that gets there. */
	private showFirstRunNotice(): void {
		if (!shouldShowFirstRunNotice({ firstRun: this.firstRun, settings: this.settings, stage: this.getSetupState() })) {
			return;
		}
		// An open sidebar already shows the Connect card, and a notice on top of it would cover the card's fields.
		const sidebarOpen = (): boolean => this.app.workspace.getLeavesOfType(ASKMATE_VIEW_TYPE).length > 0;
		if (sidebarOpen()) {
			return;
		}
		// It stays until it is used or the sidebar is opened another way: a timed notice was gone before many first-time
		// users read it, which left them only an unlabelled ribbon icon.
		const notice = this.notifyWithAction(FIRST_RUN_NOTICE.message, FIRST_RUN_NOTICE.actionLabel, () => {
			void this.openComposerWithText("");
		}, 0);
		// A notice that stays must not outlive the plugin: its button would call into an unloaded plugin.
		this.register(() => notice.hide());
		const ref = this.app.workspace.on("layout-change", () => {
			if (sidebarOpen()) {
				notice.hide();
				this.app.workspace.offref(ref);
			}
		});
		this.registerEvent(ref);
	}

	/** A notice with one button, for messages that name a next step. */
	notifyWithAction(message: string, actionLabel: string, onClick: () => void, seconds = 10): Notice {
		const notice = new Notice(message, seconds * NOTICE_SECONDS);
		const button = notice.messageEl.createEl("button", { cls: "mod-cta", text: actionLabel });
		button.type = "button";
		button.addEventListener("click", () => {
			notice.hide();
			onClick();
		});
		return notice;
	}

	/**
	 * Runs one of the sidebar view's public entry points, in whichever composer layout it is. Typing a console command into the
	 * composer is not an option: only the Console layout reads slash commands, and the default layout for new installs is Compact.
	 * A refusal from the view (a request is running, diagrams are off) is shown as a Notice, and so is a sidebar that cannot be
	 * reached, so a command never fails silently.
	 */
	private async withSidebarView(run: (view: AskMateView) => Promise<void>): Promise<void> {
		try {
			await this.activateView();
			const leaves = this.app.workspace.getLeavesOfType(ASKMATE_VIEW_TYPE);
			for (const leaf of leaves) {
				await leaf.loadIfDeferred();
				if (leaf.view instanceof AskMateView) {
					await run(leaf.view);
					return;
				}
			}
			// With no leaf at all, activateView has already said why the sidebar did not open.
			if (leaves.length > 0) {
				new Notice("AskMate could not reach its sidebar. Close the AskMate sidebar, open it again from the ribbon, then try again.");
			}
		} catch (error) {
			new Notice(this.getErrorMessage(error));
		}
	}

	private startNewConversation(): Promise<void> {
		return this.withSidebarView((view) => view.startNewConversation());
	}

	private startDiagram(): Promise<void> {
		return this.withSidebarView((view) => view.startDiagram());
	}

	/** The key can leave the device only for an address this device approved for it, so the first use asks. */
	private async assertKeyMayBeSent(providerId: TextProviderId, secretName: string): Promise<void> {
		const baseUrl = this.getProviderSettings(providerId).baseUrl;
		const stored: unknown = this.app.loadLocalStorage(`${KEY_APPROVAL_PREFIX}${secretName}`);
		const approvedHost = typeof stored === "string" ? stored : null;
		if (!needsKeyApproval({ providerId, firstPartyProviders: FIRST_PARTY_PROVIDER_IDS, baseUrl, secretName, approvedHost })) {
			return;
		}
		const host = endpointHost(baseUrl) ?? baseUrl;
		const approved = await askMateConfirm(this.app, [
			`Send the stored key "${secretName}" to ${host}?`,
			"",
			`${getProviderLabel(providerId)} is set to use this address. The key is sent to it with every request.`,
			"Only continue if you set this address yourself. A settings file synced from another computer could have changed it."
		].join("\n"));
		if (!approved) {
			throw new Error(`AskMate did not send the key to ${host}. Check the address in AskMate settings, or approve it when asked.`);
		}
		this.approveKeyHost(providerId);
	}

	private approveKeyHost(providerId: TextProviderId): void {
		const provider = this.getProviderSettings(providerId);
		const host = endpointHost(provider.baseUrl);
		if (host && provider.apiKeySecretName.trim()) {
			this.app.saveLocalStorage(`${KEY_APPROVAL_PREFIX}${provider.apiKeySecretName.trim()}`, host);
		}
	}

	async refreshSelectedProviderModels(): Promise<string[]> {
		return await this.refreshProviderModels(this.getSelectedTextProviderId());
	}

	async testSelectedProviderConnection(): Promise<string> {
		return await this.testProviderConnection(this.getSelectedTextProviderId());
	}

	async refreshProviderModels(providerId: TextProviderId): Promise<string[]> {
		// Errors pass through unchanged: the adapters already explain them, including when Azure needs a manual deployment name.
		const models = await fetchProviderModels(this.getProviderRuntime(), providerId);
		const isAzure = providerId === "azure-openai" || providerId === "azure-ai";
		if (models.length === 0 && (isAzure || providerId === "openai")) {
			throw new Error(isAzure
				? `${getProviderLabel(providerId)} did not return model IDs. Keep using a manual model or deployment name.`
				: `${getProviderLabel(providerId)} did not return model IDs.`);
		}

		const provider = this.getProviderSettings(providerId);
		const selectedModel = provider.model.trim();
		// The selected model always stays in the list, so a refresh never switches the model behind the user's back.
		provider.modelOptions = providerId === "openai"
			? normalizeOpenAIModelOptions(models, [], selectedModel)
			: normalizeProviderModelOptions(models, isAzure ? provider.modelOptions : DEFAULT_PROVIDER_SETTINGS[providerId].modelOptions, selectedModel);
		if (!selectedModel) {
			provider.model = provider.modelOptions[0] ?? DEFAULT_PROVIDER_SETTINGS[providerId].model;
		} else if (!isAzure && !models.some((model) => model.trim() === selectedModel)) {
			// Azure deployment names often differ from listed model IDs, so only other providers get this hint.
			new Notice(`${getProviderLabel(providerId)} did not list the selected model "${selectedModel}". AskMate kept it selected; check the name if requests fail.`);
		}

		await this.saveSettings();
		return provider.modelOptions;
	}

	async testProviderConnection(providerId: TextProviderId): Promise<string> {
		return await testProviderConnectionWithProvider(this.getProviderRuntime(), providerId);
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
		// One unclosed code fence in the request or the reply would turn every later section of the note into code.
		return closeOpenFencesInVariables({
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
			dateTime: values.dateTime ?? buildDateTemplateValues(now).dateTime,
			currentDate: values.date ?? this.formatDate(now),
			currentDateTime: values.dateTime ?? buildDateTemplateValues(now).dateTime,
			customInstructions: this.settings.workflowCustomInstructions.trim(),
			resultFolder: cleanFolderPath(this.settings.resultFolder)
		}, FENCE_CLOSED_TEMPLATE_KEYS);
	}

	private buildRequestTemplateVariables(request: AskRequest, responseText: string, model: string): Record<string, string> {
		return {
			...this.buildCommonTemplateVariables(request.context, {
				title: this.getResultNoteTitle(request),
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
		return buildDateTemplateValues(date).date;
	}

	/** "Study summary - Meeting notes" for a workflow, the question for a free-form answer, and the caller's own title otherwise. */
	private getResultNoteTitle(request: AskRequest): string {
		return deriveResultNoteTitle({
			title: request.title,
			question: request.question,
			workflowName: request.metadata.workflowName,
			sourceBasename: request.context.file?.basename ?? null
		});
	}

	private renderTextResultNoteContent(request: AskRequest, responseText: string, model: string): string {
		const variables = this.buildRequestTemplateVariables(request, responseText, model);
		const template = this.getWorkflowResultNoteTemplate(request.metadata.workflowId);
		const rendered = renderTemplate(template, variables);
		const usedTemplate = rendered.trim() ? template : DEFAULT_RESULT_NOTE_TEMPLATE;
		const note = rendered.trim() ? rendered : renderTemplate(DEFAULT_RESULT_NOTE_TEMPLATE, variables);
		// A template that never places {{response}} would write a note with no answer in it.
		return `${trimOuterBlankLines(ensureTemplateKeepsAnswer(note, usedTemplate, "response", variables.response))}\n`;
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

	/** Planned prompts and revised prompts come from a model, so they are made safe like any other reply before they reach a note. */
	private safeImageText(request: AskRequest, text: string): string {
		return this.prepareForWrite(request, text).text;
	}

	private renderImageResultNoteContent(request: AskRequest, result: ImageAskMateResult, imageFile: TFile): string {
		const revisedPrompt = this.safeImageText(request, result.image.revisedPrompt ?? "");
		const fallbackReason = this.safeImageText(request, result.promptPlan.fallbackReason ?? "");
		const variables = closeOpenFencesInVariables({
			...this.buildRequestTemplateVariables(request, "", result.model),
			providerName: "OpenAI",
			imageEmbed: this.createImageEmbed(imageFile),
			imagePrompt: this.safeImageText(request, result.image.prompt),
			revisedPrompt,
			revisedPromptSection: revisedPrompt ? `\n\n## Revised prompt\n\n${revisedPrompt}` : "",
			planningModel: result.promptPlan.planningModel,
			planningStatus: formatOperationStatus(result.promptPlan.status),
			planningFallback: fallbackReason,
			planningFallbackLine: fallbackReason ? `Planning fallback: ${fallbackReason}` : "",
			imageGenerationProviderName: "OpenAI"
		}, ["imagePrompt", "revisedPrompt", "revisedPromptSection", "planningFallback"]);
		const rendered = renderTemplate(this.settings.imageResultNoteTemplate, variables);
		const usedTemplate = rendered.trim() ? this.settings.imageResultNoteTemplate : DEFAULT_IMAGE_RESULT_NOTE_TEMPLATE;
		const note = rendered.trim() ? rendered : renderTemplate(DEFAULT_IMAGE_RESULT_NOTE_TEMPLATE, variables);
		// A template without {{imageEmbed}} would save the picture and leave the note without it.
		return `${trimOuterBlankLines(ensureTemplateKeepsAnswer(note, usedTemplate, "imageEmbed", variables.imageEmbed))}\n`;
	}

	/** The model's text made safe to write into this request's note. `sourceText` is what the text replaces, when it replaces any. */
	private prepareForWrite(request: AskRequest, text: string, sourceText?: string): PreparedWrite {
		return prepareReplyForWrite(text, { ...(sourceText === undefined ? {} : { sourceText }), allowDiagramHeader: this.requestRunner.getRunFacts(request).diagramValid });
	}

	/** A diagram that failed AskMate's checks is shown, never written. */
	private assertDiagramWritable(request: AskRequest): void {
		if (this.requestRunner.getRunFacts(request).diagramBlocked) {
			throw new Error("The diagram in this reply did not pass AskMate's checks, so it will not be written into a note. Fix the diagram, ask for another look, or copy the source.");
		}
	}

	async createResultNote(request: AskRequest, responseText: string, options: { model?: string; incompleteReason?: string | null } = {}): Promise<TFile> {
		this.assertDiagramWritable(request);
		const folder = await this.ensureFolder(this.getResultNoteFolder(request));
		const baseName = sanitizeFileName(this.getResultNoteTitle(request));
		const model = options.model ?? request.metadata.selectedModel;
		// Only the reply is model output: the question and the note text in the template are the person's own.
		const reply = this.prepareForWrite(request, responseText);
		const incompleteReason = options.incompleteReason ?? request.metadata.outputIncompleteReason ?? null;
		const content = withIncompleteCallout(this.renderTextResultNoteContent(request, reply.text, model), incompleteReason);

		const file = await this.createFileWithUniquePath(folder, baseName, "md", async (path) => await this.app.vault.create(path, content));
		await this.maybeAppendResultBacklinkToSource(request, file);
		return file;
	}

	/** Writes an exported conversation into the result folder, using the same unique-name handling as result notes. */
	async createConversationNote(title: string, content: string): Promise<TFile> {
		const folder = await this.ensureFolder(cleanFolderPath(this.settings.resultFolder));
		const baseName = sanitizeFileName(title, "AskMate conversation");
		return await this.createFileWithUniquePath(folder, baseName, "md", async (path) => await this.app.vault.create(path, content));
	}

	private async exportConversationFromCommand(): Promise<void> {
		try {
			await this.activateView();
			const view = this.app.workspace.getLeavesOfType(ASKMATE_VIEW_TYPE).map((leaf) => leaf.view).find((candidate) => candidate instanceof AskMateView);
			if (!(view instanceof AskMateView)) {
				new Notice("AskMate could not open the sidebar to export the conversation.");
				return;
			}
			await view.exportConversation("");
		} catch (error) {
			new Notice(this.getErrorMessage(error));
		}
	}

	async createImageResultNote(
		request: AskRequest,
		result: ImageAskMateResult
	): Promise<{ noteFile: TFile; imageFile: TFile }> {
		const folder = await this.ensureFolder(this.getResultNoteFolder(request));
		const imageFile = await this.saveGeneratedImage(request, result);
		const baseName = sanitizeFileName(`${request.title} Image`);
		const content = this.renderImageResultNoteContent(request, result, imageFile);

		const noteFile = await this.createFileWithUniquePath(folder, baseName, "md", async (path) => await this.app.vault.create(path, content));
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

		const folder = await this.ensureFolder(this.getImageResultFolder(request, result));
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
		const baseName = sanitizeFileName(renderTemplate(this.settings.imageFileNameTemplate, variables).trim() || title);
		const bytes = this.decodeBase64Image(result.image.base64);
		const file = await this.createFileWithUniquePath(folder, baseName, "png", async (path) => await this.app.vault.createBinary(path, bytes));
		result.image.savedImagePath = file.path;
		return file;
	}

	async applyImageToContext(request: AskRequest, result: ImageAskMateResult): Promise<MutationOutcome> {
		return await this.applyImageToContextOutcome(request, result);
	}

	private async applyImageToContextOutcome(request: AskRequest, result: ImageAskMateResult): Promise<MutationOutcome> {
		this.assertTargetAcceptsText(request);
		const isSelection = request.context.source === "Selected text";
		const identity = request.context.selectionIdentity ?? null;
		const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
		const targetView = request.context.file
			? this.getOpenMarkdownViewForFile(request.context.file)
			: activeView ?? this.getLastOpenMarkdownView();
		const file = targetView?.file ?? request.context.file ?? this.contextService.getLastMarkdownFile();
		if (file?.extension !== "md") {
			throw new Error("Open a Markdown note before inserting an image.");
		}
		const cannotPlace = "AskMate could not safely find the original selection to place the image after. Select the text again, then insert the image.";
		let anchorIdentity: SelectionIdentity | null = null;
		if (isSelection) {
			if (!identity || !isOriginalSelectionNote(identity.sourcePath, file, request.context.file)) {
				throw new Error(cannotPlace);
			}
			const current = targetView ? targetView.editor.getValue() : await this.app.vault.cachedRead(file);
			if (resolveSelectionIdentity(current, identity).endOffset === null) {
				throw new Error(cannotPlace);
			}
			anchorIdentity = identity;
		}

		const where = isSelection && !targetView ? `"${file.path}" after the original selection` : `"${file.path}"`;
		if (!(await askMateConfirm(this.app, `Insert the generated image into ${where}?`))) {
			return cancelledMutation("Image insert cancelled. No note was changed.");
		}
		const imageFile = await this.saveGeneratedImage(request, result);
		const embed = this.createImageEmbed(imageFile);
		// Saving the image took time: the editor read before it may belong to another note by now, so the note is looked up again.
		const placed = await this.placeImageEmbed(file, embed, anchorIdentity);
		switch (placed) {
			case "insert":
				return appliedMutation(`Inserted image in ${file.path}. Use Obsidian undo immediately if needed.`, file.path);
			case "selection-changed":
				return {
					status: "partial",
					message: `Saved image ${imageFile.path}, but the original selection changed before insertion.`,
					targetPath: file.path,
					artifactPaths: [imageFile.path]
				};
			case "open-fence":
				return {
					status: "partial",
					message: `Saved image ${imageFile.path}, but ${file.path} ends inside a code block that is never closed, so the image was not inserted. Close the block, then add ${embed} yourself.`,
					targetPath: file.path,
					artifactPaths: [imageFile.path]
				};
		}
	}

	/** Writes the embed through the open editor when the note is open, and through the vault when it is not. */
	private async placeImageEmbed(file: TFile, embed: string, selection: SelectionIdentity | null): Promise<EmbedPlan["kind"]> {
		const view = this.getOpenMarkdownViewForFile(file);
		if (view?.file?.path === file.path) {
			const editor = view.editor;
			const plan = planEmbedInsertion(
				editor.getValue(),
				embed,
				selection ? { kind: "selection", identity: selection } : { kind: "offset", offset: editor.posToOffset(editor.getCursor()) }
			);
			if (plan.kind === "insert") {
				editor.replaceRange(plan.text, editor.offsetToPos(plan.offset));
				this.rememberEditorContext(editor, file);
			}
			return plan.kind;
		}
		// An object flag, because control-flow narrowing does not see assignments made inside the callback.
		const outcome: { kind: EmbedPlan["kind"] } = { kind: "insert" };
		await this.app.vault.process(file, (latest) => {
			const plan = planEmbedInsertion(latest, embed, selection ? { kind: "selection", identity: selection } : { kind: "end" });
			outcome.kind = plan.kind;
			return plan.kind === "insert" ? applyTextInsertion(latest, { offset: plan.offset, text: plan.text }) : latest;
		});
		this.rememberMarkdownFile(file);
		return outcome.kind;
	}

	private async applyResponseToHeadingSection(request: AskRequest, output: string, headingPath: string): Promise<string> {
		const target = headingPath.trim();
		if (!target) {
			throw new Error("Enter a heading title or heading path before applying to a section.");
		}
		this.assertOutputCompleteForReplace(request);

		const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
		const targetView = request.context.file
			? this.getOpenMarkdownViewForFile(request.context.file)
			: activeView ?? this.getLastOpenMarkdownView();
		const file = targetView?.file ?? request.context.file ?? null;
		const content = targetView ? targetView.editor.getValue() : file?.extension === "md" ? await this.app.vault.cachedRead(file) : "";

		if (!content || !file) {
			throw new Error("Open the original Markdown note before applying to a heading.");
		}

		const matches = this.findHeadingSections(content, target);

		if (matches.length === 0) {
			throw new Error(`AskMate could not find heading "${target}" in ${file.path}.`);
		}

		if (matches.length > 1) {
			throw new Error(`Heading "${target}" is ambiguous. Use the full heading path, for example Parent > Child.`);
		}

		const section = matches[0];
		// The text the reply replaces is the section as it is now: constructs it already holds are not the model's.
		const { before } = spliceHeadingSectionBody(content, section, output);
		const prepared = this.prepareForWrite(request, output, before);
		const { next: nextContent } = spliceHeadingSectionBody(content, section, prepared.text);
		const targetLabel = `${file.path} > ${section.path}`;

		if (!(await this.confirmReplaceScopeRisks(request, "heading-section", targetLabel))) {
			return "Apply cancelled. No note was changed.";
		}

		if (!(await this.confirmTextApplyPreview({
			request,
			scope: "heading-section",
			targetLabel,
			before,
			after: prepared.text,
			warning: joinWarnings(this.describeSectionEditsSinceRequest(request, target, before), describeWriteChanges(prepared), describeActiveContentAdded(content, nextContent))
		}))) {
			return "Apply cancelled. No note was changed.";
		}

		if (targetView) {
			assertNoteUnchangedDuringPreview(content, targetView.editor.getValue(), file.path);
			this.writeThroughEditor(targetView.editor, content, nextContent);
			this.rememberEditorContext(targetView.editor, file);
		} else {
			await this.app.vault.process(file, (latest) => {
				assertNoteUnchangedDuringPreview(content, latest, file.path);
				return nextContent;
			});
			this.rememberMarkdownFile(file);
		}

		return `Applied to heading "${section.path}" in ${file.path}. Use Obsidian undo or file history immediately if needed.`;
	}

	private findHeadingSections(content: string, target: string): MarkdownHeadingSection[] {
		return parseMarkdownHeadingSections(content).filter((section) => section.path === target || section.title === target);
	}

	// The reply was written from the note as captured at request time, so later edits in the target would be discarded.
	private describeNoteEditsSinceRequest(request: AskRequest, current: string): string {
		if (request.context.source !== "Current note" || isSameNoteText(request.context.content, current)) {
			return "";
		}
		return "The note changed after you asked. The reply was written from the earlier version, so applying it discards those later edits.";
	}

	private describeSectionEditsSinceRequest(request: AskRequest, target: string, currentSection: string): string {
		if (request.context.source !== "Current note") {
			return "";
		}
		const original = this.findHeadingSections(request.context.content, target);
		if (original.length === 1 && isSameNoteText(getHeadingSectionCore(request.context.content, original[0]), currentSection)) {
			return "";
		}
		return "This section changed after you asked. The reply was written from the earlier version, so applying it discards those later edits.";
	}

	/** Changes only the part of an open note that differs, so the cursor, folds and undo history of the rest survive. */
	private writeThroughEditor(editor: Editor, before: string, after: string): void {
		const edit = planRangeEdit(before, after);
		if (edit.start === edit.end && edit.insert === "") {
			return;
		}
		editor.replaceRange(edit.insert, editor.offsetToPos(edit.start), editor.offsetToPos(edit.end));
	}

	/** A cut-off reply may be appended (it loses nothing), but never without the person seeing that it stops short. */
	private describeIncompleteReply(request: AskRequest): string {
		const reason = request.metadata.outputIncompleteReason;
		return reason ? `This reply is incomplete (${reason}), so the text you append stops mid-answer.` : "";
	}

	/** Appended text lands inside a code block when the note ends in one that was never closed. */
	private describeOpenFenceAppend(note: string): string {
		return endsInsideOpenFence(note)
			? "The note ends inside a code block that is never closed, so the appended text would become part of that code."
			: "";
	}

	private async appendResponseToCapturedNote(request: AskRequest, output: string, targetView: MarkdownView | null, file: TFile | null): Promise<string> {
		// Appended text sits beside the note, so nothing in it counts as already there.
		const prepared = this.prepareForWrite(request, output);
		const safe = prepared.text;
		if (targetView) {
			const editor = targetView.editor;
			const targetLabel = file?.path ?? "the current note";
			const before = editor.getValue();
			const after = appendMarkdownBlockToContent(before, safe);

			if (!(await this.confirmTextApplyPreview({
				request,
				scope: "append",
				targetLabel,
				before,
				after,
				warning: joinWarnings(this.describeIncompleteReply(request), this.describeOpenFenceAppend(before), describeWriteChanges(prepared), describeActiveContentAdded(before, after))
			}))) {
				return "Apply cancelled. No note was changed.";
			}

			// Recompute against the latest note body so concurrent edits are not clobbered.
			const latest = editor.getValue();
			const next = latest === before ? after : appendMarkdownBlockToContent(latest, safe);
			this.writeThroughEditor(editor, latest, next);
			this.rememberEditorContext(editor, file);
			return `Appended to ${targetLabel}. Use Obsidian undo or file history immediately if needed.`;
		}

		if (file?.extension === "md") {
			const content = await this.app.vault.cachedRead(file);
			const after = appendMarkdownBlockToContent(content, safe);

			if (!(await this.confirmTextApplyPreview({
				request,
				scope: "append",
				targetLabel: file.path,
				before: content,
				after,
				warning: joinWarnings(this.describeIncompleteReply(request), this.describeOpenFenceAppend(content), describeWriteChanges(prepared), describeActiveContentAdded(content, after))
			}))) {
				return "Apply cancelled. No note was changed.";
			}

			await this.app.vault.process(file, (latest) => latest === content ? after : appendMarkdownBlockToContent(latest, safe));
			this.rememberMarkdownFile(file);
			return `Appended to ${file.path}. Use Obsidian undo or file history immediately if needed.`;
		}

		throw new Error("Open the original Markdown note before appending changes.");
	}

	async applyResponseToContext(request: AskRequest, responseText: string, options: { scope?: ApplyScope; headingPath?: string } = {}): Promise<MutationOutcome> {
		const message = await this.applyResponseToContextMessage(request, responseText, options);
		return message.startsWith("Apply cancelled")
			? cancelledMutation(message)
			: appliedMutation(message, request.context.file?.path);
	}

	private async applyResponseToContextMessage(request: AskRequest, responseText: string, options: { scope?: ApplyScope; headingPath?: string } = {}): Promise<string> {
		const output = trimOuterBlankLines(responseText);

		if (!output) {
			throw new Error("AskMate has nothing to apply yet.");
		}
		this.assertOutputIsApplicable(output);
		this.assertTargetAcceptsText(request);
		this.assertDiagramWritable(request);

		// Shared with the review queue: "auto" means the selection for selected-text requests and append otherwise.
		const scope = resolveApplyScope(options.scope ?? this.settings.partialApplyDefaultScope, request.context.source);

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

		if (request.context.source === "Selected text" && scope === "selected-block") {
			const identity = request.context.selectionIdentity;
			const originalText = identity?.text ?? request.context.content.trim();
			if (identity?.sourcePath && !isOriginalSelectionNote(identity.sourcePath, file, request.context.file)) {
				throw new Error("The original selected-text note is no longer the Apply target. Select the text again, then apply.");
			}

			if (!originalText) {
				throw new Error("AskMate could not find the original selected text. Select the text again, then apply.");
			}

			this.assertOutputCompleteForReplace(request);
			if (!(await this.confirmReplaceScopeRisks(request, "selected-text", file?.path ?? "the current note"))) {
				return "Apply cancelled. No note was changed.";
			}

			// A faithful rewrite of the selection keeps whatever the selection already held; only what the model adds is defused.
			const prepared = this.prepareForWrite(request, output, originalText);
			const safe = prepared.text;
			const warning = joinWarnings(describeWriteChanges(prepared), describeActiveContentAdded(originalText, safe));

			if (targetView) {
				const editor = targetView.editor;
				const selectedText = editor.getSelection().trim();
				const currentValue = editor.getValue();
				const captured = identity ? resolveSelectionIdentity(currentValue, identity) : null;

				if (!identity && selectedText === originalText) {
					if (!(await this.confirmTextApplyPreview({
						request,
						scope: "selected-text",
						targetLabel: file?.path ?? "the current note",
						before: originalText,
						after: safe,
						warning
					}))) {
						return "Apply cancelled. No note was changed.";
					}
					if (editor.getSelection().trim() !== originalText) {
						throw new Error("Selection changed while the Apply preview was open. Select the text again, then apply.");
					}
					editor.replaceSelection(safe);
					this.rememberEditorContext(editor, file);
					return `Applied to selected text in ${file?.path ?? "the current note"}. Use Obsidian undo immediately if needed.`;
				}

				const value = currentValue;
				const occurrences = identity
					? captured?.startOffset !== null && captured?.startOffset !== undefined ? [captured.startOffset] : []
					: findExactOccurrences(value, originalText);

				if (occurrences.length === 1) {
					if (!(await this.confirmTextApplyPreview({
						request,
						scope: "selected-text",
						targetLabel: file?.path ?? "the current note",
						before: originalText,
						after: safe,
						warning
					}))) {
						return "Apply cancelled. No note was changed.";
					}
					const latestValue = editor.getValue();
					const latestResolution = identity ? resolveSelectionIdentity(latestValue, identity) : null;
					const latestOccurrences = identity
						? latestResolution?.startOffset !== null && latestResolution?.startOffset !== undefined ? [latestResolution.startOffset] : []
						: findExactOccurrences(latestValue, originalText);
					if (latestOccurrences.length !== 1) {
						throw new Error("Note changed while the Apply preview was open. Select the text again, then apply.");
					}
					const latestStart = latestOccurrences[0];
					editor.replaceRange(
						safe,
						editor.offsetToPos(latestStart),
						editor.offsetToPos(latestStart + originalText.length)
					);
					this.rememberEditorContext(editor, file);
					return `Applied to selected text in ${file?.path ?? "the current note"}. Use Obsidian undo immediately if needed.`;
				}

				throw new Error("AskMate could not safely find the original selected text. Select the text again, then apply.");
			}

			if (file?.extension === "md") {
				const content = await this.app.vault.cachedRead(file);
				const resolution = identity ? resolveSelectionIdentity(content, identity) : null;
				const occurrences = identity
					? resolution?.startOffset !== null && resolution?.startOffset !== undefined ? [resolution.startOffset] : []
					: findExactOccurrences(content, originalText);

				if (occurrences.length === 1) {
					if (!(await this.confirmTextApplyPreview({
						request,
						scope: "selected-text",
						targetLabel: file.path,
						before: originalText,
						after: safe,
						warning
					}))) {
						return "Apply cancelled. No note was changed.";
					}
					await this.app.vault.process(file, (latest) => {
						const latestResolution = identity ? resolveSelectionIdentity(latest, identity) : null;
						const latestOccurrences = identity
							? latestResolution?.startOffset !== null && latestResolution?.startOffset !== undefined ? [latestResolution.startOffset] : []
							: findExactOccurrences(latest, originalText);
						if (latestOccurrences.length !== 1) {
							throw new Error("Note changed while the Apply preview was open. Select the text again, then apply.");
						}
						const latestStart = latestOccurrences[0];
						return `${latest.slice(0, latestStart)}${safe}${latest.slice(latestStart + originalText.length)}`;
					});
					this.rememberMarkdownFile(file);
					return `Applied to selected text in ${file.path}. Use Obsidian undo immediately if needed.`;
				}
			}

			throw new Error("AskMate could not safely find the original selected text. Select the text again, then apply.");
		}

		if (scope === "append") {
			return await this.appendResponseToCapturedNote(request, output, targetView, file);
		}

		this.assertOutputCompleteForReplace(request);

		if (targetView) {
			const editor = targetView.editor;
			const targetLabel = file?.path ?? "the current note";

			if (!(await this.confirmReplaceScopeRisks(request, "full-note", targetLabel))) {
				return "Apply cancelled. No note was changed.";
			}

			const before = editor.getValue();
			const prepared = await this.planFullNoteApply(request, before, output);
			if (prepared.cancelled) {
				return "Apply cancelled. No note was changed.";
			}

			if (!(await this.confirmTextApplyPreview({
				request,
				scope: "full-note",
				targetLabel,
				before,
				after: prepared.text,
				warning: joinWarnings(this.describeNoteEditsSinceRequest(request, before), prepared.warning)
			}))) {
				return "Apply cancelled. No note was changed.";
			}

			assertNoteUnchangedDuringPreview(before, editor.getValue(), targetLabel);
			// Only the changed part is written, so the cursor, folds and undo history of the rest of the note survive.
			this.writeThroughEditor(editor, before, prepared.text);
			this.rememberEditorContext(editor, file);
			return `Applied to ${targetLabel}. Use Obsidian undo or file history immediately if needed.`;
		}

		if (file?.extension === "md") {
			const content = await this.app.vault.cachedRead(file);
			if (!(await this.confirmReplaceScopeRisks(request, "full-note", file.path))) {
				return "Apply cancelled. No note was changed.";
			}

			const prepared = await this.planFullNoteApply(request, content, output);
			if (prepared.cancelled) {
				return "Apply cancelled. No note was changed.";
			}

			if (!(await this.confirmTextApplyPreview({
				request,
				scope: "full-note",
				targetLabel: file.path,
				before: content,
				after: prepared.text,
				warning: joinWarnings(this.describeNoteEditsSinceRequest(request, content), prepared.warning)
			}))) {
				return "Apply cancelled. No note was changed.";
			}

			await this.app.vault.process(file, (latest) => {
				assertNoteUnchangedDuringPreview(content, latest, file.path);
				return prepared.text;
			});
			this.rememberMarkdownFile(file);
			return `Applied to ${file.path}. Use Obsidian undo or file history immediately if needed.`;
		}

		throw new Error("Open the original Markdown note before applying changes.");
	}

	/**
	 * What a full-note Apply would write: the reply made safe against the note it replaces, shaped by the frontmatter
	 * policy, and in the note's own line endings. A question the policy raises (malformed or changed frontmatter) is
	 * asked here; a "no" cancels the Apply.
	 */
	private async planFullNoteApply(request: AskRequest, before: string, output: string): Promise<{ text: string; warning: string; cancelled: boolean }> {
		const prepared = this.prepareForWrite(request, output, before);
		const plan = prepareFrontmatterAwareApply(before, prepared.text, this.settings.frontmatterApplyPolicy);
		if (plan.confirm && !(await askMateConfirm(this.app, plan.confirm))) {
			return { text: plan.text, warning: plan.warning, cancelled: true };
		}
		return {
			text: plan.text,
			warning: joinWarnings(plan.warning, describeWriteChanges(prepared), describeActiveContentAdded(before, plan.text)),
			cancelled: false
		};
	}

	// A cut-off reply would silently delete the text it failed to reproduce; appending it loses nothing.
	private assertOutputCompleteForReplace(request: AskRequest): void {
		const hiddenReason = getReplaceBlockReason(request.metadata.privacy, request.context.content);
		if (hiddenReason) {
			throw new Error(hiddenReason);
		}
		const reason = request.metadata.outputIncompleteReason;
		if (reason) {
			throw new Error(
				`This reply is incomplete (${reason}), so AskMate will not use it to replace note text. Append it instead, or ask again.`
			);
		}
	}

	private async confirmReplaceScopeRisks(
		request: AskRequest,
		scope: "selected-text" | "heading-section" | "full-note",
		targetLabel: string
	): Promise<boolean> {
		// Older requests only record whether any context (including attachments) was cut.
		const primaryTruncated = request.metadata.primaryContextTruncated ?? request.metadata.contextTruncated;
		const sawOnlySelection = request.context.source === "Selected text" && scope !== "selected-text";
		if (!primaryTruncated && !sawOnlySelection) {
			return true;
		}

		const target = scope === "full-note"
			? `the full note "${targetLabel}"`
			: scope === "heading-section"
				? `the heading section "${targetLabel}"`
				: `the selected text in "${targetLabel}"`;
		const primaryLabel = request.context.source === "Selected text" ? "selected text" : "note";
		return await askMateConfirm(this.app, [
			`Replace ${target} with this reply?`,
			...(sawOnlySelection
				? ["", "The model only saw the selected text, so anything else in this target may be lost."]
				: []),
			...(primaryTruncated
				? [
					"",
					`AskMate only sent part of the ${primaryLabel} to the model.`,
					`Context budget: ${getContextBudgetOption(request.metadata.contextBudgetMode).label}`,
					`Sent: ${request.metadata.promptContextCharacters.toLocaleString()} characters`,
					`Captured ${primaryLabel}: ${request.metadata.contextCharacters.toLocaleString()} characters`,
					"",
					"To reduce risk, cancel and switch the context budget to Expanded before asking AskMate to rewrite this text."
				]
				: [])
		].join("\n"));
	}

	private shouldUseDiffApproval(scope: TextApplyPreviewScope, forceDiff: boolean): boolean {
		// A reply built from tool results is always reviewed as a diff, whatever the approval mode says.
		if (forceDiff) {
			return true;
		}

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
		request,
		scope,
		targetLabel,
		before,
		after,
		warning,
		toolDerived = false
	}: {
		/** The request the reply answers, when there is one. A review-queue item has none. */
		request?: AskRequest;
		scope: TextApplyPreviewScope;
		targetLabel: string;
		before: string;
		after: string;
		warning?: string;
		/** The reply was written from tool results. A queued item carries this itself, because it has no request. */
		toolDerived?: boolean;
	}): Promise<boolean> {
		const forceDiff = toolDerived || (request !== undefined && this.requestRunner.getRunFacts(request).toolDerived);
		const notice = forceDiff ? joinWarnings(warning, "This reply was written from tool results, so check it before it is applied.") : warning;
		if (this.shouldUseDiffApproval(scope, forceDiff)) {
			return await askMateDiffConfirm(this.app, {
				scope,
				targetLabel,
				before,
				after,
				warning: notice
			});
		}

		if (scope === "full-note") {
			const warningText = notice ? `\n\nWarning: ${notice}` : "";
			return await askMateConfirm(this.app, `Apply AskMate output by replacing the full contents of "${targetLabel}"? This cannot be undone by AskMate.${warningText}`);
		}

		// Scopes that normally apply without a prompt still stop when there is a warning, such as edits made after asking.
		if (notice) {
			return await askMateConfirm(this.app, `Apply AskMate output to "${targetLabel}"?\n\nWarning: ${notice}`);
		}

		return true;
	}

	/** True when an answer to this request can call MCP tools, which is when the run adds the tools section. */
	private mayUseToolsFor(request: AskRequest): boolean {
		const metadata = request.metadata;
		if (metadata.outputMode !== "chat" || metadata.modelCapability !== "text" || metadata.intentKind === "diagram" || metadata.forceImage || metadata.autoImage) {
			return false;
		}
		return this.mcpService?.status().some((server) => server.state.kind === "ready" || server.state.kind === "idle") ?? false;
	}

	/**
	 * What the request builders produce: the instructions and the message. A run adds the diagram brief and the tools section
	 * after that, and the result says so (addedAtSend) and counts a fixed allowance for them in the estimate.
	 */
	buildPromptInspectionForRequest(request: AskRequest): InspectedPrompt {
		const shouldGenerateImage = request.metadata.forceImage || request.metadata.autoImage || request.metadata.modelCapability === "image";
		const purpose = shouldGenerateImage ? "image-plan" : "answer";
		const instructions = buildRequestInstructions(request, { purpose });
		const input = buildRequestInput(request, { purpose });
		// Show the capped fallback exactly as RequestRunner would send it if prompt planning fails.
		const secondaryInput = shouldGenerateImage ? buildFallbackImagePrompt(request) : "";
		const added = describeAddedAtSend({
			isDiagram: !shouldGenerateImage && request.metadata.intentKind === "diagram",
			toolsAvailable: !shouldGenerateImage && this.mayUseToolsFor(request)
		});
		// The fallback image prompt is only sent when planning fails, so it is shown but not counted towards the estimate.
		const estimatedInputTokens = estimateTokenCount([instructions, input].filter(Boolean).join("\n\n")) + added.extraTokens;
		const guardrails = this.usageService.evaluateUsageGuardrails(request, estimatedInputTokens);
		// Image generation always goes to OpenAI Images, whichever provider plans the prompt, so the label names both.
		const planning = shouldGenerateImage ? this.getImagePlanningProviderRef() : null;
		return {
			request,
			providerName: planning ? "OpenAI Images" : request.metadata.providerName,
			model: planning ? `${GPT_IMAGE_2_MODEL_ID} (prompt planned by ${planning.providerName}: ${planning.model})` : request.metadata.selectedModel,
			capability: request.metadata.modelCapability,
			instructions,
			input,
			secondaryInput,
			estimatedInputTokens,
			warnings: guardrails.warnings,
			blockers: guardrails.blockers,
			addedAtSend: added.notes
		};
	}

	async inspectFinalPrompt(question: string, title: string, options: ExtendedBuildOptions = {}): Promise<InspectedPrompt> {
		const request = await this.buildRequest(question, title, options);
		return this.buildPromptInspectionForRequest(request);
	}

	evaluateUsageGuardrails(request: AskRequest, estimatedInputTokens?: number): UsageGuardrailResult {
		const estimate = estimatedInputTokens ?? this.buildPromptInspectionForRequest(request).estimatedInputTokens;
		return this.usageService.evaluateUsageGuardrails(request, estimate);
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
		await this.confirmHardInputLimit(request, inspection.estimatedInputTokens);
	}

	/**
	 * Above a fixed size the person is always asked, even with every guardrail off: the Expanded default can send a whole
	 * vault note by accident. Balanced trims this one request to a shorter part of the note.
	 */
	private async confirmHardInputLimit(request: AskRequest, estimatedInputTokens: number): Promise<void> {
		const limit = this.usageService.evaluateHardInputLimit(estimatedInputTokens);
		if (!limit.confirm) {
			return;
		}
		const choice = await askMateChoice(this.app, {
			title: "Send a very large request?",
			message: `${limit.reason}\n\nNothing has been sent yet. Balanced sends a shorter part of the note for this request only.`,
			choices: [
				{ id: "cancel", label: "Cancel" },
				{ id: "balanced", label: "Use Balanced for this request" },
				{ id: "send", label: "Send anyway", primary: true }
			],
			focus: "cancel",
			dismiss: "cancel"
		});
		if (choice === "cancel") {
			throw new Error("AskMate request cancelled: it was too large to send.");
		}
		if (choice === "balanced") {
			this.requestRunner.applyContextBudget(request, "balanced");
		}
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
		// A tab restored at start-up is a deferred leaf with no view yet, so it is matched by its saved file and loaded on demand.
		const existing = findLeafForFile(this.app.workspace.getLeavesOfType("markdown"), file.path);
		let leaf: WorkspaceLeaf;
		if (existing) {
			await existing.loadIfDeferred();
			leaf = existing;
		} else {
			// A new tab, so the note the person is reading is never replaced to show a source.
			leaf = this.app.workspace.getLeaf("tab");
			await leaf.openFile(file, { state: { mode: "source" }, eState: { line: Math.max(0, source.lineStart - 1) } });
		}
		await this.app.workspace.revealLeaf(leaf);
		// A selection cannot be seen in reading view, so the note is switched to editing first.
		if (leaf.view instanceof MarkdownView && leaf.view.getMode() !== "source") {
			const state = leaf.getViewState();
			await leaf.setViewState({ ...state, state: { ...state.state, mode: "source" } });
		}
		if (leaf.view instanceof MarkdownView) {
			const editor = leaf.view.editor;
			// Line numbers were captured with the answer; the note may have shrunk since, and out-of-range lines throw.
			const lastLine = editor.lastLine();
			if (source.lineStart - 1 > lastLine) {
				new Notice(`Evidence lines ${source.lineStart}-${source.lineEnd} no longer exist in ${source.sourcePath}. The note has changed since the answer.`);
			}
			const startLine = Math.min(lastLine, Math.max(0, source.lineStart - 1));
			const endLine = Math.min(lastLine, Math.max(startLine, source.lineEnd - 1));
			const start = { line: startLine, ch: 0 };
			const end = { line: endLine, ch: editor.getLine(endLine).length };
			editor.setSelection(start, end);
			editor.scrollIntoView({ from: start, to: end }, true);
		}
	}

	async recordNoteHistoryTurn(request: AskRequest, answer: string, model: string): Promise<void> {
		await this.historyService.recordNoteHistoryTurn(request, answer, model);
	}

	getNoteHistoryForPath(sourcePath: string): NoteHistoryTurn[] {
		return this.historyService.getNoteHistoryForPath(sourcePath);
	}

	async clearNoteHistoryForPath(sourcePath: string): Promise<void> {
		await this.historyService.clearNoteHistoryForPath(sourcePath);
	}

	async queueReviewItemFromRequest(request: AskRequest, proposedText: string, model: string, scope: ApplyScope = "auto"): Promise<ReviewQueueItem> {
		this.assertOutputIsApplicable(proposedText.trim());
		this.assertTargetAcceptsText(request);
		this.assertDiagramWritable(request);
		// A suggestion that replaces the note or the selection keeps what that text already held; one that is appended has no source.
		const effective = resolveApplyScope(scope, request.context.source);
		const replaced = effective === "full-note"
			? request.context.content
			: effective === "selected-block"
				? request.context.selectionIdentity?.text ?? request.context.content
				: undefined;
		const prepared = this.prepareForWrite(request, proposedText, replaced);
		// The run facts belong to the request, so the item carries the flag: applying it later still shows the diff first.
		return await this.historyService.queueReviewItemFromRequest(request, prepared.text, model, scope, {
			toolDerived: this.requestRunner.getRunFacts(request).toolDerived
		});
	}

	/** Excalidraw files hold drawing data in Markdown; writing model text into them can corrupt the drawing. */
	private assertTargetAcceptsText(request: AskRequest): void {
		if (request.context.file?.path.toLowerCase().endsWith(".excalidraw.md")) {
			throw new Error("AskMate does not write into Excalidraw drawings. Save the reply as a note or copy it instead.");
		}
	}

	/** Apply-mode prompts ask the model to start with APPLY_REFUSAL_PREFIX when it cannot do the edit; never write that into a note. */
	private assertOutputIsApplicable(output: string): void {
		if (output.startsWith(APPLY_REFUSAL_PREFIX)) {
			const reason = output.slice(APPLY_REFUSAL_PREFIX.length).split(/\r?\n/)[0].trim();
			throw new Error(`The model could not make this edit, so AskMate did not change the note.${reason ? ` Reason: ${reason}` : ""}`);
		}
	}

	getPendingReviewQueueItems(): ReviewQueueItem[] {
		return this.historyService.getPendingReviewQueueItems();
	}

	async applyReviewQueueItem(id: string): Promise<string> {
		if (this.reviewQueueMutationActive) {
			throw new Error("Another review queue action is already running.");
		}
		this.reviewQueueMutationActive = true;
		try {
			// Only the item is kept across the awaits below; the queue itself is re-read before writing.
			const item = normalizeReviewQueueItems(this.settings.reviewQueue, this.settings.reviewQueueMaxItems).find((candidate) => candidate.id === id);
			if (!item) {
				throw new Error("Review queue item was not found.");
			}
			if (item.status !== "pending") {
				throw new Error("Review queue item is no longer pending.");
			}
			if (item.scope === "heading-section" || item.scope === "auto") {
				throw new Error("This queued review target cannot be applied safely. Re-run or requeue the suggestion.");
			}
			const file = this.app.vault.getAbstractFileByPath(item.sourcePath);
			if (!(file instanceof TFile) || file.extension !== "md") {
				throw new Error("Review queue source note was not found.");
			}
			const content = await this.app.vault.cachedRead(file);
			let nextContent = content;
			let previewScope: "selected-text" | "append" | "full-note" = "full-note";
			// An item queued by an older build, or brought by a sync, was not made safe when it was queued, so it is made safe now.
			// The strict header AskMate builds for its own diagrams is allowed through: the guard checks its grammar.
			const replaced = item.scope === "selected-block" ? item.selectionIdentity?.text : item.scope === "full-note" ? content : undefined;
			const prepared = prepareReplyForWrite(item.proposedText, { ...(replaced === undefined ? {} : { sourceText: replaced }), allowDiagramHeader: true });
			const proposed = prepared.text;
			let planWarning = "";
			if (item.scope === "selected-block") {
				const resolution = item.selectionIdentity ? resolveSelectionIdentity(content, item.selectionIdentity) : null;
				if (!resolution || resolution.startOffset === null) {
					throw new Error("AskMate could not safely find the original queued text in the current note.");
				}
				nextContent = `${content.slice(0, resolution.startOffset)}${proposed}${content.slice(resolution.endOffset ?? resolution.startOffset)}`;
				previewScope = "selected-text";
			} else if (item.scope === "append") {
				nextContent = appendMarkdownBlockToContent(content, proposed);
				previewScope = "append";
				planWarning = this.describeOpenFenceAppend(content);
			} else {
				if (content !== item.beforeText) {
					throw new Error("The source note changed since this review item was queued. Re-run or requeue the suggestion before applying it.");
				}
				const plan = prepareFrontmatterAwareApply(content, proposed, this.settings.frontmatterApplyPolicy);
				if (plan.confirm && !(await askMateConfirm(this.app, plan.confirm))) {
					return "Review item apply cancelled. No note was changed.";
				}
				nextContent = plan.text;
				planWarning = plan.warning;
			}
			if (!(await this.confirmTextApplyPreview({
				scope: previewScope,
				targetLabel: file.path,
				before: content,
				after: nextContent,
				warning: joinWarnings(planWarning, describeWriteChanges(prepared), describeActiveContentAdded(content, nextContent)),
				toolDerived: item.toolDerived === true
			}))) {
				return "Review item apply cancelled. No note was changed.";
			}
			const currentItem = normalizeReviewQueueItems(this.settings.reviewQueue, this.settings.reviewQueueMaxItems).find((candidate) => candidate.id === id);
			if (currentItem?.status !== "pending") {
				throw new Error("Review queue item changed while the Apply preview was open.");
			}
			const previewedContent = nextContent;
			await this.app.vault.process(file, (latest) => {
				if (item.scope === "append") {
					return appendMarkdownBlockToContent(latest, proposed);
				}
				if (item.scope === "selected-block") {
					const latestResolution = item.selectionIdentity ? resolveSelectionIdentity(latest, item.selectionIdentity) : null;
					if (!latestResolution || latestResolution.startOffset === null) {
						throw new Error("Note changed while the Apply preview was open. Re-queue or select the text again.");
					}
					return `${latest.slice(0, latestResolution.startOffset)}${proposed}${latest.slice(latestResolution.endOffset ?? latestResolution.startOffset)}`;
				}
				assertNoteUnchangedDuringPreview(content, latest, file.path);
				return previewedContent;
			});
			const updatedAt = new Date().toISOString();
			this.settings.reviewQueue = this.settings.reviewQueue.map((candidate) =>
				candidate.id === id ? { ...candidate, status: "applied" as const, updatedAt } : candidate
			);
			try {
				await this.saveSettings();
			} catch (error) {
				console.warn("AskMate applied a review item but could not save its queue status.", error);
				return `Applied queued AskMate change to ${file.path}, but could not update the review queue status.`;
			}
			return `Applied queued AskMate change to ${file.path}.`;
		} finally {
			this.reviewQueueMutationActive = false;
		}
	}

	async dismissReviewQueueItem(id: string): Promise<void> {
		if (this.reviewQueueMutationActive) {
			throw new Error("Another review queue action is already running.");
		}
		this.reviewQueueMutationActive = true;
		try {
			await this.historyService.dismissReviewQueueItem(id);
		} finally {
			this.reviewQueueMutationActive = false;
		}
	}

	private getResultNoteFolder(request: AskRequest): string {
		if (this.settings.smartResultPlacementEnabled && request.context.file?.parent?.path) {
			return cleanFolderPath(chooseSmartResultFolder(request.context.file.parent.path));
		}
		return cleanFolderPath(this.settings.resultFolder);
	}

	private async maybeAppendResultBacklinkToSource(request: AskRequest, resultFile: TFile): Promise<void> {
		const sourceFile = request.context.file;
		if (!this.settings.appendResultBacklinkToSource || !sourceFile || sourceFile.path === resultFile.path || sourceFile.path.toLowerCase().endsWith(".excalidraw.md")) {
			return;
		}
		const bullet = `- [[${resultFile.path}|${resultFile.basename}]] created ${this.formatDate(new Date())}`;
		// The result note already exists, so a backlink failure is reported without failing the request.
		try {
			const view = this.getOpenMarkdownViewForFile(sourceFile);
			if (view) {
				// Writing through the open editor keeps unsaved keystrokes and the user's undo history.
				const insertion = planResultBacklinkInsertion(view.editor.getValue(), bullet);
				if (insertion) {
					view.editor.replaceRange(insertion.text, view.editor.offsetToPos(insertion.offset));
				}
				return;
			}
			await this.app.vault.process(sourceFile, (content) => {
				const insertion = planResultBacklinkInsertion(content, bullet);
				return insertion ? applyTextInsertion(content, insertion) : content;
			});
		} catch (error) {
			new Notice(`AskMate created ${resultFile.path}, but could not add its backlink to ${sourceFile.path}: ${this.getErrorMessage(error)}`);
		}
	}

	/** Existing vault tags with a leading "#", for @tag: suggestions. */
	getVaultTags(): string[] {
		return rankVaultTags(this.contextService.collectVaultData(null, true).notes);
	}

	async getBatchWorkflowTargetFiles(folderPath: string, maxFiles: number): Promise<TFile[]> {
		return await this.contextService.listMarkdownFilesInFolder(folderPath, maxFiles);
	}

	async runBatchWorkflow(
		options: BatchWorkflowRunOptions,
		onProgress?: (progress: BatchWorkflowProgress) => void,
		abortSignal?: AbortSignal
	): Promise<BatchWorkflowRunSummary> {
		if (this.batchRunActive) {
			throw new Error("An AskMate batch is already running. Wait for it to finish or cancel it first.");
		}
		this.batchRunActive = true;
		try {
			return await this.runBatchWorkflowOnce(options, onProgress, abortSignal);
		} finally {
			this.batchRunActive = false;
		}
	}

	private async runBatchWorkflowOnce(
		options: BatchWorkflowRunOptions,
		onProgress?: (progress: BatchWorkflowProgress) => void,
		abortSignal?: AbortSignal
	): Promise<BatchWorkflowRunSummary> {
		if (this.getSelectedProviderModelRef().capability !== "text") {
			throw new Error(IMAGE_WORKFLOW_MESSAGE);
		}
		const configuredWorkflowId = options.workflowId.trim();
		const workflow = configuredWorkflowId
			? this.getAllWorkflows().find((item) => item.id === configuredWorkflowId)
			: this.getAllWorkflows()[0];
		if (!workflow) {
			throw new Error(configuredWorkflowId
				? "The selected batch workflow no longer exists. Choose another batch workflow in AskMate settings."
				: "No AskMate workflow is available for batch processing.");
		}
		// Only workflows that return a full revised note may replace it; everything else is queued as an append.
		const queueScope: ApplyScope = workflow.outputKind === "note-edit" ? "full-note" : "append";
		if (!options.folderPath.trim()) {
			throw new Error("Choose a batch folder first: a folder path inside the vault, without \".\" or \"..\" segments.");
		}
		let files: TFile[] = [];
		let folderMissing = false;
		try {
			files = await this.getBatchWorkflowTargetFiles(options.folderPath, options.maxFiles);
		} catch (error) {
			if (!(error instanceof FolderNotFoundError)) {
				throw error;
			}
			folderMissing = true;
		}
		const summary: BatchWorkflowRunSummary = { total: files.length, completed: 0, failed: 0, createdNotes: [], queuedReviews: 0, stoppedReason: null, failures: [] };
		const report = (currentPath: string, message: string): void => {
			onProgress?.({ total: files.length, completed: summary.completed, failed: summary.failed, currentPath, message });
		};
		const stop = (reason: string): BatchWorkflowRunSummary => {
			summary.stoppedReason = reason;
			report("", `${reason} ${summary.completed} completed, ${summary.failed} failed, ${files.length - summary.completed - summary.failed} not run.`);
			return summary;
		};
		if (files.length === 0) {
			// A folder with no notes, or no folder at all, is not a batch that ran and completed nothing.
			return stop(describeEmptyBatch(options.folderPath, !folderMissing));
		}
		if (!(await askMateConfirm(this.app, this.describeBatchRun(workflow, files.length, options, queueScope)))) {
			return stop("Batch cancelled before it started.");
		}
		// The provider and effort the person confirmed are the ones every note uses, even if settings change while the batch runs.
		const providerRef = this.getSelectedProviderModelRef();
		const reasoningEffort = this.getSelectedReasoningEffort();
		let runState = INITIAL_BATCH_STATE;
		// Asking once keeps a long batch usable while still surfacing budget overruns that the per-request flow would confirm.
		let usageWarningsAccepted = false;
		for (const [index, file] of files.entries()) {
			if (abortSignal?.aborted) {
				return stop("Batch cancelled.");
			}
			if (options.outputMode === "review-queue" && this.isReviewQueueFull()) {
				return stop(`The review queue is full (limit ${this.settings.reviewQueueMaxItems} pending items). Apply or dismiss queued items, then run the batch again.`);
			}
			report(file.path, `Running ${workflow.name} on ${file.path}`);
			try {
				const request = await this.buildRequest(this.getWorkflowPrompt(workflow), batchResultTitle(workflow.name, file.basename), {
					file,
					forceFileContext: true,
					workflow,
					outputMode: "note",
					contextBudgetMode: options.contextBudgetMode,
					commandSource: "command_palette",
					providerRef,
					reasoningEffort
				});
				const guardrails = this.evaluateUsageGuardrails(request);
				if (guardrails.blockers.length > 0) {
					throw new Error(guardrails.blockers.join(" "));
				}
				const hardLimit = this.usageService.evaluateHardInputLimit(this.buildPromptInspectionForRequest(request).estimatedInputTokens);
				if (hardLimit.confirm) {
					// A batch cannot stop to ask about every large note, so a note this large is skipped and named in the summary.
					throw new Error(`${hardLimit.reason} A batch does not send notes this large. Ask about it on its own from the sidebar.`);
				}
				if (guardrails.warnings.length > 0 && !usageWarningsAccepted) {
					const remaining = files.length - index;
					if (!(await askMateConfirm(this.app, `${guardrails.warnings.join("\n\n")}\n\nContinue the batch for the remaining ${remaining} note${remaining === 1 ? "" : "s"}? AskMate will not ask again during this batch.`))) {
						return stop("Batch stopped at a usage warning.");
					}
					usageWarningsAccepted = true;
				}
				const result = await this.runOpenAIRequest(request, { abortSignal, forceImage: false });
				if (result.kind !== "text") {
					throw new Error("Batch workflows support text responses only.");
				}
				const incompleteReason = result.incompleteReason ?? request.metadata.outputIncompleteReason;
				if (incompleteReason) {
					throw new Error(`The reply was incomplete (${incompleteReason}), so AskMate did not use it.`);
				}
				if (options.outputMode === "review-queue") {
					if (queueScope === "full-note") {
						await this.assertBatchFullNoteReplacementIsSafe(request, file);
					}
					await this.queueReviewItemFromRequest(request, result.text, result.model, queueScope);
					summary.queuedReviews += 1;
				} else {
					const note = await this.createResultNote(request, result.text, { model: result.model });
					summary.createdNotes.push(note.path);
				}
				summary.completed += 1;
				runState = nextBatchDecision(runState, null).state;
			} catch (error) {
				if (isAbortError(error)) {
					return stop("Batch cancelled.");
				}
				const reason = this.getErrorMessage(error);
				summary.failed += 1;
				summary.failures.push({ path: file.path, reason });
				report(file.path, `${file.path}: ${reason}`);
				// A wrong key or a blocking guardrail fails every note the same way, so a few in a row end the batch.
				const decision = nextBatchDecision(runState, classifyBatchFailure(reason));
				runState = decision.state;
				if (decision.stopReason) {
					return stop(decision.stopReason);
				}
			}
		}
		report("", `Batch workflow complete: ${summary.completed} completed, ${summary.failed} failed.`);
		return summary;
	}

	private describeBatchRun(workflow: Workflow, fileCount: number, options: BatchWorkflowRunOptions, queueScope: ApplyScope): string {
		const output = options.outputMode === "review-queue"
			? `queue ${queueScope === "full-note" ? "full-note replacements" : "additions to append"} in the review queue (room for ${Math.max(0, this.settings.reviewQueueMaxItems - this.getPendingReviewQueueItems().length)} more pending items)`
			: "create one result note per source note";
		return `Run "${workflow.name}" on ${fileCount} note${fileCount === 1 ? "" : "s"} in ${options.folderPath || "the vault root"}?\n\nEach note is a separate request to ${this.getSelectedProviderModelRef().providerName}, and AskMate will ${output}.`;
	}

	private isReviewQueueFull(): boolean {
		return this.getPendingReviewQueueItems().length >= this.settings.reviewQueueMaxItems;
	}

	private async assertBatchFullNoteReplacementIsSafe(request: AskRequest, file: TFile): Promise<void> {
		if (request.metadata.primaryContextTruncated ?? request.metadata.contextTruncated) {
			throw new Error("The note was longer than the context budget, so AskMate will not queue a full-note replacement that would drop the unsent part. Use the Expanded context budget for this note.");
		}
		// The queued item records the note as it is when queued, so an edit made during generation would pass the later staleness check.
		const current = await this.app.vault.cachedRead(file);
		if (current.trim() !== request.context.content) {
			throw new Error("The note changed while AskMate was generating, so the suggestion was not queued.");
		}
	}

	async getOpenAiApiKey(): Promise<string> {
		return await this.getProviderApiKey("openai");
	}

	/** The stored key, or an empty string. Reading it asks nothing: it answers "is a key stored", not "may it be sent". */
	private async readProviderSecret(providerId: TextProviderId): Promise<string> {
		const secretName = this.getProviderSettings(providerId).apiKeySecretName.trim();

		if (!secretName) {
			return "";
		}

		const secret = await Promise.resolve(this.app.secretStorage.getSecret(secretName));
		return secret ?? "";
	}

	/** The key for a request. A key leaves this device only for an address this device approved for it, so the first use asks. */
	async getProviderApiKey(providerId: TextProviderId = this.getSelectedTextProviderId()): Promise<string> {
		const secret = await this.readProviderSecret(providerId);
		if (!secret) {
			return "";
		}
		await this.assertKeyMayBeSent(providerId, this.getProviderSettings(providerId).apiKeySecretName.trim());
		return secret;
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
		// Only the OpenAI Responses adapter sends reasoning effort, and it drops values the model does not accept.
		return ref.providerId === "openai" && getSupportedReasoningEffort(ref.model, this.getSelectedReasoningEffort()) !== null;
	}

	/**
	 * Image generation always uses OpenAI Images, whichever provider handles chat. Prompt planning falls back to a
	 * built-in prompt when its provider fails, so only the OpenAI key is required.
	 */
	async isImageGenerationConfigured(): Promise<boolean> {
		return (await this.getOpenAiApiKey()).trim().length > 0;
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
			return hasModel && (await this.readProviderSecret(ref.providerId)).trim().length > 0;
		}

		if (ref.providerId === "azure-ai") {
			return hasModel && provider.baseUrl.trim().length > 0 && (await this.readProviderSecret(ref.providerId)).trim().length > 0;
		}

		return hasModel && (await this.readProviderSecret(ref.providerId)).trim().length > 0;
	}

	getSelectedModel(): string {
		return this.getSelectedProviderModelRef().model;
	}

	shouldGenerateImageFromQuestion(question: string): boolean {
		return shouldGenerateImage(question, this.settings.autoImageIntentEnabled);
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

	private expandWorkflowPrompt(workflow: Workflow, context: NoteContext, sanitizedContextContent: string, privacy?: RequestPrivacyOptions): string {
		const now = new Date();
		const template = this.getWorkflowPrompt(workflow);
		const variables = this.buildCommonTemplateVariables(context, {
			title: workflow.name,
			request: template,
			response: "",
			model: this.getSelectedModel(),
			workflowName: workflow.name,
			date: this.formatDate(now),
			dateTime: buildDateTemplateValues(now).dateTime
		});
		// The expanded prompt is sent to the provider, so note-identifying variables follow the note-context privacy choice.
		// Without explicit privacy, an empty sanitised context for a non-empty note means the note was withheld.
		const noteWithheld = privacy ? !privacy.includeNoteContext : sanitizedContextContent === "" && context.content.trim() !== "";
		if (noteWithheld) {
			variables.noteTitle = NOTE_IDENTITY_WITHHELD;
			variables.sourcePath = NOTE_IDENTITY_WITHHELD;
			variables.sourceLink = NOTE_IDENTITY_WITHHELD;
		}
		variables.customInstructions = this.settings.workflowCustomInstructions.trim();
		variables.selectedText = context.source === "Selected text" ? sanitizedContextContent : "";
		const rendered = trimOuterBlankLines(renderTemplate(template, variables)) || template;
		return appendWorkflowUserPreferences(rendered, template, variables.customInstructions);
	}

	exportCustomWorkflowPresets(): string {
		return JSON.stringify({
			version: 1,
			exportedAt: new Date().toISOString(),
			source: "AskMate",
			workflows: this.settings.customWorkflows.map((workflow) => ({ ...workflow, outputKind: workflow.outputKind ?? "note-edit" }))
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
		// A preset that does not say what it produces creates new content. It never replaces the note unless it says so.
		const normalized = normalizeCustomWorkflowsWithDiagnostics(workflowsValue.map(withSafeImportDefaults));
		const imported: CustomWorkflow[] = [];

		for (const [index, workflow] of normalized.workflows.entries()) {
			if (existingIds.has(workflow.id)) {
				workflow.id = `custom-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 7)}`;
			}
			existingIds.add(workflow.id);
			imported.push(workflow);
		}

		if (imported.length === 0) {
			throw new Error("No valid custom workflows were found in that preset JSON.");
		}

		const capacity = MAX_CUSTOM_WORKFLOWS - this.settings.customWorkflows.length;
		if (capacity <= 0) {
			throw new Error(`AskMate already has the maximum of ${MAX_CUSTOM_WORKFLOWS} custom workflows. Delete some before importing more.`);
		}
		const kept = imported.slice(0, capacity);
		const concerns = findImportConcerns(kept);
		if (concerns.length > 0 && !(await askMateConfirm(this.app, describeImportConcerns(concerns, kept.length)))) {
			throw new Error("Workflow import cancelled. Nothing was added.");
		}
		this.settings.customWorkflows = normalizeCustomWorkflowsWithDiagnostics([
			...this.settings.customWorkflows,
			...kept
		]).workflows;
		const shortened = normalized.diagnostics.filter((diagnostic) => diagnostic.code === "workflow-prompt-truncated" || diagnostic.code === "workflow-name-truncated");
		if (shortened.length > 0) {
			new Notice(shortened.map((diagnostic) => diagnostic.message).join(" "), 10 * NOTICE_SECONDS);
		}
		await this.saveSettings();
		this.registerCustomWorkflowCommands();
		this.refreshOpenAskMateViews();
		const keptIds = new Set(kept.map((workflow) => workflow.id));
		const importedCount = this.settings.customWorkflows.filter((workflow) => keptIds.has(workflow.id)).length;
		const skipped = imported.length - importedCount;
		if (skipped > 0) {
			new Notice(`AskMate skipped ${skipped} imported workflow${skipped === 1 ? "" : "s"} because the limit is ${MAX_CUSTOM_WORKFLOWS} custom workflows.`);
		}
		return importedCount;
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
				outputKind: workflow.outputKind ?? "note-edit",
				...(workflow.skillIds && workflow.skillIds.length > 0 ? { skillIds: workflow.skillIds } : {}),
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

	/** Indices are positions in the sidebar order shown in settings, which lists favorites first. */
	async reorderWorkflowDisplay(fromIndex: number, toIndex: number): Promise<void> {
		const ids = this.sortWorkflowsForSidebar(this.getAllWorkflows()).map((workflow) => workflow.id);
		const inRange = (index: number): boolean => Number.isInteger(index) && index >= 0 && index < ids.length;
		if (fromIndex === toIndex || !inRange(fromIndex) || !inRange(toIndex)) {
			return;
		}
		// Favorites always sort first, so a move across that boundary would be undone; ignoring it keeps keyboard focus on the same workflow.
		const isFavorite = (index: number): boolean => Boolean(this.getWorkflowDisplayPreference(ids[index] ?? "")?.favorite);
		if (isFavorite(fromIndex) !== isFavorite(toIndex)) {
			return;
		}

		const [moved] = ids.splice(fromIndex, 1);
		ids.splice(toIndex, 0, moved);
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
		// Saving normalises the list down to the cap, so a workflow past it would vanish without a word.
		if (this.settings.customWorkflows.length >= MAX_CUSTOM_WORKFLOWS) {
			throw new Error(`AskMate already has the maximum of ${MAX_CUSTOM_WORKFLOWS} custom workflows. Delete one before adding another.`);
		}
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
				outputKind: "new-content",
				createdAt: now,
				updatedAt: now
			}
		];
		await this.saveSettings();
		this.registerCustomWorkflowCommands();
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
		this.registerCustomWorkflowCommands();
		this.refreshOpenAskMateViews();
	}

	async deleteCustomWorkflow(id: string): Promise<void> {
		this.settings.customWorkflows = this.settings.customWorkflows.filter((workflow) => workflow.id !== id);
		await this.saveSettings();
		this.registerCustomWorkflowCommands();
		this.refreshOpenAskMateViews();
	}

	getSidebarWorkflowOrderForSettings(): Workflow[] {
		return this.sortWorkflowsForSidebar(this.getAllWorkflows());
	}


	/** Registered custom workflow command ids mapped to the name each was registered with. */
	private registeredCustomWorkflowCommands = new Map<string, string>();

	private registerCustomWorkflowCommands(): void {
		// Obsidian cannot rename a command, so a renamed workflow's command is removed and added again; hotkeys follow the id.
		// Hiding a workflow only removes it from the sidebar, so hidden workflows keep their command and hotkey.
		const wanted = new Map(this.getAllWorkflows()
			.filter((workflow) => workflow.isCustom)
			.map((workflow) => [workflow.commandId, workflow]));
		for (const [commandId, name] of this.registeredCustomWorkflowCommands) {
			if (wanted.get(commandId)?.name !== name) {
				this.removeCommand(commandId);
				this.registeredCustomWorkflowCommands.delete(commandId);
			}
		}
		for (const [commandId, workflow] of wanted) {
			if (this.registeredCustomWorkflowCommands.has(commandId)) {
				continue;
			}
			this.registeredCustomWorkflowCommands.set(commandId, workflow.name);
			const workflowId = workflow.id;
			this.addCommand({
				id: commandId,
				name: workflow.name,
				editorCallback: async (editor, ctx) => {
					const current = this.getAllWorkflows().find((item) => item.id === workflowId);
					if (!current) {
						new Notice("That custom workflow no longer exists.");
						return;
					}
					await this.runWorkflowFromCommand(current, editor, ctx.file ?? null);
				}
			});
		}
	}

	private addEditorMenuItems(menu: Menu, editor: Editor, file: TFile | null): void {
		const entries = buildEditorMenuEntries({
			enabled: this.settings.editorContextMenuEnabled,
			hasSelection: editor.somethingSelected(),
			visibleWorkflows: this.getVisibleWorkflows(),
			favouriteIds: new Set(this.settings.workflowDisplayPreferences.filter((preference) => preference.favorite).map((preference) => preference.id))
		});
		for (const entry of entries) {
			menu.addItem((item) => {
				item
					.setTitle(entry.title)
					.setIcon(entry.kind === "workflow" ? "sparkles" : ASKMATE_ICON_ID)
					.setSection("askmate")
					.onClick(() => {
						// Opening the sidebar moves focus, so the selection is captured before anything else happens.
						this.rememberEditorContext(editor, file);
						if (entry.kind === "workflow") {
							const workflow = this.getAllWorkflows().find((candidate) => candidate.id === entry.workflowId);
							if (workflow) {
								void this.runWorkflowFromCommand(workflow, editor, file);
							}
							return;
						}
						void this.openComposerWithText(entry.kind === "ask-selection" ? "@selection " : "");
					});
			});
		}
	}

	/** Reveals the sidebar and puts the cursor in the composer, optionally with text the user continues typing. */
	async openComposerWithText(text: string): Promise<void> {
		await this.activateView();
		for (const leaf of this.app.workspace.getLeavesOfType(ASKMATE_VIEW_TYPE)) {
			if (leaf.view instanceof AskMateView) {
				leaf.view.focusComposer(text);
			}
		}
	}

	/**
	 * Obsidian keeps the settings tab's definitions until update(), and the Connection rows are built for one chat provider.
	 * A provider chosen elsewhere (the sidebar card, the model switcher, a synced data.json) must rebuild them, or the page
	 * shows and edits the old provider. Not part of refreshOpenAskMateViews, which the tab calls during its own edits.
	 */
	refreshSettingTab(): void {
		this.settingTab?.update();
	}

	refreshOpenAskMateViews(): void {
		for (const leaf of this.app.workspace.getLeavesOfType(ASKMATE_VIEW_TYPE)) {
			if (leaf.view instanceof AskMateView) {
				leaf.view.refreshSettingsSensitiveUi();
			}
		}
	}

	async buildRequest(question: string, title: string, options: ExtendedBuildOptions = {}): Promise<AskRequest> {
		const request = await this.requestRunner.buildRequest(question, title, options);
		this.lastBuiltRequest = request;
		return request;
	}

	/**
	 * What the most recently built request selected through vault mentions.
	 * Legacy accessor: concurrent builds overwrite each other here. Read getContextReport(request) for the request being
	 * shown; this stays only until the sidebar stops calling it.
	 */
	describeLastVaultMentions(): string[] {
		return this.lastBuiltRequest ? this.requestRunner.getContextReport(this.lastBuiltRequest).mentions : [];
	}

	private async recordOperationUsage(params: {
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
		/** True once the request was handed to the provider, so a stopped call can still count toward budgets. */
		sent?: boolean;
	}): Promise<void> {
		await this.usageService.recordOperationUsage(params);
	}

	getTokenUsageRecords(): TokenUsageRecord[] {
		return this.usageService.getTokenUsageRecords();
	}

	getTokenUsageSummary(): TokenUsageSummary {
		return this.usageService.getTokenUsageSummary();
	}

	/** Tokens counted towards today's budget (local calendar day). */
	getTodayTokenUsage(): number {
		return this.usageService.getUsageTotalsByDay()[getLocalDayKey(new Date())] ?? 0;
	}

	/** Tokens counted towards this month's budget (local calendar month). */
	getMonthTokenUsage(): number {
		return sumUsageTotalsForMonth(this.usageService.getUsageTotalsByDay(), getLocalDayKey(new Date()).slice(0, 7));
	}

	async resetTokenUsageStats(): Promise<void> {
		await this.usageService.resetTokenUsageStats();
	}

	/** A notice that stays up while a palette run works, with a button that stops it. */
	private showRunningNotice(label: string): Notice {
		const notice = new Notice(`AskMate is running "${label}"...`, 0);
		const stop = notice.messageEl.createEl("button", { text: "Stop" });
		stop.type = "button";
		stop.addEventListener("click", () => {
			this.commandRuns.stop();
		});
		return notice;
	}

	/** A failure the settings can fix gets a button that opens them, instead of a message that ends in a dead end. */
	private reportCommandError(error: unknown): void {
		const message = this.getErrorMessage(error);
		if (!isAbortError(error) && /\bin AskMate settings\b/i.test(message)) {
			this.notifyWithAction(message, "Open settings", () => {
				this.openSettingsTab();
			}, 15);
			return;
		}
		new Notice(message);
	}

	/** Opens a note the run created, in a new tab, so the person never has to go looking for it. */
	private async openCreatedNote(file: TFile): Promise<void> {
		await this.app.workspace.getLeaf("tab").openFile(file);
	}

	private announceCreatedNote(file: TFile, incompleteReason: string | null): void {
		const message = incompleteReason
			? `AskMate created ${file.path}, but the reply was cut off (${incompleteReason}). Check it before relying on it.`
			: `AskMate created ${file.path}`;
		this.notifyWithAction(message, "Open", () => {
			void this.openCreatedNote(file).catch((error: unknown) => {
				new Notice(this.getErrorMessage(error));
			});
		});
	}

	private async runWorkflowFromCommand(workflow: Workflow, editor: Editor, noteFile: TFile | null): Promise<void> {
		const run = this.commandRuns.begin(workflow.name);
		if (!run) {
			new Notice(`AskMate is already running "${this.commandRuns.current() ?? "a command"}". Wait for it to finish, or stop it first.`);
			return;
		}
		let working: Notice | null = null;
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
			working = this.showRunningNotice(workflow.name);
			const result = await this.runOpenAIRequest(request, { abortSignal: run.signal });

			if (result.kind !== "text") {
				throw new Error(IMAGE_WORKFLOW_MESSAGE);
			}
			if (run.signal.aborted) {
				// Stopped runs write nothing, even when the reply had already arrived.
				throw createAbortError("Request was stopped.");
			}

			// A reply that was cut off is saved with a warning at the top and announced as unfinished.
			const incompleteReason = result.incompleteReason ?? request.metadata.outputIncompleteReason ?? null;
			const resultFile = await this.createResultNote(request, result.text, { model: result.model, incompleteReason });
			working.hide();
			this.announceCreatedNote(resultFile, incompleteReason);
		} catch (error) {
			this.reportCommandError(error);
		} finally {
			working?.hide();
			run.finish();
		}
	}

	private async runImageFromCommand(editor: Editor, noteFile: TFile | null): Promise<void> {
		const run = this.commandRuns.begin("Generate image");
		if (!run) {
			new Notice(`AskMate is already running "${this.commandRuns.current() ?? "a command"}". Wait for it to finish, or stop it first.`);
			return;
		}
		let working: Notice | null = null;
		try {
			const request = await this.buildRequest(DEFAULT_IMAGE_PROMPT, "AskMate Image", {
				editor,
				file: noteFile,
				commandSource: "command_palette",
				outputMode: "note",
				forceImage: true
			});
			await this.confirmUsageGuardrails(request);
			working = this.showRunningNotice("Generate image");
			const result = await this.runOpenAIRequest(request, { forceImage: true, abortSignal: run.signal });

			if (result.kind !== "image") {
				throw new Error(IMAGE_WORKFLOW_MESSAGE);
			}
			if (run.signal.aborted) {
				throw createAbortError("Request was stopped.");
			}

			const { noteFile: resultNote } = await this.createImageResultNote(request, result);
			working.hide();
			this.announceCreatedNote(resultNote, null);
		} catch (error) {
			this.reportCommandError(error);
		} finally {
			working?.hide();
			run.finish();
		}
	}

	private getImageResultFolder(request?: AskRequest, result?: ImageAskMateResult): string {
		const fallbackFolder = cleanFolderPath(this.settings.resultFolder);
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
		// Model output must not add folder levels or "." and ".." segments, and a bad template must never lose the image.
		const rendered = renderTemplate(this.settings.imageFolderTemplate, sanitizePathTemplateValues(variables, MODEL_DERIVED_TEMPLATE_KEYS)).trim();
		const defaultFolder = fallbackFolder ? `${fallbackFolder}/Images` : "AskMate Images";
		try {
			return cleanFolderPath(rendered) || defaultFolder;
		} catch (error) {
			new Notice(`${this.getErrorMessage(error)} AskMate will save the image in ${defaultFolder} instead.`);
			return defaultFolder;
		}
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

	/** Creates any missing folders and returns the folder path as it exists in the vault, which may differ in case. */
	private async ensureFolder(folder: string): Promise<string> {
		const parts = folder.split("/").filter(Boolean);
		let current = "";

		for (const part of parts) {
			if (part.trim() === "." || part.trim() === "..") {
				throw new Error(`AskMate cannot create the folder "${folder}" because it contains a "." or ".." segment.`);
			}
			const wanted = current ? `${current}/${part}` : part;
			const existing = this.findAbstractFileIgnoringCase(wanted);

			if (existing instanceof TFile) {
				throw new Error(`Cannot create folder "${wanted}" because a file already exists there.`);
			}

			if (existing) {
				current = existing.path;
				continue;
			}

			try {
				current = (await this.app.vault.createFolder(wanted)).path;
			} catch (error) {
				// Another note created in the same moment can create the folder first; reuse it in that case.
				const created = this.findAbstractFileIgnoringCase(wanted);
				if (!(created instanceof TFolder)) {
					throw error;
				}
				current = created.path;
			}
		}

		return current;
	}

	private findAbstractFileIgnoringCase(path: string): TAbstractFile | null {
		const exact = this.app.vault.getAbstractFileByPath(path);
		if (exact) {
			return exact;
		}
		const parentPath = getParentPath(path);
		const parent = parentPath ? this.app.vault.getAbstractFileByPath(parentPath) : this.app.vault.getRoot();
		const target = path.toLowerCase();
		return parent instanceof TFolder ? parent.children.find((child) => child.path.toLowerCase() === target) ?? null : null;
	}

	private async createFileWithUniquePath(
		folder: string,
		baseName: string,
		extension: string,
		create: (path: string) => Promise<TFile>
	): Promise<TFile> {
		const stamp = this.formatTimestamp(new Date());
		for (let attempt = 1; attempt <= MAX_UNIQUE_PATH_ATTEMPTS; attempt += 1) {
			const path = buildUniquePathCandidate(folder, baseName, stamp, extension, attempt);
			if (this.findAbstractFileIgnoringCase(path)) {
				continue;
			}
			try {
				return await create(path);
			} catch (error) {
				// Only a path claimed between the check and the create moves on to the next suffix.
				if (!this.findAbstractFileIgnoringCase(path)) {
					throw error;
				}
			}
		}
		throw new Error(`AskMate could not find a free file name for "${baseName}" in ${folder || "the vault root"}.`);
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
		if (isAbortError(error)) {
			return "AskMate request stopped.";
		}

		if (error instanceof Error) {
			return error.message;
		}

		return "AskMate failed because of an unknown error.";
	}
}

export default AskMatePlugin;
