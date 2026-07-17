import { ItemView, MarkdownRenderer, Notice, setIcon, type WorkspaceLeaf } from "obsidian";
import type { AskMatePlugin } from "../../plugin/AskMatePlugin";
import {
	ActiveRun,
	ASKMATE_VIEW_TYPE,
	AskRequest,
	ChatImagePreview,
	ChatMessage,
	ChatRole,
	CONTEXT_BUDGET_OPTIONS,
	ContextBudgetMode,
	DEFAULT_FOLDER_CONTEXT_MAX_FILES,
	DEFAULT_IMAGE_PROMPT,
	DEFAULT_REQUEST_PRIVACY_OPTIONS,
	estimateTokenCount,
	FolderContextOptions,
	formatOperationStatus,
	formatOutputMode,
	getContextBudgetOption,
	IMAGE_FILE_EXTENSIONS,
	IMAGE_WORKFLOW_MESSAGE,
	ImageAskMateResult,
	isAbortError,
	MAX_CONTEXT_IMAGE_PREVIEWS,
	MessageActionOptions,
	MessageElements,
	normalizeBoundedInteger,
	normalizeComposerLayout,
	normalizeContextBudgetMode,
	normalizeContextPathList,
	normalizeRequestPrivacyOptions,
	OutputMode,
	REASONING_EFFORT_OPTIONS,
	RequestIntentKind,
	RequestPrivacyOptions,
	RetryRequestSnapshot,
	RunRequestOptions,
	Workflow
} from "../../shared/core";
import { AskMatePromptInspectorModal, AskMateTextViewerModal, AskMateNoteHistoryModal, askMatePrompt } from "../modals/modals";

export class AskMateView extends ItemView {
	private readonly plugin: AskMatePlugin;
	private messagesEl: HTMLElement;
	private questionEl: HTMLTextAreaElement;
	private contextEl: HTMLButtonElement | null = null;
	private modelEl: HTMLElement | null = null;
	private sendButton: HTMLButtonElement;
	private imageButton: HTMLButtonElement | null = null;
	private stopButton: HTMLButtonElement;
	private clearButton: HTMLButtonElement | null = null;
	private activeRun: ActiveRun | null = null;
	private nextRunId = 0;
	private isClosed = false;
	private messages: ChatMessage[] = [];
	private shouldFollowMessages = true;
	private readonly autoScrollThresholdPx = 48;
	private rootEl: HTMLElement | null = null;
	private outputButtons: Partial<Record<OutputMode, HTMLButtonElement>> = {};
	private workflowButtons: HTMLButtonElement[] = [];
	private reasoningSelectEl: HTMLSelectElement | null = null;
	private reasoningControlEl: HTMLElement | null = null;
	private workflowSectionEl: HTMLElement | null = null;
	private workflowToggleButton: HTMLButtonElement | null = null;
	private workflowsVisible = false;
	private markdownRenderId = 0;
	private readonly markdownRenderTimers = new WeakMap<HTMLElement, number>();
	private readonly pendingMarkdownTimerIds = new Set<number>();
	private requestPreviewEl: HTMLElement | null = null;
	private privacyOptions: RequestPrivacyOptions = DEFAULT_REQUEST_PRIVACY_OPTIONS;
	private contextBudgetMode: ContextBudgetMode = "expanded";
	private requestPreviewRefreshId = 0;
	private additionalContextPaths: string[] = [];
	private folderContextEnabled = false;
	private folderContextPath = "";
	private folderContextMaxFiles = DEFAULT_FOLDER_CONTEXT_MAX_FILES;

	constructor(leaf: WorkspaceLeaf, plugin: AskMatePlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return ASKMATE_VIEW_TYPE;
	}

	getDisplayText(): string {
		return "AskMate";
	}

	getIcon(): string {
		return "bot";
	}

	async onOpen(): Promise<void> {
		const container = this.containerEl.children[1] as HTMLElement;
		container.empty();
		container.addClass("askmate-sidebar");
		this.rootEl = container;
		this.applyComposerLayoutClass();
		this.isClosed = false;
		this.activeRun = null;
		// Keep DOM and logical transcript aligned: reopening rebuilds an empty message pane.
		this.messages = [];
		this.outputButtons = {};
		this.workflowButtons = [];
		this.modelEl = null;
		this.contextEl = null;
		this.imageButton = null;
		this.clearButton = null;
		this.reasoningSelectEl = null;
		this.reasoningControlEl = null;
		this.workflowSectionEl = null;
		this.workflowToggleButton = null;
		this.requestPreviewEl = null;
		this.privacyOptions = normalizeRequestPrivacyOptions(this.plugin.settings.requestPrivacyDefaults);
		this.contextBudgetMode = normalizeContextBudgetMode(this.plugin.settings.contextBudgetMode);
		this.additionalContextPaths = [...this.plugin.settings.additionalContextPaths];
		this.folderContextEnabled = this.plugin.settings.folderContextEnabled;
		this.folderContextPath = this.plugin.settings.folderContextPath;
		this.folderContextMaxFiles = this.plugin.settings.folderContextMaxFiles;
		this.workflowsVisible = false;

		this.plugin.rememberActiveMarkdownContext();

		this.messagesEl = container.createDiv({ cls: "askmate-messages" });
		this.shouldFollowMessages = true;
		this.registerDomEvent(this.messagesEl, "scroll", () => {
			this.shouldFollowMessages = this.isScrolledNearBottom();
		});
		this.renderOnboardingTips();

		this.renderWorkflowGrid(container);
		this.renderComposer(container);

		const refreshContext = (): void => {
			this.plugin.rememberActiveMarkdownContext();
			this.refreshReasoningSelector();
			this.updateModelLabel();
			void this.updateContextLabel();
			void this.refreshRequestPreview();
		};

		this.registerDomEvent(container, "pointerdown", refreshContext);
		this.registerDomEvent(container, "focusin", refreshContext);

		this.registerEvent(
			this.app.workspace.on("active-leaf-change", refreshContext)
		);
	}

	private renderWorkflowGrid(container: HTMLElement): void {
		const section = container.createDiv({ cls: "askmate-workflow-section is-collapsed" });
		section.setAttribute("aria-hidden", "true");
		this.workflowSectionEl = section;
		this.populateWorkflowGrid(section);
	}

	refreshWorkflowGrid(): void {
		if (!this.workflowSectionEl) {
			return;
		}

		this.workflowSectionEl.empty();
		this.workflowButtons = [];
		this.populateWorkflowGrid(this.workflowSectionEl);
	}

	refreshSettingsSensitiveUi(): void {
		this.applyComposerLayoutClass();
		this.renderOnboardingTips();
		this.refreshWorkflowGrid();
	}

	private applyComposerLayoutClass(): void {
		if (!this.rootEl) {
			return;
		}

		const layout = normalizeComposerLayout(this.plugin.settings.composerLayout);
		this.rootEl.classList.toggle("askmate-composer-layout-compact", layout === "compact");
		this.rootEl.classList.toggle("askmate-composer-layout-expanded", layout === "expanded");
	}

	private renderOnboardingTips(): void {
		if (!this.plugin.settings.showOnboardingTips || this.plugin.settings.onboardingTipsDismissedAt) {
			this.rootEl?.querySelectorAll(".askmate-onboarding-message").forEach((element) => element.remove());
			return;
		}
		if (this.rootEl?.querySelector(".askmate-onboarding-message")) {
			return;
		}

		const message = this.createMessageEl("system", "", false);
		message.wrapper.addClass("askmate-onboarding-message");
		message.body.empty();
		const card = message.body.createDiv({ cls: "askmate-onboarding-card" });
		card.createEl("strong", { text: "AskMate! tips" });
		card.createEl("p", {
			text: "Ask about the open note, use /image for generated images, choose quick workflows, or switch output to Note or Apply before sending."
		});
		const dismiss = card.createEl("button", { text: "Dismiss tips" });
		dismiss.type = "button";
		dismiss.addEventListener("click", () => {
			void (async () => {
				this.plugin.settings.onboardingTipsDismissedAt = new Date().toISOString();
				await this.plugin.saveSettings();
				message.wrapper.remove();
			})().catch((error) => new Notice(this.plugin.getErrorMessage(error)));
		});
	}

	private populateWorkflowGrid(section: HTMLElement): void {
		const heading = section.createDiv({ cls: "askmate-section-heading" });
		const workflows = this.plugin.getVisibleWorkflows();
		heading.createSpan({ text: "Quick workflows" });
		heading.createSpan({ cls: "askmate-section-count", text: `${workflows.length} modes` });

		const grid = section.createDiv({ cls: "askmate-workflow-grid" });

		for (const workflow of workflows) {
			const preference = this.plugin.getWorkflowDisplayPreference(workflow.id);
			const button = grid.createEl("button", {
				cls: `askmate-workflow-card askmate-accent-${workflow.accent}`
			});
			button.type = "button";
			button.setAttribute("title", workflow.name);
			button.setAttribute("aria-label", `${workflow.name}: ${workflow.description}`);
			this.workflowButtons.push(button);
			this.addIcon(button, workflow.icon, "askmate-workflow-icon");

			const copy = button.createDiv({ cls: "askmate-workflow-copy" });
			copy.createDiv({ cls: "askmate-workflow-name", text: `${preference?.favorite ? "★ " : ""}${workflow.shortName}` });
			copy.createDiv({ cls: "askmate-workflow-desc", text: workflow.description });

			button.addEventListener("click", () => {
				if (!this.ensureIdleForNewRequest()) {
					return;
				}

				this.setWorkflowPanelVisible(false);
				void this.runWorkflow(workflow);
			});
		}
	}

	private getSendShortcutLabel(): string {
		return this.plugin.settings.sendShortcut === "ctrl-enter" ? "Ctrl/Cmd+Enter" : "Enter";
	}

	private getComposerPlaceholder(): string {
		const shortcut = this.plugin.settings.sendShortcut;
		const suffix = shortcut === "ctrl-enter" ? "Ctrl/Cmd+Enter to send." : "Enter to send, Shift+Enter for newline.";
		return `Ask about the note, use /image, or choose a workflow... ${suffix}`;
	}

	private shouldSubmitFromKeydown(event: KeyboardEvent): boolean {
		if (event.key !== "Enter" || event.isComposing) {
			return false;
		}

		if (this.plugin.settings.sendShortcut === "ctrl-enter") {
			return event.metaKey || event.ctrlKey;
		}

		return !event.shiftKey;
	}

	private renderComposer(container: HTMLElement): void {
		const composer = container.createDiv({ cls: "askmate-composer" });
		const header = composer.createDiv({ cls: "askmate-composer-header" });
		const headerLeft = header.createDiv({ cls: "askmate-composer-header-left" });
		const brand = headerLeft.createDiv({ cls: "askmate-composer-brand", text: "AskMate!" });
		void this.plugin.isSelectedProviderConfigured().then((isReady) => {
			brand.classList.toggle("is-api-key-set", isReady);
			brand.setAttribute("title", isReady ? "AskMate is ready" : "Configure the selected AskMate provider in settings");
		});
		this.contextEl = this.createActionButton(headerLeft, "file-text", "Show selected note", "askmate-context-button");
		this.contextEl.addEventListener("click", () => {
			void this.showContextNotice();
		});
		const historyButton = this.createActionButton(headerLeft, "history", "Show note AskMate history", "askmate-history-button");
		historyButton.addEventListener("click", () => {
			void this.showNoteHistory();
		});
		void this.updateContextLabel();
		this.modelEl = header.createDiv({ cls: "askmate-model-chip askmate-composer-model" });
		this.updateModelLabel();

		const inputShell = composer.createDiv({ cls: "askmate-input-shell" });
		this.questionEl = inputShell.createEl("textarea", {
			cls: "askmate-question",
			attr: {
				placeholder: this.getComposerPlaceholder(),
				rows: "4"
			}
		});
		this.questionEl.addEventListener("keydown", (event) => {
			if (!this.shouldSubmitFromKeydown(event)) {
				return;
			}

			event.preventDefault();
			void this.submitQuestion();
		});
		this.questionEl.addEventListener("input", () => {
			void this.refreshRequestPreview();
		});

		this.sendButton = this.createActionButton(inputShell, "send", `Send (${this.getSendShortcutLabel()})`, "askmate-send-button mod-cta");
		this.sendButton.addEventListener("click", () => {
			void this.submitQuestion();
		});

		this.renderRequestPreview(composer);

		const footer = composer.createDiv({ cls: "askmate-composer-footer" });
		const actions = footer.createDiv({ cls: "askmate-actions" });
		const imageButton = this.createActionButton(actions, "image-plus", "Image", "askmate-image-button");
		this.imageButton = imageButton;
		imageButton.addEventListener("click", () => {
			void this.submitImageQuestion();
		});

		this.stopButton = this.createActionButton(actions, "square", "Stop", "askmate-stop-button");
		this.stopButton.disabled = true;
		this.stopButton.hidden = true;
		this.stopButton.setAttribute("aria-hidden", "true");
		this.stopButton.setAttribute("aria-label", "Stop request");
		this.stopButton.setAttribute("title", "Stop request");
		this.stopButton.addEventListener("click", () => {
			this.stopActiveRun();
		});

		const clearButton = this.createActionButton(actions, "trash-2", "Clear", "askmate-clear-button");
		this.clearButton = clearButton;
		clearButton.addEventListener("click", () => {
			if (this.activeRun) {
				new Notice("Stop the current request before clearing chat.");
				return;
			}

			this.messages = [];
			this.messagesEl.empty();
			this.shouldFollowMessages = true;
			this.addMessage("system", "Chat cleared.");
		});

		this.renderOutputToggle(footer);
	}

	private renderRequestPreview(parent: HTMLElement): void {
		if (!this.plugin.settings.showRequestPreview) {
			return;
		}

		const preview = parent.createDiv({ cls: "askmate-request-preview" });
		this.requestPreviewEl = preview;
		preview.createDiv({ cls: "askmate-request-preview-summary", text: "Request preview loading..." });
		const controls = preview.createDiv({ cls: "askmate-request-preview-controls" });
		this.createPrivacyToggle(controls, "includeNoteContext", "Send note context");
		this.createPrivacyToggle(controls, "includeImageReferences", "Send image references");
		this.createContextBudgetSelector(controls);
		const inspectButton = controls.createEl("button", { cls: "askmate-request-preview-button", text: "Inspect prompt" });
		inspectButton.type = "button";
		inspectButton.setAttribute("data-askmate-preview-control", "true");
		inspectButton.addEventListener("click", () => {
			void this.openPromptInspector();
		});
		this.createExtraContextControls(preview);
		void this.refreshRequestPreview();
	}

	private createPrivacyToggle(parent: HTMLElement, key: keyof RequestPrivacyOptions, label: string): void {
		const wrapper = parent.createEl("label", { cls: "askmate-request-preview-toggle" });
		const input = wrapper.createEl("input", {
			attr: {
				type: "checkbox",
				"data-askmate-preview-control": "true"
			}
		});
		input.checked = this.privacyOptions[key];
		input.addEventListener("change", () => {
			this.privacyOptions = {
				...this.privacyOptions,
				[key]: input.checked
			};
			void this.refreshRequestPreview();
		});
		wrapper.createSpan({ text: label });
	}

	private createContextBudgetSelector(parent: HTMLElement): void {
		const wrapper = parent.createEl("label", { cls: "askmate-request-preview-toggle" });
		wrapper.createSpan({ text: "Context" });
		const select = wrapper.createEl("select", {
			cls: "askmate-request-preview-select",
			attr: {
				"data-askmate-preview-control": "true",
				"aria-label": "Context budget"
			}
		});

		for (const option of CONTEXT_BUDGET_OPTIONS) {
			select.createEl("option", {
				attr: { value: option.value },
				text: option.label
			});
		}

		select.value = this.contextBudgetMode;
		select.addEventListener("change", () => {
			this.contextBudgetMode = normalizeContextBudgetMode(select.value);
			void this.refreshRequestPreview();
		});
	}

	private createExtraContextControls(parent: HTMLElement): void {
		const details = parent.createEl("details", { cls: "askmate-extra-context-controls" });
		details.createEl("summary", { text: "Extra context" });
		const body = details.createDiv({ cls: "askmate-extra-context-body" });
		body.createEl("label", { text: "Additional note paths, one per line" });
		const notes = body.createEl("textarea", {
			cls: "askmate-extra-context-textarea",
			attr: {
				rows: "3",
				"data-askmate-preview-control": "true"
			}
		});
		notes.value = this.additionalContextPaths.join("\n");
		notes.addEventListener("input", () => {
			this.additionalContextPaths = normalizeContextPathList(notes.value);
			void this.refreshRequestPreview();
		});

		const folderLabel = body.createEl("label", { cls: "askmate-extra-context-inline" });
		const folderToggle = folderLabel.createEl("input", {
			attr: {
				type: "checkbox",
				"data-askmate-preview-control": "true"
			}
		});
		folderToggle.checked = this.folderContextEnabled;
		folderLabel.createSpan({ text: "Include folder context" });
		folderToggle.addEventListener("change", () => {
			this.folderContextEnabled = folderToggle.checked;
			void this.refreshRequestPreview();
		});

		const folderInput = body.createEl("input", {
			cls: "askmate-extra-context-input",
			attr: {
				type: "text",
				placeholder: "Folder path",
				"data-askmate-preview-control": "true"
			}
		});
		folderInput.value = this.folderContextPath;
		folderInput.addEventListener("input", () => {
			this.folderContextPath = folderInput.value.trim();
			void this.refreshRequestPreview();
		});

		const maxFiles = body.createEl("input", {
			cls: "askmate-extra-context-number",
			attr: {
				type: "number",
				min: "1",
				max: "100",
				"data-askmate-preview-control": "true",
				"aria-label": "Folder context max files"
			}
		});
		maxFiles.value = String(this.folderContextMaxFiles);
		maxFiles.addEventListener("input", () => {
			this.folderContextMaxFiles = normalizeBoundedInteger(maxFiles.value, DEFAULT_FOLDER_CONTEXT_MAX_FILES, 1, 100);
			void this.refreshRequestPreview();
		});
	}

	private async refreshRequestPreview(): Promise<void> {
		if (!this.requestPreviewEl) {
			return;
		}

		const refreshId = ++this.requestPreviewRefreshId;
		const summary = this.requestPreviewEl.querySelector<HTMLElement>(".askmate-request-preview-summary");

		if (!summary) {
			return;
		}

		try {
			const context = await this.plugin.getNoteContext();
			if (refreshId !== this.requestPreviewRefreshId || !this.requestPreviewEl) {
				return;
			}

			const provider = this.plugin.getSelectedProviderModelRef();
			const source = context.file?.path ?? "unsaved note";
			const budget = getContextBudgetOption(this.contextBudgetMode);
			const promptCharacters = this.privacyOptions.includeNoteContext
				? budget.maxCharacters === null ? context.content.length : Math.min(context.content.length, budget.maxCharacters)
				: 0;
			const budgetLabel = `${budget.label}${budget.maxCharacters !== null && context.content.length > budget.maxCharacters ? `, sends ${promptCharacters.toLocaleString()} of ${context.content.length.toLocaleString()} chars` : ""}`;
			const tokenEstimate = estimateTokenCount(this.privacyOptions.includeNoteContext ? context.content.slice(0, promptCharacters) : "");
			const extras = [
				this.plugin.settings.threadedChatEnabled ? `thread ${this.plugin.settings.threadedChatMaxTurns} turns` : "",
				this.plugin.settings.noteHistoryIncludeInContext ? "note history" : "",
				this.additionalContextPaths.length > 0 ? `${this.additionalContextPaths.length} extra notes` : "",
				this.folderContextEnabled && this.folderContextPath ? `folder ${this.folderContextMaxFiles} files` : "",
				this.plugin.settings.includeStyleGuideContext ? "style guide" : "",
				this.plugin.settings.includeGlossaryContext ? "glossary" : "",
				this.plugin.settings.includeExcalidrawSummaries ? "Excalidraw summaries" : "",
				this.plugin.settings.includeImageManifests && this.privacyOptions.includeImageReferences ? "image manifest" : ""
			].filter(Boolean).join(", ");
			const previewParts = [
				`${context.source}: ${source}`,
				`Primary: ${promptCharacters.toLocaleString()} chars, about ${tokenEstimate.toLocaleString()} tokens`,
				`Context: ${budgetLabel}`,
				extras ? `Extra: ${extras}` : "",
				`${provider.providerName}: ${provider.model}`,
				formatOutputMode(this.plugin.settings.outputMode)
			];
			if (this.plugin.settings.usageGuardrailsEnabled && this.plugin.settings.usagePerRequestWarningTokens > 0 && tokenEstimate >= this.plugin.settings.usagePerRequestWarningTokens) {
				previewParts.push(`Budget warning: about ${tokenEstimate.toLocaleString()} tokens`);
			}
			summary.setText(previewParts.filter(Boolean).join(" · "));
		} catch {
			if (refreshId === this.requestPreviewRefreshId) {
				summary.setText("Open a Markdown note or select text before sending.");
			}
		}
	}

	private renderOutputToggle(parent: HTMLElement): void {
		const shell = parent.createDiv({ cls: "askmate-output-shell" });
		shell.setAttribute("role", "group");
		shell.setAttribute("aria-label", "AskMate composer controls");
		const controls = shell.createDiv({ cls: "askmate-output-controls" });
		this.workflowToggleButton = controls.createEl("button", { cls: "askmate-workflow-toggle" });
		this.workflowToggleButton.type = "button";
		this.workflowToggleButton.setAttribute("title", "Show quick workflows");
		this.workflowToggleButton.setAttribute("aria-label", "Show quick workflows");
		this.workflowToggleButton.setAttribute("aria-expanded", "false");
		this.workflowToggleButton.setAttribute("aria-pressed", "false");
		this.addIcon(this.workflowToggleButton, "sparkles", "askmate-segment-icon");
		this.workflowToggleButton.addEventListener("click", () => {
			if (this.activeRun) {
				new Notice("Wait for the current AskMate request to finish, or stop it first.");
				return;
			}

			this.setWorkflowPanelVisible(!this.workflowsVisible);
		});
		this.refreshWorkflowToggle();

		const toggle = controls.createDiv({ cls: "askmate-output-toggle" });
		toggle.setAttribute("role", "group");
		toggle.setAttribute("aria-label", "AskMate output mode");

		const modes: Array<{ mode: OutputMode; icon: string; title: string; ariaLabel: string }> = [
			{
				mode: "chat",
				icon: "message-circle",
				title: "Show the answer in this chat",
				ariaLabel: "Show answer in sidebar chat"
			},
			{
				mode: "note",
				icon: "file-plus",
				title: "Create a new note from the answer",
				ariaLabel: "Create a new note from the answer"
			},
			{
				mode: "apply",
				icon: "pencil",
				title: "Apply response, replaces selected text or appends to the captured note",
				ariaLabel: "Apply response to the captured note"
			}
		];

		for (const option of modes) {
			const button = toggle.createEl("button", { cls: "askmate-segment" });
			button.type = "button";
			button.setAttribute("title", option.title);
			button.setAttribute("aria-label", option.ariaLabel);
			this.addIcon(button, option.icon, "askmate-segment-icon");
			button.addEventListener("click", () => {
				void this.selectOutputMode(option.mode);
			});
			this.outputButtons[option.mode] = button;
		}

		this.renderReasoningSelector(controls);
		this.refreshOutputToggle();
	}

	private async selectOutputMode(mode: OutputMode): Promise<void> {
		if (this.activeRun) {
			new Notice("Wait for the current AskMate request to finish, or stop it first.");
			this.refreshOutputToggle();
			return;
		}

		if (this.plugin.settings.outputMode === mode) {
			return;
		}

		this.plugin.settings.outputMode = mode;
		this.refreshOutputToggle();
		void this.refreshRequestPreview();
		await this.plugin.saveSettings();
	}

	private refreshOutputToggle(): void {
		for (const [mode, button] of Object.entries(this.outputButtons) as Array<[OutputMode, HTMLButtonElement]>) {
			const isActive = this.plugin.settings.outputMode === mode;
			button.classList.toggle("is-active", isActive);
			button.setAttribute("aria-pressed", String(isActive));
		}
	}

	private renderReasoningSelector(parent: HTMLElement): void {
		const shell = parent.createDiv({ cls: "askmate-reasoning-shell askmate-icon-select-control" });
		this.addIcon(shell, "brain", "askmate-reasoning-icon");

		const select = shell.createEl("select", { cls: "askmate-reasoning-select" });
		select.setAttribute("aria-label", "OpenAI reasoning effort");
		select.setAttribute("title", "Higher reasoning effort can be slower or use more tokens.");

		for (const option of REASONING_EFFORT_OPTIONS) {
			select.createEl("option", {
				attr: {
					title: option.description,
					value: option.value
				},
				text: option.label
			});
		}

		select.addEventListener("change", () => {
			void this.selectReasoningEffort(select.value);
		});

		this.reasoningControlEl = shell;
		this.reasoningSelectEl = select;
		this.refreshReasoningSelector();
	}

	private async selectReasoningEffort(value: unknown): Promise<void> {
		if (this.activeRun) {
			new Notice("Wait for the current AskMate request to finish, or stop it first.");
			this.refreshReasoningSelector();
			return;
		}

		await this.plugin.setReasoningEffort(value);
		this.refreshReasoningSelector();
		this.updateModelLabel();
	}

	private refreshReasoningSelector(): void {
		if (!this.reasoningSelectEl) {
			return;
		}

		const supportsReasoning = this.plugin.supportsSelectedReasoningEffort();
		const selectedValue = this.plugin.getSelectedReasoningEffort();
		const selectedOption = REASONING_EFFORT_OPTIONS.find((option) => option.value === selectedValue);
		const selectedLabel = selectedOption?.label ?? selectedValue;
		const isLoading = Boolean(this.activeRun);
		const title = isLoading
			? "Reasoning effort is locked while AskMate is working."
			: !supportsReasoning
				? "Reasoning effort applies to OpenAI GPT-5.5 text models."
				: `Reasoning effort: ${selectedLabel}. Higher reasoning effort can be slower or use more tokens.`;

		this.reasoningSelectEl.value = selectedValue;
		this.reasoningSelectEl.disabled = !supportsReasoning || isLoading;
		this.reasoningSelectEl.setAttribute("title", title);
		this.reasoningSelectEl.setAttribute(
			"aria-label",
			!supportsReasoning
				? `Reasoning effort disabled for this provider or model. Current effort: ${selectedLabel}`
				: `OpenAI reasoning effort: ${selectedLabel}`
		);
		this.reasoningControlEl?.classList.toggle("is-disabled", !supportsReasoning || isLoading);
		this.reasoningControlEl?.setAttribute("title", title);
		this.reasoningControlEl?.setAttribute("aria-disabled", String(!supportsReasoning || isLoading));
	}

	private setWorkflowPanelVisible(isVisible: boolean): void {
		this.workflowsVisible = isVisible;
		this.workflowSectionEl?.classList.toggle("is-collapsed", !isVisible);
		this.workflowSectionEl?.setAttribute("aria-hidden", String(!isVisible));
		this.refreshWorkflowToggle();
	}

	private refreshWorkflowToggle(): void {
		if (!this.workflowToggleButton) {
			return;
		}

		this.workflowToggleButton.classList.toggle("is-active", this.workflowsVisible);
		this.workflowToggleButton.setAttribute("aria-expanded", String(this.workflowsVisible));
		this.workflowToggleButton.setAttribute("aria-pressed", String(this.workflowsVisible));
		this.workflowToggleButton.setAttribute(
			"title",
			this.workflowsVisible ? "Hide quick workflows" : "Show quick workflows"
		);
		this.workflowToggleButton.setAttribute(
			"aria-label",
			this.workflowsVisible ? "Hide quick workflows" : "Show quick workflows"
		);
	}

	private createActionButton(
		parent: HTMLElement,
		icon: string,
		label: string,
		className: string
	): HTMLButtonElement {
		const button = parent.createEl("button", {
			cls: `askmate-action-button ${className}`
		});
		button.type = "button";
		button.setAttribute("aria-label", label);
		button.setAttribute("title", label);
		this.addIcon(button, icon, "askmate-action-icon");
		button.createSpan({ cls: "askmate-action-label askmate-visually-hidden", text: label });
		return button;
	}

	private addIcon(parent: HTMLElement, icon: string, className: string): HTMLElement {
		const iconEl = parent.createSpan({ cls: className });
		iconEl.setAttribute("aria-hidden", "true");
		setIcon(iconEl, icon);
		return iconEl;
	}

	async onClose(): Promise<void> {
		this.isClosed = true;
		this.stopActiveRun();
		this.activeRun = null;
		this.messages = [];
		for (const timer of this.pendingMarkdownTimerIds) {
			window.clearTimeout(timer);
		}
		this.pendingMarkdownTimerIds.clear();
		this.containerEl.empty();
	}

	private ensureIdleForNewRequest(): boolean {
		if (!this.activeRun) {
			return true;
		}

		new Notice("AskMate is already working. Stop the current request before starting another.");
		return false;
	}

	private beginRun(intentKind: RequestIntentKind): ActiveRun | null {
		if (!this.ensureIdleForNewRequest()) {
			return null;
		}

		const run: ActiveRun = {
			id: ++this.nextRunId,
			abortController: new AbortController(),
			intentKind,
			startedAt: new Date().toISOString()
		};

		this.activeRun = run;
		this.setLoading(true);
		return run;
	}

	private isRunActive(run: ActiveRun): boolean {
		return !this.isClosed && this.activeRun?.id === run.id;
	}

	private stopActiveRun(): void {
		this.activeRun?.abortController.abort();
	}

	private finishRun(run: ActiveRun): void {
		if (!this.isRunActive(run)) {
			return;
		}

		this.activeRun = null;
		this.setLoading(false);
	}

	private async submitQuestion(): Promise<void> {
		if (!this.ensureIdleForNewRequest()) {
			return;
		}

		const rawQuestion = this.questionEl.value.trim();

		if (!rawQuestion) {
			new Notice("Type a question first.");
			return;
		}

		const command = this.parseComposerCommand(rawQuestion);
		this.questionEl.value = "";
		await this.runRequest(command.question, command.forceImage ? "AskMate Image" : "AskMate Answer", {
			forceImage: command.forceImage
		});
	}

	private async submitImageQuestion(): Promise<void> {
		if (!this.ensureIdleForNewRequest()) {
			return;
		}

		const question = this.questionEl.value.trim() || DEFAULT_IMAGE_PROMPT;
		this.questionEl.value = "";
		await this.runRequest(question, "AskMate Image", { forceImage: true });
	}

	private parseComposerCommand(value: string): { question: string; forceImage: boolean } {
		const imageMatch = value.match(/^\/(?:image|img)\b\s*/i);

		if (imageMatch) {
			return {
				question: value.slice(imageMatch[0].length).trim() || DEFAULT_IMAGE_PROMPT,
				forceImage: true
			};
		}

		return {
			question: value,
			forceImage: false
		};
	}

	private getFolderContextOptions(): FolderContextOptions {
		return {
			enabled: this.folderContextEnabled,
			path: this.folderContextPath,
			maxFiles: this.folderContextMaxFiles,
			maxCharacters: this.plugin.settings.folderContextMaxCharacters
		};
	}

	private getThreadMessagesForNextRequest(): ChatMessage[] {
		if (!this.plugin.settings.threadedChatEnabled) {
			return [];
		}

		return this.messages
			.filter((message) => (message.role === "user" || message.role === "assistant") && message.text.trim())
			.slice(-(this.plugin.settings.threadedChatMaxTurns * 2));
	}

	private async runWorkflow(workflow: Workflow): Promise<void> {
		if (!this.ensureIdleForNewRequest()) {
			return;
		}

		if (this.plugin.getSelectedProviderModelRef().capability !== "text") {
			new Notice(IMAGE_WORKFLOW_MESSAGE);
			return;
		}

		await this.runRequest(this.plugin.getWorkflowPrompt(workflow), workflow.name, { workflow });
	}

	private async runRequest(
		question: string,
		title: string,
		options: RunRequestOptions = {}
	): Promise<void> {
		const intentKind = this.plugin.classifyRequestIntent(question, options);
		const willGenerateImage = intentKind === "explicit_image" || intentKind === "auto_image" || this.plugin.getSelectedProviderModelRef().capability === "image";
		const threadMessages = this.getThreadMessagesForNextRequest();
		const run = this.beginRun(intentKind);

		if (!run) {
			return;
		}

		void this.updateContextLabel();
		this.shouldFollowMessages = true;
		const requestTitle = title === "AskMate Answer" && willGenerateImage ? "AskMate Image" : title;
		const isUserPrompt = requestTitle === "AskMate Answer" || requestTitle === "AskMate Image";
		const displayedQuestion = isUserPrompt ? question : requestTitle;
		this.addMessage("user", displayedQuestion, isUserPrompt ? question : undefined);
		let assistantMessage: MessageElements | null = null;
		let responseText = "";
		let outputSideEffectStarted = false;
		const retrySnapshot: RetryRequestSnapshot = {
			question,
			title: requestTitle,
			options: {
				...options,
					outputMode: options.outputMode ?? this.plugin.settings.outputMode,
					privacy: options.privacy ?? this.privacyOptions,
					contextBudgetMode: options.contextBudgetMode ?? this.contextBudgetMode,
					additionalContextPaths: options.additionalContextPaths ?? this.additionalContextPaths,
					folderContext: options.folderContext ?? this.getFolderContextOptions(),
					threadMessages,
					includeThreadHistory: options.includeThreadHistory ?? this.plugin.settings.threadedChatEnabled
				},
				createdAt: new Date().toISOString()
			};

		try {
			const request = await this.plugin.buildRequest(question, requestTitle, {
				...options,
				intentKind,
				outputMode: options.outputMode ?? this.plugin.settings.outputMode,
				privacy: options.privacy ?? this.privacyOptions,
				contextBudgetMode: options.contextBudgetMode ?? this.contextBudgetMode,
				additionalContextPaths: options.additionalContextPaths ?? this.additionalContextPaths,
				folderContext: options.folderContext ?? this.getFolderContextOptions(),
				threadMessages,
				includeThreadHistory: options.includeThreadHistory ?? this.plugin.settings.threadedChatEnabled
			});

			if (!this.isRunActive(run)) {
				return;
			}

			await this.plugin.confirmUsageGuardrails(request);

			if (!this.isRunActive(run)) {
				return;
			}

			const shouldGenerateImage = request.metadata.forceImage
				|| request.metadata.autoImage
				|| request.metadata.modelCapability === "image";
			const sourcePath = request.context.file?.path ?? "";
			if (request.metadata.privacy.includeImageReferences && this.shouldShowContextImagePreviews(question)) {
				this.renderContextImagePreviews(request);
			}
			assistantMessage = this.createMessageEl(
				"assistant",
				shouldGenerateImage ? "Improving image prompt..." : "",
				!shouldGenerateImage
			);
			const activeAssistantMessage = assistantMessage;
			const result = await this.plugin.runOpenAIRequest(request, {
				onTextDelta: (delta) => {
					if (!this.isRunActive(run)) {
						return;
					}

					responseText += delta;
					this.renderMarkdownSoon(activeAssistantMessage.body, responseText, sourcePath);
					this.maybeScrollMessagesToBottom();
				},
				abortSignal: run.abortController.signal,
				forceImage: shouldGenerateImage
			});

			if (!this.isRunActive(run)) {
				return;
			}

			if (result.kind === "text") {
				responseText = result.text.trim() || responseText.trim() || "OpenAI returned no text.";
				if (!this.isClosed) {
					this.renderMarkdownNow(activeAssistantMessage.body, responseText, sourcePath);
					this.renderAssistantMessageActions(activeAssistantMessage.actions, activeAssistantMessage.evidence, request, () => responseText, result.model);
					this.messages.push({ role: "assistant", text: responseText });
				}
				await this.plugin.recordNoteHistoryTurn(request, responseText, result.model);

				if (request.metadata.outputMode === "note") {
					outputSideEffectStarted = true;
					const file = await this.plugin.createResultNote(request, responseText, { model: result.model });
					// Always surface success if the vault write landed, even if Stop/close raced.
					this.notifySideEffect(`Created note: ${file.path}`, `AskMate created ${file.path}`);
				} else if (request.metadata.outputMode === "apply") {
					outputSideEffectStarted = true;
					const message = await this.plugin.applyResponseToContext(request, responseText);
					this.notifySideEffect(message, message);
				}
				return;
			}

			if (!this.isClosed) {
				this.renderGeneratedImage(activeAssistantMessage.body, result);
				this.renderAssistantImageActions(activeAssistantMessage.actions, request, () => result);
				this.messages.push({ role: "assistant", text: `Generated image with ${result.model}.` });
			}
			await this.plugin.recordNoteHistoryTurn(request, `Generated image. Prompt: ${result.image.prompt}`, result.model);

			if (request.metadata.outputMode === "note") {
				outputSideEffectStarted = true;
				const { noteFile, imageFile } = await this.plugin.createImageResultNote(request, result);
				this.notifySideEffect(
					`Created note: ${noteFile.path} and image: ${imageFile.path}`,
					`AskMate created ${noteFile.path}`
				);
			} else if (request.metadata.outputMode === "apply") {
				outputSideEffectStarted = true;
				const message = await this.plugin.applyImageToContext(request, result);
				this.notifySideEffect(message, message);
			}
		} catch (error) {
			if (this.isClosed) {
				return;
			}

			const message = isAbortError(error) ? "AskMate request stopped." : this.plugin.getErrorMessage(error);
			// If a vault side effect already completed, do not paint a failure over success.
			if (outputSideEffectStarted && !isAbortError(error)) {
				new Notice(message);
				return;
			}
			if (!assistantMessage) {
				assistantMessage = this.createMessageEl("assistant", "", false);
			}
			assistantMessage.body.setText(message);
			if (!isAbortError(error) && !outputSideEffectStarted) {
				this.createMessageAction(assistantMessage.actions, "rotate-ccw", "Retry request", () => {
					void this.runRequest(retrySnapshot.question, retrySnapshot.title, retrySnapshot.options);
				}, { requiresIdle: true });
			}
			this.messages.push({ role: "assistant", text: message });
			new Notice(message);
		} finally {
			this.finishRun(run);
		}
	}

	/** System chat line + Notice for vault mutations that already succeeded. */
	private notifySideEffect(systemMessage: string, noticeMessage: string): void {
		if (!this.isClosed) {
			this.addMessage("system", systemMessage);
		}
		new Notice(noticeMessage);
	}

	private addMessage(role: ChatRole, text: string, editableText?: string): void {
		this.messages.push({ role, text });
		const message = this.createMessageEl(role, text, false);

		if (editableText) {
			this.createMessageAction(message.actions, "pencil", "Edit", () => {
				this.useTextInComposer(editableText);
			});
		}
	}

	private createMessageEl(role: ChatRole, text: string, renderMarkdown: boolean): MessageElements {
		const wrapper = this.messagesEl.createDiv({
			cls: renderMarkdown
				? `askmate-message askmate-message-${role} askmate-message-has-markdown`
				: `askmate-message askmate-message-${role}`
		});

		const header = wrapper.createDiv({ cls: "askmate-message-header" });
		this.createAvatarEl(header, role);
		header.createSpan({
			cls: "askmate-visually-hidden",
			text: this.getRoleLabel(role)
		});

		const actions = wrapper.createDiv({ cls: "askmate-message-actions" });
		const body = wrapper.createDiv({
			cls: renderMarkdown
				? "askmate-message-body askmate-message-body-markdown"
				: "askmate-message-body"
		});
		const evidence = wrapper.createDiv({ cls: "askmate-message-evidence" });

		if (renderMarkdown) {
			this.renderMarkdownNow(body, text, "");
		} else {
			body.setText(text);
		}

		this.maybeScrollMessagesToBottom();
		return {
			wrapper,
			header,
			actions,
			body,
			evidence
		};
	}

	private shouldShowContextImagePreviews(question: string): boolean {
		const normalized = question.trim().toLowerCase();

		if (!normalized) {
			return false;
		}

		return /\b(?:show|display|preview|view|see|open|image|images|picture|pictures|photo|photos|screenshot|drawing|diagram|visual|excalidraw)\b/u.test(normalized);
	}

	private renderContextImagePreviews(request: AskRequest): void {
		const sourcePath = request.context.file?.path ?? "";
		const references = this.extractImageReferences(request.context.content);

		if (references.length === 0) {
			return;
		}

		const previews: ChatImagePreview[] = [];
		const seen = new Set<string>();

		for (const reference of references) {
			const preview = this.resolveImagePreview(reference, sourcePath);

			if (!preview || seen.has(preview.src)) {
				continue;
			}

			seen.add(preview.src);
			previews.push(preview);

			if (previews.length >= MAX_CONTEXT_IMAGE_PREVIEWS) {
				break;
			}
		}

		if (previews.length === 0) {
			return;
		}

		const message = this.createMessageEl("system", "", false);
		message.wrapper.addClass("askmate-message-has-image");
		message.body.empty();
		message.body.addClass("askmate-message-body-image");
		const shell = message.body.createDiv({ cls: "askmate-context-image-preview" });
		shell.createDiv({
			cls: "askmate-context-image-heading",
			text: previews.length === 1 ? "Context image" : `Context images (${previews.length})`
		});
		const grid = shell.createDiv({ cls: "askmate-context-image-grid" });

		for (const preview of previews) {
			const figure = grid.createEl("figure", { cls: "askmate-context-image-card" });
			figure.createEl("img", {
				cls: "askmate-chat-image",
				attr: {
					alt: preview.label,
					src: preview.src,
					title: preview.label
				}
			});
			figure.createEl("figcaption", { text: preview.label });
		}

		if (references.length > previews.length) {
			shell.createDiv({
				cls: "askmate-context-image-more",
				text: `Showing ${previews.length} of ${references.length} referenced images.`
			});
		}

		this.messages.push({ role: "system", text: "Context images displayed." });
		this.maybeScrollMessagesToBottom();
	}

	private extractImageReferences(markdown: string): string[] {
		const references: string[] = [];
		const wikiImageLinkPattern = /!?\[\[([^\]]+)\]\]/g;
		const markdownImageLinkPattern = /!?\[[^\]]*\]\(([^)]+)\)/g;

		for (const match of markdown.matchAll(wikiImageLinkPattern)) {
			references.push(match[1]);
		}

		for (const match of markdown.matchAll(markdownImageLinkPattern)) {
			references.push(match[1]);
		}

		return references;
	}

	private resolveImagePreview(reference: string, sourcePath: string): ChatImagePreview | null {
		const cleanReference = this.cleanImageReference(reference);

		if (!cleanReference) {
			return null;
		}

		if (/^data:image\//i.test(cleanReference) || /^https?:\/\//i.test(cleanReference)) {
			return {
				label: cleanReference,
				src: cleanReference
			};
		}

		const file = this.app.metadataCache.getFirstLinkpathDest(cleanReference, sourcePath);

		if (!file || !IMAGE_FILE_EXTENSIONS.has(file.extension.toLowerCase())) {
			return null;
		}

		return {
			label: file.path,
			src: this.app.vault.getResourcePath(file)
		};
	}

	private cleanImageReference(reference: string): string {
		let cleanReference = reference.trim();
		cleanReference = cleanReference.replace(/^<(.+)>$/, "$1");
		cleanReference = cleanReference.replace(/^['"](.+)['"]$/, "$1");
		cleanReference = cleanReference.split("|")[0]?.split("#")[0]?.trim() ?? "";

		try {
			return decodeURI(cleanReference);
		} catch {
			return cleanReference;
		}
	}

	private renderAssistantMessageActions(
		parent: HTMLElement,
		evidenceParent: HTMLElement,
		request: AskRequest,
		getText: () => string,
		model: string
	): void {
		parent.empty();
		evidenceParent.empty();
		this.createMessageAction(parent, "file-text", "Show reply text", () => {
			this.showText(getText(), "AskMate reply");
		});
		this.createMessageAction(parent, "corner-down-left", "Use reply", () => {
			this.useTextInComposer(getText());
		});
		const citations = this.plugin.extractEvidenceCitations(getText(), request.evidenceSources).slice(0, 6);
		if (citations.length > 0) {
			evidenceParent.createSpan({ cls: "askmate-evidence-label", text: "Sources" });
			for (const citation of citations) {
				const button = evidenceParent.createEl("button", { cls: "askmate-evidence-chip", text: `${citation.sourceId}: ${citation.source.sourcePath.split("/").pop() ?? citation.source.sourcePath} L${citation.source.lineStart}-${citation.source.lineEnd}` });
				button.type = "button";
				button.addEventListener("click", () => {
					void this.plugin.openEvidenceSource(citation.source);
				});
			}
		}
		this.createMessageAction(parent, "inbox", "Queue for review", async () => {
			const item = await this.plugin.queueReviewItemFromRequest(request, getText(), model);
			new Notice(`Queued AskMate review for ${item.sourcePath}.`);
		}, { requiresIdle: true });
		this.createMessageAction(parent, "file-plus", "New note", async () => {
			const file = await this.plugin.createResultNote(request, getText(), { model });
			this.addMessage("system", `Created note: ${file.path}`);
			new Notice(`AskMate created ${file.path}`);
		}, { requiresIdle: true });
		this.createMessageAction(parent, "pencil", "Apply reply", async () => {
			const message = await this.plugin.applyResponseToContext(request, getText());
			this.addMessage("system", message);
			new Notice(message);
		}, { requiresIdle: true });
		if (request.context.source === "Current note") {
			this.createMessageAction(parent, "file-text", "Replace full note", async () => {
				const message = await this.plugin.applyResponseToContext(request, getText(), { scope: "full-note" });
				this.addMessage("system", message);
				new Notice(message);
			}, { requiresIdle: true });
		}
		if (request.context.source === "Selected text") {
			this.createMessageAction(parent, "text-cursor-input", "Apply selected block", async () => {
				const message = await this.plugin.applyResponseToContext(request, getText(), { scope: "selected-block" });
				this.addMessage("system", message);
				new Notice(message);
			}, { requiresIdle: true });
		}
		this.createMessageAction(parent, "heading-1", "Apply to heading", async () => {
			const heading = await askMatePrompt(this.app, "Heading title or path to replace, for example Project Plan > Risks", request.context.activeHeadingPath ?? "");
			if (heading === null) {
				return;
			}
			const message = await this.plugin.applyResponseToContext(request, getText(), {
				scope: "heading-section",
				headingPath: heading
			});
			this.addMessage("system", message);
			new Notice(message);
		}, { requiresIdle: true });
	}

	private renderGeneratedImage(body: HTMLElement, result: ImageAskMateResult): void {
		body.empty();
		body.removeClass("askmate-message-body-markdown");
		body.addClass("askmate-message-body-image");

		const shell = body.createDiv({ cls: "askmate-image-result" });
		shell.createEl("img", {
			cls: "askmate-generated-image",
			attr: {
				alt: "Generated image from AskMate",
				src: `data:${result.image.mimeType};base64,${result.image.base64}`
			}
		});

		const meta = shell.createDiv({ cls: "askmate-image-meta" });
		meta.createDiv({ text: `Model: ${result.model}` });
		meta.createDiv({ text: `Prompt planning: ${formatOperationStatus(result.promptPlan.status)} with ${result.promptPlan.planningModel}` });

		if (result.promptPlan.fallbackReason) {
			meta.createDiv({ text: `Planning fallback: ${result.promptPlan.fallbackReason}` });
		}

		if (result.image.revisedPrompt) {
			meta.createDiv({ text: "OpenAI revised the image prompt." });
		}

		const details = shell.createEl("details", { cls: "askmate-image-prompt-details" });
		details.createEl("summary", { text: "Prompt" });
		details.createEl("pre", { text: result.image.revisedPrompt ?? result.image.prompt });
		this.maybeScrollMessagesToBottom();
	}

	private renderAssistantImageActions(
		parent: HTMLElement,
		request: AskRequest,
		getResult: () => ImageAskMateResult
	): void {
		parent.empty();
		this.createMessageAction(parent, "file-text", "Show image prompt", () => {
			this.showText(getResult().image.prompt, "AskMate image prompt");
		});
		this.createMessageAction(parent, "file-plus", "New image note", async () => {
			const { noteFile, imageFile } = await this.plugin.createImageResultNote(request, getResult());
			this.addMessage("system", `Created note: ${noteFile.path} and image: ${imageFile.path}`);
			new Notice(`AskMate created ${noteFile.path}`);
		}, { requiresIdle: true });
		this.createMessageAction(parent, "image-plus", "Insert image", async () => {
			const message = await this.plugin.applyImageToContext(request, getResult());
			this.addMessage("system", message);
			new Notice(message);
		}, { requiresIdle: true });
	}

	private createMessageAction(
		parent: HTMLElement,
		icon: string,
		label: string,
		onClick: () => void | Promise<void>,
		options: MessageActionOptions = {}
	): HTMLButtonElement {
		const wrapper = parent.closest(".askmate-message");
		if (wrapper instanceof HTMLElement) {
			wrapper.addClass("askmate-message-has-actions");
		}

		const button = parent.createEl("button", { cls: "askmate-message-action" });
		button.type = "button";
		button.setAttribute("aria-label", label);
		button.setAttribute("title", label);
		if (options.requiresIdle) {
			button.dataset.askmateRequiresIdle = "true";
			button.disabled = Boolean(this.activeRun);
		}
		this.addIcon(button, icon, "askmate-message-action-icon");
		button.createSpan({ cls: "askmate-visually-hidden", text: label });
		button.addEventListener("click", () => {
			if (options.requiresIdle && this.activeRun) {
				new Notice("Wait for the current AskMate request to finish, or stop it first.");
				return;
			}

			void Promise.resolve(onClick()).catch((error) => {
				new Notice(this.plugin.getErrorMessage(error));
			});
		});
		return button;
	}

	private showText(text: string, title: string): void {
		const value = text.trim();

		if (!value) {
			new Notice("Nothing to show yet.");
			return;
		}

		new AskMateTextViewerModal(this.app, title, value).open();
	}

	private useTextInComposer(text: string): void {
		this.questionEl.value = text.trim();
		this.questionEl.focus();
		this.questionEl.setSelectionRange(this.questionEl.value.length, this.questionEl.value.length);
	}

	private renderMarkdownSoon(body: HTMLElement, markdown: string, sourcePath: string): void {
		const pending = this.markdownRenderTimers.get(body);

		if (pending !== undefined) {
			window.clearTimeout(pending);
			this.pendingMarkdownTimerIds.delete(pending);
		}

		const timer = window.setTimeout(() => {
			this.markdownRenderTimers.delete(body);
			this.pendingMarkdownTimerIds.delete(timer);
			this.renderMarkdownNow(body, markdown, sourcePath);
		}, 120);
		this.markdownRenderTimers.set(body, timer);
		this.pendingMarkdownTimerIds.add(timer);
	}

	private isSimpleMarkdownReply(markdown: string): boolean {
		const text = markdown.trim();

		if (!text || text.length > 180 || text.includes("\n")) {
			return false;
		}

		return !/^(?:#{1,6}\s|[-*+]\s|\d+\.\s|>|```|~~~|\|)|!\[|!\[\[/u.test(text);
	}

	private renderMarkdownNow(body: HTMLElement, markdown: string, sourcePath: string): void {
		const pending = this.markdownRenderTimers.get(body);

		if (pending !== undefined) {
			window.clearTimeout(pending);
			this.pendingMarkdownTimerIds.delete(pending);
			this.markdownRenderTimers.delete(body);
		}

		const renderId = String(++this.markdownRenderId);
		body.dataset.askmateRenderId = renderId;
		const isSimpleMarkdown = this.isSimpleMarkdownReply(markdown);
		body.classList.toggle("is-simple-markdown", isSimpleMarkdown);
		body.closest(".askmate-message")?.classList.toggle("askmate-message-simple-markdown", isSimpleMarkdown);

		if (!markdown.trim()) {
			body.empty();
			body.removeClass("is-simple-markdown");
			body.closest(".askmate-message")?.removeClass("askmate-message-simple-markdown");
			return;
		}

		const host = activeDocument.createElement("div");
		host.addClass("askmate-rendered-markdown");

		void MarkdownRenderer.render(this.app, markdown, host, sourcePath, this)
			.then(() => {
				if (this.isClosed || !body.isConnected || body.dataset.askmateRenderId !== renderId) {
					return;
				}

				body.empty();
				body.appendChild(host);
				this.maybeScrollMessagesToBottom();
			})
			.catch(() => {
				if (!this.isClosed && body.isConnected && body.dataset.askmateRenderId === renderId) {
					body.setText(markdown);
				}
			});
	}

	private createAvatarEl(parent: HTMLElement, role: ChatRole): HTMLElement {
		const avatar = parent.createDiv({
			cls: `askmate-avatar askmate-avatar-${role}`,
			attr: {
				"aria-label": this.getRoleLabel(role),
				title: this.getRoleLabel(role)
			}
		});

		if (role === "assistant") {
			avatar.createDiv({ cls: "askmate-avatar-robot-antenna" });
			const face = avatar.createDiv({ cls: "askmate-avatar-robot-face" });
			const eyes = face.createDiv({ cls: "askmate-avatar-robot-eyes" });
			eyes.createSpan();
			eyes.createSpan();
			face.createDiv({ cls: "askmate-avatar-robot-smile" });
			return avatar;
		}

		if (role === "user") {
			const portrait = avatar.createDiv({ cls: "askmate-avatar-person" });
			portrait.createDiv({ cls: "askmate-avatar-person-head" });
			portrait.createDiv({ cls: "askmate-avatar-person-body" });
			return avatar;
		}

		const statusMark = avatar.createDiv({ cls: "askmate-avatar-status-mark" });
		statusMark.createDiv();
		statusMark.createDiv();
		return avatar;
	}

	private getRoleLabel(role: ChatRole): string {
		if (role === "user") {
			return "You";
		}

		if (role === "assistant") {
			return "AskMate";
		}

		return "Status";
	}

	private updateModelLabel(): void {
		if (!this.modelEl) {
			return;
		}

		const ref = this.plugin.getSelectedProviderModelRef();
		const model = ref.model;
		const capability = ref.capability;
		this.modelEl.setText(`${ref.providerName}: ${model}`);
		this.modelEl.setAttribute("title", capability === "image"
			? "Image generation model"
			: "Text provider and model for the next request");
	}

	private async openPromptInspector(): Promise<void> {
		try {
			const raw = this.questionEl.value.trim() || "Preview request";
			const command = this.parseComposerCommand(raw);
			const inspection = await this.plugin.inspectFinalPrompt(command.question, command.forceImage ? "AskMate Image" : "AskMate Answer", {
				forceImage: command.forceImage,
				privacy: this.privacyOptions,
				contextBudgetMode: this.contextBudgetMode,
				additionalContextPaths: this.additionalContextPaths,
				folderContext: this.getFolderContextOptions(),
				threadMessages: this.getThreadMessagesForNextRequest(),
				includeThreadHistory: this.plugin.settings.threadedChatEnabled
			});
			new AskMatePromptInspectorModal(this.app, inspection).open();
		} catch (error) {
			new Notice(this.plugin.getErrorMessage(error));
		}
	}

	private async showNoteHistory(): Promise<void> {
		try {
			const context = await this.plugin.getNoteContext();
			new AskMateNoteHistoryModal(this.app, this.plugin, context.file?.path ?? "").open();
		} catch (error) {
			new Notice(this.plugin.getErrorMessage(error));
		}
	}

	private async showContextNotice(): Promise<void> {
		try {
			const context = await this.plugin.getNoteContext();
			const source = context.file?.path ?? "unsaved note";
			new Notice(`${context.source}: ${source}`);
		} catch {
			new Notice("Open a Markdown note or select text to add context.");
		}
	}

	private async updateContextLabel(): Promise<void> {
		if (!this.contextEl) {
			return;
		}

		try {
			const context = await this.plugin.getNoteContext();
			const source = context.file?.path ?? "unsaved note";
			const label = `${context.source}: ${source}`;
			this.contextEl.setAttribute("aria-label", `Show selected note. ${label}`);
			this.contextEl.setAttribute("title", label);
		} catch {
			const label = "Open a Markdown note or select text to add context.";
			this.contextEl.setAttribute("aria-label", label);
			this.contextEl.setAttribute("title", label);
		}
	}

	private setLoading(isLoading: boolean): void {
		this.rootEl?.classList.toggle("is-loading", isLoading);
		this.imageButton?.toggleAttribute("disabled", isLoading);
		this.clearButton?.toggleAttribute("disabled", isLoading);
		this.workflowToggleButton?.toggleAttribute("disabled", isLoading);
		for (const button of this.workflowButtons) {
			button.disabled = isLoading;
		}
		for (const button of Object.values(this.outputButtons)) {
			if (button) {
				button.disabled = isLoading;
			}
		}
		this.rootEl
			?.querySelectorAll<HTMLButtonElement>(".askmate-message-action[data-askmate-requires-idle=\"true\"]")
			.forEach((button) => {
				button.disabled = isLoading;
			});
		this.rootEl
			?.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>("[data-askmate-preview-control=\"true\"]")
			.forEach((control) => {
				control.disabled = isLoading;
			});
		this.sendButton.disabled = isLoading;
		this.stopButton.hidden = !isLoading;
		this.stopButton.disabled = !isLoading;
		this.stopButton.setAttribute("aria-hidden", String(!isLoading));
		this.setButtonLabel(this.sendButton, isLoading ? "Sending" : "Send");
		const sendShortcutLabel = this.getSendShortcutLabel();
		this.sendButton.setAttribute("aria-label", isLoading ? "Sending" : `Send (${sendShortcutLabel})`);
		this.sendButton.setAttribute("title", isLoading ? "Sending" : `Send (${sendShortcutLabel})`);
		this.refreshReasoningSelector();
		this.refreshWorkflowToggle();
		this.updateModelLabel();
	}

	private setButtonLabel(button: HTMLButtonElement, label: string): void {
		const labelEl = button.querySelector<HTMLElement>(".askmate-action-label");

		if (labelEl) {
			labelEl.setText(label);
			return;
		}

		button.setText(label);
	}

	private maybeScrollMessagesToBottom(): void {
		if (!this.shouldFollowMessages) {
			return;
		}

		this.scrollMessagesToBottom();
	}

	private isScrolledNearBottom(): boolean {
		const distanceFromBottom =
			this.messagesEl.scrollHeight - this.messagesEl.scrollTop - this.messagesEl.clientHeight;
		return distanceFromBottom <= this.autoScrollThresholdPx;
	}

	private scrollMessagesToBottom(): void {
		this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
	}
}
