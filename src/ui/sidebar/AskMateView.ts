import { Component, ItemView, Keymap, MarkdownRenderer, Notice, TFolder, setIcon, type WorkspaceLeaf } from "obsidian";
import type { AskMatePlugin } from "../../plugin/AskMatePlugin";
import { getStatusBarOverlap } from "./statusBarOverlap";
import {
	ActiveRun,
	ASKMATE_VIEW_TYPE,
	AskRequest,
	ChatImagePreview,
	ChatMessage,
	ChatRole,
	ComposerLayout,
	canRunContinue,
	CONTEXT_BUDGET_OPTIONS,
	createBuiltRetrySnapshot,
	createDraftRetrySnapshot,
	ContextBudgetMode,
	DEFAULT_FOLDER_CONTEXT_MAX_FILES,
	DEFAULT_IMAGE_PROMPT,
	DEFAULT_REQUEST_PRIVACY_OPTIONS,
	FolderContextOptions,
	formatOperationStatus,
	formatOutputMode,
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
	normalizeOutputMode,
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
import { classifyImagePreviewSource, describeDataImage, extractImageEmbedTargets, sanitizeModelMarkdown } from "./renderSafety";
import {
	buildConsoleCommands,
	formatConsoleHelp,
	formatConsoleStatus,
	getConsoleCompletions,
	parseConsoleInput,
	resolveLayoutName,
	type ConsoleAction,
	type ConsoleCommand,
	type ConsoleCompletion,
	type ConsoleMentions
} from "./consoleCommands";

let consoleViewCounter = 0;

/** Short labels shown as [label] in the Console layout; the full label stays the accessible name. */
const CONSOLE_ACTION_LABELS: Record<string, string> = {
	"Show reply text": "text",
	"Use reply": "reuse",
	"Queue for review": "queue",
	"New note": "note",
	"Apply reply": "apply",
	"Replace full note": "replace",
	"Apply selected block": "apply-sel",
	"Apply to heading": "heading",
	"Retry request": "retry",
	"Edit": "edit",
	"Show image prompt": "prompt",
	"New image note": "note",
	"Insert image": "insert"
};

export class AskMateView extends ItemView {
	private readonly plugin: AskMatePlugin;
	private messagesEl!: HTMLElement;
	private questionEl!: HTMLTextAreaElement;
	private contextEl: HTMLButtonElement | null = null;
	private modelEl: HTMLElement | null = null;
	private sendButton!: HTMLButtonElement;
	private imageButton: HTMLButtonElement | null = null;
	private stopButton!: HTMLButtonElement;
	private clearButton: HTMLButtonElement | null = null;
	private activeRun: ActiveRun | null = null;
	private nextRunId = 0;
	private isClosed = false;
	private messages: ChatMessage[] = [];
	private shouldFollowMessages = true;
	private readonly autoScrollThresholdPx = 48;
	private rootEl: HTMLElement | null = null;
	private statusBarObserver: ResizeObserver | null = null;
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
	private readonly pendingMarkdown = new WeakMap<HTMLElement, { markdown: string; sourcePath: string }>();
	private readonly markdownRendersInFlight = new WeakMap<HTMLElement, number>();
	/** Each rendered body owns its embeds and post-processor children, so they unload with that body. */
	private readonly markdownComponents = new Map<HTMLElement, Component>();
	private requestPreviewEl: HTMLElement | null = null;
	private privacyOptions: RequestPrivacyOptions = DEFAULT_REQUEST_PRIVACY_OPTIONS;
	private contextBudgetMode: ContextBudgetMode = "expanded";
	private requestPreviewRefreshId = 0;
	private requestPreviewTimer: number | null = null;
	private composerEl: HTMLElement | null = null;
	private readinessEl: HTMLElement | null = null;
	private statusEl: HTMLElement | null = null;
	private additionalContextPaths: string[] = [];
	private folderContextEnabled = false;
	private folderContextPath = "";
	private folderContextMaxFiles = DEFAULT_FOLDER_CONTEXT_MAX_FILES;
	private requestDefaultsKey = "";
	private lastRequestPreviewKey: string | null = null;
	/** Bumped whenever the note context may have changed outside the sidebar. */
	private requestPreviewContextGeneration = 0;
	private contextLabelGeneration = 0;
	private onboardingTipsShown = false;
	private readonly activeActionKeys = new Set<string>();
	private consoleCommands: ConsoleCommand[] = [];
	private consoleCompletionsEl: HTMLElement | null = null;
	private consoleStatusEl: HTMLElement | null = null;
	private consoleStatusSegmentsEl: HTMLElement | null = null;
	private consoleModeButton: HTMLButtonElement | null = null;
	private consoleStopButton: HTMLButtonElement | null = null;
	private consoleCompletion: { from: number; to: number; items: ConsoleCompletion[]; index: number; navigated: boolean } | null = null;
	/** Unique per view, so two open AskMate sidebars never share listbox or option ids. */
	private readonly consoleIdPrefix = `askmate-console-${++consoleViewCounter}`;
	private consoleHistory: string[] = [];
	private consoleHistoryIndex = -1;

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
		this.resetRequestOptionsFromSettings();
		this.workflowsVisible = false;
		this.onboardingTipsShown = false;

		this.plugin.rememberActiveMarkdownContext();

		this.messagesEl = container.createDiv({ cls: "askmate-messages" });
		this.messagesEl.setAttribute("role", "log");
		this.messagesEl.setAttribute("aria-live", "polite");
		this.messagesEl.setAttribute("aria-relevant", "additions text");
		this.statusEl = container.createDiv({ cls: "askmate-visually-hidden" });
		this.statusEl.setAttribute("role", "status");
		this.statusEl.setAttribute("aria-live", "polite");
		this.shouldFollowMessages = true;
		this.registerDomEvent(this.messagesEl, "scroll", () => {
			this.shouldFollowMessages = this.isScrolledNearBottom();
		});
		this.registerDomEvent(this.messagesEl, "click", (event) => {
			this.openInternalLink(event);
		});
		this.registerDomEvent(this.messagesEl, "auxclick", (event) => {
			if (event.button === 1) {
				this.openInternalLink(event);
			}
		});
		this.renderOnboardingTips();

		this.refreshConsoleCommands();
		this.renderWorkflowGrid(container);
		this.renderComposer(container);
		this.refreshConsoleStatus();

		const refreshContext = (): void => {
			this.plugin.rememberActiveMarkdownContext();
			// Also picks up usage from runs started elsewhere (for example the command palette).
			this.refreshReasoningSelector();
			this.updateModelLabel();
			// Building the preview reads the note and folder context, so one click (pointerdown, focusin and
			// active-leaf-change together) must cost at most one debounced build, and only when something changed.
			this.scheduleRequestPreviewRefresh();
		};

		this.registerDomEvent(container, "pointerdown", refreshContext);
		this.registerDomEvent(container, "focusin", refreshContext);

		this.registerEvent(
			this.app.workspace.on("active-leaf-change", () => {
				this.requestPreviewContextGeneration += 1;
				refreshContext();
			})
		);
		this.registerEvent(this.app.workspace.on("layout-change", () => this.updateStatusBarClearance()));
		this.watchStatusBar();
	}

	/**
	 * The status bar floats over the bottom-right of the window, so the composer would sit underneath it when AskMate is
	 * docked there. Its size changes with the plugins and notes it reports on, so it is measured rather than assumed.
	 */
	private watchStatusBar(): void {
		this.statusBarObserver?.disconnect();
		this.statusBarObserver = null;
		// Popout windows have no status bar, so there is nothing to watch there.
		const statusBarEl = this.rootEl?.doc.querySelector(".status-bar");
		if (statusBarEl) {
			this.statusBarObserver = new ResizeObserver(() => this.updateStatusBarClearance());
			this.statusBarObserver.observe(statusBarEl);
		}
		this.updateStatusBarClearance();
	}

	private updateStatusBarClearance(): void {
		const rootEl = this.rootEl;
		if (!rootEl || this.isClosed) {
			return;
		}
		const statusBarEl = rootEl.doc.querySelector(".status-bar");
		const overlap = getStatusBarOverlap(rootEl.getBoundingClientRect(), statusBarEl?.getBoundingClientRect() ?? null);
		rootEl.setCssProps({ "--askmate-status-bar-clearance": `${overlap}px` });
	}

	/** MarkdownRenderer emits wikilinks as `a.internal-link` but leaves navigation to the host view. */
	private openInternalLink(event: MouseEvent): void {
		// targetNode and instanceOf stay correct when the sidebar is moved to a popout window.
		const target = event.targetNode;
		if (!target || !target.instanceOf(Element)) {
			return;
		}
		const link = target.closest("a.internal-link");
		if (!link || !this.messagesEl.contains(link)) {
			return;
		}
		const linktext = link.getAttribute("data-href") ?? link.getAttribute("href");
		if (!linktext) {
			return;
		}

		event.preventDefault();
		const sourcePath = link.closest("[data-askmate-source-path]")?.getAttribute("data-askmate-source-path") ?? "";
		void this.app.workspace.openLinkText(linktext, sourcePath, Keymap.isModEvent(event))
			.catch((error: unknown) => new Notice(this.plugin.getErrorMessage(error)));
	}

	onResize(): void {
		// A collapsed sidebar skips preview builds; catch up when it is shown again.
		this.scheduleRequestPreviewRefresh();
		this.updateStatusBarClearance();
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
		this.refreshConsoleCommands();
		this.applyComposerLayoutClass();
		this.renderOnboardingTips();
		this.refreshWorkflowGrid();
		this.refreshOutputToggle();
		this.refreshReasoningSelector();
		this.updateModelLabel();
		if (this.questionEl) {
			this.questionEl.placeholder = this.getComposerPlaceholder();
			this.questionEl.setAttribute("aria-label", `Ask AskMate. ${this.getSendShortcutLabel()} sends.`);
		}
		if (this.sendButton) {
			const label = `Send (${this.getSendShortcutLabel()})`;
			this.sendButton.setAttribute("aria-label", label);
			this.sendButton.setAttribute("title", label);
		}
		// Settings outside the draft options (keys, budgets, limits) can change the preview's blockers.
		this.requestPreviewContextGeneration += 1;
		this.syncRequestPreviewFromSettings();
		if (this.activeRun) {
			// Rebuilt workflow buttons and preview controls are created enabled; reapply the running state.
			this.setLoading(true);
		}
		void this.refreshReadiness();
		this.refreshConsoleStatus();
		this.scheduleRequestPreviewRefresh();
	}

	private applyComposerLayoutClass(): void {
		if (!this.rootEl) {
			return;
		}

		const layout = normalizeComposerLayout(this.plugin.settings.composerLayout);
		this.rootEl.classList.toggle("askmate-composer-layout-compact", layout === "compact");
		this.rootEl.classList.toggle("askmate-composer-layout-expanded", layout === "expanded");
		this.rootEl.classList.toggle("askmate-composer-layout-console", layout === "console");
		this.closeConsoleCompletions();
		this.applyConsolePromptSemantics();
	}

	/** The console prompt is a combobox with a suggestion list; the other layouts keep a plain text box. */
	private applyConsolePromptSemantics(): void {
		if (!this.questionEl) {
			return;
		}
		if (this.isConsoleLayout()) {
			this.questionEl.setAttribute("role", "combobox");
			this.questionEl.setAttribute("aria-autocomplete", "list");
			this.questionEl.setAttribute("aria-controls", `${this.consoleIdPrefix}-completions`);
			this.questionEl.setAttribute("aria-expanded", String(Boolean(this.consoleCompletion)));
			return;
		}
		for (const attribute of ["role", "aria-autocomplete", "aria-controls", "aria-expanded", "aria-activedescendant"]) {
			this.questionEl.removeAttribute(attribute);
		}
	}

	private renderOnboardingTips(): void {
		if (!this.plugin.settings.showOnboardingTips || this.plugin.settings.onboardingTipsDismissedAt) {
			this.rootEl?.querySelectorAll(".askmate-onboarding-message").forEach((element) => element.remove());
			return;
		}
		// Settings refreshes (output mode, reasoning effort) must not re-add the card after Clear chat removed it.
		if (this.onboardingTipsShown || this.rootEl?.querySelector(".askmate-onboarding-message")) {
			return;
		}

		this.onboardingTipsShown = true;
		const message = this.createMessageEl("system", "", false);
		message.wrapper.addClass("askmate-onboarding-message");
		message.body.empty();
		const card = message.body.createDiv({ cls: "askmate-onboarding-card" });
		card.createEl("h3", { text: "AskMate tips" });
		card.createEl("p", {
			text: "Configure a provider in AskMate settings, then ask about the captured note, generate an image, choose a workflow, or select a safe output mode before sending."
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
				this.runUiTask(this.runWorkflow(workflow));
			});
		}
	}

	private getSendShortcutLabel(): string {
		return this.plugin.settings.sendShortcut === "ctrl-enter" ? "Ctrl/Cmd+Enter" : "Enter";
	}

	private getComposerPlaceholder(): string {
		if (this.isConsoleLayout()) {
			return "Ask, or type / for commands and @ for context";
		}
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
		this.composerEl = composer;
		const header = composer.createDiv({ cls: "askmate-composer-header" });
		const headerLeft = header.createDiv({ cls: "askmate-composer-header-left" });
		const brand = headerLeft.createDiv({ cls: "askmate-composer-brand", text: "AskMate" });
		this.readinessEl = brand;
		void this.refreshReadiness();
		this.contextEl = this.createActionButton(headerLeft, "file-text", "Show request context", "askmate-context-button");
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

		this.consoleCompletionsEl = composer.createDiv({
			cls: "askmate-console-completions",
			attr: { id: `${this.consoleIdPrefix}-completions`, role: "listbox", "aria-label": "Command suggestions" }
		});
		this.consoleCompletionsEl.hidden = true;

		const inputShell = composer.createDiv({ cls: "askmate-input-shell" });
		inputShell.createSpan({ cls: "askmate-console-prompt", text: "›", attr: { "aria-hidden": "true" } });
		this.questionEl = inputShell.createEl("textarea", {
			cls: "askmate-question",
			attr: {
				placeholder: this.getComposerPlaceholder(),
				rows: "4",
				"aria-label": `Ask AskMate. ${this.getSendShortcutLabel()} sends.`
			}
		});
		this.questionEl.addEventListener("keydown", (event) => {
			if (this.isConsoleLayout() && this.handleConsoleKeydown(event)) {
				return;
			}
			if (!this.shouldSubmitFromKeydown(event)) {
				return;
			}

			event.preventDefault();
			// A held Enter key must not fire a burst of submits.
			if (event.repeat) {
				return;
			}
			this.runUiTask(this.submitQuestion());
		});
		this.questionEl.addEventListener("input", () => {
			this.consoleHistoryIndex = -1;
			this.updateConsoleCompletions();
			this.scheduleRequestPreviewRefresh();
		});
		this.questionEl.addEventListener("blur", () => {
			this.closeConsoleCompletions();
		});
		this.applyConsolePromptSemantics();

		this.sendButton = this.createActionButton(inputShell, "send", `Send (${this.getSendShortcutLabel()})`, "askmate-send-button mod-cta");
		this.sendButton.addEventListener("click", () => {
			this.runUiTask(this.submitQuestion());
		});

		this.renderRequestPreview(composer);

		const footer = composer.createDiv({ cls: "askmate-composer-footer" });
		const actions = footer.createDiv({ cls: "askmate-actions" });
		const imageButton = this.createActionButton(actions, "image-plus", "Generate image", "askmate-image-button");
		this.imageButton = imageButton;
		imageButton.addEventListener("click", () => {
			this.runUiTask(this.submitImageQuestion());
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

		const clearButton = this.createActionButton(actions, "trash-2", "Clear chat", "askmate-clear-button");
		this.clearButton = clearButton;
		clearButton.addEventListener("click", () => {
			this.clearChat();
		});

		this.renderOutputToggle(footer);
		this.renderConsoleStatusBar(composer);
	}

	private clearChat(): void {
		if (this.activeRun) {
			new Notice("Stop the current request before clearing chat.");
			return;
		}

		this.messages = [];
		this.releaseAllMarkdownComponents();
		this.messagesEl.empty();
		this.shouldFollowMessages = true;
		this.addMessage("system", "Chat cleared.");
	}

	private renderRequestPreview(parent: HTMLElement): void {
		if (!this.plugin.settings.showRequestPreview) {
			return;
		}

		const preview = parent.createDiv({ cls: "askmate-request-preview" });
		const footer = parent.querySelector(":scope > .askmate-composer-footer");
		if (footer) {
			parent.insertBefore(preview, footer);
		}
		this.requestPreviewEl = preview;
		this.lastRequestPreviewKey = null;
		preview.createDiv({ cls: "askmate-request-preview-summary", text: "Request preview loading..." });
		const controls = preview.createDiv({ cls: "askmate-request-preview-controls" });
		this.createPrivacyToggle(controls, "includeNoteContext", "Send note and attached context");
		this.createPrivacyToggle(controls, "includeImageReferences", "Include image links");
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
		const notesLabel = body.createEl("label", { text: "Additional note paths, one per line" });
		const notes = body.createEl("textarea", {
			cls: "askmate-extra-context-textarea",
			attr: {
				rows: "3",
				"data-askmate-preview-control": "true"
			}
		});
		notes.id = "askmate-additional-note-paths";
		notesLabel.htmlFor = notes.id;
		notes.value = this.additionalContextPaths.join("\n");
		notes.addEventListener("input", () => {
			this.additionalContextPaths = normalizeContextPathList(notes.value);
			this.scheduleRequestPreviewRefresh();
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
				"data-askmate-preview-control": "true",
				"aria-label": "Folder context path"
			}
		});
		folderInput.value = this.folderContextPath;
		folderInput.addEventListener("input", () => {
			this.folderContextPath = folderInput.value.trim();
			this.scheduleRequestPreviewRefresh();
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
			this.scheduleRequestPreviewRefresh();
		});
	}

	private scheduleRequestPreviewRefresh(): void {
		if (this.requestPreviewTimer !== null) {
			window.clearTimeout(this.requestPreviewTimer);
		}
		this.requestPreviewTimer = window.setTimeout(() => {
			this.requestPreviewTimer = null;
			if (this.contextLabelGeneration !== this.requestPreviewContextGeneration) {
				this.contextLabelGeneration = this.requestPreviewContextGeneration;
				void this.updateContextLabel();
			}
			void this.refreshRequestPreview();
		}, 200);
	}

	private getRequestPreviewKey(question: string, forceImage: boolean, options: RunRequestOptions): string {
		return JSON.stringify([
			this.requestPreviewContextGeneration,
			question,
			forceImage,
			options,
			this.plugin.getSelectedProviderModelRef()
		]);
	}

	private getRequestDraftOptions(forceImage = false): RunRequestOptions {
		return {
			forceImage,
			outputMode: normalizeOutputMode(this.plugin.settings.outputMode),
			privacy: { ...this.privacyOptions },
			contextBudgetMode: this.contextBudgetMode,
			additionalContextPaths: [...this.additionalContextPaths],
			folderContext: this.getFolderContextOptions(),
			threadMessages: this.getThreadMessagesForNextRequest(),
			includeThreadHistory: this.plugin.settings.threadedChatEnabled
		};
	}

	private async refreshRequestPreview(): Promise<void> {
		if (!this.requestPreviewEl || !this.containerEl.isShown()) {
			return;
		}

		const summary = this.requestPreviewEl.querySelector<HTMLElement>(".askmate-request-preview-summary");
		if (!summary) {
			return;
		}

		const raw = this.questionEl?.value.trim() || "Preview request";
		const command = this.parseComposerCommand(raw);
		const options = this.getRequestDraftOptions(command.forceImage);
		const previewKey = this.getRequestPreviewKey(command.question, command.forceImage, options);
		if (previewKey === this.lastRequestPreviewKey) {
			return;
		}
		this.lastRequestPreviewKey = previewKey;
		const refreshId = ++this.requestPreviewRefreshId;

		try {
			const inspection = await this.plugin.inspectFinalPrompt(
				command.question,
				command.forceImage ? "AskMate Image" : "AskMate Answer",
				options
			);
			if (refreshId !== this.requestPreviewRefreshId || !this.requestPreviewEl) {
				return;
			}

			const request = inspection.request;
			const source = request.context.file?.path ?? "unsaved note";
			const attachmentLabel = request.metadata.contextAttachmentCount > 0
				? `${request.metadata.contextAttachmentCount} attachment${request.metadata.contextAttachmentCount === 1 ? "" : "s"}`
				: "no attachments";
			const contextLabel = request.metadata.privacy.includeNoteContext
				? request.metadata.contextTruncated
					? `${request.metadata.promptContextCharacters.toLocaleString()} of ${request.metadata.contextCharacters.toLocaleString()} context chars`
					: `${request.metadata.promptContextCharacters.toLocaleString()} context chars`
				: "note-derived context off";
			const alerts = [...inspection.blockers, ...inspection.warnings];
			summary.setText([
				`${request.context.source}: ${source}`,
				`${inspection.providerName}: ${inspection.model}`,
				formatOutputMode(request.metadata.outputMode),
				`about ${inspection.estimatedInputTokens.toLocaleString()} input tokens`,
				contextLabel,
				attachmentLabel,
				alerts.join(" ")
			].filter(Boolean).join("\n"));
			summary.classList.toggle("has-blocker", inspection.blockers.length > 0);
		} catch (error) {
			if (refreshId === this.requestPreviewRefreshId) {
				// Let the next trigger retry rather than keep showing a transient error.
				this.lastRequestPreviewKey = null;
				summary.setText(this.plugin.getErrorMessage(error));
				summary.addClass("has-blocker");
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
				this.runUiTask(this.selectOutputMode(option.mode));
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
		// Other open AskMate views would otherwise keep showing the previous mode.
		this.plugin.refreshOpenAskMateViews();
	}

	private refreshOutputToggle(): void {
		for (const [mode, button] of Object.entries(this.outputButtons) as Array<[OutputMode, HTMLButtonElement]>) {
			const isActive = this.plugin.settings.outputMode === mode;
			button.classList.toggle("is-active", isActive);
			button.setAttribute("aria-pressed", String(isActive));
		}
		this.refreshConsoleStatus();
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
			this.runUiTask(this.selectReasoningEffort(select.value));
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
		this.plugin.refreshOpenAskMateViews();
	}

	private refreshReasoningSelector(): void {
		this.refreshConsoleStatus();
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
		this.statusBarObserver?.disconnect();
		this.statusBarObserver = null;
		this.stopActiveRun(false);
		this.activeRun = null;
		this.activeActionKeys.clear();
		if (this.requestPreviewTimer !== null) {
			window.clearTimeout(this.requestPreviewTimer);
			this.requestPreviewTimer = null;
		}
		this.messages = [];
		for (const timer of this.pendingMarkdownTimerIds) {
			window.clearTimeout(timer);
		}
		this.pendingMarkdownTimerIds.clear();
		this.releaseAllMarkdownComponents();
		this.containerEl.empty();
	}

	private ensureIdleForNewRequest(): boolean {
		if (!this.activeRun && this.activeActionKeys.size === 0) {
			return true;
		}

		new Notice(this.activeRun
			? "AskMate is already working. Stop the current request before starting another."
			: "Wait for the current AskMate action to finish before starting another request.");
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
			phase: "building",
			startedAt: new Date().toISOString()
		};

		this.activeRun = run;
		this.setLoading(true);
		return run;
	}

	private isRunActive(run: ActiveRun): boolean {
		return canRunContinue(this.activeRun, run, this.isClosed);
	}

	private stopActiveRun(notify = true): void {
		const run = this.activeRun;
		if (!run) {
			return;
		}
		if (notify && run.phase === "post-processing") {
			// The reply has arrived and its note write may be under way; unlocking now would report a stop that
			// did not happen and let another write to the same note start.
			new Notice("AskMate is saving the reply. Wait for it to finish.");
			return;
		}
		run.abortController.abort();
		this.activeRun = null;
		this.setLoading(false);
		if (notify && !this.isClosed) {
			const message = run.phase === "generating"
				? "AskMate stopped waiting for this request. The provider may still finish it in the background."
				: "AskMate stopped this request before sending it.";
			this.addMessage("system", message);
			this.statusEl?.setText("AskMate request stopped locally.");
			new Notice(message);
		}
	}

	private setRunPhase(run: ActiveRun, phase: ActiveRun["phase"]): void {
		if (this.activeRun?.id === run.id) {
			run.phase = phase;
			this.refreshStopButton();
		}
	}

	private refreshStopButton(): void {
		const canStop = Boolean(this.activeRun) && this.activeRun?.phase !== "post-processing";
		this.stopButton.hidden = !this.activeRun;
		this.stopButton.disabled = !canStop;
		this.stopButton.setAttribute("aria-hidden", String(!this.activeRun));
		const label = this.activeRun?.phase === "post-processing" ? "Saving reply" : "Stop request";
		this.stopButton.setAttribute("aria-label", label);
		this.stopButton.setAttribute("title", label);
		if (this.consoleStopButton) {
			this.consoleStopButton.hidden = !this.activeRun;
			this.consoleStopButton.disabled = !canStop;
			this.consoleStopButton.setText(this.activeRun?.phase === "post-processing" ? "saving" : "stop");
			this.consoleStopButton.setAttribute("aria-label", `${label} (Esc)`);
			this.consoleStopButton.setAttribute("title", `${label} (Esc)`);
		}
	}

	private finishRun(run: ActiveRun): void {
		if (this.activeRun?.id !== run.id) {
			return;
		}

		this.activeRun = null;
		this.setLoading(false);
	}

	private async submitQuestion(): Promise<void> {
		if (this.isConsoleLayout()) {
			// Commands such as /help and /context work while a request runs; actions that send a request check idleness.
			await this.submitConsoleInput();
			return;
		}
		if (!this.ensureIdleForNewRequest()) {
			return;
		}
		// "/layout console" also works here, so the way back to the Console layout is the same everywhere.
		const layoutCommand = this.questionEl.value.trim().match(/^\/layout\s+(\S+)$/i);
		const requestedLayout = layoutCommand ? resolveLayoutName(layoutCommand[1]) : null;
		if (requestedLayout) {
			this.questionEl.value = "";
			await this.switchLayout(requestedLayout);
			return;
		}

		const rawQuestion = this.questionEl.value.trim();
		if (!rawQuestion) {
			new Notice("Type a question first.");
			return;
		}
		// "/image ..." goes to OpenAI Images whatever chat provider is selected, so check the matching readiness.
		const command = this.parseComposerCommand(rawQuestion);
		const isReady = command.forceImage
			? await this.isProviderReadyForSubmit("Add an OpenAI API key in AskMate settings before generating an image.", () => this.plugin.isImageGenerationConfigured())
			: await this.isProviderReadyForSubmit("Configure the selected AskMate provider in settings before sending.");
		if (!isReady) {
			this.questionEl.focus();
			return;
		}

		this.questionEl.value = "";
		await this.runRequest(command.question, command.forceImage ? "AskMate Image" : "AskMate Answer", this.getRequestDraftOptions(command.forceImage));
	}

	private async submitImageQuestion(): Promise<void> {
		if (!this.ensureIdleForNewRequest()) {
			return;
		}
		// Image generation always uses OpenAI Images, whichever chat provider is selected.
		if (!(await this.isProviderReadyForSubmit("Add an OpenAI API key in AskMate settings before generating an image.", () => this.plugin.isImageGenerationConfigured()))) {
			return;
		}

		// Match Enter: "/image a red fox" sends "a red fox", as the request preview shows.
		const rawQuestion = this.questionEl.value.trim();
		const question = rawQuestion ? this.parseComposerCommand(rawQuestion).question : DEFAULT_IMAGE_PROMPT;
		this.questionEl.value = "";
		await this.runRequest(question, "AskMate Image", this.getRequestDraftOptions(true));
	}

	/**
	 * Holds a claim while the provider check awaits, so a second submit or a workflow click in that gap gets the
	 * usual "busy" notice instead of racing for the run and clearing the composer.
	 */
	private async isProviderReadyForSubmit(
		notConfiguredMessage: string,
		isConfigured: () => Promise<boolean> = () => this.plugin.isSelectedProviderConfigured()
	): Promise<boolean> {
		const claim = "submit";
		this.activeActionKeys.add(claim);
		try {
			if (await isConfigured()) {
				return true;
			}
		} finally {
			this.activeActionKeys.delete(claim);
		}

		await this.refreshReadiness();
		new Notice(notConfiguredMessage);
		return false;
	}

	private runUiTask(task: Promise<void>): void {
		void task.catch((error: unknown) => {
			new Notice(this.plugin.getErrorMessage(error));
		});
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
		if (!(await this.isProviderReadyForSubmit("Configure the selected AskMate provider in settings before running a workflow."))) {
			return;
		}

		await this.runRequest(this.plugin.getWorkflowPrompt(workflow), workflow.name, { workflow });
	}

	private async runRequest(
		question: string,
		title: string,
		options: RunRequestOptions = {},
		builtRequest?: AskRequest,
		displayText?: string
	): Promise<void> {
		const intentKind = this.plugin.classifyRequestIntent(question, options);
		const willGenerateImage = intentKind === "explicit_image" || intentKind === "auto_image" || this.plugin.getSelectedProviderModelRef().capability === "image";
		const threadMessages = options.threadMessages ?? this.getThreadMessagesForNextRequest();
		const run = this.beginRun(intentKind);

		if (!run) {
			return;
		}

		void this.updateContextLabel();
		this.shouldFollowMessages = true;
		const requestTitle = title === "AskMate Answer" && willGenerateImage ? "AskMate Image" : title;
		const isUserPrompt = requestTitle === "AskMate Answer" || requestTitle === "AskMate Image";
		// Thread history keeps the clean question; the console shows (and Edit restores) the line as typed.
		const historyText = isUserPrompt ? question : requestTitle;
		const userTurn = this.addMessage("user", displayText ?? historyText, displayText ?? (isUserPrompt ? question : undefined), historyText);
		let answered = false;
		let assistantMessage: MessageElements | null = null;
		let responseText = "";
		let retrySnapshot: RetryRequestSnapshot = createDraftRetrySnapshot(question, requestTitle, {
			...options,
			outputMode: normalizeOutputMode(options.outputMode ?? this.plugin.settings.outputMode),
			privacy: { ...(options.privacy ?? this.privacyOptions) },
			contextBudgetMode: options.contextBudgetMode ?? this.contextBudgetMode,
			additionalContextPaths: [...(options.additionalContextPaths ?? this.additionalContextPaths)],
			folderContext: { ...(options.folderContext ?? this.getFolderContextOptions()) },
			threadMessages: threadMessages.map((message) => ({ ...message })),
			includeThreadHistory: options.includeThreadHistory ?? this.plugin.settings.threadedChatEnabled
		});

		try {
			const request = builtRequest ?? await this.plugin.buildRequest(question, requestTitle, {
				...options,
				intentKind,
				outputMode: normalizeOutputMode(options.outputMode ?? this.plugin.settings.outputMode),
				privacy: options.privacy ?? this.privacyOptions,
				contextBudgetMode: options.contextBudgetMode ?? this.contextBudgetMode,
				additionalContextPaths: options.additionalContextPaths ?? this.additionalContextPaths,
				folderContext: options.folderContext ?? this.getFolderContextOptions(),
				threadMessages,
				includeThreadHistory: options.includeThreadHistory ?? this.plugin.settings.threadedChatEnabled
			});
			retrySnapshot = createBuiltRetrySnapshot(request);

			if (!this.isRunActive(run)) {
				return;
			}

			this.setRunPhase(run, "confirming");
			await this.plugin.confirmUsageGuardrails(request);

			if (!this.isRunActive(run)) {
				return;
			}

			this.setRunPhase(run, "generating");
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
			this.setRunPhase(run, "post-processing");

			if (result.kind === "text") {
				const finalText = result.text.trim() || responseText.trim();
				if (!finalText) {
					// An empty reply must not be saved to history or written into the note as if it were an answer.
					throw new Error(`${request.metadata.providerName} returned no text. Try again or choose another model.`);
				}
				responseText = finalText;
				if (!this.isClosed) {
					this.renderMarkdownNow(activeAssistantMessage.body, responseText, sourcePath);
					if (result.incompleteReason) {
						this.renderIncompleteWarning(activeAssistantMessage, result.incompleteReason);
					}
					this.renderAssistantMessageActions(activeAssistantMessage.actions, activeAssistantMessage.evidence, request, () => responseText, result.model);
					this.messages.push({ role: "assistant", text: responseText });
					answered = true;
				}
				await this.plugin.recordNoteHistoryTurn(request, responseText, result.model);
				if (!this.isRunActive(run)) {
					return;
				}

				try {
					if (request.metadata.outputMode === "note") {
						const file = await this.plugin.createResultNote(request, responseText, { model: result.model });
						this.notifySideEffect(`Created note: ${file.path}`, `AskMate created ${file.path}`);
					} else if (request.metadata.outputMode === "apply") {
						const outcome = await this.plugin.applyResponseToContext(request, responseText);
						this.notifySideEffect(outcome.message, outcome.message);
					}
				} catch (error) {
					if (this.activeRun?.id === run.id && !this.isClosed) {
						const message = this.plugin.getErrorMessage(error);
						this.addMessage("system", `Generated reply preserved. Output action failed: ${message}`);
						new Notice(message);
					}
				}
				return;
			}

			if (!this.isClosed) {
				this.renderGeneratedImage(activeAssistantMessage.body, result);
				this.renderAssistantImageActions(activeAssistantMessage.actions, request, () => result);
				this.messages.push({ role: "assistant", text: `Generated image with ${result.model}.` });
				answered = true;
			}
			await this.plugin.recordNoteHistoryTurn(request, `Generated image. Prompt: ${result.image.prompt}`, result.model);
			if (!this.isRunActive(run)) {
				return;
			}

			try {
				if (request.metadata.outputMode === "note") {
					const { noteFile, imageFile } = await this.plugin.createImageResultNote(request, result);
					this.notifySideEffect(
						`Created note: ${noteFile.path} and image: ${imageFile.path}`,
						`AskMate created ${noteFile.path}`
					);
				} else if (request.metadata.outputMode === "apply") {
					const outcome = await this.plugin.applyImageToContext(request, result);
					this.notifySideEffect(outcome.message, outcome.message);
				}
			} catch (error) {
				if (this.activeRun?.id === run.id && !this.isClosed) {
					const message = this.plugin.getErrorMessage(error);
					this.addMessage("system", `Generated image preserved. Output action failed: ${message}`);
					new Notice(message);
				}
			}
		} catch (error) {
			if (this.isClosed || this.activeRun?.id !== run.id || run.abortController.signal.aborted) {
				return;
			}

			const message = isAbortError(error) ? "AskMate request stopped." : this.plugin.getErrorMessage(error);
			if (!assistantMessage) {
				assistantMessage = this.createMessageEl("assistant", "", false);
			}
			this.cancelPendingMarkdown(assistantMessage.body);
			assistantMessage.body.setText(message);
			if (!isAbortError(error)) {
				this.createMessageAction(assistantMessage.actions, "rotate-ccw", "Retry request", () => {
					if (retrySnapshot.kind === "built") {
						void this.runRequest(retrySnapshot.request.question, retrySnapshot.request.title, {}, retrySnapshot.request);
					} else {
						void this.runRequest(retrySnapshot.question, retrySnapshot.title, retrySnapshot.options);
					}
				}, { requiresIdle: true });
			}
			// A status role keeps provider errors out of the thread history sent with the next request.
			this.messages.push({ role: "system", text: message });
			new Notice(message);
		} finally {
			if (!answered) {
				// An unanswered question would otherwise be resent as a dangling user turn.
				this.messages = this.messages.filter((message) => message !== userTurn);
				if (assistantMessage && run.abortController.signal.aborted && !this.isClosed) {
					if (responseText.trim()) {
						// Keep what arrived (a pending render still draws the latest text); it stays out of the thread.
						this.renderMessageWarning(assistantMessage, "Stopped. This reply is partial and was not saved.");
					} else {
						this.cancelPendingMarkdown(assistantMessage.body);
						assistantMessage.body.setText("Stopped.");
					}
				}
			}
			this.finishRun(run);
		}
	}

	private cancelPendingMarkdown(body: HTMLElement): void {
		const pending = this.markdownRenderTimers.get(body);
		if (pending !== undefined) {
			window.clearTimeout(pending);
			this.pendingMarkdownTimerIds.delete(pending);
			this.markdownRenderTimers.delete(body);
		}
		this.pendingMarkdown.delete(body);
		// Makes any in-flight render stale so it cannot replace the text set afterwards.
		body.dataset.askmateRenderId = "";
		this.releaseMarkdownComponent(body);
	}

	private renderIncompleteWarning(message: MessageElements, reason: string): void {
		const normalized = reason.toLowerCase();
		const explanation = /max_tokens|max_output_tokens|length|token/.test(normalized)
			? "the provider stopped at its output token limit"
			: /refusal|content_filter|safety|blocked|recitation|prohibited/.test(normalized)
				? "the provider refused or filtered part of the answer"
				: `the provider reported "${reason}"`;
		this.renderMessageWarning(message, `This reply may be incomplete: ${explanation}. Review it before applying it to a note.`);
	}

	private renderMessageWarning(message: MessageElements, text: string): void {
		const warning = message.wrapper.createDiv({
			cls: "askmate-budget-warning askmate-message-incomplete-warning",
			text
		});
		warning.setAttribute("role", "note");
		message.wrapper.insertBefore(warning, message.body);
		message.wrapper.addClass("askmate-message-incomplete");
	}

	/** System chat line + Notice for vault mutations that already succeeded. */
	private notifySideEffect(systemMessage: string, noticeMessage: string): void {
		if (!this.isClosed) {
			this.addMessage("system", systemMessage);
		}
		new Notice(noticeMessage);
	}

	private addMessage(role: ChatRole, text: string, editableText?: string, historyText?: string): ChatMessage {
		const chatMessage: ChatMessage = { role, text: historyText ?? text };
		this.messages.push(chatMessage);
		const message = this.createMessageEl(role, text, false);

		if (editableText) {
			this.createMessageAction(message.actions, "pencil", "Edit", () => {
				this.useTextInComposer(editableText);
			});
		}
		return chatMessage;
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
		const references = extractImageEmbedTargets(request.context.content);

		if (references.length === 0) {
			return;
		}

		// Remote URLs are never loaded: fetching them would leak the user's IP and any tokens in the URL.
		const remoteCount = references.filter((reference) => classifyImagePreviewSource(reference) === "remote").length;
		const available: ChatImagePreview[] = [];
		const seen = new Set<string>();

		for (const reference of references) {
			const preview = this.resolveImagePreview(reference, sourcePath);

			if (!preview || seen.has(preview.src)) {
				continue;
			}

			seen.add(preview.src);
			available.push(preview);
		}

		const previews = available.slice(0, MAX_CONTEXT_IMAGE_PREVIEWS);
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

		if (available.length > previews.length) {
			shell.createDiv({
				cls: "askmate-context-image-more",
				text: `Showing ${previews.length} of ${available.length} referenced images.`
			});
		}
		if (remoteCount > 0) {
			shell.createDiv({
				cls: "askmate-context-image-more",
				text: `${remoteCount} remote image${remoteCount === 1 ? " is" : "s are"} not loaded in previews.`
			});
		}

		this.messages.push({ role: "system", text: "Context images displayed." });
		this.maybeScrollMessagesToBottom();
	}

	private resolveImagePreview(reference: string, sourcePath: string): ChatImagePreview | null {
		const kind = classifyImagePreviewSource(reference);

		if (kind === "remote") {
			return null;
		}

		if (kind === "data") {
			return {
				label: describeDataImage(reference),
				src: reference
			};
		}

		const file = this.app.metadataCache.getFirstLinkpathDest(reference, sourcePath);

		if (!file || !IMAGE_FILE_EXTENSIONS.has(file.extension.toLowerCase())) {
			return null;
		}

		return {
			label: file.path,
			src: this.app.vault.getResourcePath(file)
		};
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
		}, { requiresIdle: true, lockKey: `review:${request.context.file?.path ?? "global"}` });
		this.createMessageAction(parent, "file-plus", "New note", async () => {
			const file = await this.plugin.createResultNote(request, getText(), { model });
			this.addMessage("system", `Created note: ${file.path}`);
			new Notice(`AskMate created ${file.path}`);
		}, { requiresIdle: true, lockKey: `mutation:${request.context.file?.path ?? "global"}` });
		this.createMessageAction(parent, "pencil", "Apply reply", async () => {
			const outcome = await this.plugin.applyResponseToContext(request, getText());
			this.addMessage("system", outcome.message);
			new Notice(outcome.message);
		}, { requiresIdle: true, lockKey: `mutation:${request.context.file?.path ?? "global"}` });
		if (request.context.source === "Current note") {
			this.createMessageAction(parent, "file-text", "Replace full note", async () => {
				const outcome = await this.plugin.applyResponseToContext(request, getText(), { scope: "full-note" });
				this.addMessage("system", outcome.message);
				new Notice(outcome.message);
			}, { requiresIdle: true, lockKey: `mutation:${request.context.file?.path ?? "global"}` });
		}
		if (request.context.source === "Selected text") {
			this.createMessageAction(parent, "text-cursor-input", "Apply selected block", async () => {
				const outcome = await this.plugin.applyResponseToContext(request, getText(), { scope: "selected-block" });
				this.addMessage("system", outcome.message);
				new Notice(outcome.message);
			}, { requiresIdle: true, lockKey: `mutation:${request.context.file?.path ?? "global"}` });
		}
		this.createMessageAction(parent, "heading-1", "Apply to heading", async () => {
			const heading = await askMatePrompt(this.app, "Heading title or path to replace, for example Project Plan > Risks", request.context.activeHeadingPath ?? "");
			if (heading === null) {
				return;
			}
			const outcome = await this.plugin.applyResponseToContext(request, getText(), {
				scope: "heading-section",
				headingPath: heading
			});
			this.addMessage("system", outcome.message);
			new Notice(outcome.message);
		}, { requiresIdle: true, lockKey: `mutation:${request.context.file?.path ?? "global"}` });
	}

	private renderGeneratedImage(body: HTMLElement, result: ImageAskMateResult): void {
		this.releaseMarkdownComponent(body);
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
		}, { requiresIdle: true, lockKey: `mutation:${request.context.file?.path ?? "global"}` });
		this.createMessageAction(parent, "image-plus", "Insert image", async () => {
			const outcome = await this.plugin.applyImageToContext(request, getResult());
			this.addMessage("system", outcome.message);
			new Notice(outcome.message);
		}, { requiresIdle: true, lockKey: `mutation:${request.context.file?.path ?? "global"}` });
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
		button.dataset.consoleLabel = CONSOLE_ACTION_LABELS[label] ?? label.toLowerCase().split(" ")[0];
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
			const lockKey = options.lockKey ?? (options.requiresIdle ? label : "");
			if (lockKey && this.activeActionKeys.has(lockKey)) {
				return;
			}
			if (lockKey) {
				this.activeActionKeys.add(lockKey);
				button.disabled = true;
			}

			void Promise.resolve(onClick()).catch((error) => {
				new Notice(this.plugin.getErrorMessage(error));
			}).finally(() => {
				if (lockKey) {
					this.activeActionKeys.delete(lockKey);
					button.disabled = options.requiresIdle ? Boolean(this.activeRun) : false;
				}
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
		// Throttle rather than debounce, so a steady stream of deltas still renders every 120 ms.
		this.pendingMarkdown.set(body, { markdown, sourcePath });
		if (this.markdownRenderTimers.has(body)) {
			return;
		}

		const timer = window.setTimeout(() => {
			this.markdownRenderTimers.delete(body);
			this.pendingMarkdownTimerIds.delete(timer);
			if ((this.markdownRendersInFlight.get(body) ?? 0) > 0) {
				// The in-flight render flushes the latest pending text when it settles.
				return;
			}
			const latest = this.pendingMarkdown.get(body);
			this.pendingMarkdown.delete(body);
			if (latest) {
				this.renderMarkdownNow(body, latest.markdown, latest.sourcePath);
			}
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
		this.pendingMarkdown.delete(body);

		const renderId = String(++this.markdownRenderId);
		body.dataset.askmateRenderId = renderId;
		body.dataset.askmateSourcePath = sourcePath;
		const isSimpleMarkdown = this.isSimpleMarkdownReply(markdown);
		body.classList.toggle("is-simple-markdown", isSimpleMarkdown);
		body.closest(".askmate-message")?.classList.toggle("askmate-message-simple-markdown", isSimpleMarkdown);

		if (!markdown.trim()) {
			this.releaseMarkdownComponent(body);
			body.empty();
			body.removeClass("is-simple-markdown");
			body.closest(".askmate-message")?.removeClass("askmate-message-simple-markdown");
			return;
		}

		// Created through body so it belongs to the view's own window (popouts included), then detached so the previous
		// reply stays on screen until this render finishes.
		const host = body.createDiv({ cls: "askmate-rendered-markdown" });
		host.detach();
		const component = this.addChild(new Component());
		const isCurrent = (): boolean => !this.isClosed && body.isConnected && body.dataset.askmateRenderId === renderId;
		this.markdownRendersInFlight.set(body, (this.markdownRendersInFlight.get(body) ?? 0) + 1);

		// Model output can carry prompt-injected remote images or plugin code blocks, so render a defused copy.
		void MarkdownRenderer.render(this.app, sanitizeModelMarkdown(markdown), host, sourcePath, component)
			.then(() => {
				if (!isCurrent()) {
					this.removeChild(component);
					return;
				}

				this.releaseMarkdownComponent(body);
				this.markdownComponents.set(body, component);
				body.empty();
				body.appendChild(host);
				this.maybeScrollMessagesToBottom();
			})
			.catch(() => {
				this.removeChild(component);
				if (isCurrent()) {
					this.releaseMarkdownComponent(body);
					body.setText(markdown);
				}
			})
			.finally(() => {
				this.settleMarkdownRender(body);
			});
	}

	private settleMarkdownRender(body: HTMLElement): void {
		const remaining = (this.markdownRendersInFlight.get(body) ?? 1) - 1;
		if (remaining > 0) {
			this.markdownRendersInFlight.set(body, remaining);
			return;
		}
		this.markdownRendersInFlight.delete(body);

		const latest = this.pendingMarkdown.get(body);
		if (latest && !this.markdownRenderTimers.has(body) && !this.isClosed && body.isConnected) {
			this.renderMarkdownNow(body, latest.markdown, latest.sourcePath);
		}
	}

	private releaseMarkdownComponent(body: HTMLElement): void {
		const component = this.markdownComponents.get(body);
		if (component) {
			this.markdownComponents.delete(body);
			this.removeChild(component);
		}
	}

	private releaseAllMarkdownComponents(): void {
		for (const component of this.markdownComponents.values()) {
			this.removeChild(component);
		}
		this.markdownComponents.clear();
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

	private async refreshReadiness(): Promise<void> {
		if (!this.readinessEl) {
			return;
		}
		const isReady = await this.plugin.isSelectedProviderConfigured();
		if (this.isClosed || !this.readinessEl) {
			return;
		}
		const label = isReady ? "AskMate · Ready" : "AskMate · Setup needed";
		this.readinessEl.setText(label);
		this.readinessEl.classList.toggle("is-api-key-set", isReady);
		this.readinessEl.classList.toggle("is-ready", isReady);
		this.readinessEl.classList.toggle("is-not-ready", !isReady);
		this.readinessEl.setAttribute("role", "status");
		this.readinessEl.setAttribute("aria-label", label);
		this.readinessEl.setAttribute("title", isReady ? "AskMate is ready" : "Configure the selected provider in AskMate settings");
	}

	private getRequestDefaultsKey(): string {
		const settings = this.plugin.settings;
		return JSON.stringify([
			settings.requestPrivacyDefaults,
			settings.contextBudgetMode,
			settings.additionalContextPaths,
			settings.folderContextEnabled,
			settings.folderContextPath,
			settings.folderContextMaxFiles
		]);
	}

	private resetRequestOptionsFromSettings(): void {
		this.requestDefaultsKey = this.getRequestDefaultsKey();
		this.privacyOptions = normalizeRequestPrivacyOptions(this.plugin.settings.requestPrivacyDefaults);
		this.contextBudgetMode = normalizeContextBudgetMode(this.plugin.settings.contextBudgetMode);
		this.additionalContextPaths = [...this.plugin.settings.additionalContextPaths];
		this.folderContextEnabled = this.plugin.settings.folderContextEnabled;
		this.folderContextPath = this.plugin.settings.folderContextPath;
		this.folderContextMaxFiles = this.plugin.settings.folderContextMaxFiles;
	}

	private syncRequestPreviewFromSettings(): void {
		// Unrelated saves (a workflow favourite, a UI toggle) must not silently undo the user's per-session choices,
		// such as turning note context off, while the checkbox still shows the old state.
		const defaultsChanged = this.getRequestDefaultsKey() !== this.requestDefaultsKey;
		if (defaultsChanged) {
			this.resetRequestOptionsFromSettings();
		}
		if (!this.composerEl) {
			return;
		}
		const existing = this.composerEl.querySelector(".askmate-request-preview");
		if (!this.plugin.settings.showRequestPreview) {
			existing?.remove();
			this.requestPreviewEl = null;
		} else if (!existing || defaultsChanged) {
			existing?.remove();
			this.requestPreviewEl = null;
			this.renderRequestPreview(this.composerEl);
		}
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

	private async openPromptInspector(questionOverride?: string, optionsOverride?: RunRequestOptions): Promise<void> {
		try {
			const raw = questionOverride?.trim() || this.questionEl.value.trim() || "Preview request";
			const command = this.parseComposerCommand(raw);
			const inspection = await this.plugin.inspectFinalPrompt(command.question, command.forceImage ? "AskMate Image" : "AskMate Answer", optionsOverride ?? {
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
		this.messagesEl?.setAttribute("aria-busy", String(isLoading));
		if (this.statusEl) {
			this.statusEl.setText(isLoading ? "AskMate is working." : "AskMate is ready for another request.");
		}
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
		this.refreshStopButton();
		this.setButtonLabel(this.sendButton, isLoading ? "Sending" : "Send");
		const sendShortcutLabel = this.getSendShortcutLabel();
		this.sendButton.setAttribute("aria-label", isLoading ? "Sending" : `Send (${sendShortcutLabel})`);
		this.sendButton.setAttribute("title", isLoading ? "Sending" : `Send (${sendShortcutLabel})`);
		this.refreshReasoningSelector();
		this.refreshWorkflowToggle();
		this.updateModelLabel();
		this.refreshConsoleStatus();
	}

	private setButtonLabel(button: HTMLButtonElement, label: string): void {
		const labelEl = button.querySelector<HTMLElement>(".askmate-action-label");

		if (labelEl) {
			labelEl.setText(label);
			return;
		}

		button.setText(label);
	}

	private isConsoleLayout(): boolean {
		return normalizeComposerLayout(this.plugin.settings.composerLayout) === "console";
	}

	private refreshConsoleCommands(): void {
		this.consoleCommands = buildConsoleCommands(this.plugin.getAllWorkflows());
	}

	private renderConsoleStatusBar(composer: HTMLElement): void {
		this.consoleStatusEl = composer.createDiv({ cls: "askmate-console-status" });
		this.consoleStatusEl.setAttribute("role", "group");
		this.consoleStatusEl.setAttribute("aria-label", "AskMate status");
		// The mode button is created once and updated in place: re-creating it on every refresh (refreshes run on
		// pointerdown and focusin) would replace it before a click could land.
		this.consoleModeButton = this.consoleStatusEl.createEl("button", { cls: "askmate-console-segment is-mode" });
		this.consoleModeButton.type = "button";
		this.consoleModeButton.addEventListener("click", () => {
			const order: OutputMode[] = ["chat", "note", "apply"];
			const current = order.indexOf(normalizeOutputMode(this.plugin.settings.outputMode));
			this.runUiTask(this.selectOutputMode(order[(current + 1) % order.length]));
		});
		this.consoleStatusSegmentsEl = this.consoleStatusEl.createDiv({ cls: "askmate-console-status-segments" });
		this.consoleStopButton = this.consoleStatusEl.createEl("button", { cls: "askmate-console-stop", text: "stop" });
		this.consoleStopButton.type = "button";
		this.consoleStopButton.hidden = true;
		this.consoleStopButton.addEventListener("click", () => {
			this.stopActiveRun();
		});
	}

	private refreshConsoleStatus(): void {
		if (!this.consoleStatusSegmentsEl) {
			return;
		}
		const ref = this.plugin.getSelectedProviderModelRef();
		const segments = formatConsoleStatus({
			mode: normalizeOutputMode(this.plugin.settings.outputMode),
			providerName: ref.providerName,
			model: ref.model,
			effort: this.plugin.supportsSelectedReasoningEffort() ? this.plugin.getSelectedReasoningEffort() : null,
			dayUsedTokens: this.plugin.getTodayTokenUsage(),
			dayBudgetTokens: this.plugin.settings.usageDailyTokenBudget
		});
		this.consoleStatusSegmentsEl.empty();
		for (const segment of segments) {
			if (segment.kind === "mode") {
				if (this.consoleModeButton) {
					this.consoleModeButton.setText(segment.text);
					this.consoleModeButton.setAttribute("title", segment.title);
					this.consoleModeButton.setAttribute("aria-label", segment.title);
					this.consoleModeButton.disabled = Boolean(this.activeRun);
				}
				continue;
			}
			const span = this.consoleStatusSegmentsEl.createSpan({ cls: `askmate-console-segment is-${segment.kind}`, text: segment.text });
			span.setAttribute("title", segment.title);
		}
	}

	/** Returns true when the console handled the key (completion, history or stop). */
	private handleConsoleKeydown(event: KeyboardEvent): boolean {
		if (event.isComposing) {
			return false;
		}
		const completion = this.consoleCompletion;
		if (completion && completion.items.length > 0) {
			if (event.key === "ArrowDown" || event.key === "ArrowUp") {
				event.preventDefault();
				const step = event.key === "ArrowDown" ? 1 : -1;
				completion.index = (completion.index + step + completion.items.length) % completion.items.length;
				completion.navigated = true;
				this.renderConsoleCompletions();
				return true;
			}
			if (event.key === "Tab") {
				event.preventDefault();
				this.acceptConsoleCompletion(completion.index);
				return true;
			}
			// Enter accepts the highlighted suggestion, unless the typed token is already a complete command or mention
			// and the user did not move through the list; then Enter sends as usual (Ctrl/Cmd+Enter always sends).
			if (event.key === "Enter" && !event.shiftKey && !event.metaKey && !event.ctrlKey) {
				const typed = this.questionEl.value.slice(completion.from, completion.to);
				const highlighted = completion.items[completion.index];
				const alreadyComplete = completion.items.some((item) => item.insertText.trim() === typed);
				if (highlighted && (completion.navigated || !alreadyComplete)) {
					event.preventDefault();
					this.acceptConsoleCompletion(completion.index);
					return true;
				}
			}
			if (event.key === "Escape") {
				event.preventDefault();
				this.closeConsoleCompletions();
				return true;
			}
		}
		if (event.key === "Escape" && this.activeRun) {
			event.preventDefault();
			this.stopActiveRun();
			return true;
		}
		if ((event.key === "ArrowUp" || event.key === "ArrowDown") && this.canBrowseConsoleHistory()) {
			event.preventDefault();
			this.browseConsoleHistory(event.key === "ArrowUp" ? -1 : 1);
			return true;
		}
		return false;
	}

	private canBrowseConsoleHistory(): boolean {
		const value = this.questionEl.value;
		// Only an empty prompt or one showing a recalled entry browses history, so arrows still move the caret while editing.
		return this.consoleHistory.length > 0
			&& (value === "" || (this.consoleHistoryIndex >= 0 && value === this.consoleHistory[this.consoleHistoryIndex]));
	}

	private browseConsoleHistory(direction: -1 | 1): void {
		const length = this.consoleHistory.length;
		const current = this.consoleHistoryIndex === -1 ? length : this.consoleHistoryIndex;
		const next = Math.max(0, Math.min(length, current + direction));
		this.consoleHistoryIndex = next === length ? -1 : next;
		this.questionEl.value = next === length ? "" : this.consoleHistory[next];
		const end = this.questionEl.value.length;
		this.questionEl.setSelectionRange(end, end);
	}

	private rememberConsoleInput(raw: string): void {
		if (this.consoleHistory[this.consoleHistory.length - 1] !== raw) {
			this.consoleHistory = [...this.consoleHistory, raw].slice(-50);
		}
		this.consoleHistoryIndex = -1;
	}

	private updateConsoleCompletions(): void {
		if (!this.isConsoleLayout() || !this.questionEl) {
			this.closeConsoleCompletions();
			return;
		}
		const value = this.questionEl.value;
		const result = getConsoleCompletions(value, this.questionEl.selectionStart ?? value.length, this.consoleCommands);
		if (result.items.length === 0) {
			this.closeConsoleCompletions();
			return;
		}
		this.consoleCompletion = { ...result, index: 0, navigated: false };
		this.renderConsoleCompletions();
	}

	private renderConsoleCompletions(): void {
		const list = this.consoleCompletionsEl;
		const completion = this.consoleCompletion;
		if (!list || !completion) {
			return;
		}
		list.empty();
		completion.items.forEach((item, index) => {
			const option = list.createDiv({ cls: "askmate-console-completion", attr: { id: `${this.consoleIdPrefix}-option-${index}`, role: "option" } });
			option.setAttribute("aria-selected", String(index === completion.index));
			option.classList.toggle("is-selected", index === completion.index);
			option.createSpan({ cls: "askmate-console-completion-label", text: item.label });
			option.createSpan({ cls: "askmate-console-completion-detail", text: item.detail });
			// mousedown keeps focus in the prompt, so the blur handler does not close the list before the click lands.
			option.addEventListener("mousedown", (event) => {
				event.preventDefault();
				this.acceptConsoleCompletion(index);
			});
		});
		list.hidden = false;
		this.questionEl.setAttribute("aria-expanded", "true");
		this.questionEl.setAttribute("aria-activedescendant", `${this.consoleIdPrefix}-option-${completion.index}`);
	}

	private acceptConsoleCompletion(index: number): void {
		const completion = this.consoleCompletion;
		const item = completion?.items[index];
		if (!completion || !item) {
			return;
		}
		const value = this.questionEl.value;
		this.questionEl.value = `${value.slice(0, completion.from)}${item.insertText}${value.slice(completion.to)}`;
		const caret = completion.from + item.insertText.length;
		this.questionEl.setSelectionRange(caret, caret);
		this.closeConsoleCompletions();
		this.updateConsoleCompletions();
		this.questionEl.focus();
	}

	private closeConsoleCompletions(): void {
		this.consoleCompletion = null;
		if (this.consoleCompletionsEl) {
			this.consoleCompletionsEl.hidden = true;
			this.consoleCompletionsEl.empty();
		}
		this.questionEl?.removeAttribute("aria-activedescendant");
		if (this.isConsoleLayout()) {
			this.questionEl?.setAttribute("aria-expanded", "false");
		}
	}

	/** Echo of a typed command. Kept out of `messages`, so commands never become thread history. */
	private echoConsoleCommand(raw: string): void {
		const echo = this.createMessageEl("system", raw, false);
		echo.wrapper.addClass("askmate-console-echo");
	}

	private printConsoleOutput(text: string, tone: "info" | "error" = "info"): void {
		const output = this.createMessageEl("system", text, false);
		output.wrapper.addClass("askmate-console-output");
		output.wrapper.classList.toggle("is-error", tone === "error");
	}

	/** Maps @mentions onto the existing request options; throws when a mention cannot be honoured. */
	private applyConsoleMentions(options: RunRequestOptions, mentions: ConsoleMentions): RunRequestOptions {
		const baseFolder = options.folderContext ?? this.getFolderContextOptions();
		const folderPath = mentions.folder === null ? baseFolder.path : mentions.folder || this.plugin.settings.folderContextPath || baseFolder.path;
		if (mentions.folder !== null && !folderPath.trim()) {
			throw new Error("@folder needs a folder. Use @folder:Path/To/Folder, or set a folder in AskMate settings.");
		}
		if (mentions.folder !== null && !(this.app.vault.getAbstractFileByPath(folderPath.trim().replace(/^\/+|\/+$/g, "")) instanceof TFolder)) {
			throw new Error(`@folder: there is no folder called "${folderPath}" in this vault.`);
		}
		const sourcePath = this.app.workspace.getActiveFile()?.path ?? "";
		const missing = mentions.notes.filter((note) => !this.app.metadataCache.getFirstLinkpathDest(note, sourcePath));
		if (missing.length > 0) {
			throw new Error(`No note found for ${missing.map((note) => `@[[${note}]]`).join(", ")}. Check the name and try again.`);
		}
		return {
			...options,
			additionalContextPaths: normalizeContextPathList([...(options.additionalContextPaths ?? this.additionalContextPaths), ...mentions.notes]),
			folderContext: mentions.folder === null ? baseFolder : { ...baseFolder, enabled: true, path: folderPath },
			contextScope: mentions.scope
		};
	}

	private async submitConsoleInput(): Promise<void> {
		const raw = this.questionEl.value.trim();
		if (!raw) {
			new Notice("Type a question, or /help for commands.");
			return;
		}
		this.closeConsoleCompletions();
		const action = parseConsoleInput(raw, this.consoleCommands);
		const sendsRequest = action.kind === "ask" || action.kind === "image" || action.kind === "workflow";
		if (sendsRequest && !this.ensureIdleForNewRequest()) {
			return;
		}
		this.rememberConsoleInput(raw);

		try {
			await this.runConsoleAction(action, raw);
		} catch (error) {
			// Each action clears the prompt only after its risky work succeeded, so the typed text is still there to fix.
			this.echoConsoleCommand(raw);
			this.printConsoleOutput(this.plugin.getErrorMessage(error), "error");
		}
	}

	/** Clears the prompt and echoes the command once the action is known to succeed. */
	private commitConsoleCommand(raw: string, echo = true): void {
		this.questionEl.value = "";
		if (echo) {
			this.echoConsoleCommand(raw);
		}
	}

	private async switchLayout(layout: ComposerLayout): Promise<void> {
		this.plugin.settings.composerLayout = layout;
		await this.plugin.saveSettings();
		this.plugin.refreshOpenAskMateViews();
		new Notice(layout === "console"
			? "AskMate layout: console. Type /layout compact to switch back."
			: `AskMate layout: ${layout}. Type /layout console to come back.`);
	}

	private async runConsoleAction(action: ConsoleAction, raw: string): Promise<void> {
		switch (action.kind) {
			case "error":
				this.echoConsoleCommand(raw);
				this.printConsoleOutput(action.message, "error");
				return;
			case "help":
				this.commitConsoleCommand(raw);
				this.printConsoleOutput(formatConsoleHelp(this.consoleCommands));
				return;
			case "clear":
				if (this.activeRun) {
					throw new Error("Stop the current request before clearing the conversation.");
				}
				this.commitConsoleCommand(raw, false);
				this.clearChat();
				return;
			case "mode":
				if (this.activeRun) {
					throw new Error("Wait for the current request to finish, or press Esc to stop it, before changing the output mode.");
				}
				await this.selectOutputMode(action.mode);
				this.commitConsoleCommand(raw);
				this.printConsoleOutput(`Output mode: ${formatOutputMode(action.mode)}.`);
				return;
			case "effort": {
				if (action.effort) {
					if (this.activeRun) {
						throw new Error("Wait for the current request to finish, or press Esc to stop it, before changing reasoning effort.");
					}
					await this.selectReasoningEffort(action.effort);
				}
				this.commitConsoleCommand(raw);
				const supported = this.plugin.supportsSelectedReasoningEffort();
				this.printConsoleOutput(`Reasoning effort: ${this.plugin.getSelectedReasoningEffort()}.${supported ? "" : " The selected model does not use reasoning effort."}`);
				return;
			}
			case "layout":
				await this.switchLayout(action.layout);
				this.commitConsoleCommand(raw, false);
				return;
			case "context": {
				const options = this.applyConsoleMentions(this.getRequestDraftOptions(false), action.mentions);
				const lines = await this.describeConsoleContext(options);
				this.commitConsoleCommand(raw);
				this.printConsoleOutput(lines.text, lines.blocked ? "error" : "info");
				return;
			}
			case "inspect": {
				const options = this.applyConsoleMentions(this.getRequestDraftOptions(false), action.mentions);
				this.commitConsoleCommand(raw);
				await this.openPromptInspector(action.question || "Preview request", options);
				return;
			}
			case "history":
				this.commitConsoleCommand(raw);
				await this.showNoteHistory();
				return;
			case "ask": {
				const draft = this.getRequestDraftOptions(false);
				const withMode = action.outputMode ? { ...draft, outputMode: action.outputMode } : draft;
				// A "//" line is sent as typed: "//image x" asks about "/image x" and never generates an image.
				const options = this.applyConsoleMentions(action.literal ? { ...withMode, intentKind: "freeform_text" } : withMode, action.mentions);
				if (!(await this.isProviderReadyForSubmit("Configure the selected AskMate provider in settings before sending."))) {
					return;
				}
				this.commitConsoleCommand(raw, false);
				await this.runRequest(action.question, "AskMate Answer", options, undefined, raw);
				return;
			}
			case "image": {
				const options = this.applyConsoleMentions(this.getRequestDraftOptions(true), action.mentions);
				if (!(await this.isProviderReadyForSubmit("Add an OpenAI API key in AskMate settings before generating an image.", () => this.plugin.isImageGenerationConfigured()))) {
					return;
				}
				this.commitConsoleCommand(raw, false);
				await this.runRequest(action.prompt, "AskMate Image", options, undefined, raw);
				return;
			}
			case "workflow": {
				const workflow = this.plugin.getAllWorkflows().find((candidate) => candidate.id === action.workflowId);
				if (!workflow) {
					throw new Error("That workflow no longer exists. Type /help to see the current list.");
				}
				if (this.plugin.getSelectedProviderModelRef().capability !== "text") {
					throw new Error(IMAGE_WORKFLOW_MESSAGE);
				}
				// The runner rebuilds workflow prompts from the template, so extra text travels as its own option.
				const options = this.applyConsoleMentions({ workflow, workflowExtra: action.extra || undefined }, action.mentions);
				if (!(await this.isProviderReadyForSubmit("Configure the selected AskMate provider in settings before running a workflow."))) {
					return;
				}
				this.commitConsoleCommand(raw, false);
				await this.runRequest(this.plugin.getWorkflowPrompt(workflow), workflow.name, options, undefined, raw);
				return;
			}
		}
	}

	private async describeConsoleContext(options: RunRequestOptions): Promise<{ text: string; blocked: boolean }> {
		const inspection = await this.plugin.inspectFinalPrompt("Preview request", "AskMate Answer", options);
		const request = inspection.request;
		const metadata = request.metadata;
		const lines = [
			`source    ${request.context.source}: ${request.context.file?.path ?? "unsaved note"}`,
			`provider  ${inspection.providerName}: ${inspection.model}`,
			`output    ${formatOutputMode(metadata.outputMode)}`,
			`tokens    about ${inspection.estimatedInputTokens.toLocaleString()} input`,
			`context   ${metadata.privacy.includeNoteContext
				? `${metadata.promptContextCharacters.toLocaleString()}${metadata.contextTruncated ? ` of ${metadata.contextCharacters.toLocaleString()}` : ""} characters, ${metadata.contextBudgetMode} budget`
				: "note text withheld by privacy settings"}`,
			`attached  ${metadata.contextAttachmentSources.length > 0 ? metadata.contextAttachmentSources.join(", ") : "nothing else"}`,
			`privacy   note text ${metadata.privacy.includeNoteContext ? "on" : "off"}, image links ${metadata.privacy.includeImageReferences ? "on" : "off"}`,
			...inspection.blockers.map((blocker) => `blocked   ${blocker}`),
			...inspection.warnings.map((warning) => `warning   ${warning}`)
		];
		return { text: lines.join("\n"), blocked: inspection.blockers.length > 0 };
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
