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
	IMAGE_WORKFLOW_MESSAGE,
	ImageAskMateResult,
	ImagePromptPlan,
	appendMarkdownBlockToContent,
	normalizeAskMateSettings,
	createAbortError,
	isAbortError,
	isGpt55Model,
	ModelCapability,
	normalizeApplyApprovalMode,
	normalizeApplyScope,
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
	offsetToEditorPosition,
	OpenAITokenUsage,
	OperationKind,
	OperationStatus,
	PromptInspection,
	ProviderModelRef,
	ProviderSettings,
	ReasoningEffort,
	RequestIntentKind,
	ReviewQueueItem,
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
import { UsageService } from "../usage";
import { HistoryService } from "../history";
import { ContextService, cleanFolderPath } from "../context";
import { RequestRunner } from "../requests";
import {
	buildImagePrompt,
	buildImagePromptPlanningInput,
	buildImagePromptPlanningInstructions,
	buildPrompt,
	buildTextInstructions
} from "../requests/requestBuilders";
import { parseMarkdownHeadingSections, splitMarkdownFrontmatter } from "../output";
import { askMateConfirm, askMateDiffConfirm } from "../ui/modals/modals";
import { AskMateView } from "../ui/sidebar/AskMateView";
import { AskMateSettingTab } from "../ui/settings/AskMateSettingTab";

export class AskMatePlugin extends Plugin {
	settings: AskMateSettings;
	private usageService!: UsageService;
	private historyService!: HistoryService;
	private contextService!: ContextService;
	private requestRunner!: RequestRunner;

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
			expandWorkflowPrompt: (workflow, context, sanitized) => this.expandWorkflowPrompt(workflow, context, sanitized),
			getNoteContext: (editor, file) => this.getNoteContext(editor, file),
			getFileNoteContext: (file) => this.getFileNoteContext(file),
			buildContextAttachments: (context, options, privacy) => this.contextService.buildContextAttachments(context, options, privacy),
			throwIfAborted: (abortSignal) => this.throwIfAborted(abortSignal),
			decodeBase64Image: (base64) => this.decodeBase64Image(base64)
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

		this.addSettingTab(new AskMateSettingTab(this.app, this));
	}

	async loadSettings(): Promise<void> {
		const raw = await this.loadData() as Partial<AskMateSettings> | null;
		this.settings = normalizeAskMateSettings(raw, "load");
	}

	async saveSettings(): Promise<void> {
		this.settings = normalizeAskMateSettings(this.settings, "save");
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
		const provider = this.getProviderSettings(providerId);
		let models: string[];
		try {
			models = await fetchProviderModels(this.getProviderRuntime(), providerId);
		} catch (error) {
			const message = this.getErrorMessage(error);
			if (providerId === "azure-openai" && !message.includes("API key") && !message.includes("base URL")) {
				throw new Error("Azure OpenAI model listing is unavailable for this endpoint. Keep using a manual deployment name.");
			}
			if (providerId === "azure-ai" && !message.includes("API key") && !message.includes("base URL")) {
				throw new Error("Azure AI Foundry model listing is unavailable for this endpoint. Keep using a manual model or deployment name.");
			}
			throw error;
		}

		if (providerId === "azure-openai" || providerId === "azure-ai") {
			if (models.length === 0) {
				throw new Error(`${getProviderLabel(providerId)} did not return model IDs. Keep using a manual model or deployment name.`);
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

			const targetLabel = file?.path ?? "the current note";
			if (!(await askMateConfirm(this.app, `Insert the generated image into "${targetLabel}"?`))) {
				return "Image insert cancelled. No note was changed.";
			}
			const imageFile = await this.saveGeneratedImage(request, result);
			const insertion = `\n\n${this.createImageEmbed(imageFile)}\n`;

			if (request.context.source === "Selected text") {
				editor.replaceRange(insertion, editor.getCursor("to"));
			} else {
				editor.replaceRange(insertion, editor.getCursor());
			}

			this.rememberEditorContext(editor, file ?? null);
			return `Inserted image in ${targetLabel}. Use Obsidian undo immediately if needed.`;
		}

		if (request.context.source === "Selected text") {
			throw new Error("AskMate could not find the original selection to place the image after. Select the text again, then insert the image.");
		}

		const file = request.context.file ?? this.contextService.getLastMarkdownFile();

		if (file?.extension === "md") {
			if (!(await askMateConfirm(this.app, `Insert the generated image into "${file.path}"?`))) {
				return "Image insert cancelled. No note was changed.";
			}
			const imageFile = await this.saveGeneratedImage(request, result);
			const insertion = `\n\n${this.createImageEmbed(imageFile)}\n`;
			const content = await this.app.vault.cachedRead(file);
			await this.app.vault.modify(file, `${content.trimEnd()}${insertion}`);
			this.rememberMarkdownFile(file);
			return `Inserted image in ${file.path}. Use Obsidian undo immediately if needed.`;
		}

		throw new Error("Open a Markdown note before inserting an image.");
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

		const sections = parseMarkdownHeadingSections(content);
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

		const latestContent = targetView ? targetView.editor.getValue() : await this.app.vault.cachedRead(file);
		this.throwIfNoteChangedDuringPreview(content, latestContent, file.path);

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

	private throwIfNoteChangedDuringPreview(expected: string, actual: string, targetLabel: string): void {
		if (expected !== actual) {
			throw new Error(
				`Note "${targetLabel}" changed while the Apply preview was open. AskMate cancelled the write to avoid overwriting concurrent edits. Try Apply again.`
			);
		}
	}

	private async appendResponseToCapturedNote(request: AskRequest, output: string, targetView: MarkdownView | null, file: TFile | null): Promise<string> {
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

			const latest = await this.app.vault.cachedRead(file);
			const next = latest === content ? after : appendMarkdownBlockToContent(latest, output);
			await this.app.vault.modify(file, next);
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
					if (editor.getSelection().trim() !== originalText) {
						throw new Error("Selection changed while the Apply preview was open. Select the text again, then apply.");
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
					const latestValue = editor.getValue();
					const latestOccurrences = findExactOccurrences(latestValue, originalText);
					if (latestOccurrences.length !== 1) {
						throw new Error("Note changed while the Apply preview was open. Select the text again, then apply.");
					}
					const latestStart = latestOccurrences[0];
					editor.replaceRange(
						output,
						offsetToEditorPosition(latestValue, latestStart),
						offsetToEditorPosition(latestValue, latestStart + originalText.length)
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
					const latest = await this.app.vault.cachedRead(file);
					const latestOccurrences = findExactOccurrences(latest, originalText);
					if (latestOccurrences.length !== 1) {
						throw new Error("Note changed while the Apply preview was open. Select the text again, then apply.");
					}
					const latestStart = latestOccurrences[0];
					await this.app.vault.modify(file, `${latest.slice(0, latestStart)}${output}${latest.slice(latestStart + originalText.length)}`);
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

			this.throwIfNoteChangedDuringPreview(before, editor.getValue(), targetLabel);
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

			const latest = await this.app.vault.cachedRead(file);
			this.throwIfNoteChangedDuringPreview(content, latest, file.path);
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



	private async prepareFrontmatterAwareApply(before: string, proposed: string): Promise<FrontmatterApplyResult> {
		const beforeBlock = splitMarkdownFrontmatter(before);
		const proposedBlock = splitMarkdownFrontmatter(proposed);
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
		const instructions = shouldGenerateImage ? buildImagePromptPlanningInstructions() : buildTextInstructions();
		const input = shouldGenerateImage ? buildImagePromptPlanningInput(request) : buildPrompt(request);
		const secondaryInput = shouldGenerateImage ? buildImagePrompt(request) : "";
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
			const start = { line: Math.max(0, source.lineStart - 1), ch: 0 };
			const end = { line: Math.max(0, source.lineEnd - 1), ch: Math.max(0, editor.getLine(Math.max(0, source.lineEnd - 1)).length) };
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
		return await this.historyService.queueReviewItemFromRequest(request, proposedText, model, scope);
	}

	getPendingReviewQueueItems(): ReviewQueueItem[] {
		return this.historyService.getPendingReviewQueueItems();
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
		let previewScope: "selected-text" | "append" | "heading-section" | "full-note" = "full-note";
		if (item.scope === "selected-block") {
			const occurrences = findExactOccurrences(content, item.beforeText);
			if (occurrences.length !== 1) {
				throw new Error("AskMate could not safely find the original queued text in the current note.");
			}
			const start = occurrences[0];
			nextContent = `${content.slice(0, start)}${item.proposedText}${content.slice(start + item.beforeText.length)}`;
			previewScope = "selected-text";
		} else if (item.scope === "append") {
			// Append is non-destructive: recompute against the latest note body.
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
			previewScope = item.scope === "heading-section" ? "heading-section" : "full-note";
		}
		if (!(await this.confirmTextApplyPreview({ scope: previewScope, targetLabel: file.path, before: content, after: nextContent }))) {
			return "Review item apply cancelled. No note was changed.";
		}
		const latest = await this.app.vault.cachedRead(file);
		if (item.scope === "append") {
			nextContent = appendMarkdownBlockToContent(latest, item.proposedText);
		} else if (item.scope === "selected-block") {
			const latestOccurrences = findExactOccurrences(latest, item.beforeText);
			if (latestOccurrences.length !== 1) {
				throw new Error("Note changed while the Apply preview was open. Re-queue or select the text again.");
			}
			const latestStart = latestOccurrences[0];
			nextContent = `${latest.slice(0, latestStart)}${item.proposedText}${latest.slice(latestStart + item.beforeText.length)}`;
		} else {
			this.throwIfNoteChangedDuringPreview(content, latest, file.path);
		}
		await this.app.vault.modify(file, nextContent);
		item.status = "applied";
		item.updatedAt = new Date().toISOString();
		this.settings.reviewQueue = items;
		await this.saveSettings();
		return `Applied queued AskMate change to ${file.path}.`;
	}

	async dismissReviewQueueItem(id: string): Promise<void> {
		await this.historyService.dismissReviewQueueItem(id);
	}

	private getResultNoteFolder(request: AskRequest): string {
		if (this.settings.smartResultPlacementEnabled && request.context.file?.parent?.path) {
			const parentPath = request.context.file.parent.path === "/" ? "" : request.context.file.parent.path;
			return cleanFolderPath(parentPath ? `${parentPath}/AskMate` : "AskMate");
		}
		return cleanFolderPath(this.settings.resultFolder);
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

	async getBatchWorkflowTargetFiles(folderPath: string, maxFiles: number): Promise<TFile[]> {
		return await this.contextService.listMarkdownFilesInFolder(folderPath, maxFiles);
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

		if (ref.providerId === "azure-ai") {
			return hasModel && provider.baseUrl.trim().length > 0 && (await this.getProviderApiKey(ref.providerId)).trim().length > 0;
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


	private registeredCustomWorkflowCommandIds = new Set<string>();

	private registerCustomWorkflowCommands(): void {
		// Obsidian has no removeCommand API; only register each custom id once per session.
		for (const workflow of this.getAllWorkflows()) {
			if (!workflow.isCustom || this.registeredCustomWorkflowCommandIds.has(workflow.commandId)) {
				continue;
			}
			this.registeredCustomWorkflowCommandIds.add(workflow.commandId);
			const workflowId = workflow.id;
			this.addCommand({
				id: workflow.commandId,
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
		const rendered = this.renderTemplate(this.settings.imageFolderTemplate, variables);
		const folder = cleanFolderPath(rendered);
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
