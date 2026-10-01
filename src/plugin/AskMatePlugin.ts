import { Editor, MarkdownView, Notice, Plugin, TAbstractFile, TFile, TFolder, requestUrl } from "obsidian";
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
	CustomWorkflow,
	DEFAULT_IMAGE_PROMPT,
	DEFAULT_IMAGE_RESULT_NOTE_TEMPLATE,
	DEFAULT_PROVIDER_SETTINGS,
	DEFAULT_RESULT_NOTE_TEMPLATE,
	estimateTokenCount,
	EvidenceCitation,
	EvidenceSource,
	findExactOccurrences,
	formatOperationStatus,
	formatOutputMode,
	formatRequestIntent,
	FrontmatterApplyResult,
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
	createAbortError,
	isAbortError,
	isGpt55Model,
	ModelCapability,
	MutationOutcome,
	normalizeApplyApprovalMode,
	normalizeCustomWorkflow,
	normalizeCustomWorkflows,
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
	PromptInspection,
	ProviderModelRef,
	ProviderSettings,
	ReasoningEffort,
	RequestIntentKind,
	RequestPrivacyOptions,
	ReviewQueueItem,
	resolveApplyScope,
	resolveSelectionIdentity,
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
	testProviderConnection as testProviderConnectionWithProvider
} from "../providers";
import type { ProviderRequestOptions, ProviderRuntime } from "../providers";
import { UsageService, getLocalDayKey, sumUsageTotalsForMonth } from "../usage";
import { HistoryService } from "../history";
import { ContextService, cleanFolderPath } from "../context";
import { RequestRunner, buildFallbackImagePrompt } from "../requests";
import {
	APPLY_REFUSAL_PREFIX,
	buildImagePromptPlanningInput,
	buildImagePromptPlanningInstructions,
	buildPrompt,
	buildTextInstructions
} from "../requests/requestBuilders";
import {
	appendWorkflowUserPreferences,
	applyTextInsertion,
	buildUniquePathCandidate,
	getHeadingSectionCore,
	getParentPath,
	isSameNoteText,
	parseMarkdownHeadingSections,
	planResultBacklinkInsertion,
	renderTemplate,
	sanitizeFileName,
	sanitizePathTemplateValues,
	spliceHeadingSectionBody,
	splitMarkdownFrontmatter,
	trimOuterBlankLines
} from "../output";
import { syncObjectInPlace } from "../settings/syncInPlace";
import { shouldGenerateImage } from "../shared/imageIntent";
import { askMateConfirm, askMateDiffConfirm } from "../ui/modals/modals";
import { AskMateView } from "../ui/sidebar/AskMateView";
import { AskMateSettingTab } from "../ui/settings/AskMateSettingTab";

const NOTE_IDENTITY_WITHHELD = "[withheld by AskMate privacy controls]";
const MAX_UNIQUE_PATH_ATTEMPTS = 50;
/** Free-text template values that can contain model output or the user's question. */
const MODEL_DERIVED_TEMPLATE_KEYS = ["title", "request", "response", "imagePrompt", "revisedPrompt", "planningFallback"] as const;

export interface BatchWorkflowRunSummary extends BatchWorkflowSummary {
	/** Why the batch ended before every file was processed, or null when it ran to the end. */
	stoppedReason: string | null;
	failures: { path: string; reason: string }[];
}

export class AskMatePlugin extends Plugin {
	settings!: AskMateSettings;
	private usageService!: UsageService;
	private historyService!: HistoryService;
	private contextService!: ContextService;
	private requestRunner!: RequestRunner;
	private reviewQueueMutationActive = false;
	private settingsSaveChain: Promise<void> = Promise.resolve();
	private viewActivation: Promise<void> | null = null;
	private settingTab: AskMateSettingTab | null = null;
	private batchRunActive = false;

	private getProviderRuntime(): ProviderRuntime {
		return {
			getProviderSettings: (providerId) => this.getProviderSettings(providerId),
			getProviderApiKey: (providerId) => this.getProviderApiKey(providerId),
			requestJson: async <T>(url: string, options?: ProviderRequestOptions) => await this.requestJson<T>(url, options)
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

		this.contextService = new ContextService({
			app: this.app,
			getSettings: () => this.settings,
			getNoteHistoryForPath: (path) => this.getNoteHistoryForPath(path)
		});
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
			getNoteContext: (editor, file) => this.getNoteContext(editor, file),
			getFileNoteContext: (file) => this.getFileNoteContext(file),
			getFullNoteContext: (file) => this.contextService.getFullNoteContext(file),
			buildContextAttachments: (context, options, privacy) => this.contextService.buildContextAttachments(context, options, privacy),
			throwIfAborted: (abortSignal) => this.throwIfAborted(abortSignal)
		});

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
			this.app.vault.on("rename", (file, oldPath) => {
				this.contextService.handleFileRenamed(file, oldPath);
				void this.historyService.handleFileRenamed(oldPath, file.path).catch((error: unknown) => {
					new Notice(`AskMate could not move saved history for ${oldPath}: ${this.getErrorMessage(error)}`);
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
		this.registerCustomWorkflowCommands();

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

		this.settingTab = new AskMateSettingTab(this.app, this);
		this.addSettingTab(this.settingTab);
	}

	onunload(): void {
		// A batch keeps sending paid requests after the plugin is disabled unless it is stopped here.
		this.settingTab?.abortActiveBatch();
	}

	async loadSettings(): Promise<void> {
		const raw = await this.loadData() as Partial<AskMateSettings> | null;
		this.settings = structuredClone(normalizeAskMateSettings(raw, "load"));
	}

	async saveSettings(): Promise<void> {
		// Normalise in place: the settings tab, services and running requests hold nested settings references across awaits.
		const normalized = normalizeAskMateSettings(this.settings, "save");
		syncObjectInPlace(this.settings, normalized);
		// Each write waits for the previous one, so overlapping saves cannot land out of order and persist older settings.
		const save = this.settingsSaveChain.then(async () => await this.saveData(this.settings));
		this.settingsSaveChain = save.catch(() => undefined);
		await save;
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
		return await this.requestRunner.runOpenAIRequest(request, options);
	}

	async streamOpenAI(
		request: AskRequest,
		onDelta: (delta: string) => void,
		abortSignal?: AbortSignal
	): Promise<string> {
		return await this.requestRunner.streamOpenAI(request, onDelta, abortSignal);
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
			resultFolder: cleanFolderPath(this.settings.resultFolder)
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
		const rendered = renderTemplate(this.getWorkflowResultNoteTemplate(request.metadata.workflowId), variables);
		if (rendered.trim()) {
			return `${trimOuterBlankLines(rendered)}\n`;
		}

		return `${trimOuterBlankLines(renderTemplate(DEFAULT_RESULT_NOTE_TEMPLATE, variables))}\n`;
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
		const rendered = renderTemplate(this.settings.imageResultNoteTemplate, variables);
		if (rendered.trim()) {
			return `${trimOuterBlankLines(rendered)}\n`;
		}

		return `${trimOuterBlankLines(renderTemplate(DEFAULT_IMAGE_RESULT_NOTE_TEMPLATE, variables))}\n`;
	}

	async createResultNote(request: AskRequest, responseText: string, options: { model?: string } = {}): Promise<TFile> {
		const folder = await this.ensureFolder(this.getResultNoteFolder(request));
		const baseName = sanitizeFileName(request.title);
		const model = options.model ?? request.metadata.selectedModel;
		const content = this.renderTextResultNoteContent(request, responseText, model);

		const file = await this.createFileWithUniquePath(folder, baseName, "md", async (path) => await this.app.vault.create(path, content));
		await this.maybeAppendResultBacklinkToSource(request, file);
		return file;
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
		const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
		const targetView = request.context.file
			? this.getOpenMarkdownViewForFile(request.context.file)
			: activeView ?? this.getLastOpenMarkdownView();

		if (targetView) {
			const editor = targetView.editor;
			const file = targetView.file ?? request.context.file;
			const identity = request.context.selectionIdentity;
			const initialValue = editor.getValue();
			const resolution = identity ? resolveSelectionIdentity(initialValue, identity) : null;

			if (request.context.source === "Selected text" && (!identity || file?.path !== identity.sourcePath || resolution?.endOffset === null)) {
				throw new Error("AskMate could not safely find the original selection to place the image after. Select the text again, then insert the image.");
			}

			const targetLabel = file?.path ?? "the current note";
			if (!(await askMateConfirm(this.app, `Insert the generated image into "${targetLabel}"?`))) {
				return cancelledMutation("Image insert cancelled. No note was changed.");
			}
			const imageFile = await this.saveGeneratedImage(request, result);
			const insertion = `\n\n${this.createImageEmbed(imageFile)}\n`;
			const latestValue = editor.getValue();
			const latestResolution = identity ? resolveSelectionIdentity(latestValue, identity) : null;

			if (request.context.source === "Selected text") {
				if (latestResolution?.endOffset === null || latestResolution?.endOffset === undefined) {
					return {
						status: "partial",
						message: `Saved image ${imageFile.path}, but the original selection changed before insertion.`,
						targetPath: targetLabel,
						artifactPaths: [imageFile.path]
					};
				}
				editor.replaceRange(insertion, editor.offsetToPos(latestResolution.endOffset));
			} else {
				editor.replaceRange(insertion, editor.getCursor());
			}

			this.rememberEditorContext(editor, file ?? null);
			return appliedMutation(`Inserted image in ${targetLabel}. Use Obsidian undo immediately if needed.`, targetLabel);
		}

		const file = request.context.file ?? this.contextService.getLastMarkdownFile();
		if (request.context.source === "Selected text") {
			const identity = request.context.selectionIdentity;
			if (!file || !identity || identity.sourcePath !== file.path) {
				throw new Error("AskMate could not safely find the original selection to place the image after. Select the text again, then insert the image.");
			}
			const content = await this.app.vault.cachedRead(file);
			const resolution = resolveSelectionIdentity(content, identity);
			if (resolution.endOffset === null) {
				throw new Error("AskMate could not safely find the original selection to place the image after. Select the text again, then insert the image.");
			}
			if (!(await askMateConfirm(this.app, `Insert the generated image into "${file.path}" after the original selection?`))) {
				return cancelledMutation("Image insert cancelled. No note was changed.");
			}
			const imageFile = await this.saveGeneratedImage(request, result);
			const insertion = `\n\n${this.createImageEmbed(imageFile)}\n`;
			// An object flag, because control-flow narrowing does not see assignments made inside the callback.
			const outcome = { inserted: false };
			await this.app.vault.process(file, (latest) => {
				const latestResolution = resolveSelectionIdentity(latest, identity);
				if (latestResolution.endOffset === null) {
					return latest;
				}
				outcome.inserted = true;
				return `${latest.slice(0, latestResolution.endOffset)}${insertion}${latest.slice(latestResolution.endOffset)}`;
			});
			if (!outcome.inserted) {
				return {
					status: "partial",
					message: `Saved image ${imageFile.path}, but the original selection changed before insertion.`,
					targetPath: file.path,
					artifactPaths: [imageFile.path]
				};
			}
			this.rememberMarkdownFile(file);
			return appliedMutation(`Inserted image in ${file.path}. Use Obsidian undo immediately if needed.`, file.path);
		}

		if (file?.extension === "md") {
			if (!(await askMateConfirm(this.app, `Insert the generated image into "${file.path}"?`))) {
				return cancelledMutation("Image insert cancelled. No note was changed.");
			}
			const imageFile = await this.saveGeneratedImage(request, result);
			const insertion = `\n\n${this.createImageEmbed(imageFile)}\n`;
			await this.app.vault.process(file, (content) => `${content.trimEnd()}${insertion}`);
			this.rememberMarkdownFile(file);
			return appliedMutation(`Inserted image in ${file.path}. Use Obsidian undo immediately if needed.`, file.path);
		}

		throw new Error("Open a Markdown note before inserting an image.");
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
		const { before, next: nextContent } = spliceHeadingSectionBody(content, section, output);
		const targetLabel = `${file.path} > ${section.path}`;

		if (!(await this.confirmReplaceScopeRisks(request, "heading-section", targetLabel))) {
			return "Apply cancelled. No note was changed.";
		}

		if (!(await this.confirmTextApplyPreview({
			scope: "heading-section",
			targetLabel,
			before,
			after: output,
			warning: this.describeSectionEditsSinceRequest(request, target, before)
		}))) {
			return "Apply cancelled. No note was changed.";
		}

		if (targetView) {
			assertNoteUnchangedDuringPreview(content, targetView.editor.getValue(), file.path);
			targetView.editor.setValue(nextContent);
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

	private async appendResponseToCapturedNote(output: string, targetView: MarkdownView | null, file: TFile | null): Promise<string> {
		if (targetView) {
			const editor = targetView.editor;
			const targetLabel = file?.path ?? "the current note";
			const before = editor.getValue();
			const after = appendMarkdownBlockToContent(before, output);

			if (!(await this.confirmTextApplyPreview({
				scope: "append",
				targetLabel,
				before,
				after
			}))) {
				return "Apply cancelled. No note was changed.";
			}

			// Recompute against the latest note body so concurrent edits are not clobbered.
			const latest = editor.getValue();
			const next = latest === before ? after : appendMarkdownBlockToContent(latest, output);
			editor.setValue(next);
			this.rememberEditorContext(editor, file);
			return `Appended to ${targetLabel}. Use Obsidian undo or file history immediately if needed.`;
		}

		if (file?.extension === "md") {
			const content = await this.app.vault.cachedRead(file);
			const after = appendMarkdownBlockToContent(content, output);

			if (!(await this.confirmTextApplyPreview({
				scope: "append",
				targetLabel: file.path,
				before: content,
				after
			}))) {
				return "Apply cancelled. No note was changed.";
			}

			await this.app.vault.process(file, (latest) => latest === content ? after : appendMarkdownBlockToContent(latest, output));
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
		const output = responseText.trim();

		if (!output) {
			throw new Error("AskMate has nothing to apply yet.");
		}
		this.assertOutputIsApplicable(output);
		this.assertTargetAcceptsText(request);

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
			if (identity?.sourcePath && file?.path !== identity.sourcePath) {
				throw new Error("The original selected-text note is no longer the Apply target. Select the text again, then apply.");
			}

			if (!originalText) {
				throw new Error("AskMate could not find the original selected text. Select the text again, then apply.");
			}

			this.assertOutputCompleteForReplace(request);
			if (!(await this.confirmReplaceScopeRisks(request, "selected-text", file?.path ?? "the current note"))) {
				return "Apply cancelled. No note was changed.";
			}

			if (targetView) {
				const editor = targetView.editor;
				const selectedText = editor.getSelection().trim();
				const currentValue = editor.getValue();
				const captured = identity ? resolveSelectionIdentity(currentValue, identity) : null;

				if (!identity && selectedText === originalText) {
					if (!(await this.confirmTextApplyPreview({
						scope: "selected-text",
						targetLabel: file?.path ?? "the current note",
						before: originalText,
						after: output
					}))) {
						return "Apply cancelled. No note was changed.";
					}
					if (editor.getSelection().trim() !== originalText) {
						throw new Error("Selection changed while the Apply preview was open. Select the text again, then apply.");
					}
					editor.replaceSelection(output);
					this.rememberEditorContext(editor, file);
					return `Applied to selected text in ${file?.path ?? "the current note"}. Use Obsidian undo immediately if needed.`;
				}

				const value = currentValue;
				const occurrences = identity
					? captured?.startOffset !== null && captured?.startOffset !== undefined ? [captured.startOffset] : []
					: findExactOccurrences(value, originalText);

				if (occurrences.length === 1) {
					if (!(await this.confirmTextApplyPreview({
						scope: "selected-text",
						targetLabel: file?.path ?? "the current note",
						before: originalText,
						after: output
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
						output,
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
						scope: "selected-text",
						targetLabel: file.path,
						before: originalText,
						after: output
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
						return `${latest.slice(0, latestStart)}${output}${latest.slice(latestStart + originalText.length)}`;
					});
					this.rememberMarkdownFile(file);
					return `Applied to selected text in ${file.path}. Use Obsidian undo immediately if needed.`;
				}
			}

			throw new Error("AskMate could not safely find the original selected text. Select the text again, then apply.");
		}

		if (scope === "append") {
			return await this.appendResponseToCapturedNote(output, targetView, file);
		}

		this.assertOutputCompleteForReplace(request);

		if (targetView) {
			const editor = targetView.editor;
			const targetLabel = file?.path ?? "the current note";

			if (!(await this.confirmReplaceScopeRisks(request, "full-note", targetLabel))) {
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
				warning: [this.describeNoteEditsSinceRequest(request, before), prepared.warning].filter(Boolean).join(" ")
			}))) {
				return "Apply cancelled. No note was changed.";
			}

			assertNoteUnchangedDuringPreview(before, editor.getValue(), targetLabel);
			editor.setValue(prepared.text);
			this.rememberEditorContext(editor, file);
			return `Applied to ${targetLabel}. Use Obsidian undo or file history immediately if needed.`;
		}

		if (file?.extension === "md") {
			const content = await this.app.vault.cachedRead(file);
			if (!(await this.confirmReplaceScopeRisks(request, "full-note", file.path))) {
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
				warning: [this.describeNoteEditsSinceRequest(request, content), prepared.warning].filter(Boolean).join(" ")
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

	// A cut-off reply would silently delete the text it failed to reproduce; appending it loses nothing.
	private assertOutputCompleteForReplace(request: AskRequest): void {
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

		// Scopes that normally apply without a prompt still stop when there is a warning, such as edits made after asking.
		if (warning) {
			return await askMateConfirm(this.app, `Apply AskMate output to "${targetLabel}"?\n\nWarning: ${warning}`);
		}

		return true;
	}



	private async prepareFrontmatterAwareApply(before: string, proposed: string): Promise<FrontmatterApplyResult> {
		const beforeBlock = splitMarkdownFrontmatter(before);
		const proposedBlock = splitMarkdownFrontmatter(proposed);
		// An unclosed opening "---" in the reply is body text (often a thematic break), so it is never treated as frontmatter.
		const proposedHasFrontmatter = proposedBlock.exists && !proposedBlock.malformed;
		if (!beforeBlock.exists && !proposedHasFrontmatter) {
			return { text: proposed, warning: "", cancelled: false };
		}
		if (beforeBlock.malformed) {
			const confirmed = await askMateConfirm(this.app, "The existing YAML frontmatter appears malformed. Continue with the AI replacement?");
			return { text: proposed, warning: "Existing YAML frontmatter looked malformed.", cancelled: !confirmed };
		}
		if (this.settings.frontmatterApplyPolicy === "replace") {
			return { text: proposed, warning: proposedHasFrontmatter ? "AskMate will replace YAML frontmatter from the AI output." : "", cancelled: false };
		}
		const sameLineEndings = (text: string): string => text.replace(/\r\n/g, "\n");
		const eol = before.includes("\r\n") ? "\r\n" : "\n";
		const withNoteLineEndings = (text: string): string => text.replace(/\r?\n/g, eol);
		if (this.settings.frontmatterApplyPolicy === "confirm" && sameLineEndings(beforeBlock.frontmatter) !== sameLineEndings(proposedBlock.frontmatter)) {
			const confirmed = await askMateConfirm(this.app, "AskMate output changes YAML frontmatter. Continue with the replacement?");
			return { text: proposed, warning: "YAML frontmatter differs from the original note.", cancelled: !confirmed };
		}
		if (this.settings.frontmatterApplyPolicy === "preserve" && beforeBlock.exists) {
			const body = proposedHasFrontmatter ? proposedBlock.body : proposed;
			return {
				text: `${beforeBlock.frontmatter}${eol}${eol}${withNoteLineEndings(body.trimStart())}`,
				warning: proposedHasFrontmatter ? "AskMate preserved the original YAML frontmatter and removed AI-proposed frontmatter." : "AskMate preserved the original YAML frontmatter.",
				cancelled: false
			};
		}
		if (this.settings.frontmatterApplyPolicy === "preserve" && proposedHasFrontmatter) {
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
		const instructions = shouldGenerateImage ? buildImagePromptPlanningInstructions() : buildTextInstructions();
		const input = shouldGenerateImage ? buildImagePromptPlanningInput(request) : buildPrompt(request);
		// Show the capped fallback exactly as RequestRunner would send it if prompt planning fails.
		const secondaryInput = shouldGenerateImage ? buildFallbackImagePrompt(request) : "";
		// The fallback image prompt is only sent when planning fails, so it is shown but not counted towards the estimate.
		const estimatedInputTokens = estimateTokenCount([instructions, input].filter(Boolean).join("\n\n"));
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
			blockers: guardrails.blockers
		};
	}

	async inspectFinalPrompt(question: string, title: string, options: BuildRequestOptions = {}): Promise<PromptInspection> {
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
		return await this.historyService.queueReviewItemFromRequest(request, proposedText, model, scope);
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
			if (item.scope === "selected-block") {
				const resolution = item.selectionIdentity ? resolveSelectionIdentity(content, item.selectionIdentity) : null;
				if (!resolution || resolution.startOffset === null) {
					throw new Error("AskMate could not safely find the original queued text in the current note.");
				}
				nextContent = `${content.slice(0, resolution.startOffset)}${item.proposedText}${content.slice(resolution.endOffset ?? resolution.startOffset)}`;
				previewScope = "selected-text";
			} else if (item.scope === "append") {
				nextContent = appendMarkdownBlockToContent(content, item.proposedText);
				previewScope = "append";
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
			if (!(await this.confirmTextApplyPreview({ scope: previewScope, targetLabel: file.path, before: content, after: nextContent }))) {
				return "Review item apply cancelled. No note was changed.";
			}
			const currentItem = normalizeReviewQueueItems(this.settings.reviewQueue, this.settings.reviewQueueMaxItems).find((candidate) => candidate.id === id);
			if (currentItem?.status !== "pending") {
				throw new Error("Review queue item changed while the Apply preview was open.");
			}
			const previewedContent = nextContent;
			await this.app.vault.process(file, (latest) => {
				if (item.scope === "append") {
					return appendMarkdownBlockToContent(latest, item.proposedText);
				}
				if (item.scope === "selected-block") {
					const latestResolution = item.selectionIdentity ? resolveSelectionIdentity(latest, item.selectionIdentity) : null;
					if (!latestResolution || latestResolution.startOffset === null) {
						throw new Error("Note changed while the Apply preview was open. Re-queue or select the text again.");
					}
					return `${latest.slice(0, latestResolution.startOffset)}${item.proposedText}${latest.slice(latestResolution.endOffset ?? latestResolution.startOffset)}`;
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
			const parentPath = request.context.file.parent.path === "/" ? "" : request.context.file.parent.path;
			return cleanFolderPath(parentPath ? `${parentPath}/AskMate` : "AskMate");
		}
		return cleanFolderPath(this.settings.resultFolder);
	}

	private async maybeAppendResultBacklinkToSource(request: AskRequest, resultFile: TFile): Promise<void> {
		const sourceFile = request.context.file;
		if (!this.settings.appendResultBacklinkToSource || !sourceFile || sourceFile.path === resultFile.path) {
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
		const files = await this.getBatchWorkflowTargetFiles(options.folderPath, options.maxFiles);
		const summary: BatchWorkflowRunSummary = { total: files.length, completed: 0, failed: 0, createdNotes: [], queuedReviews: 0, stoppedReason: null, failures: [] };
		const report = (currentPath: string, message: string): void => {
			onProgress?.({ total: files.length, completed: summary.completed, failed: summary.failed, currentPath, message });
		};
		const stop = (reason: string): BatchWorkflowRunSummary => {
			summary.stoppedReason = reason;
			report("", `${reason} ${summary.completed} completed, ${summary.failed} failed, ${files.length - summary.completed - summary.failed} not run.`);
			return summary;
		};
		if (files.length > 0 && !(await askMateConfirm(this.app, this.describeBatchRun(workflow, files.length, options, queueScope)))) {
			return stop("Batch cancelled before it started.");
		}
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
			} catch (error) {
				if (isAbortError(error)) {
					return stop("Batch cancelled.");
				}
				const reason = this.getErrorMessage(error);
				summary.failed += 1;
				summary.failures.push({ path: file.path, reason });
				report(file.path, `${file.path}: ${reason}`);
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
			return hasModel && (await this.getProviderApiKey(ref.providerId)).trim().length > 0;
		}

		if (ref.providerId === "azure-ai") {
			return hasModel && provider.baseUrl.trim().length > 0 && (await this.getProviderApiKey(ref.providerId)).trim().length > 0;
		}

		return hasModel && (await this.getProviderApiKey(ref.providerId)).trim().length > 0;
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
			dateTime: now.toISOString()
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

		const capacity = MAX_CUSTOM_WORKFLOWS - this.settings.customWorkflows.length;
		if (capacity <= 0) {
			throw new Error(`AskMate already has the maximum of ${MAX_CUSTOM_WORKFLOWS} custom workflows. Delete some before importing more.`);
		}
		const kept = imported.slice(0, capacity);
		this.settings.customWorkflows = normalizeCustomWorkflows([
			...this.settings.customWorkflows,
			...kept
		]);
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

	refreshOpenAskMateViews(): void {
		for (const leaf of this.app.workspace.getLeavesOfType(ASKMATE_VIEW_TYPE)) {
			if (leaf.view instanceof AskMateView) {
				leaf.view.refreshSettingsSensitiveUi();
			}
		}
	}

	async buildRequest(question: string, title: string, options: BuildRequestOptions = {}): Promise<AskRequest> {
		return await this.requestRunner.buildRequest(question, title, options);
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
