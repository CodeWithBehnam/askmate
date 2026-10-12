import { Component, ItemView, Keymap, MarkdownRenderer, MarkdownView, Menu, Notice, TFolder, setIcon, type WorkspaceLeaf } from "obsidian";
import type { AskMatePlugin } from "../../plugin/AskMatePlugin";
import { getStatusBarOverlap } from "./statusBarOverlap";
import { describeIncompleteReason, lastAnswerFromMessages, SAVED_INCOMPLETE_REASON } from "./answerActions";
import type { InsertableReply } from "./components/insertPlan";
import { copyAnswerText, insertAnswerAtRememberedCursor } from "./answerShell";
import { ModelPickerModal } from "./ModelPickerModal";
import {
	applyChatSelection,
	buildModelChoices,
	formatModelListing,
	formatProviderListing,
	listProviderModels,
	providerNeedsApiKey,
	resolveModelQuery,
	resolveProviderQuery,
	type ModelChoice
} from "./modelSwitch";
import { ASKMATE_ICON_ID, TEXT_PROVIDER_IDS, TEXT_PROVIDER_LABELS } from "../../settings/constants";
import type { TextProviderId } from "../../shared/types";
import {
	ASKMATE_VIEW_TYPE,
	AskRequest,
	ChatImagePreview,
	ChatRole,
	ComposerLayout,
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
	IMAGE_KEY_MISSING_MESSAGE,
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
	RunRequestOptions,
	Workflow
} from "../../shared/core";
import type { DiagramRequestMetadata } from "../../shared/types";
import { AskMatePromptInspectorModal, AskMateTextViewerModal, AskMateNoteHistoryModal, askMateConfirm, askMatePrompt } from "../modals/modals";
import { AskMateThreadPickerModal } from "../modals/threadModals";
import { conversationToMarkdown, hasExportableTurns, resolveExportTitle } from "../../output/conversationExport";
import {
	applyPathChangeToLiveMessages,
	createThread,
	createThreadId,
	fromSavedMessages,
	renameThreadValue,
	settleThreadMessages,
	withThreadMessages,
	withThreadSkillIds,
	type ChatMessageLike,
	type SavedThread
} from "../../threads/threadModel";
import { classifyImagePreviewSource, describeDataImage, extractImageEmbedTargets, sanitizeModelMarkdown } from "./renderSafety";
import {
	buildConsoleCommands,
	classifyConsoleAction,
	formatConsoleHelp,
	formatConsoleStatus,
	getConsoleCompletions,
	parseConsoleInput,
	type ConsoleAction,
	type ConsoleCommand,
	type ConsoleCompletion,
	type ConsoleMentions
} from "./consoleCommands";
import { createScratchHost, mountSvg, nextRenderId, sourceHash } from "../../diagrams";
import { MAX_SKILLS_PER_REQUEST, type Skill, type SkillSuggestion } from "../../skills";
import { NO_NOTE_SOURCE } from "../../context/ContextService";
import type { ProviderConnectionTestResult } from "../../providers";
import type { DiagramRunResult, ExtendedBuildOptions, RunPhaseEvent, RunResult, SkillSelection, ToolApprovalCard, ToolApprovalChoice, ToolUiEvent } from "../../requests/runTypes";
import {
	checkApiKeyInput,
	getProviderCatalogEntry,
	isReadyToSend,
	mapProviderErrorToSetupCopy,
	SETUP_ACTIONS,
	type SetupAction,
	type SetupErrorCopy,
	type SetupStage,
	type StarterChip
} from "../../setup";
import { createAnnouncer, type Announcer } from "./components/announcer";
import { onboardingTipText } from "./components/onboardingTip";
import { renderDiagramCard, type DiagramCardHandle, type DiagramPreviewHost, type DrawResult } from "./components/DiagramCard";
import { presentRunError, type ErrorPresentation } from "./components/errorFix";
import { parsePlainComposerCommand, readComposerLine, resolveDraftRequest, type DraftResolution } from "./components/draftRequest";
import {
	buildFixQuestion,
	canonicalDiagramText,
	describeDiagramCard,
	diagramCardStatus,
	DEFAULT_DIAGRAM_QUESTION,
	FALLBACK_INSERT_REASON,
	firstLook,
	insertMarkFor,
	MERMAID_SKILL_ID,
	nextLook,
	proseAroundDiagram,
	savedDiagramSummary,
	withDiagramMark,
	withDiagramMetadata
} from "./components/diagramModel";
import { canUndoDraft, mergeIntoDraft, type DraftUndo } from "./components/composerDraft";
import { runGuardedAction, type GuardedTaskContext } from "./components/guardedAction";
import { decideLinkClick } from "./components/linkClicks";
import { describeOutputBadge, modeAfterRun } from "./components/outputMode";
import { planReplyActions, type ReplyActionSpec } from "./components/replyActions";
import { planRetry, selectionSignature, type RetryTicket } from "./components/retry";
import { deriveSetupCardModel, overlayTestResult, type SetupCardError } from "./components/setupCardModel";
import { renderSetupCard, type SetupCardDraft, type SetupCardHandle } from "./components/SetupCard";
import { buildSkillChips, renderSkillChips, skillChipsSignature } from "./components/SkillChips";
import {
	buildSkillSelection,
	describeSkillBadge,
	formatSkillsListing,
	lookUpSkill,
	skillStatusLabel,
	wasSkillAutomatic
} from "./components/skillSelection";
import { buildStatusSegments, createStatusSegments, formatMcpStatus, type StatusSegmentsHandle } from "./components/statusSegments";
import { DRAWING_DIAGRAM_TEXT, isRenderCurrent, planStreamRender, streamRenderDelay } from "./components/streamingDiagram";
import { createToolCallCard, renderSavedToolCalls, type ToolCardHandle } from "./components/ToolCallCard";
import { mergeToolEvent, planToolUse, summariseToolCalls, type ToolUsePlan } from "./components/toolModel";
import { createRunController, type RunController, type RunRecord } from "./runController";

let consoleViewCounter = 0;

/** Short labels shown as [label] in the Console layout; the full label stays the accessible name. */
const CONSOLE_ACTION_LABELS: Record<string, string> = {
	"Show reply text": "text",
	"Use reply as a new question": "reuse",
	"Queue for review": "queue",
	"Save as new note": "note",
	"Apply": "apply",
	"Replace the whole note": "replace",
	"Apply to the selected text": "apply-sel",
	"Apply to a heading": "heading",
	"Run again without skill": "no-skill",
	"More actions": "more",
	"Retry request": "retry",
	"Edit": "edit",
	"Copy": "copy",
	"Insert": "cursor",
	"Show image prompt": "prompt",
	"New image note": "note",
	"Insert image": "insert"
};

/** Where the setup card keeps what the person is doing between redraws. */
interface SetupFlowState {
	flowOpen: boolean;
	welcomeOpen: boolean;
	provider: TextProviderId | null;
	/** What was typed into the card, and the provider it was typed for. A draft is never carried to another provider. */
	draft: SetupCardDraft;
	draftProvider: TextProviderId | null;
	test: { status: "ok" | "failed"; providerId: TextProviderId; model: string; copy?: SetupErrorCopy; at: number; suggestedModel?: string } | null;
	testing: boolean;
	localError: SetupCardError | null;
}

/** Everything one request needs, so Retry, Another look and Fix can start it again from the same description. */
interface RunSpec {
	question: string;
	title: string;
	options: RunRequestOptions;
	builtRequest?: AskRequest;
	displayText?: string;
	/** Claims the caller holds itself (Retry's own) that must not count as busy. */
	ignoreKeys?: readonly string[];
	/** Skills named for this question only: chips, @skill:name, /skill name question, a diagram request. */
	skillRefs?: readonly string[];
	/** "Run again without skill". */
	suppressAutoSkills?: boolean;
	/** The look of a diagram request. */
	diagram?: DiagramRequestMetadata;
	/** Retry reuses the question that failed instead of adding it a second time. */
	reuse?: { userTurn: ChatMessageLike; userElements: MessageElements | null; errorElements: MessageElements | null };
	/** Called once the request is built and accepted, when the typed text can leave the composer. */
	onSent?: (() => void) | undefined;
}

type ReplyHandler = (context: GuardedTaskContext) => void | Promise<void>;
type ReplyActionOptions = MessageActionOptions & { variant?: "primary" | "more"; disabledReason?: string | null };

/** How long a connection test run from this view outranks the plugin's own record of the last test. */
const LOCAL_TEST_MAX_AGE_MS = 10 * 60 * 1000;

/** What the usage guardrails throw when the person answers Cancel at the size warning. */
const DECLINED_AT_WARNING = /cancelled by usage guardrails/i;

/** Pictures drawn for diagram cards are kept by source; this many are enough for a long conversation. */
const MAX_CACHED_DIAGRAMS = 24;

function emptySetupDraft(): SetupCardDraft {
	return { apiKey: "", baseUrl: "", model: "" };
}

/** A request made with no note open carries the "No note" source; until the shared type names it, it is read as a string. */
function isNoNoteSource(source: string): boolean {
	return source === NO_NOTE_SOURCE;
}

function assertNeverAction(action: never): never {
	throw new Error(`Unhandled console action: ${JSON.stringify(action)}`);
}

function assertNeverSetupAction(kind: never): never {
	throw new Error(`Unhandled setup action: ${String(kind)}`);
}

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
	/** Which request is running and which short claims are held; the view only wires it to buttons. */
	private readonly runs: RunController = createRunController();
	private isClosed = false;
	private messages: ChatMessageLike[] = [];
	/** Questions whose run is still going. They are left out of a saved snapshot, so a question never saves without its answer. */
	private readonly pendingTurns = new Set<ChatMessageLike>();
	/** Identity and title of the conversation shown in the sidebar; its messages live in `messages`. */
	private threadMeta: SavedThread = this.createFreshThread();
	/** Generated images are saved to the vault later, so the path is read from the result when a snapshot is taken. */
	private readonly generatedImages = new WeakMap<ChatMessageLike, { savedImagePath: string | null }>();
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
	private consoleCommands: ConsoleCommand[] = [];
	private consoleCompletionsEl: HTMLElement | null = null;
	private consoleStatusEl: HTMLElement | null = null;
	private statusSegments: StatusSegmentsHandle | null = null;
	private lastAnswer: InsertableReply | null = null;
	private consoleStopButton: HTMLButtonElement | null = null;
	private consoleCompletion: { from: number; to: number; items: ConsoleCompletion[]; index: number; navigated: boolean } | null = null;
	/** Unique per view, so two open AskMate sidebars never share listbox or option ids. */
	private readonly consoleIdPrefix = `askmate-console-${++consoleViewCounter}`;
	private consoleHistory: string[] = [];
	private consoleHistoryIndex = -1;
	/** One status element for assistive technology; streamed text never goes there. */
	private announcer: Announcer | null = null;
	/** The Connect card lives in the transcript as its first entry, in every layout. */
	private setupHostEl: HTMLElement | null = null;
	private setupHandle: SetupCardHandle | null = null;
	private readonly setup: SetupFlowState = {
		flowOpen: false,
		welcomeOpen: false,
		provider: null,
		draft: emptySetupDraft(),
		draftProvider: null,
		test: null,
		testing: false,
		localError: null
	};
	private hasOpenNote = false;
	/** The note about a tool server that is not trusted yet is said once per sidebar, not on every question. */
	private toolTrustNoticeShown = false;
	/** Skills chosen for the next question only. Conversation-wide skills live in `threadMeta.skillIds`. */
	private onceSkillIds: string[] = [];
	private skillChipsEl: HTMLElement | null = null;
	private skillChipsSignature = "";
	private skillChipsTimer = 0;
	private skillPickerButton: HTMLButtonElement | null = null;
	/** The console line already echoed for this submit, so a failure after an early echo does not echo it again. */
	private echoedConsoleLine: string | null = null;
	private draftUndo: DraftUndo | null = null;
	private draftUndoEl: HTMLElement | null = null;
	private outputBadgeEl: HTMLElement | null = null;
	/** Previews of linked pictures are off until the person turns them on with /images. */
	private imagePreviewsEnabled = false;
	/** Drawn previews by diagram source, so scrolling back or re-showing a conversation never draws the same diagram twice. */
	private readonly diagramPreviews = new Map<string, string>();
	private readonly toolCards = new Map<string, ToolCardHandle>();
	/** What streaming last rendered into each body, and the "Drawing the diagram..." note beside it. */
	private readonly streamedText = new WeakMap<HTMLElement, string>();
	private readonly drawingNotes = new WeakMap<HTMLElement, HTMLElement>();

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
		return ASKMATE_ICON_ID;
	}

	private get activeRun(): RunRecord | null {
		return this.runs.getActiveRun();
	}

	async onOpen(): Promise<void> {
		// One AskMate sidebar at a time: two would save over each other's conversation.
		const existing = this.app.workspace.getLeavesOfType(ASKMATE_VIEW_TYPE).find((leaf) => leaf !== this.leaf);
		if (existing) {
			this.isClosed = true;
			this.leaf.detach();
			await this.app.workspace.revealLeaf(existing);
			return;
		}

		const container = this.containerEl.children[1] as HTMLElement;
		container.empty();
		container.addClass("askmate-sidebar");
		this.rootEl = container;
		this.applyComposerLayoutClass();
		this.isClosed = false;
		this.runs.shutdown();
		this.pendingTurns.clear();
		// Keep DOM and logical transcript aligned: reopening rebuilds the message pane from the saved thread, if any.
		this.messages = [];
		this.threadMeta = this.createFreshThread();
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
		this.skillChipsEl = null;
		this.draftUndoEl = null;
		this.outputBadgeEl = null;
		this.setupHandle = null;
		this.setupHostEl = null;
		this.statusSegments = null;
		this.skillChipsSignature = "";
		this.onceSkillIds = [];
		this.resetRequestOptionsFromSettings();
		this.workflowsVisible = false;
		this.onboardingTipsShown = false;
		this.imagePreviewsEnabled = this.readImagePreviewSetting();

		this.plugin.rememberActiveMarkdownContext();

		// A quiet, labelled region: streamed text is not a live region, because a screen reader would read it word by word.
		this.messagesEl = container.createDiv({ cls: "askmate-messages" });
		this.messagesEl.setAttribute("role", "region");
		this.messagesEl.setAttribute("aria-label", "AskMate conversation");
		this.messagesEl.tabIndex = 0;
		this.statusEl = container.createDiv({ cls: "askmate-visually-hidden" });
		this.statusEl.setAttribute("role", "status");
		this.statusEl.setAttribute("aria-live", "polite");
		this.statusEl.setAttribute("aria-atomic", "true");
		this.announcer = createAnnouncer((text) => this.statusEl?.setText(text));
		this.shouldFollowMessages = true;
		this.registerDomEvent(this.messagesEl, "scroll", () => {
			this.shouldFollowMessages = this.isScrolledNearBottom();
		});
		// Capture phase: this runs before Obsidian's own link handling, so a blocked link never reaches it.
		this.registerDomEvent(this.messagesEl, "click", (event) => {
			this.handleTranscriptLink(event);
		}, { capture: true });
		this.registerDomEvent(this.messagesEl, "auxclick", (event) => {
			if (event.button === 1) {
				this.handleTranscriptLink(event);
			}
		}, { capture: true });
		this.mountSetupHost();

		this.register(this.plugin.threads.onDidClear(() => this.handleThreadsCleared()));
		this.register(this.plugin.threads.onDidRewritePaths((change) => this.handlePathChange(applyPathChangeToLiveMessages(this.messages, change))));
		this.register(this.plugin.skillService.onChange(() => this.scheduleSkillChips()));

		this.refreshConsoleCommands();
		this.renderWorkflowGrid(container);
		this.renderComposer(container);
		this.refreshConsoleStatus();
		this.restoreActiveThread();
		this.refreshSetupCard();
		this.refreshSkillChips();

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

	/**
	 * Every link in the transcript is decided here, in the capture phase. MarkdownRenderer emits wikilinks as
	 * `a.internal-link` but leaves navigation to the host view, and Obsidian opens `obsidian://` links without asking,
	 * so a link that is not a web link or a note that exists is stopped and never reaches Obsidian.
	 */
	private handleTranscriptLink(event: MouseEvent): void {
		// targetNode and instanceOf stay correct when the sidebar is moved to a popout window.
		const target = event.targetNode;
		if (!target || !target.instanceOf(Element)) {
			return;
		}
		const link = target.closest("a");
		if (!link || !this.messagesEl.contains(link)) {
			return;
		}
		const internalClass = link.classList.contains("internal-link");
		const decision = decideLinkClick({
			rawHref: internalClass ? link.getAttribute("data-href") ?? link.getAttribute("href") : link.getAttribute("href"),
			internalClass,
			sourcePath: link.closest("[data-askmate-source-path]")?.getAttribute("data-askmate-source-path") ?? "",
			newLeaf: Keymap.isModEvent(event) !== false,
			resolve: (linkpath, sourcePath) => {
				const file = this.app.metadataCache.getFirstLinkpathDest(linkpath, sourcePath);
				return file ? { path: file.path } : null;
			}
		});
		if (decision.kind === "ignore") {
			return;
		}
		event.preventDefault();
		event.stopPropagation();
		if (decision.kind === "block") {
			this.notify(decision.message);
			return;
		}
		if (decision.decision.kind === "open") {
			const open = decision.decision;
			void this.app.workspace.openLinkText(open.linktext, open.sourcePath, Keymap.isModEvent(event))
				.catch((error: unknown) => this.notify(this.plugin.getErrorMessage(error)));
		} else if (decision.decision.kind === "notice") {
			this.notify(decision.decision.message);
		}
	}

	/** A Notice, mirrored into the status element because Notices are silent to screen readers. */
	private notify(message: string): void {
		new Notice(message);
		this.announcer?.announce({ kind: "notice", message });
	}

	private readImagePreviewSetting(): boolean {
		try {
			return this.app.loadLocalStorage("askmate-image-previews") === "on";
		} catch {
			return false;
		}
	}

	private writeImagePreviewSetting(enabled: boolean): void {
		try {
			this.app.saveLocalStorage("askmate-image-previews", enabled ? "on" : null);
		} catch {
			// The choice then lasts until the sidebar closes, which is the safe side of a failed write.
		}
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
		this.refreshSetupCard();
		this.refreshSkillChips();
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

	/** The prompt is a combobox with a suggestion list in every layout, because commands and mentions work in every layout. */
	private applyConsolePromptSemantics(): void {
		if (!this.questionEl) {
			return;
		}
		this.questionEl.setAttribute("role", "combobox");
		this.questionEl.setAttribute("aria-autocomplete", "list");
		this.questionEl.setAttribute("aria-controls", `${this.consoleIdPrefix}-completions`);
		this.questionEl.setAttribute("aria-expanded", String(Boolean(this.consoleCompletion)));
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
		// The Connect card says what to do first, and an open conversation needs no tips; they wait for an empty chat.
		if (this.setupHandle || this.messages.length > 0) {
			return;
		}

		this.onboardingTipsShown = true;
		const message = this.createMessageEl("system", "", false);
		message.wrapper.addClass("askmate-onboarding-message");
		message.body.empty();
		const card = message.body.createDiv({ cls: "askmate-onboarding-card" });
		const title = card.createEl("h3");
		setIcon(title.createSpan({ cls: "askmate-brand-mark", attr: { "aria-hidden": "true" } }), ASKMATE_ICON_ID);
		title.appendText("AskMate tips");
		card.createEl("p", { text: onboardingTipText(normalizeComposerLayout(this.plugin.settings.composerLayout)) });
		const dismiss = card.createEl("button", { text: "Dismiss tips" });
		dismiss.type = "button";
		dismiss.addEventListener("click", () => {
			void (async () => {
				this.plugin.settings.onboardingTipsDismissedAt = new Date().toISOString();
				await this.plugin.saveSettings();
				message.wrapper.remove();
			})().catch((error) => this.notify(this.plugin.getErrorMessage(error)));
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
		return `Ask about the note, or type / for commands and @ for context. ${suffix}`;
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
		setIcon(headerLeft.createSpan({ cls: "askmate-brand-mark", attr: { "aria-hidden": "true" } }), ASKMATE_ICON_ID);
		const brand = headerLeft.createDiv({ cls: "askmate-composer-brand", text: "AskMate" });
		this.readinessEl = brand;
		this.readinessEl.addEventListener("click", () => this.openSetupFromReadiness());
		this.readinessEl.addEventListener("keydown", (event) => {
			if (event.key === "Enter" || event.key === " ") {
				event.preventDefault();
				this.openSetupFromReadiness();
			}
		});
		void this.refreshReadiness();
		this.contextEl = this.createActionButton(headerLeft, "file-text", "Show request context", "askmate-context-button");
		this.contextEl.addEventListener("click", () => {
			void this.showContextNotice();
		});
		const historyButton = this.createActionButton(headerLeft, "history", "Show note AskMate history", "askmate-context-button askmate-history-button");
		historyButton.addEventListener("click", () => {
			void this.showNoteHistory();
		});
		const newThreadButton = this.createActionButton(headerLeft, "message-square-plus", "New conversation", "askmate-context-button askmate-new-thread-button");
		newThreadButton.addEventListener("click", () => {
			this.runUiTask(this.startNewThread());
		});
		const threadsButton = this.createActionButton(headerLeft, "messages-square", "Saved conversations", "askmate-context-button askmate-threads-button");
		threadsButton.addEventListener("click", () => {
			this.openThreadSwitcher();
		});
		const exportButton = this.createActionButton(headerLeft, "download", "Export conversation to note", "askmate-context-button askmate-export-button");
		exportButton.addEventListener("click", () => {
			this.runUiTask(this.exportConversation(""));
		});
		void this.updateContextLabel();
		this.modelEl = header.createDiv({ cls: "askmate-model-chip askmate-composer-model" });
		this.updateModelLabel();

		this.consoleCompletionsEl = composer.createDiv({
			cls: "askmate-console-completions",
			attr: { id: `${this.consoleIdPrefix}-completions`, role: "listbox", "aria-label": "Command suggestions" }
		});
		this.consoleCompletionsEl.hidden = true;

		this.skillChipsEl = composer.createDiv({ cls: "askmate-skill-chips" });
		this.skillChipsEl.hidden = true;
		this.draftUndoEl = composer.createDiv({ cls: "askmate-draft-undo" });
		this.draftUndoEl.hidden = true;

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
			if (this.handleComposerKeydown(event)) {
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
			this.scheduleSkillChips();
			this.hideDraftUndoIfChanged();
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

		// Clearing the chat starts a new conversation and keeps the old one in Saved conversations, so nothing is lost by a click.
		const clearButton = this.createActionButton(actions, "eraser", "Clear chat (starts a new conversation)", "askmate-clear-button");
		this.clearButton = clearButton;
		clearButton.addEventListener("click", () => {
			this.runUiTask(this.startNewThread());
		});

		this.renderOutputToggle(footer);
		this.renderConsoleStatusBar(composer);
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
		notes.id = `${this.consoleIdPrefix}-additional-notes`;
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

	private getRequestPreviewKey(question: string, forceImage: boolean, options: ExtendedBuildOptions): string {
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
		const draft = this.resolveDraftRequest(raw);
		if (draft.kind === "none") {
			// A command, not a question: there is nothing to build, so say so instead of previewing the wrong thing.
			this.lastRequestPreviewKey = null;
			++this.requestPreviewRefreshId;
			summary.setText(draft.hint);
			summary.classList.remove("has-blocker");
			return;
		}
		const { options: draftOptions, skillNames, ...command } = draft;
		const options = this.withSkillSelection(draftOptions, skillNames);
		const previewKey = this.getRequestPreviewKey(command.question, command.forceImage, options);
		if (previewKey === this.lastRequestPreviewKey) {
			return;
		}
		this.lastRequestPreviewKey = previewKey;
		const refreshId = ++this.requestPreviewRefreshId;

		try {
			const inspection = await this.plugin.inspectFinalPrompt(
				command.question,
				command.title,
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
				this.notify("Wait for the current AskMate request to finish, or stop it first.");
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

		// Visible whenever the mode is not chat, so a note or apply mode is never a surprise.
		this.outputBadgeEl = controls.createSpan({ cls: "askmate-output-badge" });
		this.outputBadgeEl.hidden = true;
		this.renderSkillPicker(controls);
		this.renderReasoningSelector(controls);
		const modelButton = this.createActionButton(controls, "cpu", "Switch model or provider", "askmate-workflow-toggle askmate-model-switch");
		modelButton.addEventListener("click", () => {
			this.openModelPicker();
		});
		this.refreshOutputToggle();
	}

	private async selectOutputMode(mode: OutputMode): Promise<void> {
		if (this.activeRun) {
			this.notify("Wait for the current AskMate request to finish, or stop it first.");
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

	/** A note or apply mode chosen in settings is spent by the request that uses it; the next question goes back to chat. */
	private async spendOutputMode(mode: OutputMode): Promise<void> {
		const next = modeAfterRun({ mode, fromSetting: true });
		if (next === null || this.plugin.settings.outputMode === next) {
			return;
		}
		this.plugin.settings.outputMode = next;
		this.refreshOutputToggle();
		await this.plugin.saveSettings();
		this.plugin.refreshOpenAskMateViews();
	}

	private refreshOutputToggle(): void {
		const current = normalizeOutputMode(this.plugin.settings.outputMode);
		for (const [mode, button] of Object.entries(this.outputButtons) as Array<[OutputMode, HTMLButtonElement]>) {
			const isActive = current === mode;
			button.classList.toggle("is-active", isActive);
			button.setAttribute("aria-pressed", String(isActive));
		}
		const badge = describeOutputBadge(current);
		if (this.outputBadgeEl) {
			this.outputBadgeEl.hidden = badge === null;
			this.outputBadgeEl.setText(badge?.label ?? "");
			this.outputBadgeEl.setAttribute("title", badge?.title ?? "");
			this.outputBadgeEl.classList.toggle("is-note", badge?.tone === "note");
			this.outputBadgeEl.classList.toggle("is-apply", badge?.tone === "apply");
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
			this.notify("Wait for the current AskMate request to finish, or stop it first.");
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
		if (!this.rootEl) {
			// A duplicate sidebar that never opened has nothing to close.
			return;
		}
		this.isClosed = true;
		this.statusBarObserver?.disconnect();
		this.statusBarObserver = null;
		this.stopActiveRun(false);
		this.runs.shutdown();
		this.forgetToolGrants();
		if (this.requestPreviewTimer !== null) {
			window.clearTimeout(this.requestPreviewTimer);
			this.requestPreviewTimer = null;
		}
		window.clearTimeout(this.skillChipsTimer);
		// A question that was still being answered is left out; the rest of the conversation is written before the view goes.
		await this.persistThread();
		this.pendingTurns.clear();
		this.messages = [];
		this.setup.draft = emptySetupDraft();
		this.setup.draftProvider = null;
		for (const timer of this.pendingMarkdownTimerIds) {
			window.clearTimeout(timer);
		}
		this.pendingMarkdownTimerIds.clear();
		this.releaseAllMarkdownComponents();
		this.toolCards.clear();
		this.containerEl.empty();
		this.rootEl = null;
	}

	private ensureIdleForNewRequest(ignoreKeys: readonly string[] = []): boolean {
		const busy = this.runs.getBusyMessage(ignoreKeys);
		if (busy === null) {
			return true;
		}
		this.notify(busy);
		return false;
	}

	private beginRun(intentKind: RequestIntentKind, ignoreKeys: readonly string[] = []): RunRecord | null {
		const begun = this.runs.begin(intentKind, { ignoreKeys });
		if (!begun.ok) {
			this.notify(begun.message);
			return null;
		}
		this.setLoading(true);
		this.announcer?.announce({ kind: "started" });
		return begun.run;
	}

	private isRunActive(run: RunRecord): boolean {
		return this.runs.canContinue(run, this.isClosed);
	}

	private stopActiveRun(notify = true): void {
		const outcome = this.runs.stop({ notify });
		if (outcome.kind === "idle") {
			return;
		}
		if (outcome.kind === "blocked") {
			// The reply has arrived and its note write may be under way; unlocking now would report a stop that did not happen.
			this.notify(outcome.message);
			return;
		}
		// A tool waiting for a decision is answered "deny", so the run it belongs to can end.
		this.cancelPendingApprovals();
		this.setLoading(false);
		if (notify && !this.isClosed) {
			this.addMessage("system", outcome.message);
			this.notify(outcome.message);
		}
	}

	private setRunPhase(run: RunRecord, phase: RunRecord["phase"]): void {
		if (this.runs.setPhase(run, phase)) {
			this.refreshStopButton();
		}
	}

	private refreshStopButton(): void {
		const control = this.runs.describeStopControl();
		this.stopButton.hidden = !control.visible;
		this.stopButton.disabled = !control.enabled;
		this.stopButton.setAttribute("aria-hidden", String(!control.visible));
		this.stopButton.setAttribute("aria-label", control.label);
		this.stopButton.setAttribute("title", control.label);
		if (this.consoleStopButton) {
			this.consoleStopButton.hidden = !control.visible;
			this.consoleStopButton.disabled = !control.enabled;
			this.consoleStopButton.setText(control.consoleText);
			this.consoleStopButton.setAttribute("aria-label", `${control.label} (Esc)`);
			this.consoleStopButton.setAttribute("title", `${control.label} (Esc)`);
		}
	}

	private finishRun(run: RunRecord): void {
		if (this.runs.finish(run)) {
			this.setLoading(false);
		}
	}

	private async submitQuestion(): Promise<void> {
		if (this.isConsoleLayout()) {
			// Commands such as /help and /context work while a request runs; actions that send a request check idleness.
			await this.submitConsoleInput();
			return;
		}
		const rawQuestion = this.questionEl.value.trim();
		const line = rawQuestion ? readComposerLine(rawQuestion, this.consoleCommands) : null;
		// Slash commands and @mentions work in every layout. A line with neither is a plain question and goes on as it always did.
		if (line?.kind === "command") {
			if (line.action.kind === "layout") {
				if (!this.ensureIdleForNewRequest()) {
					return;
				}
				this.questionEl.value = "";
				await this.switchLayout(line.action.layout);
				return;
			}
			// Commands such as /help work while a request runs; the actions that send a request check idleness themselves.
			await this.submitConsoleInput();
			return;
		}
		if (!this.ensureIdleForNewRequest()) {
			return;
		}
		if (!line) {
			this.notify("Type a question first.");
			return;
		}
		// "/image ..." goes to OpenAI Images whatever chat provider is selected, so check the matching readiness.
		const isReady = line.forceImage
			? await this.isProviderReadyForSubmit(IMAGE_KEY_MISSING_MESSAGE, () => this.plugin.isImageGenerationConfigured(), "image")
			: await this.isProviderReadyForSubmit("Connect an AI provider before sending.");
		if (!isReady) {
			this.questionEl.focus();
			return;
		}
		this.assertSkillsUsable(this.onceSkillIds);

		// The text stays in the box until the request has been built and confirmed, so a failure never loses it.
		await this.runRequest({
			question: line.question,
			title: line.forceImage ? "AskMate Image" : "AskMate Answer",
			options: this.getRequestDraftOptions(line.forceImage),
			onSent: () => this.clearComposerIf(rawQuestion)
		});
	}

	private async submitImageQuestion(): Promise<void> {
		if (!this.ensureIdleForNewRequest()) {
			return;
		}
		// Image generation always uses OpenAI Images, whichever chat provider is selected.
		if (!(await this.isProviderReadyForSubmit(IMAGE_KEY_MISSING_MESSAGE, () => this.plugin.isImageGenerationConfigured(), "image"))) {
			return;
		}

		// Match Enter: "/image a red fox" sends "a red fox", as the request preview shows.
		const rawQuestion = this.questionEl.value.trim();
		const question = rawQuestion ? parsePlainComposerCommand(rawQuestion).question : DEFAULT_IMAGE_PROMPT;
		await this.runRequest({
			question,
			title: "AskMate Image",
			options: this.getRequestDraftOptions(true),
			onSent: () => this.clearComposerIf(rawQuestion)
		});
	}

	/** Empties the composer once the text has been sent, unless the person has typed something else in the meantime. */
	private clearComposerIf(sent: string): void {
		if (sent && this.questionEl && this.questionEl.value.trim() === sent) {
			this.questionEl.value = "";
			this.scheduleRequestPreviewRefresh();
			this.scheduleSkillChips();
		}
	}

	/**
	 * Holds a claim while the provider check awaits, so a second submit or a workflow click in that gap gets the
	 * usual "busy" notice instead of racing for the run and clearing the composer. When the provider is not set up, the
	 * Connect card opens and the typed text stays where it is.
	 */
	private async isProviderReadyForSubmit(
		notConfiguredMessage: string,
		isConfigured: () => Promise<boolean> = () => this.plugin.isSelectedProviderConfigured(),
		kind: "chat" | "image" = "chat"
	): Promise<boolean> {
		const claim = this.runs.claim("submit");
		if (!claim.ok) {
			this.notify(claim.message);
			return false;
		}
		try {
			if (await isConfigured()) {
				return true;
			}
		} finally {
			claim.release();
		}

		await this.refreshReadiness();
		if (kind === "chat") {
			this.openSetupFlow({ message: notConfiguredMessage });
		} else {
			this.notify(notConfiguredMessage);
			this.openSettings();
		}
		return false;
	}

	private runUiTask(task: Promise<void>): void {
		void task.catch((error: unknown) => {
			this.notify(this.plugin.getErrorMessage(error));
		});
	}

	/**
	 * What the composer would send for `raw`. In console layout this follows the same parsing as sending (commands and
	 * @mentions); other inputs keep the plain reading. A line that is a command and not a question has nothing to build.
	 */
	private resolveDraftRequest(raw: string): DraftResolution {
		return resolveDraftRequest(raw, {
			isConsole: this.isConsoleLayout(),
			commands: this.consoleCommands,
			baseOptions: (forceImage) => this.getRequestDraftOptions(forceImage),
			applyMentions: (options, mentions) => this.applyConsoleMentions(options, mentions),
			findWorkflow: (id) => this.plugin.getAllWorkflows().find((workflow) => workflow.id === id),
			workflowPrompt: (workflow) => this.plugin.getWorkflowPrompt(workflow)
		});
	}

	private getFolderContextOptions(): FolderContextOptions {
		return {
			enabled: this.folderContextEnabled,
			path: this.folderContextPath,
			maxFiles: this.folderContextMaxFiles,
			maxCharacters: this.plugin.settings.folderContextMaxCharacters
		};
	}

	private getThreadMessagesForNextRequest(): ChatMessageLike[] {
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
			this.notify(IMAGE_WORKFLOW_MESSAGE);
			return;
		}
		if (!(await this.isProviderReadyForSubmit("Connect an AI provider before running a workflow."))) {
			return;
		}

		await this.runRequest({ question: this.plugin.getWorkflowPrompt(workflow), title: workflow.name, options: { workflow } });
	}

	/** Draws a Mermaid diagram of the note (or of what the person describes). */
	private async runDiagram(prompt: string, options: { options?: RunRequestOptions; displayText?: string; skillRefs?: readonly string[]; onSent?: () => void } = {}): Promise<void> {
		if (!this.ensureIdleForNewRequest()) {
			return;
		}
		if (!this.plugin.settings.diagrams.enabled) {
			throw new Error("Diagrams are turned off. Turn them on in AskMate settings, under Skills and tools.");
		}
		if (this.plugin.getSelectedProviderModelRef().capability !== "text") {
			throw new Error("Diagrams need a text model. Choose a text model, or use /image for a picture.");
		}
		if (!(await this.isProviderReadyForSubmit("Connect an AI provider before drawing a diagram."))) {
			return;
		}
		const refs = [MERMAID_SKILL_ID, ...(options.skillRefs ?? [])];
		this.assertSkillsUsable(refs);
		await this.runRequest({
			question: prompt || DEFAULT_DIAGRAM_QUESTION,
			title: "AskMate Diagram",
			options: { ...(options.options ?? this.getRequestDraftOptions(false)), intentKind: "diagram" },
			skillRefs: refs,
			diagram: firstLook(this.plugin.settings.diagrams),
			...(options.displayText ? { displayText: options.displayText } : {}),
			...(options.onSent ? { onSent: options.onSent } : {})
		});
	}

	private currentNotePath(): string {
		return this.plugin.getLastOpenMarkdownView()?.file?.path ?? this.app.workspace.getActiveFile()?.path ?? "";
	}

	/** What Retry compares against what the failed request captured. */
	private currentRetrySignature(): string {
		const ref = this.plugin.getChatProviderModelRef();
		return selectionSignature({
			providerId: ref.providerId,
			model: ref.model,
			effort: this.plugin.getSelectedReasoningEffort(),
			notePath: this.currentNotePath()
		});
	}

	private async retryRun(spec: RunSpec, ticket: RetryTicket, reuse: NonNullable<RunSpec["reuse"]>, ignoreKeys: readonly string[]): Promise<void> {
		const plan = planRetry(ticket, this.currentRetrySignature(), this.runs);
		await this.runRequest({
			...spec,
			// A rebuilt request takes the conversation as it is now, which no longer holds the question that failed.
			options: plan.mode === "rebuild" ? { ...spec.options, threadMessages: undefined } : spec.options,
			builtRequest: plan.mode === "reuse" ? plan.request : undefined,
			ignoreKeys,
			reuse,
			onSent: undefined
		});
	}

	private async buildRunRequest(
		spec: RunSpec,
		intentKind: RequestIntentKind,
		title: string,
		threadMessages: ChatMessageLike[],
		skillSelection: SkillSelection
	): Promise<AskRequest> {
		const options = spec.options;
		const built = await this.plugin.buildRequest(spec.question, title, {
			...options,
			allowNoNote: true,
			intentKind,
			outputMode: normalizeOutputMode(options.outputMode ?? this.plugin.settings.outputMode),
			privacy: options.privacy ?? this.privacyOptions,
			contextBudgetMode: options.contextBudgetMode ?? this.contextBudgetMode,
			additionalContextPaths: options.additionalContextPaths ?? this.additionalContextPaths,
			folderContext: options.folderContext ?? this.getFolderContextOptions(),
			threadMessages,
			includeThreadHistory: options.includeThreadHistory ?? this.plugin.settings.threadedChatEnabled,
			// Built with the skills the run will carry, so the size check, the preview and the inspector all see their text.
			skillSelection
		});
		// A look that was asked for applies whatever made this a diagram request: the wording, a workflow, a skill or a chip.
		const look = spec.diagram ?? (intentKind === "diagram" ? built.metadata.diagram ?? firstLook(this.plugin.settings.diagrams) : undefined);
		return look ? withDiagramMetadata(built, look) : built;
	}

	/** The skills a question carries: those named for it, the ones kept on for the conversation, and the automatic ones. */
	private skillSelectionFor(explicitRefs: readonly string[], autoEnabled = true): SkillSelection {
		return buildSkillSelection({
			explicit: explicitRefs.map((ref) => this.skillIdFor(ref)),
			sticky: this.threadMeta.skillIds ?? [],
			autoEnabled
		});
	}

	/**
	 * Options for a preview or an inspection: the skills the line names, plus the chips and the conversation's own. Reading
	 * them uses up no one-shot chip, so what is shown is what Enter would send.
	 */
	private withSkillSelection(options: RunRequestOptions, named: readonly string[]): ExtendedBuildOptions {
		return { ...options, skillSelection: this.skillSelectionFor(Array.from(new Set([...named, ...this.onceSkillIds]))) };
	}

	/** Tools are offered on ordinary chat questions when a tool server can be used; never for diagrams, images, notes or applied answers. */
	private planTools(request: AskRequest): ToolUsePlan {
		const mcp = this.plugin.mcpService;
		if (!mcp || request.metadata.outputMode !== "chat" || request.metadata.modelCapability !== "text") {
			return { attempt: false, trustNeeded: false };
		}
		if (request.metadata.intentKind === "diagram" || request.metadata.forceImage || request.metadata.autoImage) {
			return { attempt: false, trustNeeded: false };
		}
		return planToolUse(mcp.status());
	}

	private async runRequest(spec: RunSpec): Promise<void> {
		const { question, options } = spec;
		const intentKind = this.plugin.classifyRequestIntent(question, options);
		const willGenerateImage = intentKind === "explicit_image" || intentKind === "auto_image" || this.plugin.getSelectedProviderModelRef().capability === "image";
		const threadMessages = options.threadMessages ?? this.getThreadMessagesForNextRequest();
		const run = this.beginRun(intentKind, spec.ignoreKeys);

		if (!run) {
			return;
		}

		void this.updateContextLabel();
		this.shouldFollowMessages = true;
		const requestTitle = spec.title === "AskMate Answer" && willGenerateImage ? "AskMate Image" : spec.title;
		const isUserPrompt = requestTitle === "AskMate Answer" || requestTitle === "AskMate Image" || requestTitle === "AskMate Diagram";
		// Thread history keeps the clean question; the console shows (and Edit restores) the line as typed.
		const historyText = isUserPrompt ? question : requestTitle;
		let userTurn: ChatMessageLike;
		let userElements: MessageElements | null;
		if (spec.reuse) {
			// Retry keeps the question that is already on screen and replaces the error under it.
			userTurn = spec.reuse.userTurn;
			userElements = spec.reuse.userElements;
			const stale = spec.reuse.errorElements?.wrapper;
			if (stale) {
				const hadFocus = stale.contains(stale.doc.activeElement);
				stale.remove();
				if (hadFocus) {
					// The Retry button that had the focus is gone with the error it belonged to.
					this.questionEl.focus();
				}
			}
			if (!this.messages.includes(userTurn)) {
				this.messages.push(userTurn);
			}
		} else {
			const added = this.addMessageWithElements("user", spec.displayText ?? historyText, spec.displayText ?? (isUserPrompt ? question : undefined), historyText);
			userTurn = added.chat;
			userElements = added.elements;
		}
		this.pendingTurns.add(userTurn);
		let answered = false;
		let assistantMessage: MessageElements | null = null;
		let responseText = "";
		let request: AskRequest | null = null;
		let toolEvents: ToolUiEvent[] = [];
		const draft = createDraftRetrySnapshot(question, requestTitle, {
			...options,
			outputMode: normalizeOutputMode(options.outputMode ?? this.plugin.settings.outputMode),
			privacy: { ...(options.privacy ?? this.privacyOptions) },
			contextBudgetMode: options.contextBudgetMode ?? this.contextBudgetMode,
			additionalContextPaths: [...(options.additionalContextPaths ?? this.additionalContextPaths)],
			folderContext: { ...(options.folderContext ?? this.getFolderContextOptions()) },
			threadMessages: threadMessages.map((message) => ({ ...message })),
			includeThreadHistory: options.includeThreadHistory ?? this.plugin.settings.threadedChatEnabled
		});
		let ticket: RetryTicket = { draft, built: null };
		// Chips and the picker name skills for this question only, so the question keeps them: Retry, Another look and Fix are
		// the same question, and must run with the skills the person chose for it. The choice is made before the request is
		// built, so the size check and the inspector read the same skills the run carries.
		const explicitRefs = Array.from(new Set([...(spec.skillRefs ?? []), ...this.onceSkillIds]));
		const chipsForThisQuestion = [...this.onceSkillIds];
		const selection = this.skillSelectionFor(explicitRefs, spec.suppressAutoSkills !== true);

		try {
			request = spec.builtRequest ?? await this.buildRunRequest(spec, intentKind, requestTitle, threadMessages, selection);
			ticket = { draft, built: createBuiltRetrySnapshot(request) };

			if (!this.isRunActive(run)) {
				return;
			}

			this.setRunPhase(run, "confirming");
			await this.plugin.confirmUsageGuardrails(request);

			if (!this.isRunActive(run)) {
				return;
			}

			this.setRunPhase(run, "generating");
			// The question has been built and accepted: now it leaves the composer, and a note or apply mode is spent.
			spec.onSent?.();
			// A mode typed in the command (/note followed by a question) is for that question alone and leaves the setting as it is.
			if ((options.outputMode ?? this.plugin.settings.outputMode) === this.plugin.settings.outputMode) {
				void this.spendOutputMode(request.metadata.outputMode).catch((error: unknown) => this.notify(this.plugin.getErrorMessage(error)));
			}
			const shouldGenerateImage = request.metadata.forceImage
				|| request.metadata.autoImage
				|| request.metadata.modelCapability === "image";
			const isDiagramRun = request.metadata.intentKind === "diagram";
			const sourcePath = request.context.file?.path ?? "";
			if (sourcePath) {
				userTurn.sourcePath = sourcePath;
			}
			if (this.imagePreviewsEnabled && request.metadata.privacy.includeImageReferences && this.shouldShowContextImagePreviews(question)) {
				this.renderContextImagePreviews(request);
			}
			const message = this.createMessageEl(
				"assistant",
				shouldGenerateImage ? "Improving image prompt..." : "",
				!shouldGenerateImage
			);
			assistantMessage = message;
			if (isDiagramRun) {
				this.showDrawingNote(message.body, DRAWING_DIAGRAM_TEXT);
			}
			spec.skillRefs = explicitRefs;
			// The skills picked for one question are used up by it. A chip added while the size warning was open waits for the next.
			if (chipsForThisQuestion.length > 0) {
				this.onceSkillIds = this.onceSkillIds.filter((id) => !chipsForThisQuestion.includes(id));
				this.refreshSkillChips();
			}
			const tools = this.planTools(request);
			if (tools.trustNeeded) {
				this.noteToolsNeedTrust();
			}
			const result: RunResult = await this.plugin.runOpenAIRequest(request, {
				onTextDelta: (delta) => {
					if (!this.isRunActive(run)) {
						return;
					}

					responseText += delta;
					// A diagram reply is replaced by its card, so its half-written source is never drawn.
					if (!isDiagramRun) {
						this.renderMarkdownSoon(message.body, responseText, sourcePath);
						this.maybeScrollMessagesToBottom();
					}
				},
				// A tool run streams every turn, and a turn that ends in tool calls wrote progress, not the answer. Clearing it
				// here keeps that text out of the answer and out of what Stop leaves behind.
				onTextReset: () => {
					if (!this.isRunActive(run)) {
						return;
					}

					responseText = "";
					// Without this a repeat of the cleared text would look already drawn and be skipped.
					this.streamedText.delete(message.body);
					this.showDrawingNote(message.body, isDiagramRun ? DRAWING_DIAGRAM_TEXT : null);
					// Also cancels a render that is waiting and makes one that is under way stale.
					this.renderMarkdownNow(message.body, "", sourcePath);
				},
				abortSignal: run.abortController.signal,
				forceImage: shouldGenerateImage,
				skillSelection: selection,
				// "Allow for this chat" is scoped to this conversation, and ends with it.
				chatId: this.threadMeta.id,
				...(tools.attempt ? { toolsEnabled: true } : {}),
				onToolEvent: (event) => {
					toolEvents = mergeToolEvent(toolEvents, event);
					if (this.isRunActive(run)) {
						this.upsertToolCard(message, event);
						this.maybeScrollMessagesToBottom();
					}
				},
				confirmToolCall: (card) => this.confirmToolCall(run, message, card),
				onPhase: (phase) => this.handleRunPhase(run, message, phase)
			});

			if (!this.isRunActive(run)) {
				return;
			}
			this.setRunPhase(run, "post-processing");

			if (result.kind === "text") {
				const finalRaw = result.text.trim() || responseText.trim();
				if (!finalRaw) {
					// An empty reply must not be saved to history or written into the note as if it were an answer.
					throw new Error(`${request.metadata.providerName} returned no text. Try again or choose another model.`);
				}
				const diagram = result.diagram ?? null;
				// A diagram reply is kept as its words plus the diagram source, so Copy, Insert and a saved copy all hold the diagram.
				const savedText = diagram ? canonicalDiagramText(finalRaw, diagram) : finalRaw;
				responseText = savedText;
				// The note may have been renamed while the request ran, so the path is read when the reply lands.
				const completedSourcePath = userTurn.sourcePath ?? sourcePath;
				if (!this.isClosed) {
					this.showDrawingNote(message.body, null);
					this.renderMarkdownNow(message.body, diagram ? proseAroundDiagram(finalRaw) : savedText, completedSourcePath);
					for (const call of result.toolCalls ?? []) {
						toolEvents = mergeToolEvent(toolEvents, call);
						this.upsertToolCard(message, call);
					}
					if (result.incompleteReason) {
						this.renderIncompleteWarning(message, result.incompleteReason);
					}
					this.lastAnswer = {
						text: responseText,
						incompleteReason: result.incompleteReason ?? null,
						...(diagram ? { diagram: insertMarkFor(diagram.status) } : {})
					};
					this.renderAssistantMessageActions(message, {
						request,
						getText: () => responseText,
						model: result.model,
						answer: this.lastAnswer,
						spec,
						skillsUsed: result.skillsUsed ?? [],
						diagram
					});
					this.messages.push({
						role: "assistant",
						text: responseText,
						createdAt: new Date().toISOString(),
						model: result.model,
						...(completedSourcePath ? { sourcePath: completedSourcePath } : {}),
						...(result.incompleteReason ? { incomplete: true } : {}),
						...(toolEvents.length > 0 ? { tools: summariseToolCalls(toolEvents) } : {}),
						...(diagram ? { diagram: savedDiagramSummary(diagram) } : {})
					});
					this.pendingTurns.delete(userTurn);
					answered = true;
					this.announcer?.announce({
						kind: "completed",
						text: finalRaw,
						incompleteReason: result.incompleteReason ?? null,
						diagram: diagram !== null,
						toolCalls: toolEvents.length
					});
					await this.persistThread();
				}
				await this.plugin.recordNoteHistoryTurn(request, responseText, result.model);
				if (!this.isRunActive(run)) {
					return;
				}

				try {
					const writes = request.metadata.outputMode === "note" || request.metadata.outputMode === "apply";
					if (writes && diagram?.status === "fallback") {
						// The card says a diagram that did not draw cannot be saved; a Note or Apply run must say the same and write nothing.
						const unsaved = "The diagram did not draw, so it was not written to a note. Use Fix on the diagram to ask for a corrected one.";
						this.addMessage("system", unsaved);
						this.notify(unsaved);
					} else if (request.metadata.outputMode === "note") {
						const file = await this.plugin.createResultNote(request, responseText, { model: result.model });
						this.notifySideEffect(`Created note: ${file.path}`, `AskMate created ${file.path}`);
					} else if (request.metadata.outputMode === "apply") {
						const outcome = await this.plugin.applyResponseToContext(request, responseText);
						this.notifySideEffect(outcome.message, outcome.message);
					}
				} catch (error) {
					if (this.runs.getActiveRun()?.id === run.id && !this.isClosed) {
						const failure = this.plugin.getErrorMessage(error);
						this.addMessage("system", `Generated reply preserved. Output action failed: ${failure}`);
						this.notify(failure);
					}
				}
				return;
			}

			if (!this.isClosed) {
				this.renderGeneratedImage(message.body, result);
				this.renderAssistantImageActions(message.actions, request, () => result);
				const imageSourcePath = userTurn.sourcePath ?? sourcePath;
				const imageTurn: ChatMessageLike = {
					role: "assistant",
					text: `Generated image with ${result.model}.`,
					createdAt: new Date().toISOString(),
					model: result.model,
					image: true,
					...(imageSourcePath ? { sourcePath: imageSourcePath } : {})
				};
				this.messages.push(imageTurn);
				this.generatedImages.set(imageTurn, result.image);
				this.pendingTurns.delete(userTurn);
				answered = true;
				this.announcer?.announce({ kind: "completed", image: true });
				await this.persistThread();
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
					// The image was saved to the vault now, so the saved copy of the reply learns its path.
					this.queueThreadSave();
				} else if (request.metadata.outputMode === "apply") {
					const outcome = await this.plugin.applyImageToContext(request, result);
					this.notifySideEffect(outcome.message, outcome.message);
					this.queueThreadSave();
				}
			} catch (error) {
				if (this.runs.getActiveRun()?.id === run.id && !this.isClosed) {
					const failure = this.plugin.getErrorMessage(error);
					this.addMessage("system", `Generated image preserved. Output action failed: ${failure}`);
					this.notify(failure);
				}
			}
		} catch (error) {
			if (this.isClosed || this.runs.getActiveRun()?.id !== run.id || run.abortController.signal.aborted) {
				return;
			}

			const aborted = isAbortError(error);
			const plain = aborted ? "AskMate request stopped." : this.plugin.getErrorMessage(error);
			// Choosing Cancel at the size warning is the person's decision, not a failure.
			const declined = !aborted && DECLINED_AT_WARNING.test(plain);
			const presented = aborted
				? { message: plain, detail: null, fix: null, mapped: false }
				: declined
					? { message: "Not sent. You chose not to continue after the size warning. Your text is still in the box.", detail: null, fix: null, mapped: false }
					: presentRunError(error, plain, request ? "provider" : "build", this.errorContext(request));
			if (!assistantMessage) {
				assistantMessage = this.createMessageEl("assistant", "", false);
			}
			const failed = assistantMessage;
			this.cancelPendingMarkdown(failed.body);
			this.showDrawingNote(failed.body, null);
			this.renderRunError(failed, presented, declined ? "notice" : "error");
			// A status role keeps provider errors out of the thread history sent with the next request.
			const errorTurn: ChatMessageLike = { role: "system", text: presented.message };
			this.messages.push(errorTurn);
			if (!aborted) {
				const reuse = { userTurn, userElements, errorElements: failed };
				const retryWith = (context: { ignoreKeys: readonly string[] }): Promise<void> => {
					this.messages = this.messages.filter((candidate) => candidate !== errorTurn);
					return this.retryRun(spec, ticket, reuse, context.ignoreKeys);
				};
				if (presented.fix) {
					this.renderErrorFix(failed, presented.fix);
				}
				this.createMessageAction(failed.actions, "rotate-ccw", "Retry request", retryWith, { requiresIdle: true, lockKey: "Retry request" });
			}
			new Notice(presented.message);
			this.announcer?.announce({ kind: "failed", message: presented.message });
		} finally {
			this.pendingTurns.delete(userTurn);
			if (!answered) {
				// An unanswered question would otherwise be resent as a dangling user turn.
				this.messages = this.messages.filter((message) => message !== userTurn);
				if (assistantMessage && run.abortController.signal.aborted && !this.isClosed) {
					if (responseText.trim()) {
						// Keep what arrived (a pending render still draws the latest text); it stays out of the thread.
						this.renderMessageWarning(assistantMessage, "Stopped. This reply is partial and was not saved.");
						this.announcer?.announce({ kind: "stopped", partial: true });
					} else {
						this.cancelPendingMarkdown(assistantMessage.body);
						this.showDrawingNote(assistantMessage.body, null);
						assistantMessage.body.setText("Stopped.");
						this.announcer?.announce({ kind: "stopped", partial: false });
					}
				}
			}
			this.cancelPendingApprovals();
			this.toolCards.clear();
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
		this.renderMessageWarning(message, `This reply may be incomplete: ${describeIncompleteReason(reason)}. Review it before applying it to a note.`);
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
		this.notify(noticeMessage);
	}

	private addMessage(role: ChatRole, text: string, editableText?: string, historyText?: string): ChatMessageLike {
		return this.addMessageWithElements(role, text, editableText, historyText).chat;
	}

	private addMessageWithElements(role: ChatRole, text: string, editableText?: string, historyText?: string): { chat: ChatMessageLike; elements: MessageElements } {
		const chatMessage: ChatMessageLike = { role, text: historyText ?? text, createdAt: new Date().toISOString() };
		this.messages.push(chatMessage);
		const message = this.createMessageEl(role, text, false);

		if (editableText) {
			this.createMessageAction(message.actions, "pencil", "Edit", () => {
				this.useTextInComposer(editableText);
			});
		}
		return { chat: chatMessage, elements: message };
	}

	/** The line under a reply that says a diagram is being drawn. It sits beside the body, so a render never removes it. */
	private showDrawingNote(body: HTMLElement, text: string | null): void {
		const existing = this.drawingNotes.get(body);
		if (text === null) {
			existing?.remove();
			this.drawingNotes.delete(body);
			return;
		}
		if (existing) {
			existing.setText(text);
			return;
		}
		// Created through the body so it belongs to this view's window (popouts included), then moved beside it.
		const note = body.createDiv({ cls: "askmate-diagram-placeholder", text });
		note.setAttribute("role", "note");
		body.after(note);
		this.drawingNotes.set(body, note);
	}

	private upsertToolCard(message: MessageElements, event: ToolUiEvent): ToolCardHandle {
		const existing = this.toolCards.get(event.id);
		if (existing) {
			existing.update(event);
			return existing;
		}
		let host = message.wrapper.querySelector<HTMLElement>(":scope > .askmate-tool-cards");
		if (!host) {
			host = message.wrapper.createDiv({ cls: "askmate-tool-cards" });
			message.wrapper.insertBefore(host, message.body);
		}
		const handle = createToolCallCard(host, event);
		this.toolCards.set(event.id, handle);
		return handle;
	}

	/** Says why a question went without tools when the only tool servers are waiting for the person's trust. */
	private noteToolsNeedTrust(): void {
		if (this.toolTrustNoticeShown) {
			return;
		}
		this.toolTrustNoticeShown = true;
		this.notify("A tool server needs your trust on this device, so AskMate answered without tools. Open AskMate settings, then Skills and tools, to review it.");
	}

	/** "Allow for this chat" decisions belong to one conversation, so they end when it is left, cleared or deleted. */
	private forgetToolGrants(): void {
		this.plugin.mcpService?.forgetChat(this.threadMeta.id);
	}

	/** Asks inside the answer, with the full arguments, and waits. Stopping the run or closing the sidebar answers "deny". */
	private async confirmToolCall(run: RunRecord, message: MessageElements, request: ToolApprovalCard): Promise<ToolApprovalChoice> {
		if (!this.isRunActive(run)) {
			return "deny";
		}
		const handle = this.upsertToolCard(message, {
			id: request.id,
			server: request.server,
			tool: request.tool,
			status: "pending-approval",
			argumentsJson: request.argumentsJson
		});
		this.setRunPhase(run, "awaiting-approval");
		this.announcer?.announce({ kind: "approval", toolName: request.title || request.tool, serverName: request.server });
		this.maybeScrollMessagesToBottom();
		try {
			// The service says whether a grant can be scoped to this conversation; a button that would grant nothing is not shown.
			return await handle.requestApproval(request, { canAllowForChat: request.canAllowForChat === true });
		} finally {
			if (this.isRunActive(run)) {
				this.setRunPhase(run, "tool-calling");
			}
		}
	}

	private cancelPendingApprovals(): void {
		for (const handle of this.toolCards.values()) {
			handle.cancelApproval();
		}
	}

	private handleRunPhase(run: RunRecord, message: MessageElements, phase: RunPhaseEvent): void {
		if (!this.isRunActive(run)) {
			return;
		}
		switch (phase) {
			case "tool-calling":
			case "awaiting-approval":
				this.setRunPhase(run, phase);
				return;
			case "drawing-diagram":
				this.showDrawingNote(message.body, DRAWING_DIAGRAM_TEXT);
				this.announcer?.say("AskMate is drawing the diagram.");
				return;
			case "repairing-diagram":
				this.showDrawingNote(message.body, "Fixing the diagram...");
				this.announcer?.say("AskMate is fixing the diagram.");
				return;
		}
	}

	private errorContext(request: AskRequest | null): { providerId: TextProviderId; baseUrl: string; model: string } {
		const providerId = request?.metadata.providerId ?? this.plugin.getChatProviderId();
		return {
			providerId,
			baseUrl: this.plugin.getProviderSettings(providerId).baseUrl,
			model: request?.metadata.selectedModel ?? this.plugin.getChatProviderModelRef().model
		};
	}

	/** The failure in one sentence, with what AskMate was told in a disclosure when it was translated. */
	private renderRunError(message: MessageElements, presented: ErrorPresentation, tone: "error" | "notice" = "error"): void {
		message.body.setText(presented.message);
		if (tone === "error") {
			message.wrapper.addClass("askmate-message-error");
			message.body.setAttribute("role", "alert");
		}
		if (presented.detail) {
			const details = message.body.createEl("details");
			details.createEl("summary", { text: "Details" });
			details.createEl("pre", { text: presented.detail });
		}
	}

	/** The button that fixes the cause of a failure, under the message. */
	private renderErrorFix(message: MessageElements, fix: SetupAction): void {
		const row = message.evidence.createDiv({ cls: "askmate-setup-actions" });
		const button = row.createEl("button", { text: fix.label, cls: "mod-cta" });
		button.type = "button";
		button.addEventListener("click", () => this.handleSetupAction(fix));
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

		return /\b(?:show|display|preview|view|see|open|image|images|picture|pictures|photo|photos|screenshot|drawing|visual|excalidraw)\b/u.test(normalized);
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

	/** A restored reply has no request behind it, but Insert, Copy and Show reply text need only the saved text. */
	private renderRestoredActions(parent: HTMLElement, answer: InsertableReply): void {
		const plan = planReplyActions({
			hasRequest: false,
			source: "",
			skillWasAutomatic: false,
			writeBlockedReason: answer.diagram === "fallback" ? FALLBACK_INSERT_REASON : null
		});
		this.renderReplyActionButtons(parent, plan, {
			insert: () => this.insertAnswer(answer),
			copy: () => copyAnswerText(answer.text),
			"show-text": () => this.showText(answer.text, "AskMate reply"),
			"use-reply": () => this.useTextInComposer(answer.text)
		}, () => "");
	}

	private insertAnswer(answer: InsertableReply): Promise<void> {
		return insertAnswerAtRememberedCursor(this.app, this.app.workspace.getActiveViewOfType(MarkdownView), this.plugin.getLastOpenMarkdownView(), answer);
	}

	/** A finished vault change, said once in the chat and once as a Notice. */
	private reportOutcome(message: string): void {
		this.addMessage("system", message);
		this.notify(message);
	}

	private renderReplyActionButtons(
		parent: HTMLElement,
		plan: ReturnType<typeof planReplyActions>,
		handlers: Partial<Record<ReplyActionSpec["id"], ReplyHandler>>,
		lockKeyFor: (spec: ReplyActionSpec) => string
	): void {
		for (const spec of plan.primary) {
			const handler = handlers[spec.id];
			if (handler) {
				this.createMessageAction(parent, spec.icon, spec.label, handler, {
					requiresIdle: spec.requiresIdle,
					lockKey: lockKeyFor(spec),
					variant: "primary",
					disabledReason: spec.disabledReason
				});
			}
		}
		const menuRead = plan.menuRead.filter((spec) => handlers[spec.id]);
		const menuWrite = plan.menuWrite.filter((spec) => handlers[spec.id]);
		if (menuRead.length === 0 && menuWrite.length === 0) {
			return;
		}
		this.createMoreMenu(parent, menuRead, menuWrite, (spec) => {
			const handler = handlers[spec.id];
			if (handler) {
				this.runReplyAction(spec.label, handler, { requiresIdle: spec.requiresIdle, lockKey: lockKeyFor(spec) });
			}
		});
	}

	/** One menu with text labels; the items that change a note come after a separator. */
	private createMoreMenu(parent: HTMLElement, read: readonly ReplyActionSpec[], write: readonly ReplyActionSpec[], run: (spec: ReplyActionSpec) => void): HTMLButtonElement {
		parent.closest(".askmate-message")?.addClass("askmate-message-has-actions");
		const button = parent.createEl("button", { cls: "askmate-message-action askmate-message-action-more" });
		button.type = "button";
		button.dataset.consoleLabel = CONSOLE_ACTION_LABELS["More actions"] ?? "more";
		button.setAttribute("aria-label", "More actions");
		button.setAttribute("aria-haspopup", "menu");
		button.setAttribute("title", "More actions");
		this.addIcon(button, "more-horizontal", "askmate-message-action-icon");
		button.createSpan({ cls: "askmate-visually-hidden", text: "More actions" });
		button.addEventListener("click", (event) => {
			const menu = new Menu();
			const addItems = (specs: readonly ReplyActionSpec[]): void => {
				for (const spec of specs) {
					menu.addItem((item) => {
						item.setTitle(spec.label)
							.setIcon(spec.icon)
							.setDisabled(Boolean(spec.disabledReason) || (spec.requiresIdle && Boolean(this.activeRun)))
							.onClick(() => run(spec));
					});
				}
			};
			addItems(read);
			if (read.length > 0 && write.length > 0) {
				menu.addSeparator();
			}
			addItems(write);
			if (event.detail === 0) {
				// Opened from the keyboard: the click has no pointer position, so the menu opens under the button.
				const rect = button.getBoundingClientRect();
				menu.showAtPosition({ x: rect.left, y: rect.bottom });
			} else {
				menu.showAtMouseEvent(event);
			}
		});
		return button;
	}

	/** Runs a menu item with the same busy and claim rules as a button. */
	private runReplyAction(label: string, handler: ReplyHandler, options: { requiresIdle: boolean; lockKey: string }): void {
		void runGuardedAction(this.runs, { lockKey: options.lockKey || (options.requiresIdle ? label : ""), requiresIdle: options.requiresIdle }, handler, {
			busy: (message) => this.notify(message),
			failed: (error) => this.notify(this.plugin.getErrorMessage(error))
		});
	}

	private renderAssistantMessageActions(
		message: MessageElements,
		input: {
			request: AskRequest;
			getText: () => string;
			model: string;
			answer: InsertableReply;
			spec: RunSpec;
			skillsUsed: ReadonlyArray<{ id: string; name: string; source: "built-in" | "vault"; channel: string }>;
			diagram: DiagramRunResult | null;
		}
	): void {
		const { request, getText, model, answer, spec, diagram } = input;
		message.actions.empty();
		message.evidence.empty();
		const path = request.context.file?.path ?? "global";
		const diagramBlocked = diagram?.status === "fallback" ? "This diagram did not draw, so it cannot be written to a note." : null;
		const plan = planReplyActions({
			hasRequest: true,
			source: request.context.source,
			skillWasAutomatic: wasSkillAutomatic(input.skillsUsed),
			writeBlockedReason: diagramBlocked
		});
		const handlers: Partial<Record<ReplyActionSpec["id"], ReplyHandler>> = {
			insert: () => this.insertAnswer(answer),
			copy: () => copyAnswerText(answer.text),
			apply: async () => {
				const outcome = await this.plugin.applyResponseToContext(request, getText());
				this.reportOutcome(outcome.message);
			},
			"show-text": () => this.showText(getText(), "AskMate reply"),
			"use-reply": () => this.useTextInComposer(getText()),
			"rerun-without-skill": (context) => this.runRequest({
				...spec,
				options: { ...spec.options, threadMessages: undefined },
				builtRequest: undefined,
				suppressAutoSkills: true,
				displayText: spec.displayText ? `${spec.displayText} (without skill)` : undefined,
				ignoreKeys: context.ignoreKeys,
				reuse: undefined,
				onSent: undefined
			}),
			queue: async () => {
				const item = await this.plugin.queueReviewItemFromRequest(request, getText(), model);
				this.notify(`Queued AskMate review for ${item.sourcePath}.`);
			},
			"new-note": async () => {
				const file = await this.plugin.createResultNote(request, getText(), { model });
				this.reportOutcome(`Created note: ${file.path}`);
			},
			"replace-note": async () => {
				const outcome = await this.plugin.applyResponseToContext(request, getText(), { scope: "full-note" });
				this.reportOutcome(outcome.message);
			},
			"apply-selection": async () => {
				const outcome = await this.plugin.applyResponseToContext(request, getText(), { scope: "selected-block" });
				this.reportOutcome(outcome.message);
			},
			"apply-heading": async () => {
				const heading = await askMatePrompt(this.app, "Heading title or path to replace, for example Project Plan > Risks", request.context.activeHeadingPath ?? "");
				if (heading === null) {
					return;
				}
				const outcome = await this.plugin.applyResponseToContext(request, getText(), { scope: "heading-section", headingPath: heading });
				this.reportOutcome(outcome.message);
			}
		};
		const lockKeyFor = (spec: ReplyActionSpec): string => {
			switch (spec.id) {
				case "queue":
					return `review:${path}`;
				case "rerun-without-skill":
					return "Run again without skill";
				case "apply":
				case "new-note":
				case "replace-note":
				case "apply-selection":
				case "apply-heading":
					return `mutation:${path}`;
				default:
					return "";
			}
		};
		// A diagram reply has its own card for Insert and New note, so only Copy and the menu remain here.
		const shown = diagram
			? { primary: plan.primary.filter((entry) => entry.id === "copy"), menuRead: plan.menuRead, menuWrite: [] }
			: plan;
		this.renderReplyActionButtons(message.actions, shown, handlers, lockKeyFor);

		this.renderSkillBadges(message.evidence, input.skillsUsed);
		const citations = this.plugin.extractEvidenceCitations(getText(), request.evidenceSources).slice(0, 6);
		if (citations.length > 0) {
			message.evidence.createSpan({ cls: "askmate-evidence-label", text: "Sources" });
			for (const citation of citations) {
				const button = message.evidence.createEl("button", { cls: "askmate-evidence-chip", text: `${citation.sourceId}: ${citation.source.sourcePath.split("/").pop() ?? citation.source.sourcePath} L${citation.source.lineStart}-${citation.source.lineEnd}` });
				button.type = "button";
				button.addEventListener("click", () => {
					this.runUiTask(this.plugin.openEvidenceSource(citation.source));
				});
			}
		}
		if (diagram) {
			this.renderDiagramReply(message, { request, diagram, getText, model, spec });
		}
	}

	private renderSkillBadges(parent: HTMLElement, used: ReadonlyArray<{ id: string; name: string; source: "built-in" | "vault"; channel: string }>): void {
		for (const skill of used) {
			const badge = describeSkillBadge(skill);
			parent.createSpan({ cls: "askmate-skill-badge", text: badge.text, attr: { title: badge.title } });
		}
	}

	/** The diagram, drawn through Obsidian's own Mermaid, with Insert (through the Apply preview), New note, Copy source, Fix and Another look. */
	private renderDiagramReply(
		message: MessageElements,
		input: { request: AskRequest; diagram: DiagramRunResult; getText: () => string; model: string; spec: RunSpec }
	): DiagramCardHandle {
		const { request, diagram, getText, model, spec } = input;
		const hasNote = !isNoNoteSource(request.context.source);
		const path = request.context.file?.path ?? "global";
		let card: DiagramCardHandle | null = null;
		const act = (lockKey: string, requiresIdle: boolean, task: (context: { ignoreKeys: readonly string[] }) => Promise<void>): void => {
			void runGuardedAction(this.runs, { lockKey, requiresIdle }, task, {
				busy: (text) => this.notify(text),
				failed: (error) => this.notify(this.plugin.getErrorMessage(error)),
				started: () => card?.setBusy(true),
				settled: () => card?.setBusy(false)
			});
		};
		card = renderDiagramCard(
			message.wrapper,
			{ status: diagramCardStatus(diagram), copy: describeDiagramCard(diagram, { hasNote }), source: diagram.source, hasNote },
			{
				onInsert: () => act(`mutation:${path}`, true, async () => {
					// The same preview and approval as every other write to a note.
					const outcome = await this.plugin.applyResponseToContext(request, getText(), { scope: "append" });
					this.reportOutcome(outcome.status === "applied"
						? `${outcome.message} If Obsidian asks whether to trust Mermaid diagrams in this vault, choose Trust to see it in the note.`
						: outcome.message);
				}),
				onNewNote: () => act(`mutation:${path}`, true, async () => {
					const file = await this.plugin.createResultNote(request, getText(), { model });
					this.reportOutcome(`Created note: ${file.path}`);
				}),
				onCopy: () => act("", false, () => copyAnswerText(diagram.source)),
				onFix: () => act("diagram-fix", true, (context) => this.runRequest({
					question: buildFixQuestion(diagram),
					title: "AskMate Diagram",
					options: { ...this.getRequestDraftOptions(false), intentKind: "diagram" },
					displayText: "Fix the diagram",
					skillRefs: [MERMAID_SKILL_ID],
					diagram: request.metadata.diagram ?? firstLook(this.plugin.settings.diagrams),
					ignoreKeys: context.ignoreKeys
				})),
				onAnotherLook: () => act("diagram-look", true, (context) => this.runRequest({
					...spec,
					options: { ...spec.options, threadMessages: undefined },
					builtRequest: undefined,
					displayText: "Another look at the diagram",
					diagram: nextLook(request.metadata.diagram, this.plugin.settings.diagrams),
					ignoreKeys: context.ignoreKeys,
					reuse: undefined,
					onSent: undefined
				}))
			},
			this.createDiagramPreviewHost()
		);
		message.wrapper.insertBefore(card.el, message.evidence);
		this.maybeScrollMessagesToBottom();
		return card;
	}

	/** Draws through Obsidian's own Mermaid, so it works even when the vault has not turned on diagrams in notes. */
	private createDiagramPreviewHost(): DiagramPreviewHost {
		return {
			draw: async (target, source): Promise<DrawResult> => {
				const key = sourceHash(source);
				const cached = this.diagramPreviews.get(key);
				if (cached !== undefined) {
					return mountSvg(target, cached) ? "drawn" : "failed";
				}
				const api = await this.plugin.loadMermaidApi();
				if (!api) {
					return "unavailable";
				}
				const scratch = createScratchHost(target.ownerDocument.body).open();
				try {
					const { svg } = await api.render(nextRenderId(), source, scratch.container);
					if (!mountSvg(target, svg)) {
						return "failed";
					}
					this.diagramPreviews.set(key, svg);
					if (this.diagramPreviews.size > MAX_CACHED_DIAGRAMS) {
						const oldest = this.diagramPreviews.keys().next();
						if (!oldest.done) {
							this.diagramPreviews.delete(oldest.value);
						}
					}
					return "drawn";
				} catch {
					return "failed";
				} finally {
					scratch.close();
				}
			}
		};
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
				// The prompt describes the picture, so it is the alternative text.
				alt: `Generated image: ${result.image.prompt.replace(/\s+/g, " ").trim().slice(0, 140) || "no description"}`,
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
			this.reportOutcome(`Created note: ${noteFile.path} and image: ${imageFile.path}`);
			// Saving the note also saved the picture, so the saved copy of this reply can now point at it.
			this.queueThreadSave();
		}, { requiresIdle: true, lockKey: `mutation:${request.context.file?.path ?? "global"}` });
		this.createMessageAction(parent, "image-plus", "Insert image", async () => {
			const outcome = await this.plugin.applyImageToContext(request, getResult());
			this.reportOutcome(outcome.message);
			this.queueThreadSave();
		}, { requiresIdle: true, lockKey: `mutation:${request.context.file?.path ?? "global"}` });
	}

	/**
	 * One button. Busy rules and claims come from the run controller: an action that changes something holds a named
	 * claim while it works (so a second click, or a new request, is refused) and one that needs the sidebar idle is
	 * refused while a request runs. The action receives the key it holds, for a request it starts itself (Retry).
	 */
	private createMessageAction(
		parent: HTMLElement,
		icon: string,
		label: string,
		onClick: ReplyHandler,
		options: ReplyActionOptions = {}
	): HTMLButtonElement {
		const wrapper = parent.closest(".askmate-message");
		if (wrapper instanceof HTMLElement) {
			wrapper.addClass("askmate-message-has-actions");
		}

		const blocked = Boolean(options.disabledReason);
		const button = parent.createEl("button", { cls: options.variant === "primary" ? "askmate-message-action is-primary" : "askmate-message-action" });
		button.type = "button";
		button.dataset.consoleLabel = CONSOLE_ACTION_LABELS[label] ?? label.toLowerCase().split(" ")[0];
		button.setAttribute("aria-label", label);
		button.setAttribute("title", options.disabledReason ? `${label}. ${options.disabledReason}` : label);
		if (blocked) {
			button.dataset.askmateBlocked = "true";
			button.disabled = true;
		}
		if (options.requiresIdle) {
			button.dataset.askmateRequiresIdle = "true";
			button.disabled = blocked || Boolean(this.activeRun);
		}
		this.addIcon(button, icon, "askmate-message-action-icon");
		button.createSpan({ cls: "askmate-visually-hidden", text: label });
		button.addEventListener("click", () => {
			const lockKey = options.lockKey ?? (options.requiresIdle ? label : "");
			// A button that disables itself while it works must hand the focus back when it is enabled again.
			const hadFocus = button.ownerDocument.activeElement === button;
			void runGuardedAction(this.runs, { lockKey, requiresIdle: Boolean(options.requiresIdle) }, onClick, {
				busy: (message) => this.notify(message),
				failed: (error) => this.notify(this.plugin.getErrorMessage(error)),
				started: () => {
					if (lockKey) {
						button.disabled = true;
					}
				},
				settled: () => {
					if (!lockKey) {
						return;
					}
					button.disabled = blocked || (options.requiresIdle ? Boolean(this.activeRun) : false);
					if (hadFocus && !button.disabled && button.isConnected) {
						button.focus();
					}
				}
			});
		});
		return button;
	}

	private showText(text: string, title: string): void {
		const value = text.trim();

		if (!value) {
			this.notify("Nothing to show yet.");
			return;
		}

		new AskMateTextViewerModal(this.app, title, value).open();
	}

	/**
	 * The Console shows @selection in the box as typed. Elsewhere a selection is already the default scope, so the mention
	 * is left out to keep the box to what the person writes.
	 */
	focusComposer(consoleText: string): void {
		if (!this.questionEl) {
			return;
		}
		const prefix = this.isConsoleLayout() && !this.questionEl.value.includes(consoleText.trim()) ? consoleText : "";
		this.questionEl.value = `${prefix}${this.questionEl.value}`;
		this.questionEl.focus();
		const caret = prefix.length > 0 ? prefix.length : this.questionEl.value.length;
		this.questionEl.setSelectionRange(caret, caret);
	}

	/** Puts text in the composer without destroying a draft: it goes below the draft, and the draft can be restored. */
	private useTextInComposer(text: string): void {
		const change = mergeIntoDraft(this.questionEl.value, text);
		this.questionEl.value = change.text;
		this.draftUndo = change.previous === null ? null : { previous: change.previous, merged: change.text };
		this.refreshDraftUndo();
		this.questionEl.focus();
		this.questionEl.setSelectionRange(this.questionEl.value.length, this.questionEl.value.length);
		this.scheduleRequestPreviewRefresh();
		this.scheduleSkillChips();
	}

	private refreshDraftUndo(): void {
		const host = this.draftUndoEl;
		if (!host) {
			return;
		}
		host.empty();
		host.hidden = this.draftUndo === null;
		if (this.draftUndo === null) {
			return;
		}
		host.setAttribute("role", "status");
		host.createSpan({ text: "Added below your draft." });
		const undo = host.createEl("button", { text: "Undo" });
		undo.type = "button";
		undo.addEventListener("click", () => {
			const pending = this.draftUndo;
			if (pending && canUndoDraft(pending, this.questionEl.value)) {
				this.questionEl.value = pending.previous;
				this.questionEl.focus();
				this.scheduleRequestPreviewRefresh();
				this.scheduleSkillChips();
			}
			this.draftUndo = null;
			this.refreshDraftUndo();
		});
	}

	/** The undo is offered only for the text it would restore; any edit makes it stale. */
	private hideDraftUndoIfChanged(): void {
		if (this.draftUndo !== null && !canUndoDraft(this.draftUndo, this.questionEl.value)) {
			this.draftUndo = null;
			this.refreshDraftUndo();
		}
	}

	private renderMarkdownSoon(body: HTMLElement, markdown: string, sourcePath: string): void {
		// A diagram that is still being written is shown as a note and drawn once, when its last line arrives.
		const plan = planStreamRender(markdown);
		this.showDrawingNote(body, plan.drawing ? DRAWING_DIAGRAM_TEXT : null);
		if (isRenderCurrent(plan, this.streamedText.get(body))) {
			return;
		}
		// Throttle rather than debounce, so a steady stream of deltas still renders every 120 ms.
		this.pendingMarkdown.set(body, { markdown: plan.settled, sourcePath });
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
				this.streamedText.set(body, latest.markdown);
				this.renderMarkdownNow(body, latest.markdown, latest.sourcePath);
			}
		}, streamRenderDelay(plan));
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

	private renderMarkdownNow(body: HTMLElement, markdown: string, sourcePath: string, allowPluginHeader = false): void {
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
		// A saved diagram carries the strict header AskMate built for it; the guard still checks that header against its closed schema.
		const safe = allowPluginHeader ? sanitizeModelMarkdown(markdown, { allowPluginMermaidHeader: true }) : sanitizeModelMarkdown(markdown);
		void MarkdownRenderer.render(this.app, safe, host, sourcePath, component)
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
			// The registered AskMate mark; its colours come from the theme and the brand tokens in the style sheet.
			setIcon(avatar.createSpan({ cls: "askmate-brand-mark", attr: { "aria-hidden": "true" } }), ASKMATE_ICON_ID);
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
		this.readinessEl.setAttribute("aria-label", label);
		if (isReady) {
			this.readinessEl.setAttribute("role", "status");
			this.readinessEl.removeAttribute("tabindex");
			this.readinessEl.setAttribute("title", "AskMate is ready");
		} else {
			// Not ready is something to act on, so the chip is a button that opens the Connect card.
			this.readinessEl.setAttribute("role", "button");
			this.readinessEl.tabIndex = 0;
			this.readinessEl.setAttribute("title", "Connect an AI provider");
		}
	}

	private openSetupFromReadiness(): void {
		if (this.readinessEl?.classList.contains("is-not-ready")) {
			this.openSetupFlow();
		}
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

	private async openPromptInspector(questionOverride?: string, optionsOverride?: RunRequestOptions, skillNames: readonly string[] = []): Promise<void> {
		try {
			const raw = questionOverride?.trim() || this.questionEl.value.trim() || "Preview request";
			if (optionsOverride) {
				const plain = parsePlainComposerCommand(raw);
				const inspection = await this.plugin.inspectFinalPrompt(plain.question, plain.forceImage ? "AskMate Image" : "AskMate Answer", this.withSkillSelection(optionsOverride, skillNames));
				new AskMatePromptInspectorModal(this.app, inspection).open();
				return;
			}
			// The same reading as the request preview, so Inspect prompt shows what Enter would send, workflow commands included.
			const draft = this.resolveDraftRequest(raw);
			if (draft.kind === "none") {
				this.notify(draft.hint);
				return;
			}
			const inspection = await this.plugin.inspectFinalPrompt(draft.question, draft.title, this.withSkillSelection(draft.options, draft.skillNames));
			new AskMatePromptInspectorModal(this.app, inspection).open();
		} catch (error) {
			this.notify(this.plugin.getErrorMessage(error));
		}
	}

	private createFreshThread(): SavedThread {
		const now = new Date();
		return createThread(createThreadId(now, Math.random()), now);
	}

	/**
	 * Plain-data snapshot of the sidebar conversation; also refreshes the remembered title. A question whose run is
	 * still going is left out by identity, so saving never stores a question with no answer.
	 */
	private snapshotThread(): SavedThread {
		for (const message of this.messages) {
			const image = this.generatedImages.get(message);
			if (image?.savedImagePath) {
				message.imagePath = image.savedImagePath;
			}
		}
		const now = new Date();
		const snapshot = withThreadMessages(this.threadMeta, settleThreadMessages(this.messages, [...this.pendingTurns], now.toISOString()), now);
		this.threadMeta = { ...snapshot, messages: [] };
		return snapshot;
	}

	private queueThreadSave(): void {
		this.plugin.threads.scheduleSave(this.snapshotThread());
	}

	/** Writes the conversation now and waits for the write, so closing, switching and finishing never rely on a timer. */
	private async persistThread(): Promise<void> {
		await this.plugin.threads.saveNow(this.snapshotThread());
	}

	private async saveThreadNow(): Promise<void> {
		await this.persistThread();
		await this.plugin.threads.flush();
	}

	private restoreActiveThread(): void {
		const saved = this.plugin.threads.getActiveThread();
		if (saved) {
			this.showThread(saved);
		}
	}

	private showThread(saved: SavedThread): void {
		if (saved.id !== this.threadMeta.id) {
			this.forgetToolGrants();
		}
		this.threadMeta = { ...saved, messages: [] };
		this.messages = fromSavedMessages(saved.messages);
		this.pendingTurns.clear();
		this.renderTranscript();
	}

	/** Draws the conversation from `messages`. System lines (stops, errors, command output) are not part of a conversation. */
	private renderTranscript(): void {
		this.emptyTranscript();
		this.shouldFollowMessages = true;
		for (const message of this.messages) {
			if (message.role === "user") {
				const user = this.createMessageEl("user", message.text, false);
				this.createMessageAction(user.actions, "pencil", "Edit", () => {
					this.useTextInComposer(message.text);
				});
				continue;
			}
			if (message.role !== "assistant") {
				continue;
			}
			const assistant = this.createMessageEl("assistant", "", true);
			const markdown = message.image && message.imagePath ? `${message.text}\n\n![[${message.imagePath}]]` : message.text;
			this.renderMarkdownNow(assistant.body, markdown, message.sourcePath ?? "", Boolean(message.diagram));
			if (message.incomplete) {
				this.renderMessageWarning(assistant, "This reply may be incomplete. Review it before applying it to a note.");
			}
			if (message.tools && message.tools.length > 0) {
				const list = renderSavedToolCalls(assistant.wrapper, message.tools);
				if (list) {
					assistant.wrapper.insertBefore(list, assistant.body);
				}
			}
			if (!message.image) {
				this.renderRestoredActions(assistant.actions, {
					text: message.text,
					incompleteReason: message.incomplete ? SAVED_INCOMPLETE_REASON : null,
					...(message.diagram ? { diagram: insertMarkFor(message.diagram.status) } : {})
				});
			}
		}
		this.lastAnswer = withDiagramMark(lastAnswerFromMessages(this.messages), this.messages);
		this.refreshSkillChips();
		this.refreshConsoleStatus();
		this.scrollMessagesToBottom();
	}

	/** Empties the transcript and puts the Connect card's place back at the top, where the first entry belongs. */
	private emptyTranscript(): void {
		this.releaseAllMarkdownComponents();
		this.messagesEl.empty();
		this.toolCards.clear();
		this.setupHostEl = null;
		this.setupHandle = null;
		this.mountSetupHost();
		this.refreshSetupCard();
	}

	/** Saved conversations were deleted in settings: what the sidebar shows must go too, or its next save would bring them back. */
	private handleThreadsCleared(): void {
		if (this.isClosed || !this.messagesEl) {
			return;
		}
		this.stopActiveRun(false);
		this.forgetToolGrants();
		this.threadMeta = this.createFreshThread();
		this.messages = [];
		this.pendingTurns.clear();
		this.lastAnswer = null;
		this.onceSkillIds = [];
		this.renderTranscript();
		this.printConsoleOutput("Saved conversations were deleted, so this conversation was cleared too.");
	}

	/** A note the conversation mentions was renamed or deleted: the open transcript follows, or its next save would undo the change. */
	private handlePathChange(changed: readonly ChatMessageLike[]): void {
		if (changed.length === 0 || this.isClosed || !this.messagesEl) {
			return;
		}
		for (const message of changed) {
			const image = this.generatedImages.get(message);
			if (image) {
				image.savedImagePath = message.imagePath ?? null;
			}
		}
		// A reply that is still arriving is redrawn with the next conversation change.
		if (!this.activeRun) {
			this.renderTranscript();
		}
	}

	private assertNoActiveRequest(action: string): void {
		if (this.runs.getBusyReason() !== null) {
			throw new Error(`Stop the current request before ${action}.`);
		}
	}

	private async startNewThread(): Promise<void> {
		this.assertNoActiveRequest("starting a new conversation");
		await this.saveThreadNow();
		// A request may have started while the save was being written.
		this.assertNoActiveRequest("starting a new conversation");
		this.forgetToolGrants();
		this.threadMeta = this.createFreshThread();
		this.messages = [];
		this.pendingTurns.clear();
		this.lastAnswer = null;
		this.onceSkillIds = [];
		this.renderTranscript();
		await this.plugin.threads.markActive(null);
		this.printConsoleOutput(this.plugin.threads.isEnabled()
			? "Started a new conversation. The previous one is saved; use /threads to switch back."
			: "Started a new conversation. Saving conversations is off, so the previous one was not kept.");
	}

	private openThreadSwitcher(purpose: "switch" | "delete" = "switch"): void {
		const threads = this.plugin.threads.listThreads();
		if (threads.length === 0) {
			this.notify(this.plugin.threads.isEnabled()
				? "No saved conversations yet. Ask a question first."
				: "Saving conversations is off. Turn on Remember conversations in AskMate settings, under Privacy and memory, to keep threads.");
			return;
		}
		new AskMateThreadPickerModal(this.app, threads, this.threadMeta.id, purpose, (thread) => {
			this.runUiTask(purpose === "delete" ? this.deleteSavedThread(thread) : this.switchToThread(thread.id));
		}).open();
	}

	private async switchToThread(id: string): Promise<void> {
		if (id === this.threadMeta.id) {
			return;
		}
		this.assertNoActiveRequest("switching conversations");
		await this.saveThreadNow();
		// A request may have started while the save was being written.
		this.assertNoActiveRequest("switching conversations");
		const target = this.plugin.threads.getThread(id);
		if (!target) {
			throw new Error("That conversation is no longer saved.");
		}
		this.onceSkillIds = [];
		this.showThread(target);
		await this.plugin.threads.markActive(target.id);
		this.printConsoleOutput(`Switched to "${target.title}".`);
	}

	private async renameActiveThread(title: string): Promise<void> {
		this.threadMeta = renameThreadValue(this.threadMeta, title);
		const snapshot = this.snapshotThread();
		this.printConsoleOutput(snapshot.messages.length > 0 ? `Renamed to "${snapshot.title}".` : `Title set to "${snapshot.title}". It is saved with the first question.`);
		await this.saveThreadNow();
	}

	private async deleteSavedThread(thread: SavedThread): Promise<void> {
		if (!(await askMateConfirm(this.app, `Delete the saved conversation "${thread.title}"? This cannot be undone.`))) {
			return;
		}
		const isCurrent = thread.id === this.threadMeta.id;
		// While the delete is under way no request may start, and a request that started during the confirmation is not interrupted.
		const outcome = await this.runs.withClaim("delete-thread", async () => {
			const removed = await this.plugin.threads.remove(thread.id);
			if (removed && isCurrent) {
				this.forgetToolGrants();
				this.threadMeta = this.createFreshThread();
				this.messages = [];
				this.pendingTurns.clear();
				this.lastAnswer = null;
				this.onceSkillIds = [];
				this.renderTranscript();
			}
			return removed;
		}, { requireIdle: isCurrent });
		if (!outcome.ok) {
			throw new Error(outcome.message);
		}
		this.printConsoleOutput(
			outcome.value ? `Deleted "${thread.title}".` : `AskMate could not delete "${thread.title}". Try again.`,
			outcome.value ? "info" : "error"
		);
	}

	/** Writes the sidebar conversation to a note in the result folder and opens it. */
	async exportConversation(requestedTitle: string): Promise<void> {
		this.snapshotThread();
		if (!hasExportableTurns(this.messages)) {
			this.notify("There is no conversation to export yet.");
			return;
		}
		const ref = this.plugin.getSelectedProviderModelRef();
		const lastModel = [...this.messages].reverse().find((message) => message.role === "assistant" && message.model)?.model;
		const now = new Date();
		const title = resolveExportTitle(requestedTitle || (this.threadMeta.autoTitle ? "" : this.threadMeta.title), this.messages);
		const markdown = conversationToMarkdown(this.messages, {
			title,
			exportedAt: now.toISOString(),
			exportedAtLabel: now.toLocaleString(),
			providerName: ref.providerName,
			model: lastModel ?? ref.model
		});
		const file = await this.plugin.createConversationNote(title, markdown);
		this.notify(`Exported conversation to ${file.path}`);
		await this.app.workspace.getLeaf("tab").openFile(file);
	}

	private async showNoteHistory(): Promise<void> {
		try {
			const context = await this.plugin.getNoteContext();
			new AskMateNoteHistoryModal(this.app, this.plugin, context.file?.path ?? "").open();
		} catch (error) {
			this.notify(this.plugin.getErrorMessage(error));
		}
	}

	private async showContextNotice(): Promise<void> {
		try {
			const context = await this.plugin.getNoteContext();
			const source = context.file?.path ?? "unsaved note";
			this.notify(`${context.source}: ${source}`);
		} catch {
			this.notify("Open a Markdown note or select text to add context.");
		}
	}

	private async updateContextLabel(): Promise<void> {
		if (!this.contextEl) {
			return;
		}

		let hasNote = false;
		try {
			const context = await this.plugin.getNoteContext();
			const source = context.file?.path ?? "unsaved note";
			const label = `${context.source}: ${source}`;
			this.contextEl.setAttribute("aria-label", `Show selected note. ${label}`);
			this.contextEl.setAttribute("title", label);
			hasNote = true;
		} catch {
			const label = "No note is open. AskMate can still answer, but not about a note.";
			this.contextEl.setAttribute("aria-label", label);
			this.contextEl.setAttribute("title", label);
		}
		// The starter chips are disabled with a reason until a note is open, so they follow it.
		if (hasNote !== this.hasOpenNote && !this.isClosed) {
			this.hasOpenNote = hasNote;
			this.refreshSetupCard();
		}
	}

	private setLoading(isLoading: boolean): void {
		this.rootEl?.classList.toggle("is-loading", isLoading);
		this.messagesEl?.setAttribute("aria-busy", String(isLoading));
		const doc = this.rootEl?.doc;
		const focused = doc?.activeElement ?? null;
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
				button.disabled = isLoading || button.dataset.askmateBlocked === "true";
			});
		this.rootEl
			?.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>("[data-askmate-preview-control=\"true\"]")
			.forEach((control) => {
				control.disabled = isLoading;
			});
		this.sendButton.disabled = isLoading;
		// A control that has focus and is then disabled drops the focus to the page, so keyboard users are put back in the box.
		if (isLoading && focused && focused !== this.questionEl && this.rootEl?.contains(focused) && (focused as HTMLButtonElement).disabled) {
			this.questionEl.focus();
		}
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
		// Every segment is created once and updated in place: refreshes run on pointerdown and focusin, and a segment that
		// was replaced would take keyboard focus with it.
		const segments = this.consoleStatusEl.createDiv({ cls: "askmate-console-status-segments" });
		this.statusSegments = createStatusSegments(segments, {
			onMode: () => {
				const order: OutputMode[] = ["chat", "note", "apply"];
				const current = order.indexOf(normalizeOutputMode(this.plugin.settings.outputMode));
				this.runUiTask(this.selectOutputMode(order[(current + 1) % order.length]));
			},
			onModel: () => this.openModelPicker(),
			onSetup: () => this.openSetupFlow()
		});
		this.consoleStopButton = this.consoleStatusEl.createEl("button", { cls: "askmate-console-stop", text: this.runs.describeStopControl().consoleText });
		this.consoleStopButton.type = "button";
		this.consoleStopButton.hidden = true;
		this.consoleStopButton.addEventListener("click", () => {
			this.stopActiveRun();
		});
	}

	private refreshConsoleStatus(): void {
		if (!this.statusSegments) {
			return;
		}
		const ref = this.plugin.getSelectedProviderModelRef();
		const mode = normalizeOutputMode(this.plugin.settings.outputMode);
		this.statusSegments.update(buildStatusSegments({
			console: formatConsoleStatus({
				mode,
				providerName: ref.providerName,
				model: ref.model,
				effort: this.plugin.supportsSelectedReasoningEffort() ? this.plugin.getSelectedReasoningEffort() : null,
				dayUsedTokens: this.plugin.getTodayTokenUsage(),
				dayBudgetTokens: this.plugin.settings.usageDailyTokenBudget
			}),
			stage: this.readSetupStage(),
			stickySkills: this.threadMeta.skillIds?.length ?? 0,
			mcp: this.plugin.mcpService?.status() ?? null,
			busy: Boolean(this.activeRun)
		}));
		const modeButton = this.statusSegments.buttons.mode;
		modeButton?.classList.toggle("is-note", mode === "note");
		modeButton?.classList.toggle("is-apply", mode === "apply");
	}

	/** Returns true when the composer handled the key: a suggestion in any layout, or history and stop in the Console. */
	private handleComposerKeydown(event: KeyboardEvent): boolean {
		if (event.isComposing) {
			return false;
		}
		return this.handleCompletionKeydown(event) || (this.isConsoleLayout() && this.handleConsoleKeydown(event));
	}

	/** Moves through, accepts or closes the suggestion list. The list is the same in every layout. */
	private handleCompletionKeydown(event: KeyboardEvent): boolean {
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
		return false;
	}

	/** The Console's own keys: Escape stops a request, and the arrows browse the lines typed before. */
	private handleConsoleKeydown(event: KeyboardEvent): boolean {
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
		if (!this.questionEl) {
			this.closeConsoleCompletions();
			return;
		}
		const value = this.questionEl.value;
		// Ordinary prose, typed in any layout, offers nothing, so the lists behind the suggestions are not built for it.
		const beforeCaret = value.slice(0, this.questionEl.selectionStart ?? value.length);
		if (!beforeCaret.startsWith("/") && !/(^|\s)@\S*$/.test(beforeCaret)) {
			if (this.consoleCompletion) {
				this.closeConsoleCompletions();
			}
			return;
		}
		const providerId = this.plugin.getChatProviderId();
		const result = getConsoleCompletions(value, this.questionEl.selectionStart ?? value.length, this.consoleCommands, {
			models: listProviderModels(providerId, this.plugin.settings),
			providers: TEXT_PROVIDER_IDS.map((id) => ({ id, label: TEXT_PROVIDER_LABELS[id] })),
			// Scanning every note's tags is only worth it while a tag mention is being typed.
			vaultTags: value.includes("@tag:") ? this.plugin.getVaultTags() : [],
			skills: this.listUsableSkillsForCompletion()
		});
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
		this.questionEl?.setAttribute("aria-expanded", "false");
	}

	/** Echo of a typed command. Kept out of `messages`, so commands never become thread history. Said once per submit. */
	private echoConsoleCommand(raw: string): void {
		if (this.echoedConsoleLine === raw) {
			return;
		}
		this.echoedConsoleLine = raw;
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
			contextScope: mentions.scope,
			vaultMentions: mentions.vault
		};
	}

	private async submitConsoleInput(): Promise<void> {
		const raw = this.questionEl.value.trim();
		if (!raw) {
			this.notify("Type a question, or /help for commands.");
			return;
		}
		this.closeConsoleCompletions();
		const action = parseConsoleInput(raw, this.consoleCommands);
		if (classifyConsoleAction(action) === "request" && !this.ensureIdleForNewRequest()) {
			return;
		}
		this.rememberConsoleInput(raw);
		this.echoedConsoleLine = null;

		try {
			await this.runConsoleAction(action, raw);
		} catch (error) {
			// The command is echoed once even if it was already echoed before the failure, and the text comes back to be fixed.
			this.echoConsoleCommand(raw);
			this.printConsoleOutput(this.plugin.getErrorMessage(error), "error");
			if (!this.questionEl.value) {
				this.questionEl.value = raw;
			}
		}
	}

	/** Clears the prompt and echoes the command once the action is known to succeed. */
	private commitConsoleCommand(raw: string, echo = true): void {
		this.questionEl.value = "";
		this.scheduleRequestPreviewRefresh();
		this.scheduleSkillChips();
		if (echo) {
			this.echoConsoleCommand(raw);
		}
	}

	getLastAnswer(): InsertableReply | null {
		return this.lastAnswer;
	}

	/**
	 * Starts a new conversation and keeps the old one in Saved conversations. The palette command calls this, and so do /new and the
	 * header button in every layout. It rejects, with the reason, while a request is running.
	 */
	async startNewConversation(): Promise<void> {
		await this.startNewThread();
	}

	/**
	 * Draws a Mermaid diagram of the remembered note, or of what `prompt` asks for. The same in every composer layout, and the
	 * composer text is left alone. It rejects when diagrams are off or the model cannot write text; a missing connection opens the
	 * Connect card instead.
	 */
	async startDiagram(prompt?: string): Promise<void> {
		await this.runDiagram(prompt?.trim() ?? "");
	}

	private openModelPicker(): void {
		if (this.activeRun) {
			this.notify("Wait for the current AskMate request to finish, or stop it first.");
			return;
		}
		const ref = this.plugin.getChatProviderModelRef();
		const choices = buildModelChoices(this.plugin.settings, ref.providerId);
		new ModelPickerModal(this.app, choices, ref, (choice: ModelChoice) => {
			this.runUiTask(this.switchChatModel(choice.providerId, choice.model));
		}).open();
	}

	/** Saves the choice, then lets every open view recheck reasoning support and its status line. */
	private async switchChatModel(providerId: TextProviderId, model?: string): Promise<void> {
		if (this.activeRun) {
			throw new Error("Wait for the current request to finish, or press Esc to stop it, before switching model.");
		}
		applyChatSelection(this.plugin.settings, providerId, model);
		await this.plugin.saveSettings();
		this.plugin.refreshOpenAskMateViews();
		const ref = this.plugin.getChatProviderModelRef();
		this.addMessage("system", `Model: ${ref.providerName} / ${ref.model || "(none selected)"}`);
		if (providerNeedsApiKey(providerId, this.plugin.settings)) {
			this.addMessage("system", `${ref.providerName} has no API key configured. Add one in AskMate settings before sending.`);
		}
	}

	private async runModelCommand(query: string): Promise<void> {
		const ref = this.plugin.getChatProviderModelRef();
		const available = listProviderModels(ref.providerId, this.plugin.settings);
		if (!query.trim()) {
			this.printConsoleOutput(formatModelListing(ref.providerName, ref.model, available));
			return;
		}
		const resolution = resolveModelQuery(query, available);
		if (resolution.kind === "ambiguous") {
			this.printConsoleOutput(`"${query.trim()}" matches several models: ${resolution.candidates.join(", ")}. Type more of the name.`, "error");
			return;
		}
		if (resolution.kind === "unknown") {
			this.printConsoleOutput(`No ${ref.providerName} model matches "${resolution.query}". Type /model to list models, or /model ${resolution.query}! to use it anyway.`, "error");
			return;
		}
		await this.switchChatModel(ref.providerId, resolution.model);
	}

	private async runProviderCommand(query: string): Promise<void> {
		if (!query.trim()) {
			this.printConsoleOutput(formatProviderListing(this.plugin.getChatProviderId(), this.plugin.settings));
			return;
		}
		const match = resolveProviderQuery(query);
		if (match.kind === "none") {
			this.printConsoleOutput(`Unknown provider "${query.trim()}". Type /provider to list them.`, "error");
			return;
		}
		if (match.kind === "ambiguous") {
			this.printConsoleOutput(`"${query.trim()}" matches several providers: ${match.candidates.join(", ")}. Type more of the name.`, "error");
			return;
		}
		await this.switchChatModel(match.value);
	}

	private async switchLayout(layout: ComposerLayout): Promise<void> {
		this.plugin.settings.composerLayout = layout;
		await this.plugin.saveSettings();
		this.plugin.refreshOpenAskMateViews();
		this.notify(layout === "console"
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
				// Clearing the chat starts a new conversation and keeps the old one, so it is never a loss.
				this.commitConsoleCommand(raw, false);
				await this.startNewThread();
				return;
			case "mode":
				if (this.activeRun) {
					throw new Error("Wait for the current request to finish, or press Esc to stop it, before changing the output mode.");
				}
				await this.selectOutputMode(action.mode);
				this.commitConsoleCommand(raw);
				this.printConsoleOutput(`Output mode: ${formatOutputMode(action.mode)}. It applies to your next question only.`);
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
			case "model":
				if (action.query.trim() && this.activeRun) {
					throw new Error("Wait for the current request to finish, or press Esc to stop it, before switching model.");
				}
				this.commitConsoleCommand(raw);
				await this.runModelCommand(action.query);
				return;
			case "provider":
				if (action.query.trim() && this.activeRun) {
					throw new Error("Wait for the current request to finish, or press Esc to stop it, before switching provider.");
				}
				this.commitConsoleCommand(raw);
				await this.runProviderCommand(action.query);
				return;
			case "layout":
				await this.switchLayout(action.layout);
				this.commitConsoleCommand(raw, false);
				return;
			case "context": {
				const options = this.applyConsoleMentions(this.getRequestDraftOptions(false), action.mentions);
				const lines = await this.describeConsoleContext(this.withSkillSelection(options, action.mentions.skills));
				this.commitConsoleCommand(raw);
				this.printConsoleOutput(lines.text, lines.blocked ? "error" : "info");
				return;
			}
			case "inspect": {
				const options = this.applyConsoleMentions(this.getRequestDraftOptions(false), action.mentions);
				this.commitConsoleCommand(raw);
				await this.openPromptInspector(action.question || "Preview request", options, action.mentions.skills);
				return;
			}
			case "history":
				this.commitConsoleCommand(raw);
				await this.showNoteHistory();
				return;
			case "export":
				this.commitConsoleCommand(raw);
				await this.exportConversation(action.title);
				return;
			case "newThread":
				this.assertNoActiveRequest("starting a new conversation");
				this.commitConsoleCommand(raw, false);
				await this.startNewThread();
				return;
			case "threads":
				this.commitConsoleCommand(raw);
				this.openThreadSwitcher();
				return;
			case "renameThread":
				this.commitConsoleCommand(raw);
				await this.renameActiveThread(action.title);
				return;
			case "deleteThread":
				this.commitConsoleCommand(raw);
				this.openThreadSwitcher("delete");
				return;
			case "setup":
				this.commitConsoleCommand(raw);
				this.openSetupFlow();
				return;
			case "welcome":
				this.commitConsoleCommand(raw);
				this.openWelcome();
				return;
			case "skills":
				this.commitConsoleCommand(raw);
				this.printConsoleOutput(this.describeSkills());
				return;
			case "mcp":
				this.commitConsoleCommand(raw);
				this.printConsoleOutput(formatMcpStatus(this.plugin.mcpService?.status()));
				this.refreshConsoleStatus();
				return;
			case "test": {
				this.commitConsoleCommand(raw);
				const outcome = await this.runConnectionTest();
				this.printConsoleOutput(outcome.line, outcome.ok ? "info" : "error");
				if (!outcome.ok) {
					// The card carries the button that fixes it.
					this.openSetupFlow();
				}
				return;
			}
			case "images": {
				this.commitConsoleCommand(raw);
				if (action.setting) {
					this.imagePreviewsEnabled = action.setting === "on";
					this.writeImagePreviewSetting(this.imagePreviewsEnabled);
				}
				this.printConsoleOutput(this.imagePreviewsEnabled
					? "Image previews are on. Pictures that a note links to are shown above a reply when your question asks to see them. Type /images off to turn them off."
					: "Image previews are off. Type /images on to show the pictures that a note links to when you ask to see them.");
				return;
			}
			case "skill": {
				const found = lookUpSkill(this.plugin.skillService, action.name);
				if (!found.ok) {
					throw new Error(found.message);
				}
				if (!action.question) {
					// With no question, the skill is chosen for the whole conversation.
					this.commitConsoleCommand(raw);
					this.printConsoleOutput(await this.toggleStickySkill(found.skill));
					return;
				}
				const options = this.applyConsoleMentions(this.getRequestDraftOptions(false), action.mentions);
				if (!(await this.isProviderReadyForSubmit("Connect an AI provider before sending."))) {
					return;
				}
				const refs = [action.name, ...action.mentions.skills];
				this.assertSkillsUsable([...refs, ...this.onceSkillIds]);
				await this.runRequest({ question: action.question, title: "AskMate Answer", options, displayText: raw, skillRefs: refs, onSent: () => this.clearComposerIf(raw) });
				return;
			}
			case "diagram": {
				const options = this.applyConsoleMentions(this.getRequestDraftOptions(false), action.mentions);
				await this.runDiagram(action.prompt, { options, displayText: raw, skillRefs: action.mentions.skills, onSent: () => this.clearComposerIf(raw) });
				return;
			}
			case "ask": {
				const draft = this.getRequestDraftOptions(false);
				const withMode = action.outputMode ? { ...draft, outputMode: action.outputMode } : draft;
				// A "//" line is sent as typed: "//image x" asks about "/image x" and never generates an image.
				const options = this.applyConsoleMentions(action.literal ? { ...withMode, intentKind: "freeform_text" } : withMode, action.mentions);
				if (!(await this.isProviderReadyForSubmit("Connect an AI provider before sending."))) {
					return;
				}
				this.assertSkillsUsable([...action.mentions.skills, ...this.onceSkillIds]);
				await this.runRequest({ question: action.question, title: "AskMate Answer", options, displayText: raw, skillRefs: action.mentions.skills, onSent: () => this.clearComposerIf(raw) });
				return;
			}
			case "image": {
				const options = this.applyConsoleMentions(this.getRequestDraftOptions(true), action.mentions);
				if (!(await this.isProviderReadyForSubmit(IMAGE_KEY_MISSING_MESSAGE, () => this.plugin.isImageGenerationConfigured(), "image"))) {
					return;
				}
				await this.runRequest({ question: action.prompt, title: "AskMate Image", options, displayText: raw, onSent: () => this.clearComposerIf(raw) });
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
				if (!(await this.isProviderReadyForSubmit("Connect an AI provider before running a workflow."))) {
					return;
				}
				this.assertSkillsUsable([...action.mentions.skills, ...this.onceSkillIds]);
				await this.runRequest({
					question: this.plugin.getWorkflowPrompt(workflow),
					title: workflow.name,
					options,
					displayText: raw,
					skillRefs: action.mentions.skills,
					onSent: () => this.clearComposerIf(raw)
				});
				return;
			}
			default:
				return assertNeverAction(action);
		}
	}

	// ----- Setup: the Connect card ---------------------------------------------------------------------------------

	/** The card's place in the transcript: always its first entry, in every layout. */
	private mountSetupHost(): void {
		this.setupHostEl = this.messagesEl.createDiv({ cls: "askmate-setup-host", prepend: true });
		this.setupHostEl.hidden = true;
	}

	private hasSecret = (name: string): boolean => {
		try {
			return Boolean(this.app.secretStorage.getSecret(name));
		} catch {
			return false;
		}
	};

	private hasStoredKey(providerId: TextProviderId): boolean {
		const name = this.plugin.getProviderSettings(providerId).apiKeySecretName?.trim() ?? "";
		return name !== "" && this.hasSecret(name);
	}

	/** One answer to "is AskMate set up?", shared with the status bar and the settings page when the plugin provides it. */
	private readSetupStage(): SetupStage {
		const stage = this.plugin.getSetupState();
		// A test run here counts for ten minutes; after that the plugin's own record is the only answer.
		const fresh = this.setup.test && Date.now() - this.setup.test.at < LOCAL_TEST_MAX_AGE_MS ? this.setup.test : null;
		const overlaid = overlayTestResult(stage, fresh);
		return this.setup.testing && isReadyToSend(overlaid)
			? { providerId: overlaid.providerId, label: overlaid.label, model: overlaid.model, kind: "testing" }
			: overlaid;
	}

	private refreshSetupCard(): void {
		const host = this.setupHostEl;
		if (!host || this.isClosed) {
			return;
		}
		const stage = this.readSetupStage();
		// The chat provider is what the card is about until the person picks another chip, whichever provider it is. A chip
		// picked in an earlier visit does not outlive the visit, or a later gap in the chat provider would go unseen.
		const selected = this.chipInUse(stage);
		const model = deriveSetupCardModel({
			stage,
			selectedProvider: selected,
			flowOpen: this.setup.flowOpen,
			welcomeOpen: this.setup.welcomeOpen,
			hasOpenNote: this.hasOpenNote,
			hasStoredKey: this.hasStoredKey(selected),
			localError: this.setup.localError,
			savedBaseUrl: this.plugin.settings.providers[selected]?.baseUrl,
			savedModel: this.plugin.settings.providers[selected]?.model
		});
		// What was typed survives a redraw, and so does the keyboard focus inside the card. The view's draft is current
		// because every keystroke reports to it; reading it back from the old card would undo a clear.
		const hadFocus = host.contains(host.doc.activeElement);
		this.bindDraftTo(selected);
		host.empty();
		this.setupHandle = null;
		host.hidden = !model.visible;
		if (!model.visible) {
			// With the card gone, the tips can take its place.
			this.renderOnboardingTips();
			return;
		}
		this.setupHandle = renderSetupCard(host, model, {
			onSelectProvider: (id) => {
				this.setup.provider = id;
				this.setup.flowOpen = true;
				this.setup.localError = null;
				this.refreshSetupCard();
				this.setupHandle?.focusKey();
			},
			onConnect: (id, draft) => {
				this.setup.draft = draft;
				this.runUiTask(this.connectFromCard(id, draft));
			},
			onAction: (action) => this.handleSetupAction(action),
			onStarter: (chip) => this.runStarter(chip),
			onDismiss: () => this.closeSetupFlow(),
			onDraft: (draft) => {
				this.setup.draft = draft;
			}
		}, this.setup.draft);
		if (hadFocus) {
			// A control that had the keyboard is gone with the redraw: it goes to the first field, or after a connection to the starters.
			if (model.phase === "connected") {
				this.setupHandle.focusStart();
			} else {
				this.setupHandle.focusKey();
			}
		}
	}

	/**
	 * The provider chip the Connect card is on: the one picked during this visit, otherwise the chat provider. A chip picked in
	 * an earlier visit does not count, or a later gap in the chat provider would go unseen.
	 */
	private chipInUse(stage: SetupStage): TextProviderId {
		const choosing = this.setup.flowOpen || this.setup.welcomeOpen;
		return (choosing ? this.setup.provider : null) ?? stage.providerId;
	}

	/** The draft belongs to one provider: a key typed for OpenAI must never reach the Anthropic field or be saved under it. */
	private bindDraftTo(providerId: TextProviderId): void {
		if (this.setup.draftProvider !== providerId) {
			this.setup.draftProvider = providerId;
			this.setup.draft = emptySetupDraft();
		}
	}

	/** The key was used, rejected or abandoned: neither the card nor the view keeps it. */
	private clearSetupKey(): void {
		this.setup.draft = { ...this.setup.draft, apiKey: "" };
		this.setupHandle?.clearKey();
	}

	/** Shows the Connect card and puts the cursor in its first field. The typed question stays where it is. */
	private openSetupFlow(options: { message?: string; provider?: TextProviderId } = {}): void {
		// A new visit starts from the chat provider; a visit already open keeps the chip the person is on.
		if (options.provider) {
			this.setup.provider = options.provider;
		} else if (!this.setup.flowOpen) {
			this.setup.provider = null;
		}
		this.setup.flowOpen = true;
		this.setup.welcomeOpen = false;
		this.setup.localError = null;
		if (options.message) {
			this.notify(options.message);
		}
		this.refreshSetupCard();
		this.shouldFollowMessages = false;
		this.messagesEl.scrollTop = 0;
		this.setupHandle?.focusKey();
		this.refreshConsoleStatus();
	}

	private openWelcome(): void {
		if (!isReadyToSend(this.readSetupStage())) {
			this.openSetupFlow();
			return;
		}
		this.setup.provider = null;
		this.setup.flowOpen = false;
		this.setup.welcomeOpen = true;
		this.refreshSetupCard();
		this.shouldFollowMessages = false;
		this.messagesEl.scrollTop = 0;
	}

	private closeSetupFlow(): void {
		this.setup.provider = null;
		this.setup.flowOpen = false;
		this.setup.welcomeOpen = false;
		this.setup.localError = null;
		this.clearSetupKey();
		this.refreshSetupCard();
		this.refreshConsoleStatus();
		this.questionEl.focus();
	}

	private failSetup(message: string, action: SetupAction["kind"]): void {
		this.setup.localError = { message, detail: null, action: SETUP_ACTIONS[action] };
		this.refreshSetupCard();
		this.setupHandle?.focusKey();
	}

	/** Saves the key (or the address of a local server), makes the provider the chat provider, and tests the connection. */
	private async connectFromCard(providerId: TextProviderId, draft: SetupCardDraft): Promise<void> {
		if (this.setup.testing) {
			return;
		}
		const catalog = getProviderCatalogEntry(providerId);
		const settings = this.plugin.settings;
		this.setup.flowOpen = true;
		this.setup.welcomeOpen = false;
		this.setup.localError = null;
		this.setup.test = null;
		if (catalog.needsKey) {
			const typed = draft.apiKey.trim();
			if (typed) {
				const checked = checkApiKeyInput(typed);
				if (!checked.ok) {
					this.failSetup(checked.message, "update-key");
					return;
				}
				applyChatSelection(settings, providerId);
				await this.plugin.saveSettings();
				await this.plugin.saveProviderApiKey(providerId, checked.key);
				// Stored now: the typed copy goes from the field and from memory before anything redraws the card.
				this.clearSetupKey();
			} else if (this.hasStoredKey(providerId)) {
				applyChatSelection(settings, providerId);
				await this.plugin.saveSettings();
			} else {
				this.failSetup("Paste your API key first.", "update-key");
				return;
			}
		} else {
			// An empty field means the address is unchanged: the saved one, then the provider's usual one.
			const baseUrl = draft.baseUrl.trim() || settings.providers[providerId].baseUrl.trim() || catalog.defaultBaseUrl;
			if (!/^https?:\/\/\S+$/i.test(baseUrl)) {
				this.failSetup("The address must start with http:// or https://, for example http://localhost:11434/v1.", "check-address");
				return;
			}
			const model = draft.model.trim();
			settings.providers[providerId].baseUrl = baseUrl;
			applyChatSelection(settings, providerId, model || undefined);
			await this.plugin.saveSettings();
		}
		this.plugin.refreshOpenAskMateViews();
		await this.runConnectionTest();
	}

	/** Tests the selected provider and says the result in plain words, on the card, to assistive technology, and in the line it returns. */
	private async runConnectionTest(): Promise<{ ok: boolean; line: string }> {
		if (this.setup.testing) {
			return { ok: false, line: "A connection test is already running." };
		}
		const ref = this.plugin.getChatProviderModelRef();
		const context = { providerId: ref.providerId, baseUrl: this.plugin.getProviderSettings(ref.providerId).baseUrl, model: ref.model };
		this.setup.testing = true;
		this.setup.test = null;
		this.setup.localError = null;
		this.announcer?.say(`Checking ${ref.providerName}.`);
		this.refreshSetupCard();
		this.refreshConsoleStatus();
		let result: Pick<ProviderConnectionTestResult, "ok" | "message" | "modelFound" | "suggestedModel">;
		try {
			result = await this.plugin.testProviderConnectionDetailed();
		} catch (error) {
			result = { ok: false, message: this.plugin.getErrorMessage(error), modelFound: null, suggestedModel: null };
		}
		this.setup.testing = false;
		if (this.isClosed) {
			return { ok: result.ok, line: result.message };
		}
		let line: string;
		let ok = false;
		if (result.ok && result.modelFound !== false) {
			ok = true;
			this.setup.test = { status: "ok", providerId: ref.providerId, model: ref.model, at: Date.now() };
			line = `Connected to ${ref.providerName}.`;
			if (this.setup.flowOpen) {
				// The person is on the card: the next step is a starter, so the card turns into one.
				this.setup.welcomeOpen = true;
			}
			this.announcer?.say(this.setup.welcomeOpen ? `${line} Starter buttons are below.` : line);
			await this.markFirstRunComplete();
		} else {
			const failure = result.ok ? new Error(`The model ${ref.model} was not found. ${result.message}`) : new Error(result.message);
			const suggested = result.ok ? result.suggestedModel?.trim() ?? "" : "";
			const mapped = mapProviderErrorToSetupCopy(failure, context);
			// The server's own list is the best answer to a missing model, so the button uses its closest match instead of a static list.
			const copy: SetupErrorCopy = suggested
				? { ...mapped, message: `${mapped.message} The closest model it lists is ${suggested}.`, action: { kind: "choose-model", label: `Use ${suggested}` } }
				: mapped;
			this.setup.test = { status: "failed", providerId: ref.providerId, model: ref.model, copy, at: Date.now(), ...(suggested ? { suggestedModel: suggested } : {}) };
			line = copy.message;
			this.announcer?.say(line);
		}
		this.refreshSetupCard();
		this.refreshConsoleStatus();
		void this.refreshReadiness();
		return { ok, line };
	}

	/** Switches to the model the server itself listed, then checks the connection again. */
	private async useSuggestedModel(model: string): Promise<void> {
		await this.switchChatModel(this.plugin.getChatProviderModelRef().providerId, model);
		await this.runConnectionTest();
	}

	/** Reads the server's own model list first, so the picker offers models that exist there and not only the built-in suggestions. */
	private async chooseModelFromServer(): Promise<void> {
		if (this.activeRun) {
			this.openModelPicker();
			return;
		}
		try {
			await this.plugin.refreshSelectedProviderModels();
		} catch (error) {
			// The picker still opens, with the list it has; the person is told why that list may be short.
			this.notify(`AskMate could not read the model list from the server. ${this.plugin.getErrorMessage(error)}`);
		}
		this.openModelPicker();
	}

	private async markFirstRunComplete(): Promise<void> {
		if (!this.plugin.settings.firstRunCompletedAt) {
			this.plugin.settings.firstRunCompletedAt = new Date().toISOString();
			await this.plugin.saveSettings();
		}
	}

	/** The button under an error, whatever the error was: each kind of fix goes to one place. */
	private handleSetupAction(action: SetupAction): void {
		switch (action.kind) {
			case "update-key":
				// The rejected key must not stay in the field, or the next paste would be added to the end of it.
				this.clearSetupKey();
				// No provider override: the card stays on the chip in use. A rejected connection test is only drawn on the chip
				// of the provider it tested, and a local error (empty or malformed key) belongs to the chip the person typed on,
				// which is not necessarily the chat provider yet.
				this.openSetupFlow();
				return;
			case "choose-model": {
				const suggested = this.setup.test?.status === "failed" ? this.setup.test.suggestedModel : undefined;
				this.runUiTask(suggested ? this.useSuggestedModel(suggested) : this.chooseModelFromServer());
				return;
			}
			case "check-address": {
				// Like Update key, the card stays on the chip in use: a local error belongs to the chip the person typed on, which is
				// not necessarily the chat provider yet. Only a local server's address can be fixed in the card; the address of any other
				// provider (a custom OpenAI address, Azure) is edited in settings.
				const chip = getProviderCatalogEntry(this.chipInUse(this.readSetupStage()));
				if (!chip.needsKey) {
					this.openSetupFlow();
				} else {
					this.openSettings();
				}
				return;
			}
			case "start-server":
			case "retry":
			case "test":
				this.runUiTask(this.runConnectionTest().then(() => undefined));
				return;
			case "open-settings":
				this.openSettings();
				return;
			default:
				assertNeverSetupAction(action.kind);
		}
	}

	private openSettings(): void {
		this.plugin.openSettingsTab();
	}

	private runStarter(chip: StarterChip): void {
		const action = chip.action;
		this.closeSetupFlow();
		switch (action.kind) {
			case "workflow": {
				const workflow = this.plugin.getAllWorkflows().find((candidate) => candidate.id === action.workflowId);
				this.runUiTask(workflow ? this.runWorkflow(workflow) : this.runPrompt(action.fallbackPrompt));
				return;
			}
			case "diagram":
				this.runUiTask(this.runDiagram(""));
				return;
			case "prompt":
				this.runUiTask(this.runPrompt(action.prompt));
				return;
		}
	}

	private async runPrompt(prompt: string): Promise<void> {
		if (!this.ensureIdleForNewRequest()) {
			return;
		}
		if (!(await this.isProviderReadyForSubmit("Connect an AI provider before sending."))) {
			return;
		}
		await this.runRequest({ question: prompt, title: "AskMate Answer", options: this.getRequestDraftOptions(false) });
	}

	// ----- Skills ----------------------------------------------------------------------------------------------------

	/** Skills that /skill and @skill: can complete: the ones that can be used right now. */
	private listUsableSkillsForCompletion(): Array<{ name: string; description: string }> {
		const service = this.plugin.skillService;
		if (!this.plugin.settings.skills.enabled) {
			return [];
		}
		return service.list()
			.filter((skill) => skill.valid && skill.manifest.userInvocable && (service.statusOf(skill) === "built-in" || service.statusOf(skill) === "ready"))
			.map((skill) => ({ name: skill.name, description: skill.manifest.description }));
	}

	/** The id a request carries for a skill the person named by id or by plain name. A name that matches nothing is passed on and noticed by the resolver. */
	private skillIdFor(ref: string): string {
		return this.plugin.skillService.find(ref)?.id ?? ref;
	}

	/** Refuses a skill that does not exist or cannot be used yet, with a sentence that says what to do. Nothing is sent. */
	private assertSkillsUsable(refs: readonly string[]): void {
		const needed = refs.filter((ref) => ref !== MERMAID_SKILL_ID);
		if (needed.length === 0) {
			return;
		}
		const service = this.plugin.skillService;
		for (const ref of needed) {
			const found = lookUpSkill(service, ref);
			if (!found.ok) {
				throw new Error(found.message);
			}
		}
	}

	private skillTitle(skill: Skill): string {
		return skill.manifest.title.trim() || skill.name;
	}

	/** Turns a skill on or off for the whole conversation, and says which. */
	private async toggleStickySkill(skill: Skill): Promise<string> {
		const current = this.threadMeta.skillIds ?? [];
		const turnOn = !current.includes(skill.id);
		const next = turnOn ? [...current, skill.id] : current.filter((id) => id !== skill.id);
		this.threadMeta = withThreadSkillIds(this.threadMeta, next);
		this.refreshSkillChips();
		this.refreshConsoleStatus();
		this.scheduleRequestPreviewRefresh();
		this.queueThreadSave();
		const title = this.skillTitle(skill);
		if (!turnOn) {
			return `${title} is off for this conversation.`;
		}
		const crowded = next.length > MAX_SKILLS_PER_REQUEST ? ` Only ${MAX_SKILLS_PER_REQUEST} skills run at once, so the others are skipped.` : "";
		return `${title} is on for this conversation. It adds about ${skill.characters.toLocaleString("en-GB")} characters to each request. Click its chip to turn it off.${crowded}`;
	}

	private describeSkills(): string {
		const service = this.plugin.skillService;
		return formatSkillsListing(service.list(), (skill) => service.statusOf(skill), this.threadMeta.skillIds ?? []);
	}

	private scheduleSkillChips(): void {
		if (!this.skillChipsEl) {
			return;
		}
		window.clearTimeout(this.skillChipsTimer);
		this.skillChipsTimer = window.setTimeout(() => this.refreshSkillChips(), 300);
	}

	/** The row above the box: skills that are on, and at most one suggestion for what is being typed. */
	private refreshSkillChips(): void {
		const host = this.skillChipsEl;
		if (!host || this.isClosed) {
			return;
		}
		const service = this.plugin.skillService;
		const enabled = this.plugin.settings.skills.enabled;
		this.skillPickerButton?.toggleAttribute("hidden", !enabled);
		if (!enabled) {
			if (this.skillChipsSignature !== "") {
				this.skillChipsSignature = "";
				renderSkillChips(host, [], { onRemove: () => undefined, onAccept: () => undefined });
			}
			return;
		}
		const known = (ids: readonly string[]): Skill[] => ids.flatMap((id) => {
			const skill = service.get(id);
			return skill ? [skill] : [];
		});
		const sticky = known(this.threadMeta.skillIds ?? []);
		const once = known(this.onceSkillIds);
		const text = this.questionEl?.value.trim() ?? "";
		let suggestion: SkillSuggestion | null = null;
		if (text.length >= 8 && !text.startsWith("/")) {
			suggestion = service.resolve({ request: text, explicit: [], sticky: sticky.map((skill) => skill.id) }).suggestion;
		}
		const suggested = suggestion ? service.get(suggestion.id) : null;
		const chips = buildSkillChips({
			sticky,
			once,
			suggestion,
			...(suggested ? { suggestionTitle: this.skillTitle(suggested) } : {})
		});
		const signature = skillChipsSignature(chips);
		if (signature === this.skillChipsSignature) {
			return;
		}
		this.skillChipsSignature = signature;
		renderSkillChips(host, chips, {
			onRemove: (chip) => {
				if (chip.state === "sticky") {
					this.threadMeta = withThreadSkillIds(this.threadMeta, (this.threadMeta.skillIds ?? []).filter((id) => id !== chip.id));
					this.queueThreadSave();
				} else {
					this.onceSkillIds = this.onceSkillIds.filter((id) => id !== chip.id);
				}
				this.refreshSkillChips();
				this.refreshConsoleStatus();
				this.scheduleRequestPreviewRefresh();
				this.questionEl.focus();
			},
			onAccept: (chip) => {
				this.onceSkillIds = Array.from(new Set([...this.onceSkillIds, chip.id]));
				this.refreshSkillChips();
				this.scheduleRequestPreviewRefresh();
				this.questionEl.focus();
			}
		});
	}

	private renderSkillPicker(parent: HTMLElement): void {
		const button = this.createActionButton(parent, "wand-sparkles", "Choose a skill", "askmate-workflow-toggle askmate-skill-picker");
		button.hidden = true;
		this.skillPickerButton = button;
		button.addEventListener("click", (event) => this.openSkillPicker(event, button));
	}

	/** Skills the person can keep on for this conversation. A skill that needs review is listed but cannot be picked. */
	private openSkillPicker(event: MouseEvent, anchor: HTMLElement): void {
		const service = this.plugin.skillService;
		const menu = new Menu();
		const sticky = this.threadMeta.skillIds ?? [];
		const skills = service.list().filter((skill) => skill.valid && skill.manifest.userInvocable);
		for (const skill of skills) {
			const status = service.statusOf(skill);
			const usable = status === "built-in" || status === "ready";
			menu.addItem((item) => {
				item.setTitle(usable ? this.skillTitle(skill) : `${this.skillTitle(skill)} (${skillStatusLabel(status)})`)
					.setIcon("wand-sparkles")
					.setChecked(sticky.includes(skill.id))
					.setDisabled(!usable)
					.onClick(() => this.runUiTask(this.toggleStickySkill(skill).then((message) => this.notify(message))));
			});
		}
		if (skills.length > 0) {
			menu.addSeparator();
		}
		menu.addItem((item) => {
			item.setTitle("Manage skills in settings").setIcon("settings").onClick(() => this.openSettings());
		});
		if (event.detail === 0) {
			const rect = anchor.getBoundingClientRect();
			menu.showAtPosition({ x: rect.left, y: rect.bottom });
		} else {
			menu.showAtMouseEvent(event);
		}
	}

	private async describeConsoleContext(options: ExtendedBuildOptions): Promise<{ text: string; blocked: boolean }> {
		const inspection = await this.plugin.inspectFinalPrompt("Preview request", "AskMate Answer", options);
		const request = inspection.request;
		const metadata = request.metadata;
		const lines = [
			`source    ${isNoNoteSource(request.context.source) ? "no note is open" : `${request.context.source}: ${request.context.file?.path ?? "unsaved note"}`}`,
			`provider  ${inspection.providerName}: ${inspection.model}`,
			`output    ${formatOutputMode(metadata.outputMode)}`,
			`tokens    about ${inspection.estimatedInputTokens.toLocaleString()} input`,
			`context   ${metadata.privacy.includeNoteContext
				? `${metadata.promptContextCharacters.toLocaleString()}${metadata.contextTruncated ? ` of ${metadata.contextCharacters.toLocaleString()}` : ""} characters, ${metadata.contextBudgetMode} budget`
				: "note text withheld by privacy settings"}`,
			`rules     ${request.customInstructions ? `custom instructions applied (${request.customInstructions.length.toLocaleString()} characters)` : "no custom instructions"}`,
			`attached  ${metadata.contextAttachmentSources.length > 0 ? metadata.contextAttachmentSources.join(", ") : "nothing else"}`,
			...this.plugin.describeLastVaultMentions(),
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
