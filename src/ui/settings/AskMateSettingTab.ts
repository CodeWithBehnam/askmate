import * as obsidianModule from "obsidian";
import {
	ButtonComponent,
	debounce,
	Notice,
	PluginSettingTab,
	Setting,
	SettingGroup,
	SettingPage,
	setIcon,
	type App,
	type ExtraButtonComponent,
	type SettingDefinition,
	type SettingDefinitionBase,
	type SettingDefinitionItem,
	type SettingDefinitionPage,
	type TextAreaComponent,
	type TextComponent,
	type ToggleComponent
} from "obsidian";
import type { AskMatePlugin } from "../../plugin/AskMatePlugin";
import { IDLE_SETUP_TEST, deriveSetupState, type SetupStage } from "../../setup";
import {
	CONTEXT_BUDGET_OPTIONS,
	DEFAULT_IMAGE_FILE_NAME_TEMPLATE,
	DEFAULT_IMAGE_FOLDER_TEMPLATE,
	DEFAULT_IMAGE_RESULT_NOTE_TEMPLATE,
	DEFAULT_RESULT_NOTE_TEMPLATE,
	DEFAULT_SETTINGS,
	DEFAULT_TRANSLATION_TARGET_LANGUAGE,
	formatUsageTimestamp,
	MAX_CONTEXT_PATH_LENGTH,
	MAX_CUSTOM_WORKFLOW_PROMPT_LENGTH,
	MAX_WORKFLOW_CUSTOM_INSTRUCTIONS_LENGTH,
	normalizeBatchWorkflowOutputMode,
	normalizeContextPathList,
	normalizeOptionalString,
	normalizeTemplateString,
	normalizeTranslationTargetLanguage,
	normalizeWorkflowAccent,
	truncateLabel,
	WORKFLOW_ACCENTS,
	type BatchWorkflowOutputMode,
	type CustomWorkflow,
	type Workflow,
	type WorkflowOutputKind
} from "../../shared/core";
import { AskMateTextViewerModal, askMateConfirm } from "../modals/modals";
import {
	buildConnectionItems,
	linkFragment,
	type ConnectionState,
	type DefinitionExtras,
	type FeedbackKind,
	type SettingsPageHost
} from "./connectionPage";
import { renderInstructionsPage } from "./instructionsPage";
import { buildToolsItems, summarizeServerStatuses } from "./mcpPage";
import { attachFolderSuggest, attachMarkdownFileSuggest, isPathSuggestOpen } from "./pathSuggest";
import {
	buildRecommendedSettingsPatch,
	checkTemplate,
	describeNoteMemory,
	describePromptLength,
	describePromptNormalisation,
	describeStoredTextDeletion,
	formatIntegerRange,
	NOTE_MEMORY_LABELS,
	readSettingControl,
	resolveBatchWorkflowId,
	resolveFolderPathInput,
	resolveIntegerInput,
	uniqueLabels,
	writeSettingControl,
	type IntegerBounds,
	type SettingControlKey,
	type TemplateKind
} from "./settingsInputs";
import {
	ADVANCED_REASSURANCE,
	getSettingsPage,
	pageSummaryFields,
	pluralise,
	summarizeContextSources,
	summarizePrivacyMemory,
	summarizeProviderSetup,
	summarizeSidebarOutput,
	summarizeSkillsAndTools,
	summarizeUsageGuardrails,
	supportsPageSummaries,
	type SettingsPageId,
	type SettingsPageStatus
} from "./settingsSummaries";
import { buildDiagramItems, buildSkillItems, countSkills } from "./skillsPage";
import { renderUsageStatistics } from "./usageStatistics";

type PageRenderer = (containerEl: HTMLElement, refresh: () => void) => void;
type SettingsDefinitionExtras = Pick<SettingDefinitionBase, "aliases" | "visible">;

interface IntegerInputOptions {
	label: string;
	bounds: IntegerBounds;
	getValue: () => number;
	setValue: (value: number) => void;
}

interface FolderPathInputOptions {
	label: string;
	getValue: () => string;
	setValue: (value: string) => void;
}

interface TemplateFieldOptions {
	kind: TemplateKind;
	defaultValue: string;
	multiline: boolean;
	getValue: () => string;
	setValue: (value: string) => void;
}

interface ImperativePageOptions {
	displayValue?: () => string;
	onHide?: () => void;
}

interface ActiveBatchState {
	controller: AbortController;
	message: string;
	percent: number;
}

interface BatchRunnerElements {
	progress: HTMLElement;
	bar: HTMLElement;
	fill: HTMLElement;
	runButton: ButtonComponent;
	cancelButton: ButtonComponent;
}

type CustomWorkflowTextField = "name" | "shortName" | "description" | "icon" | "prompt" | "resultNoteTemplate";

const TEXT_SAVE_DELAY_MS = 600;
const PROJECT_URL = "https://github.com/CodeWithBehnam/askmate";

const BATCH_OUTPUT_LABELS: Record<BatchWorkflowOutputMode, string> = {
	note: "Create result notes",
	"review-queue": "Queue proposed note changes"
};

const WORKFLOW_OUTPUT_KIND_LABELS: Record<WorkflowOutputKind, string> = {
	"note-edit": "Revised note",
	"new-content": "New content"
};

// These mirror the bounds normalizeAskMateSettings applies on save, so the field shows the value that is kept.
const THREADED_CHAT_MAX_TURNS_BOUNDS: IntegerBounds = { min: 1, max: 12 };
const ADDITIONAL_CONTEXT_MAX_CHARACTERS_BOUNDS: IntegerBounds = { min: 1000, max: 100000 };
const FOLDER_CONTEXT_MAX_FILES_BOUNDS: IntegerBounds = { min: 1, max: 100 };
const FOLDER_CONTEXT_MAX_CHARACTERS_BOUNDS: IntegerBounds = { min: 1000, max: 200000 };
const EXCALIDRAW_SUMMARY_MAX_CHARACTERS_BOUNDS: IntegerBounds = { min: 1000, max: 100000 };
const EVIDENCE_MAX_SOURCES_BOUNDS: IntegerBounds = { min: 1, max: 200 };
const BATCH_WORKFLOW_MAX_FILES_BOUNDS: IntegerBounds = { min: 1, max: 100 };
const REVIEW_QUEUE_MAX_ITEMS_BOUNDS: IntegerBounds = { min: 1, max: 200 };
const DAILY_TOKEN_BUDGET_BOUNDS: IntegerBounds = { min: 0, max: 10000000 };
const MONTHLY_TOKEN_BUDGET_BOUNDS: IntegerBounds = { min: 0, max: 100000000 };
const PER_REQUEST_TOKEN_BOUNDS: IntegerBounds = { min: 0, max: 10000000 };

/** The Obsidian version the app reports. It is read from the module so a host without the export (a test) simply has no version. */
function readAppVersion(): string | null {
	const version: unknown = Reflect.get(obsidianModule, "apiVersion");
	return typeof version === "string" ? version : null;
}

/** A dropdown shows text, so only text-like control values are turned into it. */
function controlText(value: unknown): string {
	return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? String(value) : "";
}

/** A sub-page whose content is drawn imperatively: custom cards, charts and runners that a list of definitions cannot express. */
class AskMateSettingsPage extends SettingPage {
	private readonly renderPage: PageRenderer;
	private readonly onHide: () => void;

	constructor(title: string, renderPage: PageRenderer, onHide: () => void) {
		super();
		this.title = title;
		this.renderPage = renderPage;
		this.onHide = onHide;
	}

	display(): void {
		this.containerEl.empty();
		this.renderPage(this.containerEl, () => this.display());
	}

	hide(): void {
		this.onHide();
		super.hide();
	}
}

/** Gives each field message its own id, so the field it belongs to can name it as its description. */
let feedbackCounter = 0;

export class AskMateSettingTab extends PluginSettingTab implements SettingsPageHost {
	readonly plugin: AskMatePlugin;
	// State of the Connection page that must outlive a redraw: the last connection test and whether "More options" is open.
	readonly connection: ConnectionState = { lastTest: IDLE_SETUP_TEST, showMoreOptions: false };
	readonly approvedSkillText = new Map<string, string>();
	focusAfterRebuild: string | null = null;
	// Page entries show a value and a warning only in Obsidian 1.13.1 and later; older versions get the same words in the description.
	private readonly summariesSupported: boolean;
	// The tab instance outlives each render, so a running batch keeps its cancel handle and progress across re-renders.
	private activeBatch: ActiveBatchState | null = null;
	private batchElements: BatchRunnerElements | null = null;
	// The latest runner page to draw, so a batch that ends after its page was left and reopened refreshes the one on screen.
	private batchRefresh: (() => void) | null = null;
	// Shown on the runner after a batch ends, so the result outlives the notice and is still there when the page reopens.
	private lastBatchSummary: string | null = null;
	// Fields that save on blur or Enter and have unsaved edits. Leaving a page or closing settings commits them from here,
	// because removing a focused field does not reliably fire blur.
	private readonly pendingFieldCommits = new Map<HTMLElement, () => void>();

	constructor(app: App, plugin: AskMatePlugin, appVersion: string | null = readAppVersion()) {
		super(app, plugin);
		this.plugin = plugin;
		this.summariesSupported = supportsPageSummaries(appVersion);
	}

	/** Whether this device's keychain holds a value for the saved key name. A name alone is not a key. */
	hasSecret(secretName: string): boolean {
		try {
			return (this.app.secretStorage.getSecret(secretName) ?? "").trim() !== "";
		} catch {
			return false;
		}
	}

	/**
	 * The setup state every surface agrees on. The plugin's own, when it has one, knows about tests run from the sidebar; this
	 * page prefers its own result once it has run a test here.
	 */
	currentStage(): SetupStage {
		return this.connection.lastTest.status === "idle"
			? this.plugin.getSetupState()
			: deriveSetupState(this.plugin.settings, (name) => this.hasSecret(name), this.connection.lastTest);
	}

	async saveUiSetting(refreshViews = true): Promise<void> {
		await this.plugin.saveSettings();
		if (refreshViews) {
			this.plugin.refreshOpenAskMateViews();
		}
	}

	// data.json also holds history, usage and the review queue, so text fields must not rewrite it on every keystroke.
	private readonly debouncedSave = debounce(() => {
		void this.runSettingAction(() => this.plugin.saveSettings());
	}, TEXT_SAVE_DELAY_MS, true);

	scheduleSave(): void {
		this.debouncedSave();
	}

	async runSettingAction(action: () => Promise<void>): Promise<void> {
		try {
			await action();
		} catch (error) {
			new Notice(this.plugin.getErrorMessage(error));
		}
	}

	/**
	 * Obsidian focuses the toggle's container label, not the hidden checkbox inside it, and gives it no role or state,
	 * so the container carries the name, the switch role and aria-checked. The checkbox inside is taken out of rendering:
	 * a focusable control nested in a switch is announced twice and fails WCAG 4.1.2 (axe nested-interactive), and a
	 * negative tabindex does not stop assistive technology reaching it. Clicks on the label still reach it. The value is set
	 * before the handler is attached because ToggleComponent.setValue fires onChange whenever the value changes.
	 */
	setupToggle(toggle: ToggleComponent, label: string, value: boolean, onChange: (value: boolean) => void | Promise<void>): void {
		const switchEl = toggle.toggleEl;
		switchEl.setAttribute("role", "switch");
		switchEl.setAttribute("aria-label", label);
		const input = switchEl.querySelector("input");
		if (input) {
			input.setAttribute("aria-hidden", "true");
			input.tabIndex = -1;
			input.addClass("askmate-switch-input");
		}
		toggle.setValue(value);
		switchEl.setAttribute("aria-checked", String(value));
		toggle.onChange(async (next) => {
			switchEl.setAttribute("aria-checked", String(next));
			await onChange(next);
		});
	}

	// Obsidian does not tie a row's name to its controls, so each control is named directly.
	labelControl(el: HTMLElement, label: string): void {
		el.setAttribute("aria-label", label);
	}

	// Extra buttons are plain divs named only by their tooltip; the role, tab stop and disabled state make them read as buttons.
	describeExtraButton(button: ExtraButtonComponent, label: string): void {
		const el = button.extraSettingsEl;
		button.setTooltip(label);
		el.setAttribute("role", "button");
		el.setAttribute("aria-label", label);
		el.setAttribute("aria-disabled", "false");
		// Obsidian already runs an extra button on Enter and Space once it can take focus, so it only needs a tab stop.
		el.setAttribute("tabindex", "0");
	}

	setExtraButtonDisabled(button: ExtraButtonComponent, disabled: boolean): void {
		button.setDisabled(disabled);
		button.extraSettingsEl.setAttribute("aria-disabled", String(disabled));
	}

	/**
	 * Disabling a focused control drops focus to the page, so a keyboard user who started an action
	 * gets focus back on the same control once it is enabled again.
	 */
	async keepFocusWhileBusy(el: HTMLElement, setBusy: (busy: boolean) => void, action: () => Promise<void>): Promise<void> {
		const hadFocus = el.ownerDocument.activeElement === el;
		setBusy(true);
		try {
			await action();
		} finally {
			setBusy(false);
			const active = el.ownerDocument.activeElement;
			if (hadFocus && el.isConnected && (active === null || active === el.ownerDocument.body)) {
				el.focus();
			}
		}
	}

	// Toggles and dropdowns read and write through these, so every change is normalised and saved like any other.
	getControlValue(key: string): unknown {
		return readSettingControl(this.plugin.settings, key);
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		writeSettingControl(this.plugin.settings, key, value);
		await this.runSettingAction(() => this.saveUiSetting());
	}

	/**
	 * Commits only after an edit, so Enter followed by blur, or a blur without changes, does not save or report twice.
	 * Returns the commit so a path suggestion can save the moment it is picked.
	 */
	bindCommitOnBlur(inputEl: HTMLInputElement | HTMLTextAreaElement, commit: () => Promise<void>, commitOnEnter: boolean): () => void {
		const runCommit = (): void => {
			void this.runSettingAction(commit);
		};
		const commitPending = (): void => {
			if (this.pendingFieldCommits.delete(inputEl)) {
				runCommit();
			}
		};
		inputEl.addEventListener("input", () => this.pendingFieldCommits.set(inputEl, runCommit));
		inputEl.addEventListener("blur", commitPending);
		if (commitOnEnter) {
			// Typed as HTMLElement so the listener receives a KeyboardEvent; the input and textarea union loses the event map.
			const keyTarget: HTMLElement = inputEl;
			keyTarget.addEventListener("keydown", (event) => {
				// While a path suggestion list is open, Enter picks a suggestion instead of saving the half-typed path.
				if (event.key !== "Enter" || isPathSuggestOpen(inputEl)) {
					return;
				}
				event.preventDefault();
				commitPending();
			});
		}
		return commitPending;
	}

	bindCommitOnBlurOrEnter(inputEl: HTMLInputElement, commit: () => Promise<void>): () => void {
		return this.bindCommitOnBlur(inputEl, commit, true);
	}

	private flushPendingFieldCommits(): void {
		const commits = Array.from(this.pendingFieldCommits.values());
		this.pendingFieldCommits.clear();
		for (const commit of commits) {
			commit();
		}
	}

	/**
	 * Call from every render that can report feedback. A live region is announced only when its text changes after it exists,
	 * so it is created empty up front; rows re-rendered in place keep their info area, so an old message is cleared here.
	 */
	prepareFieldFeedback(setting: Setting): HTMLElement {
		const existing = setting.infoEl.querySelector<HTMLElement>(":scope > .askmate-settings-feedback");
		if (existing) {
			existing.empty();
			existing.removeClass("is-error", "is-warning", "is-success", "is-info");
			return existing;
		}
		feedbackCounter += 1;
		const feedbackEl = setting.infoEl.createDiv({ cls: "askmate-settings-feedback", attr: { role: "status" } });
		feedbackEl.id = `askmate-settings-feedback-${feedbackCounter}`;
		// The row's fields name the message as their description, so a screen reader reads it with the field, not only once.
		for (const field of Array.from(setting.controlEl.querySelectorAll<HTMLElement>("input, textarea, select"))) {
			field.setAttribute("aria-describedby", feedbackEl.id);
		}
		return feedbackEl;
	}

	// One line under the description for errors, results and corrections alike, so the control never shifts.
	setFieldFeedback(setting: Setting, message: string | null, kind: FeedbackKind = "error"): void {
		const feedbackEl = setting.infoEl.querySelector<HTMLElement>(":scope > .askmate-settings-feedback") ?? this.prepareFieldFeedback(setting);
		feedbackEl.setText(message ?? "");
		feedbackEl.toggleClass("is-error", message !== null && kind === "error");
		feedbackEl.toggleClass("is-warning", message !== null && kind === "warning");
		feedbackEl.toggleClass("is-success", message !== null && kind === "success");
		feedbackEl.toggleClass("is-info", message !== null && kind === "info");
		for (const field of Array.from(setting.controlEl.querySelectorAll<HTMLElement>("input, textarea, select"))) {
			field.setAttribute("aria-describedby", feedbackEl.id);
			if (message !== null && kind === "error") {
				field.setAttribute("aria-invalid", "true");
			} else {
				field.removeAttribute("aria-invalid");
			}
		}
	}

	private bindIntegerInput(setting: Setting, text: TextComponent, options: IntegerInputOptions): void {
		const { bounds, label } = options;
		const range = formatIntegerRange(bounds);
		this.prepareFieldFeedback(setting);
		// A text field with a numeric keyboard: a number field would drop Persian, Arabic and other digits before AskMate saw them.
		text.inputEl.type = "text";
		text.inputEl.inputMode = "numeric";
		text.inputEl.setAttribute("aria-label", `${label} (${range})`);
		text.setPlaceholder(range).setValue(String(options.getValue()));
		this.bindCommitOnBlurOrEnter(text.inputEl, async () => {
			const current = options.getValue();
			const result = resolveIntegerInput(text.getValue(), bounds);
			if (result.kind === "ignored") {
				text.setValue(String(current));
				this.setFieldFeedback(setting, `Enter a whole number from ${range}. AskMate kept ${current.toLocaleString("en-GB")}.`, "info");
				return;
			}

			text.setValue(String(result.value));
			this.setFieldFeedback(setting, result.clamped ? `${label} must be ${range}. AskMate saved ${result.value.toLocaleString("en-GB")}.` : null, "info");
			if (result.value === current) {
				return;
			}
			options.setValue(result.value);
			// Budgets and limits feed the sidebar request preview, which must not keep showing an old blocker.
			await this.saveUiSetting();
		});
	}

	// "." and ".." segments are refused here, because the save-time normaliser would otherwise replace them without telling the user.
	private bindFolderPathInput(setting: Setting, text: TextComponent, options: FolderPathInputOptions): void {
		this.prepareFieldFeedback(setting);
		text.setValue(options.getValue());
		const commit = this.bindCommitOnBlurOrEnter(text.inputEl, async () => {
			const current = options.getValue();
			const result = resolveFolderPathInput(text.getValue());
			if (result.kind === "unsafe") {
				this.setFieldFeedback(setting, `${options.label} cannot contain "." or ".." segments. AskMate kept the previous value${current ? `: ${current}` : ""}.`);
				text.setValue(current);
				return;
			}

			this.setFieldFeedback(setting, null);
			text.setValue(result.value);
			if (result.value === current) {
				return;
			}
			options.setValue(result.value);
			await this.saveUiSetting();
		});
		attachFolderSuggest(this.app, text.inputEl, commit);
	}

	hide(): void {
		this.flushPendingFieldCommits();
		this.debouncedSave.run();
		// Debounced text settings save without refreshing, so open sidebars catch up once when settings close.
		this.plugin.refreshOpenAskMateViews();
		super.hide();
	}

	// ----------------------------------------------------------------------------------------------------------------------
	// The six pages
	// ----------------------------------------------------------------------------------------------------------------------

	// Obsidian draws each row from its name and description, which also feed settings search; render adds the controls.
	// Page summaries are functions, so the entries show current values each time a page is left and the list redraws.
	getSettingDefinitions(): SettingDefinitionItem[] {
		const settings = this.plugin.settings;
		const folderRuleDraft = settings.folderInstructions.map((rule) => ({ ...rule }));
		const hasSecret = (name: string): boolean => this.hasSecret(name);
		const instructions = getSettingsPage("instructions");
		return [
			this.summarisedPage("connection", this.getConnectionDefinitions(), () => summarizeProviderSetup(settings, hasSecret).displayValue, () => summarizeProviderSetup(settings, hasSecret).status),
			this.summarisedPage("sidebar-output", this.getSidebarOutputDefinitions(), () => summarizeSidebarOutput(settings, this.plugin.getPendingReviewQueueItems().length)),
			this.summarisedPage("privacy-memory", this.getPrivacyMemoryDefinitions(), () => summarizePrivacyMemory(settings)),
			this.summarisedPage("skills-tools", this.getSkillsAndToolsDefinitions(), () => this.skillsAndToolsSummary().displayValue, () => this.skillsAndToolsSummary().status),
			this.imperativePage(
				instructions.name,
				instructions.desc,
				(containerEl, refresh) => renderInstructionsPage(this.app, settings, folderRuleDraft, containerEl, refresh, () => this.scheduleSave()),
				{ displayValue: () => summarizeInstructionsText(settings.globalInstructions, settings.folderInstructions.length) }
			),
			this.summarisedPage("advanced", this.getAdvancedDefinitions(), () => summarizeContextSources(settings)),
			{
				type: "group",
				heading: "About",
				items: [
					{
						name: "Version",
						desc: this.aboutDescription(),
						searchable: false
					}
				]
			}
		];
	}

	private summarisedPage(id: SettingsPageId, items: SettingDefinitionItem[], summary: () => string, status: (() => SettingsPageStatus) | null = null): SettingDefinitionPage {
		const info = getSettingsPage(id);
		return { type: "page", name: info.name, ...pageSummaryFields(this.summariesSupported, info.desc, summary, status), items };
	}

	imperativePage(name: string, desc: string, renderPage: PageRenderer, options: ImperativePageOptions = {}): SettingDefinitionPage {
		return {
			type: "page",
			name,
			...pageSummaryFields(this.summariesSupported, desc, options.displayValue ?? null),
			page: () => new AskMateSettingsPage(name, renderPage, () => {
				this.flushPendingFieldCommits();
				options.onHide?.();
			})
		};
	}

	private aboutDescription(): DocumentFragment {
		return linkFragment([
			`AskMate ${this.plugin.manifest.version}. `,
			{ text: "Documentation", href: `${PROJECT_URL}#readme` },
			" · ",
			{ text: "Report an issue", href: `${PROJECT_URL}/issues` },
			" · ",
			{ text: "Changelog", href: `${PROJECT_URL}/releases` }
		]);
	}

	private skillsAndToolsSummary(): { displayValue: string; status: SettingsPageStatus } {
		const settings = this.plugin.settings;
		const skillService = this.plugin.skillService;
		const statuses = this.plugin.mcpService?.status() ?? [];
		return summarizeSkillsAndTools({
			skillsEnabled: settings.skills.enabled,
			skills: countSkills(skillService.list(), (skill) => skillService.statusOf(skill)),
			mcpEnabled: settings.mcp.enabled,
			servers: summarizeServerStatuses(settings.mcp, statuses)
		});
	}

	// Render rows rather than declarative controls, because Obsidian gives declarative controls no accessible name.
	// Rows that depend on the value use `visible`, so each change re-evaluates them with refreshDomState().
	toggleDefinition(key: SettingControlKey, name: string, desc: string, extras: DefinitionExtras | SettingsDefinitionExtras = {}): SettingDefinition {
		return {
			name,
			desc,
			...extras,
			render: (setting) => {
				setting.addToggle((toggle) => {
					this.setupToggle(toggle, name, this.getControlValue(key) === true, async (value) => {
						await this.setControlValue(key, value);
						this.refreshDomState();
					});
				});
			}
		};
	}

	dropdownDefinition(key: SettingControlKey, name: string, desc: string, options: Record<string, string>, extras: DefinitionExtras | SettingsDefinitionExtras = {}): SettingDefinition {
		return {
			name,
			desc,
			...extras,
			render: (setting) => {
				setting.addDropdown((dropdown) => {
					this.labelControl(dropdown.selectEl, name);
					dropdown
						.addOptions(options)
						.setValue(controlText(this.getControlValue(key)))
						.onChange(async (value) => {
							await this.setControlValue(key, value);
							this.refreshDomState();
						});
				});
			}
		};
	}

	integerDefinition(name: string, desc: string, options: Omit<IntegerInputOptions, "label">, extras: DefinitionExtras | SettingsDefinitionExtras = {}): SettingDefinition {
		return {
			name,
			desc,
			...extras,
			render: (setting) => {
				setting.addText((text) => this.bindIntegerInput(setting, text, { ...options, label: name }));
			}
		};
	}

	private folderPathDefinition(name: string, desc: string, options: Omit<FolderPathInputOptions, "label"> & { placeholder: string }, extras: DefinitionExtras | SettingsDefinitionExtras = {}): SettingDefinition {
		return {
			name,
			desc,
			...extras,
			render: (setting) => {
				setting.addText((text) => {
					text.setPlaceholder(options.placeholder);
					text.inputEl.setAttribute("aria-label", name);
					this.bindFolderPathInput(setting, text, { ...options, label: name });
				});
			}
		};
	}

	// A row that is only an explanation; it has no name, so it is kept out of settings search.
	noteDefinition(text: string): SettingDefinition {
		return {
			name: "",
			searchable: false,
			render: (setting) => {
				setting.settingEl.empty();
				setting.settingEl.addClass("askmate-settings-note-row");
				setting.settingEl.createEl("p", { cls: "askmate-settings-note", text });
			}
		};
	}

	// ----------------------------------------------------------------------------------------------------------------------
	// Connection
	// ----------------------------------------------------------------------------------------------------------------------

	private getConnectionDefinitions(): SettingDefinitionItem[] {
		return buildConnectionItems(this);
	}

	// ----------------------------------------------------------------------------------------------------------------------
	// Sidebar and output
	// ----------------------------------------------------------------------------------------------------------------------

	private getSidebarOutputDefinitions(): SettingDefinitionItem[] {
		const settings = this.plugin.settings;
		return [
			{
				type: "group",
				heading: "Sidebar",
				items: [
					this.dropdownDefinition(
						"composerLayout",
						"Sidebar layout",
						"Console is keyboard-first, Compact is denser, and Expanded gives the composer more room. Slash commands and @mentions work in all three; type /help to see them.",
						{ console: "Console", compact: "Compact", expanded: "Expanded" },
						{ aliases: ["console", "compact", "expanded", "composer"] }
					),
					this.dropdownDefinition(
						"sendShortcut",
						"Send shortcut",
						"Choose whether Enter or Ctrl/Cmd+Enter sends a message.",
						{ enter: "Enter sends", "ctrl-enter": "Ctrl/Cmd+Enter sends" }
					),
					this.toggleDefinition(
						"editorContextMenuEnabled",
						"Show AskMate in the editor context menu",
						"Right-click selected text to ask about it or run a favourite workflow."
					),
					this.toggleDefinition(
						"showRequestPreview",
						"Show request preview",
						"Show the source, context size, provider and output mode above the composer."
					)
				]
			},
			{
				type: "group",
				heading: "Answers",
				items: [
					this.dropdownDefinition(
						"outputMode",
						"Default output",
						"Where the next answer goes: the sidebar, a new note, or an edit to your note. A new note or an edit covers one answer only, then AskMate goes back to the sidebar.",
						{ chat: "Show in the sidebar", note: "Create a new note", apply: "Edit my note (asks before changing it)" }
					),
					this.dropdownDefinition(
						"applyApprovalMode",
						"Ask before changing my notes",
						"When AskMate shows you a diff before writing into a note. The loosest choice shows no diff: it asks yes or no before a whole note is replaced and writes anything smaller without asking. Safety stops apply in every mode.",
						{ "auto-approve": "Yes or no, only when replacing the whole note", full: "When replacing a whole note or a section", manual: "Every time" },
						{ aliases: ["preview", "confirm", "diff", "apply"] }
					),
					this.toggleDefinition(
						"streamResponses",
						"Stream replies",
						"Show text as it arrives; turn this off if your endpoint cannot stream."
					),
					this.toggleDefinition(
						"autoImageIntentEnabled",
						"Treat \"draw me a...\" as an image request",
						"Images are made with OpenAI's paid image API, so this needs an OpenAI key and each image costs money; when off, only the /image command and Image button make images."
					),
					this.folderPathDefinition(
						"Result folder",
						"Folder for notes that AskMate creates; leave it empty to use the vault root.",
						{
							placeholder: `Vault root (default ${DEFAULT_SETTINGS.resultFolder})`,
							getValue: () => settings.resultFolder,
							setValue: (value) => {
								settings.resultFolder = value;
							}
						}
					)
				]
			}
		];
	}

	// ----------------------------------------------------------------------------------------------------------------------
	// Privacy and memory
	// ----------------------------------------------------------------------------------------------------------------------

	private getPrivacyMemoryDefinitions(): SettingDefinitionItem[] {
		const settings = this.plugin.settings;
		const budgetOptions = Object.fromEntries(CONTEXT_BUDGET_OPTIONS.map((option) => [
			option.value,
			option.maxCharacters === null ? "Whole note" : `Up to ${option.maxCharacters.toLocaleString("en-GB")} characters`
		]));
		return [
			this.noteDefinition("Your question and the context you choose go to your AI provider. Pictures from /image and the Image button go to OpenAI, and tools you allow send their arguments to the MCP servers you trust. AskMate has no telemetry and no server of its own. A cloud provider charges you for what you send; with Local or self-hosted, requests go to your own computer or server. Saved conversations and note history are stored in this plugin's data file in your vault."),
			{
				type: "group",
				heading: "Sent with each question",
				items: [
					this.toggleDefinition(
						"includeNoteContext",
						"Send the current note with each question",
						"When off, the note's text, path and title stay out of requests; you can still choose per request."
					),
					this.toggleDefinition(
						"includeImageReferences",
						"Send image links",
						"Include Markdown image links in new requests; you can choose per request."
					),
					this.dropdownDefinition(
						"contextBudgetMode",
						"How much of a long note to send",
						"Longer notes are cut to this size before they are sent.",
						budgetOptions
					)
				]
			},
			{
				type: "group",
				heading: "Kept on this device",
				items: [
					this.toggleDefinition(
						"saveConversations",
						"Remember conversations",
						"Keep sidebar conversations so they survive restarts; their full text is stored in this plugin's data file."
					),
					this.toggleDefinition(
						"threadedChatEnabled",
						"Follow-up questions use earlier answers",
						"Send the most recent turns of the conversation along with each follow-up."
					),
					this.integerDefinition(
						"Earlier turns to send",
						`How many recent turns a follow-up carries (${formatIntegerRange(THREADED_CHAT_MAX_TURNS_BOUNDS)}).`,
						{
							bounds: THREADED_CHAT_MAX_TURNS_BOUNDS,
							getValue: () => settings.threadedChatMaxTurns,
							setValue: (value) => {
								settings.threadedChatMaxTurns = value;
							}
						},
						{ visible: () => settings.threadedChatEnabled }
					),
					this.dropdownDefinition(
						"noteMemoryMode",
						"Per-note memory",
						describeNoteMemory(settings.noteHistoryMaxTurnsPerNote),
						{ ...NOTE_MEMORY_LABELS }
					)
				]
			},
			{
				type: "group",
				heading: "Delete",
				items: [
					{
						name: "Delete saved conversations",
						desc: "Remove every saved thread; the conversation on screen stays until you clear it.",
						render: (setting) => {
							this.prepareFieldFeedback(setting);
							setting.addButton((button) => {
								button.setButtonText("Delete conversations").setDestructive().setClass("askmate-danger").onClick(() => {
									void this.keepFocusWhileBusy(button.buttonEl, (busy) => { button.setDisabled(busy); }, () => this.runSettingAction(() => this.deleteSavedConversations(setting)));
								});
							});
						}
					},
					{
						name: "Delete all stored text",
						desc: "Remove saved conversations, note history and the text of queued reviews from this plugin's data. If this vault's plugin data syncs between devices, repeat the deletion on each device. A device that still holds a conversation or a queued review puts it back.",
						render: (setting) => {
							this.prepareFieldFeedback(setting);
							setting.addButton((button) => {
								button.setButtonText("Delete all stored text").setDestructive().setClass("askmate-danger").onClick(() => {
									void this.keepFocusWhileBusy(button.buttonEl, (busy) => { button.setDisabled(busy); }, () => this.runSettingAction(() => this.deleteAllStoredText(setting)));
								});
							});
						}
					}
				]
			}
		];
	}

	private async deleteSavedConversations(setting: Setting): Promise<void> {
		const confirmed = await askMateConfirm(this.app, "Delete every saved AskMate conversation? This cannot be undone.", {
			title: "Delete saved conversations",
			confirmLabel: "Delete conversations",
			destructive: true,
			details: ["Note history and queued reviews are not affected.", "If this vault's plugin data syncs between devices, repeat the deletion on each device. A device that still holds a conversation or a queued review puts it back."]
		});
		if (!confirmed) {
			return;
		}
		this.plugin.forgetPendingQuestion();
		// The store reports whether the write reached disk, so the message never claims a deletion that was rolled back.
		const cleared = await this.plugin.threads.clearAll();
		if (cleared) {
			new Notice("AskMate deleted all saved conversations.");
			this.setFieldFeedback(setting, "All saved conversations were deleted.", "success");
		} else {
			new Notice("AskMate could not delete the saved conversations. Try again.");
			this.setFieldFeedback(setting, "The saved conversations could not be deleted. Try again.");
		}
	}

	private async deleteAllStoredText(setting: Setting): Promise<void> {
		const confirmed = await askMateConfirm(this.app, "Delete all saved conversations, the note history and the queued reviews? This removes the text of your questions, AskMate's answers and the proposed note changes from this plugin's data. It cannot be undone.", {
			title: "Delete all stored text",
			confirmLabel: "Delete everything",
			destructive: true,
			details: ["Your notes, settings, skills and tool servers are not touched.", "If this vault's plugin data syncs between devices, repeat the deletion on each device. A device that still holds a conversation or a queued review puts it back."]
		});
		if (!confirmed) {
			return;
		}
		this.plugin.forgetPendingQuestion();
		const otherStores = await this.clearHistoryAndReviews();
		const conversations = await this.plugin.threads.clearAll();
		const outcome = describeStoredTextDeletion({ conversations, otherStores });
		new Notice(outcome.message);
		this.setFieldFeedback(setting, outcome.message, outcome.ok ? "success" : "error");
		if (otherStores) {
			this.plugin.refreshOpenAskMateViews();
		}
	}

	/** Empties note history and the review queue together and puts them back if the write fails, so the answer is all or nothing. */
	private async clearHistoryAndReviews(): Promise<boolean> {
		const settings = this.plugin.settings;
		const previous = { history: settings.noteHistoryStore, queue: settings.reviewQueue };
		settings.noteHistoryStore = { turns: [] };
		settings.reviewQueue = [];
		try {
			await this.plugin.saveSettings();
			return true;
		} catch {
			settings.noteHistoryStore = previous.history;
			settings.reviewQueue = previous.queue;
			return false;
		}
	}

	// ----------------------------------------------------------------------------------------------------------------------
	// Skills and tools
	// ----------------------------------------------------------------------------------------------------------------------

	private getSkillsAndToolsDefinitions(): SettingDefinitionItem[] {
		return [...buildSkillItems(this), ...buildDiagramItems(this), ...buildToolsItems(this)];
	}

	// ----------------------------------------------------------------------------------------------------------------------
	// Advanced
	// ----------------------------------------------------------------------------------------------------------------------

	private getAdvancedDefinitions(): SettingDefinitionItem[] {
		return [
			this.noteDefinition(ADVANCED_REASSURANCE),
			...this.getContextSourceDefinitions(),
			...this.getOutputApplyDefinitions(),
			...this.getWorkflowAutomationDefinitions(),
			...this.getUsageDefinitions(),
			{
				type: "group",
				heading: "Help and reset",
				items: [
					{
						name: "Onboarding tips",
						desc: "Show a small first-use tip card in the sidebar until dismissed.",
						render: (setting) => {
							let onboardingToggle: ToggleComponent | null = null;
							const saveOnboarding = async (show: boolean): Promise<void> => {
								this.plugin.settings.showOnboardingTips = show;
								if (show) {
									this.plugin.settings.onboardingTipsDismissedAt = null;
								}
								await this.runSettingAction(() => this.saveUiSetting());
							};
							setting
								.addToggle((toggle) => {
									onboardingToggle = toggle;
									this.setupToggle(toggle, "Show onboarding tips", this.plugin.settings.showOnboardingTips, saveOnboarding);
								})
								.addButton((button) => {
									this.labelControl(button.buttonEl, "Show onboarding tips again");
									button.setButtonText("Show again").onClick(() => {
										// Switching the toggle on fires its own handler, which saves; only a tip already on but dismissed needs a save here.
										if (onboardingToggle && !onboardingToggle.getValue()) {
											onboardingToggle.setValue(true);
											return;
										}
										void saveOnboarding(true);
									});
								});
						}
					},
					{
						name: "Reset to recommended settings",
						desc: "Put the sidebar, answer, privacy, context, template and usage options back to their recommended values.",
						render: (setting) => {
							setting.addButton((button) => {
								button.setButtonText("Reset options").setDestructive().setClass("askmate-danger").onClick(() => {
									void this.keepFocusWhileBusy(button.buttonEl, (busy) => { button.setDisabled(busy); }, () => this.runSettingAction(() => this.resetToRecommended()));
								});
							});
						}
					}
				]
			}
		];
	}

	private async resetToRecommended(): Promise<void> {
		const confirmed = await askMateConfirm(this.app, "Reset the sidebar, answer, privacy, context, template and usage options to their recommended values?", {
			title: "Reset to recommended settings",
			confirmLabel: "Reset options",
			destructive: true,
			details: ["Your provider, API keys, instructions, workflows, skills, tool servers and saved conversations stay as they are."]
		});
		if (!confirmed) {
			return;
		}
		Object.assign(this.plugin.settings, buildRecommendedSettingsPatch());
		await this.saveUiSetting();
		new Notice("AskMate put the options back to their recommended values.");
		this.update();
	}

	private getContextSourceDefinitions(): SettingDefinitionItem[] {
		const settings = this.plugin.settings;
		return [
			{
				type: "group",
				heading: "Extra notes and folders",
				items: [
					{
						name: "Default additional note paths",
						desc: "Optional extra notes to send with every question, one Markdown path or wikilink per line.",
						render: (setting) => {
							setting.addTextArea((text) => {
								text.inputEl.rows = 4;
								this.labelControl(text.inputEl, "Default additional note paths");
								text.setValue(settings.additionalContextPaths.join("\n")).onChange((value) => {
									settings.additionalContextPaths = normalizeContextPathList(value);
									this.scheduleSave();
								});
							});
						}
					},
					this.integerDefinition(
						"Additional note character limit",
						`The most characters taken from additional notes before the normal size limit applies (${formatIntegerRange(ADDITIONAL_CONTEXT_MAX_CHARACTERS_BOUNDS)}).`,
						{
							bounds: ADDITIONAL_CONTEXT_MAX_CHARACTERS_BOUNDS,
							getValue: () => settings.additionalContextMaxCharacters,
							setValue: (value) => {
								settings.additionalContextMaxCharacters = value;
							}
						}
					),
					this.toggleDefinition(
						"folderContextEnabled",
						"Default folder context",
						"Send Markdown notes from one folder as context; it is off by default and limited by file and character counts."
					),
					this.folderPathDefinition(
						"Folder context path",
						"The folder whose Markdown notes are sent.",
						{
							placeholder: "Folder path",
							getValue: () => settings.folderContextPath,
							setValue: (value) => {
								settings.folderContextPath = value;
							}
						},
						{ visible: () => settings.folderContextEnabled }
					),
					this.integerDefinition(
						"Folder context file limit",
						`The most notes read from the folder (${formatIntegerRange(FOLDER_CONTEXT_MAX_FILES_BOUNDS)}).`,
						{
							bounds: FOLDER_CONTEXT_MAX_FILES_BOUNDS,
							getValue: () => settings.folderContextMaxFiles,
							setValue: (value) => {
								settings.folderContextMaxFiles = value;
							}
						},
						{ visible: () => settings.folderContextEnabled }
					),
					this.integerDefinition(
						"Folder context character limit",
						`The most characters read from the folder before the normal size limit applies (${formatIntegerRange(FOLDER_CONTEXT_MAX_CHARACTERS_BOUNDS)}).`,
						{
							bounds: FOLDER_CONTEXT_MAX_CHARACTERS_BOUNDS,
							getValue: () => settings.folderContextMaxCharacters,
							setValue: (value) => {
								settings.folderContextMaxCharacters = value;
							}
						},
						{ visible: () => settings.folderContextEnabled }
					)
				]
			},
			{
				type: "group",
				heading: "Attachments",
				items: [
					this.toggleDefinition(
						"includeExcalidrawSummaries",
						"Excalidraw summaries",
						"Send the readable text and embedded references from Excalidraw files; this is not an analysis of the drawing itself."
					),
					this.integerDefinition(
						"Excalidraw character limit",
						`The most characters taken from each drawing (${formatIntegerRange(EXCALIDRAW_SUMMARY_MAX_CHARACTERS_BOUNDS)}).`,
						{
							bounds: EXCALIDRAW_SUMMARY_MAX_CHARACTERS_BOUNDS,
							getValue: () => settings.excalidrawSummaryMaxCharacters,
							setValue: (value) => {
								settings.excalidrawSummaryMaxCharacters = value;
							}
						},
						{ visible: () => settings.includeExcalidrawSummaries }
					),
					this.toggleDefinition(
						"includeImageManifests",
						"Image manifest context",
						"Send image paths, labels, sizes and reference lines as text when image links are allowed; the pictures themselves are not sent."
					)
				]
			},
			{
				type: "group",
				heading: "Evidence",
				items: [
					this.toggleDefinition(
						"evidenceLinkedAnswersEnabled",
						"Evidence-linked answers",
						"Ask text models to cite sources like [S1] and show jump-to-source actions on cited replies."
					),
					this.integerDefinition(
						"Evidence source limit",
						`The most evidence sources offered to the model (${formatIntegerRange(EVIDENCE_MAX_SOURCES_BOUNDS)}).`,
						{
							bounds: EVIDENCE_MAX_SOURCES_BOUNDS,
							getValue: () => settings.evidenceMaxSources,
							setValue: (value) => {
								settings.evidenceMaxSources = value;
							}
						},
						{ visible: () => settings.evidenceLinkedAnswersEnabled }
					)
				]
			},
			{
				type: "group",
				heading: "Pinned notes",
				items: [
					this.toggleDefinition(
						"includeStyleGuideContext",
						"Style guide note",
						"Pin a Markdown note as a style guide that goes with every request."
					),
					this.notePathDefinition(
						"Style guide note path",
						() => settings.styleGuideContextPath,
						(value) => {
							settings.styleGuideContextPath = value;
						},
						{ visible: () => settings.includeStyleGuideContext }
					),
					this.toggleDefinition(
						"includeGlossaryContext",
						"Glossary note",
						"Pin a Markdown note as a glossary of terms that goes with every request."
					),
					this.notePathDefinition(
						"Glossary note path",
						() => settings.glossaryContextPath,
						(value) => {
							settings.glossaryContextPath = value;
						},
						{ visible: () => settings.includeGlossaryContext }
					)
				]
			}
		];
	}

	private notePathDefinition(name: string, getValue: () => string, setValue: (value: string) => void, extras: SettingsDefinitionExtras): SettingDefinition {
		return {
			name,
			desc: "Type a path to browse notes folder by folder, or enter a wikilink.",
			...extras,
			render: (setting) => {
				this.prepareFieldFeedback(setting);
				const checkExists = (value: string): void => {
					const target = value.trim().replace(/^\[\[|\]\]$/g, "").split("|")[0] ?? "";
					const found = target !== "" && this.app.metadataCache.getFirstLinkpathDest(target, "") !== null;
					this.setFieldFeedback(setting, target !== "" && !found ? "AskMate cannot find that note yet, so it is skipped until it exists." : null, "warning");
				};
				setting.addText((text) => {
					text.setPlaceholder("Path or wikilink").setValue(getValue()).onChange((value) => {
						setValue(normalizeOptionalString(value, MAX_CONTEXT_PATH_LENGTH));
						this.scheduleSave();
					});
					this.labelControl(text.inputEl, name);
					text.inputEl.addEventListener("blur", () => checkExists(text.getValue()));
					// A picked note is a finished edit, so it saves at once instead of waiting for the typing delay.
					attachMarkdownFileSuggest(this.app, text.inputEl, () => {
						this.debouncedSave.run();
						checkExists(text.getValue());
					});
				});
				checkExists(getValue());
			}
		};
	}

	private templateDefinition(name: string, desc: string, options: TemplateFieldOptions): SettingDefinition {
		return {
			name,
			desc,
			render: (setting) => {
				this.prepareFieldFeedback(setting);
				let field: TextComponent | TextAreaComponent | null = null;
				let restoreButton: ExtraButtonComponent | null = null;
				const isDefault = (): boolean => options.getValue() === options.defaultValue;
				// A template that drops the answer or misspells a variable renders without telling anyone, after the tokens are spent.
				const warn = (): void => {
					this.setFieldFeedback(setting, checkTemplate(options.kind, options.getValue()), "warning");
				};
				const bindField = (component: TextComponent | TextAreaComponent): void => {
					field = component;
					this.labelControl(component.inputEl, name);
					component.setValue(options.getValue()).onChange((value) => {
						options.setValue(normalizeTemplateString(value, options.defaultValue));
						if (restoreButton) {
							this.setExtraButtonDisabled(restoreButton, isDefault());
						}
						this.scheduleSave();
					});
					component.inputEl.addEventListener("blur", () => {
						// An empty template is saved as the default, so the field shows what was kept once editing ends.
						if (!component.getValue().trim() && options.getValue() === options.defaultValue) {
							component.setValue(options.defaultValue);
							this.setFieldFeedback(setting, "Empty template replaced with the default.", "info");
							return;
						}
						warn();
					});
				};
				if (options.multiline) {
					setting.addTextArea((text) => {
						text.inputEl.rows = 8;
						text.inputEl.addClass("askmate-settings-template-input");
						bindField(text);
					});
				} else {
					setting.addText((text) => {
						text.setPlaceholder(options.defaultValue);
						bindField(text);
					});
				}
				setting.addExtraButton((button) => {
					restoreButton = button;
					this.describeExtraButton(button.setIcon("rotate-ccw"), `Restore default ${name.toLowerCase()}`);
					this.setExtraButtonDisabled(button, isDefault());
					button.onClick(() => {
						void this.runSettingAction(async () => {
							if (isDefault()) {
								return;
							}
							if (!(await askMateConfirm(this.app, `Restore the default ${name.toLowerCase()}? Your current version will be replaced.`, {
								title: "Restore default template",
								confirmLabel: "Restore default",
								destructive: true
							}))) {
								return;
							}
							field?.setValue(options.defaultValue);
							options.setValue(options.defaultValue);
							this.setExtraButtonDisabled(button, true);
							await this.plugin.saveSettings();
							this.setFieldFeedback(setting, "Restored the default.", "success");
						});
					});
				});
				warn();
			}
		};
	}

	private getOutputApplyDefinitions(): SettingDefinitionItem[] {
		const settings = this.plugin.settings;
		return [
			{
				type: "group",
				heading: "Result notes",
				items: [
					this.toggleDefinition(
						"smartResultPlacementEnabled",
						"Place result notes beside the source note",
						"Create result notes in an AskMate subfolder next to the source note instead of the result folder."
					),
					this.toggleDefinition(
						"appendResultBacklinkToSource",
						"Link result notes from the source note",
						"Add a link to each new result note at the end of its source note."
					),
					this.templateDefinition(
						"Result note template",
						"Markdown template for result notes; variables include {{title}}, {{sourceLink}}, {{providerName}}, {{model}}, {{request}} and {{response}}.",
						{
							kind: "result-note",
							defaultValue: DEFAULT_RESULT_NOTE_TEMPLATE,
							multiline: true,
							getValue: () => settings.resultNoteTemplate,
							setValue: (value) => {
								settings.resultNoteTemplate = value;
							}
						}
					)
				]
			},
			{
				type: "group",
				heading: "Image output",
				items: [
					this.templateDefinition(
						"Image result note template",
						"Markdown template for generated image notes; variables include {{imageEmbed}}, {{imagePrompt}}, {{revisedPromptSection}} and {{planningModel}}.",
						{
							kind: "image-note",
							defaultValue: DEFAULT_IMAGE_RESULT_NOTE_TEMPLATE,
							multiline: true,
							getValue: () => settings.imageResultNoteTemplate,
							setValue: (value) => {
								settings.imageResultNoteTemplate = value;
							}
						}
					),
					this.templateDefinition(
						"Image folder template",
						"Folder template for generated PNG files; use {{resultFolder}}, {{date}}, {{noteTitle}} or {{workflowName}}.",
						{
							kind: "image-folder",
							defaultValue: DEFAULT_IMAGE_FOLDER_TEMPLATE,
							multiline: false,
							getValue: () => settings.imageFolderTemplate,
							setValue: (value) => {
								settings.imageFolderTemplate = value;
							}
						}
					),
					this.templateDefinition(
						"Image file name template",
						"Base file name for generated PNG files; AskMate still adds a timestamp and resolves duplicates.",
						{
							kind: "image-file-name",
							defaultValue: DEFAULT_IMAGE_FILE_NAME_TEMPLATE,
							multiline: false,
							getValue: () => settings.imageFileNameTemplate,
							setValue: (value) => {
								settings.imageFileNameTemplate = value;
							}
						}
					)
				]
			},
			{
				type: "group",
				heading: "Changing notes",
				items: [
					this.dropdownDefinition(
						"partialApplyDefaultScope",
						"Default partial Apply scope",
						"Auto replaces selected text or else appends to the note; choose full-note replacement only for deliberate rewrites.",
						{ auto: "Auto", append: "Append to note", "selected-block": "Selected block", "heading-section": "Heading section", "full-note": "Full note replacement" }
					),
					this.dropdownDefinition(
						"frontmatterApplyPolicy",
						"Frontmatter Apply handling",
						"How a full-note Apply treats the YAML frontmatter at the top of a note.",
						{ preserve: "Preserve original frontmatter", confirm: "Confirm frontmatter changes", replace: "Replace from AI output" }
					)
				]
			},
			{
				type: "group",
				heading: "Review queue",
				items: [
					this.integerDefinition(
						"Review queue max items",
						`How many items the queue keeps (${formatIntegerRange(REVIEW_QUEUE_MAX_ITEMS_BOUNDS)}); lowering it removes older applied or dismissed items, never pending ones.`,
						{
							bounds: REVIEW_QUEUE_MAX_ITEMS_BOUNDS,
							getValue: () => settings.reviewQueueMaxItems,
							setValue: (value) => {
								settings.reviewQueueMaxItems = value;
							}
						}
					),
					this.imperativePage(
						"Pending reviews",
						"Apply, dismiss, or inspect AI-suggested note changes waiting for review.",
						(containerEl, refresh) => this.renderPendingReviews(containerEl, refresh),
						{ displayValue: () => `${this.plugin.getPendingReviewQueueItems().length.toLocaleString("en-GB")} pending` }
					)
				]
			}
		];
	}

	private getWorkflowAutomationDefinitions(): SettingDefinitionItem[] {
		return [
			{
				type: "group",
				heading: "Workflows in the sidebar",
				items: [
					{
						type: "page",
						name: "Workflow sidebar",
						...pageSummaryFields(
							this.summariesSupported,
							"Favourite, hide or reorder workflows in the sidebar; command palette workflows are not changed.",
							() => `${this.plugin.getVisibleWorkflows().length.toLocaleString("en-GB")} of ${this.plugin.getAllWorkflows().length.toLocaleString("en-GB")} shown`
						),
						items: this.getWorkflowSidebarDefinitions()
					},
					{
						type: "page",
						name: "Custom workflows",
						...pageSummaryFields(
							this.summariesSupported,
							"Create and edit your own sidebar workflows, and export or import workflow presets.",
							() => pluralise(this.plugin.settings.customWorkflows.length, "workflow")
						),
						items: this.getCustomWorkflowDefinitions()
					}
				]
			},
			{
				type: "group",
				heading: "Workflow defaults",
				items: [
					{
						name: "Workflow custom instructions",
						desc: "Preferences added to workflows only; custom workflows can place them with {{customInstructions}}.",
						render: (setting) => {
							this.prepareFieldFeedback(setting);
							setting.addTextArea((text) => {
								text.inputEl.rows = 4;
								text.inputEl.addClass("askmate-settings-prompt-input");
								this.labelControl(text.inputEl, "Workflow custom instructions");
								const count = (): void => {
									this.setFieldFeedback(setting, describePromptLength(text.getValue().length, MAX_WORKFLOW_CUSTOM_INSTRUCTIONS_LENGTH), "info");
								};
								text
									.setValue(this.plugin.settings.workflowCustomInstructions)
									.onChange((value) => {
										this.plugin.settings.workflowCustomInstructions = normalizeOptionalString(value, MAX_WORKFLOW_CUSTOM_INSTRUCTIONS_LENGTH);
										this.scheduleSave();
									});
								text.inputEl.addEventListener("blur", count);
							});
						}
					},
					{
						name: "Translation target language",
						desc: `The language that the Translate workflow writes in (default: ${DEFAULT_TRANSLATION_TARGET_LANGUAGE}); enter a name such as German or Brazilian Portuguese.`,
						render: (setting) => {
							setting.addText((text) => {
								this.labelControl(text.inputEl, "Translation target language");
								text
									.setPlaceholder(DEFAULT_TRANSLATION_TARGET_LANGUAGE)
									.setValue(normalizeTranslationTargetLanguage(this.plugin.settings.translationTargetLanguage))
									.onChange((value) => {
										this.plugin.settings.translationTargetLanguage = normalizeTranslationTargetLanguage(value);
										this.scheduleSave();
									});

								text.inputEl.addEventListener("blur", () => {
									text.setValue(this.plugin.settings.translationTargetLanguage);
								});
							});
						}
					}
				]
			},
			{
				type: "group",
				heading: "Automation",
				items: [
					this.imperativePage(
						"Batch workflow runner",
						"Run one workflow separately for each Markdown note in a folder.",
						(containerEl, refresh) => this.renderBatchWorkflowRunner(containerEl, refresh)
					)
				]
			}
		];
	}

	private getWorkflowSidebarDefinitions(): SettingDefinitionItem[] {
		const workflows = this.plugin.getSidebarWorkflowOrderForSettings();
		const labels = uniqueLabels(workflows.map((workflow) => workflow.name));
		const favourites = workflows.map((workflow) => Boolean(this.plugin.getWorkflowDisplayPreference(workflow.id)?.favorite));
		// Favourites always sort first, so a move across that boundary would be undone; that button is off instead of doing nothing.
		const canMove = (from: number, to: number): boolean => favourites[to] !== undefined && favourites[from] === favourites[to];
		return [
			this.noteDefinition("Use Move up and Move down on a row to change the order. Favourites always appear first, so a workflow moves within its own group. Hidden built-in workflows stay available from the command palette."),
			// Obsidian's reorderable list puts a div with an aria-label and no role on every row (axe aria-prohibited-attr), so plain rows carry real buttons.
			{
				type: "group",
				heading: "Sidebar order",
				items: workflows.map((workflow, index) => this.workflowSidebarRow(workflow, labels[index] ?? workflow.name, index, canMove(index, index - 1), canMove(index, index + 1)))
			}
		];
	}

	private workflowSidebarRow(workflow: Workflow, label: string, index: number, canMoveUp: boolean, canMoveDown: boolean): SettingDefinition {
		const preference = this.plugin.getWorkflowDisplayPreference(workflow.id);
		const customWorkflow = workflow.isCustom
			? this.plugin.settings.customWorkflows.find((item) => item.id === workflow.id)
			: undefined;
		const isFavorite = Boolean(preference?.favorite);
		const isHidden = Boolean(preference?.hidden) || Boolean(customWorkflow?.hidden);
		const favouriteKey = `workflow-favourite:${workflow.id}`;
		const visibilityKey = `workflow-visibility:${workflow.id}`;
		const moves = [
			{ key: `workflow-move-up:${workflow.id}`, icon: "arrow-up", label: `Move ${workflow.name} up`, offset: -1, enabled: canMoveUp },
			{ key: `workflow-move-down:${workflow.id}`, icon: "arrow-down", label: `Move ${workflow.name} down`, offset: 1, enabled: canMoveDown }
		];
		return {
			name: label,
			desc: [workflow.isCustom ? "Custom" : "Built-in", isFavorite ? "Favourite" : null, isHidden ? "Hidden" : null]
				.filter((part): part is string => part !== null)
				.join(" · "),
			render: (setting) => {
				setting.settingEl.toggleClass("askmate-workflow-row-hidden", isHidden);
				for (const move of moves) {
					setting.addExtraButton((button) => {
						this.describeExtraButton(button.setIcon(move.icon), move.label);
						this.setExtraButtonDisabled(button, !move.enabled);
						button.onClick(() => {
							if (!move.enabled) {
								return;
							}
							// The list is rebuilt from the new order, so focus is asked back for the same button on the moved row.
							this.focusAfterRebuild = move.key;
							this.applyWorkflowDisplayChange(this.plugin.reorderWorkflowDisplay(index, index + move.offset));
						});
						this.restoreFocus(move.key, button.extraSettingsEl);
					});
				}
				setting.addExtraButton((button) => {
					this.describeExtraButton(button.setIcon("star"), isFavorite ? `Remove ${workflow.name} from favourites` : `Add ${workflow.name} to favourites`);
					button.extraSettingsEl.setAttribute("aria-pressed", String(isFavorite));
					button.onClick(() => {
						this.focusAfterRebuild = favouriteKey;
						this.applyWorkflowDisplayChange(this.plugin.updateWorkflowDisplayPreference(workflow.id, { favorite: !isFavorite }));
					});
					button.extraSettingsEl.addClass("askmate-workflow-favorite");
					button.extraSettingsEl.toggleClass("is-active", isFavorite);
					this.restoreFocus(favouriteKey, button.extraSettingsEl);
				});
				setting.addExtraButton((button) => {
					this.describeExtraButton(button.setIcon(isHidden ? "eye-off" : "eye"), isHidden ? `Show ${workflow.name} in the sidebar` : `Hide ${workflow.name} from the sidebar`);
					button.onClick(() => {
						this.focusAfterRebuild = visibilityKey;
						// Both updates mutate settings before their first await, and saves are chained, so they can start together.
						this.applyWorkflowDisplayChange(Promise.all([
							workflow.isCustom ? this.plugin.updateCustomWorkflow(workflow.id, { hidden: !isHidden }) : Promise.resolve(),
							this.plugin.updateWorkflowDisplayPreference(workflow.id, { hidden: !isHidden })
						]));
					});
					this.restoreFocus(visibilityKey, button.extraSettingsEl);
				});
			}
		};
	}

	/** Takes focus back after a page redraw, when the control that caused the redraw is the one that was asked to be restored. */
	private restoreFocus(key: string, el: HTMLElement): void {
		if (this.focusAfterRebuild !== key) {
			return;
		}
		this.focusAfterRebuild = null;
		el.focus();
		// A row drawn by update() may not be in the page yet, and Obsidian then puts focus on the row's first control (a move
		// up button after a move down). Focusing again once the redraw is done keeps the keyboard on the control it used.
		(el.ownerDocument.defaultView ?? window).setTimeout(() => {
			if (el.isConnected) {
				el.focus();
			}
		}, 0);
	}

	/**
	 * Takes a change that has already mutated settings synchronously and is now saving. The list is rebuilt at once,
	 * because favourites re-sort to the top and row descriptions change with the new order.
	 */
	private applyWorkflowDisplayChange(saving: Promise<unknown>): void {
		this.update();
		void this.runSettingAction(async () => {
			await saving;
		});
	}

	private getCustomWorkflowDefinitions(): SettingDefinitionItem[] {
		const workflows = this.plugin.settings.customWorkflows;
		const labels = uniqueLabels(workflows.map((workflow) => workflow.name));
		return [
			this.noteDefinition("Select a workflow to edit it. Delete a workflow from its page, or focus its row and press Delete."),
			// A real button: the list's own add affordance is a div with an aria-label and no role (axe aria-prohibited-attr).
			{
				name: "Add a workflow",
				desc: "Starts a new custom workflow that you can then name and edit.",
				aliases: ["add workflow", "new workflow"],
				render: (setting) => {
					setting.addButton((button) => {
						button.setButtonText("Add workflow").onClick(() => {
							void this.runSettingAction(() => this.plugin.addCustomWorkflow()).then(() => this.update());
						});
					});
				}
			},
			{
				type: "list",
				heading: "Your workflows",
				emptyState: "No custom workflows yet. Use Add workflow above.",
				onDelete: (index) => {
					void this.deleteCustomWorkflowAt(index);
				},
				items: workflows.map((workflow, index) => this.customWorkflowPage(workflow.id, labels[index] ?? workflow.name, workflow.description))
			},
			{
				type: "group",
				heading: "Presets",
				items: [
					{
						name: "Export presets",
						desc: "Show your custom workflows as JSON that you can copy and share.",
						render: (setting) => {
							setting.addButton((button) => {
								button
									.setButtonText("Show export JSON")
									.setDisabled(this.plugin.settings.customWorkflows.length === 0)
									.onClick(() => {
										new AskMateTextViewerModal(this.app, "AskMate workflow preset export", this.plugin.exportCustomWorkflowPresets()).open();
									});
							});
						}
					},
					{
						name: "Import presets",
						desc: "Paste an AskMate workflow preset export, then select Import; imported workflows are added and never replace yours.",
						render: (setting) => {
							let importJson = "";
							let importButton: ButtonComponent | null = null;
							this.prepareFieldFeedback(setting);
							setting.settingEl.addClass("askmate-settings-import");
							setting.addTextArea((text) => {
								text.inputEl.rows = 6;
								text.inputEl.addClass("askmate-settings-template-input");
								this.labelControl(text.inputEl, "Preset JSON");
								text.setPlaceholder("{\n  \"version\": 1,\n  \"source\": \"AskMate\",\n  \"workflows\": []\n}");
								text.onChange((value) => {
									importJson = value;
									importButton?.setDisabled(!value.trim());
									this.setFieldFeedback(setting, null);
								});
							});
							setting.addButton((button) => {
								importButton = button;
								button.setButtonText("Import").setDisabled(true).onClick(async () => {
									try {
										const count = await this.plugin.importCustomWorkflowPresets(importJson);
										new Notice(`AskMate imported ${pluralise(count, "custom workflow")}.`);
										this.update();
									} catch (error) {
										this.setFieldFeedback(setting, this.plugin.getErrorMessage(error));
									}
								});
							});
						}
					}
				]
			}
		];
	}

	private async deleteCustomWorkflowAt(index: number): Promise<void> {
		const workflow = this.plugin.settings.customWorkflows[index];
		if (!workflow || !(await askMateConfirm(this.app, `Delete the custom workflow "${workflow.name}"? Its sidebar button and command go with it.`, {
			title: "Delete workflow",
			confirmLabel: "Delete workflow",
			destructive: true
		}))) {
			return;
		}

		await this.runSettingAction(async () => {
			await this.plugin.deleteCustomWorkflow(workflow.id);
			await this.healBatchWorkflowSelection();
		});
		this.update();
	}

	/** The batch runner must never point at a workflow that no longer exists, so a deleted one is replaced by the first that does. */
	private async healBatchWorkflowSelection(): Promise<void> {
		const settings = this.plugin.settings;
		const next = resolveBatchWorkflowId(settings.batchWorkflowId, this.plugin.getAllWorkflows().map((workflow) => workflow.id));
		if (next !== settings.batchWorkflowId) {
			settings.batchWorkflowId = next;
			await this.plugin.saveSettings();
		}
	}

	// What the workflow list shows for one workflow; leaving its editor rebuilds the list only when this changed.
	private getCustomWorkflowListSignature(workflowId: string): string {
		const workflow = this.plugin.settings.customWorkflows.find((item) => item.id === workflowId);
		const hiddenPreference = this.plugin.getWorkflowDisplayPreference(workflowId)?.hidden ?? false;
		return workflow ? JSON.stringify([workflow.name, workflow.description, workflow.hidden, workflow.outputKind, hiddenPreference]) : "";
	}

	// Definitions are cached until the next update(), so everything here reads the live workflow by id.
	private customWorkflowPage(workflowId: string, label: string, description: string): SettingDefinitionPage {
		const signature = this.getCustomWorkflowListSignature(workflowId);
		return this.imperativePage(
			label,
			description,
			(containerEl, refresh) => this.renderCustomWorkflowEditor(containerEl, workflowId, refresh),
			{
				displayValue: () => {
					const workflow = this.plugin.settings.customWorkflows.find((item) => item.id === workflowId);
					if (!workflow) {
						return "";
					}
					const kind = WORKFLOW_OUTPUT_KIND_LABELS[workflow.outputKind ?? "new-content"];
					const isHidden = workflow.hidden || Boolean(this.plugin.getWorkflowDisplayPreference(workflowId)?.hidden);
					return isHidden ? `Hidden · ${kind}` : kind;
				},
				onHide: () => {
					if (this.getCustomWorkflowListSignature(workflowId) !== signature) {
						this.update();
					}
				}
			}
		);
	}

	private renderCustomWorkflowEditor(containerEl: HTMLElement, workflowId: string, refresh: () => void): void {
		const workflow = this.plugin.settings.customWorkflows.find((item) => item.id === workflowId);
		if (!workflow) {
			containerEl.createEl("p", { cls: "askmate-settings-note", text: "This workflow no longer exists." });
			return;
		}

		containerEl.createEl("p", {
			cls: "askmate-settings-note",
			text: "Custom workflows appear in the AskMate sidebar and the command palette. Variables available in prompts: {{noteTitle}}, {{sourcePath}}, {{contextSource}}, {{selectedText}}, {{currentDate}}, {{currentDateTime}}, and {{customInstructions}}."
		});

		new SettingGroup(containerEl)
			.setHeading("Details")
			.addSetting((setting) => {
				setting.setName("Name").setDesc("Also used as the command palette name.").addText((text) => {
					this.labelControl(text.inputEl, "Name");
					text.setValue(workflow.name);
					this.bindCustomWorkflowField(workflow.id, text.inputEl, "name", true);
				});
			})
			.addSetting((setting) => {
				setting.setName("Short name").setDesc("Label on the sidebar workflow button, and the base of its console command.").addText((text) => {
					this.labelControl(text.inputEl, "Short name");
					text.setValue(workflow.shortName);
					this.bindCustomWorkflowField(workflow.id, text.inputEl, "shortName", true);
				});
			})
			.addSetting((setting) => {
				setting.setName("Description").setDesc("Shown under the short name on the sidebar workflow button.").addText((text) => {
					this.labelControl(text.inputEl, "Description");
					text.setValue(workflow.description);
					this.bindCustomWorkflowField(workflow.id, text.inputEl, "description", true);
				});
			})
			.addSetting((setting) => {
				setting.setName("Icon").setDesc("Lucide icon name, for example wand-2, lightbulb, or file-text.");
				const preview = setting.controlEl.createSpan({ cls: "askmate-workflow-icon-preview", attr: { "aria-hidden": "true" } });
				const showPreview = (icon: string): void => {
					preview.empty();
					setIcon(preview, icon.trim());
				};
				showPreview(workflow.icon);
				setting.addText((text) => {
					this.labelControl(text.inputEl, "Icon");
					text.setValue(workflow.icon);
					text.inputEl.addEventListener("input", () => showPreview(text.getValue()));
					this.bindCustomWorkflowField(workflow.id, text.inputEl, "icon", true);
				});
			})
			.addSetting((setting) => {
				setting.setName("Accent").addDropdown((dropdown) => {
					for (const accent of WORKFLOW_ACCENTS) {
						dropdown.addOption(accent, `${accent.charAt(0).toUpperCase()}${accent.slice(1)}`);
					}
					this.labelControl(dropdown.selectEl, "Accent");
					dropdown.setValue(workflow.accent).onChange((value) => {
						void this.runSettingAction(() => this.plugin.updateCustomWorkflow(workflow.id, { accent: normalizeWorkflowAccent(value) }));
					});
				});
			});

		new SettingGroup(containerEl)
			.setHeading("Prompt and output")
			.addSetting((setting) => {
				this.prepareFieldFeedback(setting);
				setting
					.setName("Prompt")
					.setDesc("Describe the result you want; AskMate provides the current note or selection as context.")
					.addTextArea((text) => {
						text.inputEl.rows = 8;
						text.inputEl.addClass("askmate-settings-prompt-input");
						this.labelControl(text.inputEl, "Prompt");
						text.setValue(workflow.prompt);
						const count = (): void => {
							this.setFieldFeedback(setting, describePromptLength(text.getValue().trim().length, MAX_CUSTOM_WORKFLOW_PROMPT_LENGTH), text.getValue().trim().length > MAX_CUSTOM_WORKFLOW_PROMPT_LENGTH ? "warning" : "info");
						};
						text.inputEl.addEventListener("input", count);
						// Leaving the field shows what was kept, because a cut or replaced prompt would otherwise look unchanged on screen.
						text.inputEl.addEventListener("blur", () => {
							const note = describePromptNormalisation(text.getValue(), MAX_CUSTOM_WORKFLOW_PROMPT_LENGTH, "An empty prompt is replaced with a generic one. Say what the workflow should do.");
							if (note) {
								this.setFieldFeedback(setting, note, "warning");
							}
						});
						this.bindCustomWorkflowField(workflow.id, text.inputEl, "prompt", false);
						count();
					});
			})
			.addSetting((setting) => {
				setting
					.setName("Output kind")
					.setDesc("Revised note means the output is a full new version of the note and may replace it; New content is added or saved as a note.")
					.addDropdown((dropdown) => {
						this.labelControl(dropdown.selectEl, "Output kind");
						dropdown
							.addOption("note-edit", WORKFLOW_OUTPUT_KIND_LABELS["note-edit"])
							.addOption("new-content", WORKFLOW_OUTPUT_KIND_LABELS["new-content"])
							.setValue(workflow.outputKind ?? "new-content")
							.onChange((value) => {
								const outputKind: WorkflowOutputKind = value === "note-edit" ? "note-edit" : "new-content";
								void this.runSettingAction(() => this.plugin.updateCustomWorkflow(workflow.id, { outputKind }));
							});
					});
			})
			.addSetting((setting) => {
				this.prepareFieldFeedback(setting);
				setting
					.setName("Result note template")
					.setDesc("Optional Markdown template for this workflow; leave it empty to use the global result note template.")
					.addTextArea((text) => {
						text.inputEl.rows = 6;
						text.inputEl.addClass("askmate-settings-template-input");
						this.labelControl(text.inputEl, "Result note template");
						text.setValue(workflow.resultNoteTemplate);
						const warn = (): void => {
							this.setFieldFeedback(setting, checkTemplate("workflow-result-note", text.getValue()), "warning");
						};
						text.inputEl.addEventListener("blur", warn);
						this.bindCustomWorkflowField(workflow.id, text.inputEl, "resultNoteTemplate", false, (value) => normalizeTemplateString(value, ""));
						warn();
					});
			});

		const isHidden = workflow.hidden || Boolean(this.plugin.getWorkflowDisplayPreference(workflow.id)?.hidden);
		new SettingGroup(containerEl)
			.setHeading("Manage")
			.addSetting((setting) => {
				setting
					.setName("Hide from sidebar")
					.setDesc("Hide this workflow from the sidebar without deleting it; its command palette entry and hotkey keep working.")
					.addToggle((toggle) => {
						// The page is not redrawn after a rename, so labels name "this workflow" rather than a name that can go stale.
						this.setupToggle(toggle, "Hide this workflow from the sidebar", isHidden, (value) => {
							void this.runSettingAction(async () => {
								await this.plugin.updateCustomWorkflow(workflow.id, { hidden: value });
								await this.plugin.updateWorkflowDisplayPreference(workflow.id, { hidden: value });
							});
						});
					});
			})
			.addSetting((setting) => {
				setting
					.setName("Delete workflow")
					.setDesc("Remove this workflow, its sidebar button and its command; this cannot be undone.")
					.addButton((button) => {
						this.labelControl(button.buttonEl, "Delete this workflow");
						button.setButtonText("Delete").setDestructive().setClass("askmate-danger").onClick(() => {
							void this.runSettingAction(async () => {
								const currentName = this.plugin.settings.customWorkflows.find((item) => item.id === workflow.id)?.name ?? workflow.name;
								if (!(await askMateConfirm(this.app, `Delete the custom workflow "${currentName}"? Its sidebar button and command go with it.`, {
									title: "Delete workflow",
									confirmLabel: "Delete workflow",
									destructive: true
								}))) {
									return;
								}
								// Uncommitted edits on this page still flush on hide, but find no workflow and save nothing.
								await this.plugin.deleteCustomWorkflow(workflow.id);
								await this.healBatchWorkflowSelection();
								refresh();
							});
						});
					});
			});
	}

	// Each workflow update re-registers commands and refreshes every sidebar, so commit when editing ends, not per keystroke.
	private bindCustomWorkflowField(
		workflowId: string,
		inputEl: HTMLInputElement | HTMLTextAreaElement,
		field: CustomWorkflowTextField,
		commitOnEnter: boolean,
		normalize: (value: string) => string = (value) => value
	): void {
		this.bindCommitOnBlur(inputEl, async () => {
			const workflow = this.plugin.settings.customWorkflows.find((item) => item.id === workflowId);
			const value = normalize(inputEl.value);
			if (!workflow || workflow[field] === value) {
				return;
			}
			const patch: Partial<Pick<CustomWorkflow, CustomWorkflowTextField>> = {};
			patch[field] = value;
			await this.plugin.updateCustomWorkflow(workflowId, patch);
		}, commitOnEnter);
	}

	private getUsageDefinitions(): SettingDefinitionItem[] {
		const settings = this.plugin.settings;
		const guardrailsOn = (): boolean => settings.usageGuardrailsEnabled;
		return [
			{
				type: "group",
				heading: "Usage limits",
				items: [
					this.toggleDefinition(
						"usageGuardrailsEnabled",
						"Usage budgets and guardrails",
						"Warn or block requests before they use a large context or pass a daily or monthly token budget."
					),
					this.dropdownDefinition(
						"usageBudgetEnforcement",
						"Budget enforcement",
						"Choose whether passing a daily or monthly budget warns or blocks; the per-request hard limit always blocks.",
						{ warn: "Warn", block: "Block" },
						{ visible: guardrailsOn }
					),
					this.integerDefinition(
						"Daily token budget",
						`Tokens per local calendar day (${formatIntegerRange(DAILY_TOKEN_BUDGET_BOUNDS)}); use 0 for no daily limit.`,
						{
							bounds: DAILY_TOKEN_BUDGET_BOUNDS,
							getValue: () => settings.usageDailyTokenBudget,
							setValue: (value) => {
								settings.usageDailyTokenBudget = value;
							}
						},
						{ visible: guardrailsOn }
					),
					this.integerDefinition(
						"Monthly token budget",
						`Tokens per calendar month (${formatIntegerRange(MONTHLY_TOKEN_BUDGET_BOUNDS)}); use 0 for no monthly limit.`,
						{
							bounds: MONTHLY_TOKEN_BUDGET_BOUNDS,
							getValue: () => settings.usageMonthlyTokenBudget,
							setValue: (value) => {
								settings.usageMonthlyTokenBudget = value;
							}
						},
						{ visible: guardrailsOn }
					),
					this.integerDefinition(
						"Per-request warning threshold",
						`Warn when a request is estimated above this many input tokens (${formatIntegerRange(PER_REQUEST_TOKEN_BOUNDS)}); use 0 to turn off.`,
						{
							bounds: PER_REQUEST_TOKEN_BOUNDS,
							getValue: () => settings.usagePerRequestWarningTokens,
							setValue: (value) => {
								settings.usagePerRequestWarningTokens = value;
							}
						},
						{ visible: guardrailsOn }
					),
					this.integerDefinition(
						"Per-request hard limit",
						`Block requests estimated above this many input tokens (${formatIntegerRange(PER_REQUEST_TOKEN_BOUNDS)}); use 0 to turn off.`,
						{
							bounds: PER_REQUEST_TOKEN_BOUNDS,
							getValue: () => settings.usagePerRequestHardLimitTokens,
							setValue: (value) => {
								settings.usagePerRequestHardLimitTokens = value;
							}
						},
						{ visible: guardrailsOn }
					)
				]
			},
			{
				type: "group",
				heading: "Usage history",
				items: [
					this.imperativePage(
						"Usage statistics",
						"Budgets, operation counts, token charts, recent operations, and a reset control.",
						(containerEl, refresh) => this.renderUsageStatisticsPage(containerEl, refresh),
						{ displayValue: () => `${pluralise(this.plugin.getTokenUsageRecords().length, "operation")} · ${summarizeUsageGuardrails(settings, this.plugin.getTodayTokenUsage(), this.plugin.getMonthTokenUsage())}` }
					)
				]
			}
		];
	}

	private renderBatchWorkflowRunner(containerEl: HTMLElement, refresh: () => void): void {
		const box = containerEl.createDiv({ cls: "askmate-batch-runner" });
		const progress = box.createDiv({ cls: "askmate-batch-progress", attr: { role: "status" } });
		const bar = box.createDiv({
			cls: "askmate-batch-progress-bar",
			attr: { role: "progressbar", "aria-label": "Batch progress", "aria-valuemin": "0", "aria-valuemax": "100" }
		});
		const fill = bar.createDiv({ cls: "askmate-batch-progress-fill" });

		const folderSetting = new Setting(box)
			.setName("Batch folder")
			.setDesc("Run one workflow separately for each Markdown note in this folder.");
		folderSetting.addText((text) => {
			text.setPlaceholder("Folder path");
			this.labelControl(text.inputEl, "Batch folder");
			this.bindFolderPathInput(folderSetting, text, {
				label: "Batch folder",
				getValue: () => this.plugin.settings.batchWorkflowFolderPath,
				setValue: (value) => {
					this.plugin.settings.batchWorkflowFolderPath = value;
				}
			});
		});

		const workflowSetting = new Setting(box)
			.setName("Batch workflow")
			.setDesc(`Workflow to run, and the maximum number of notes to process (${formatIntegerRange(BATCH_WORKFLOW_MAX_FILES_BOUNDS)}).`);
		workflowSetting
			.addDropdown((dropdown) => {
				const workflows = this.plugin.getAllWorkflows();
				for (const workflow of workflows) {
					dropdown.addOption(workflow.id, workflow.name);
				}
				this.labelControl(dropdown.selectEl, "Batch workflow");
				// A deleted workflow leaves a stale id that would show a blank list, so the first workflow takes its place and is saved.
				const selected = resolveBatchWorkflowId(this.plugin.settings.batchWorkflowId, workflows.map((workflow) => workflow.id));
				if (selected !== this.plugin.settings.batchWorkflowId) {
					this.plugin.settings.batchWorkflowId = selected;
					void this.runSettingAction(() => this.plugin.saveSettings());
				}
				dropdown.setValue(selected).onChange((value) => {
					this.plugin.settings.batchWorkflowId = value;
					void this.runSettingAction(() => this.plugin.saveSettings());
				});
			})
			.addText((text) => {
				this.bindIntegerInput(workflowSetting, text, {
					label: "Max notes",
					bounds: BATCH_WORKFLOW_MAX_FILES_BOUNDS,
					getValue: () => this.plugin.settings.batchWorkflowMaxFiles,
					setValue: (value) => {
						this.plugin.settings.batchWorkflowMaxFiles = value;
					}
				});
			});

		const outputSetting = new Setting(box)
			.setName("Batch output")
			.setDesc("Each note is a separate request to your chat provider and uses tokens.")
			.addDropdown((dropdown) => {
				this.labelControl(dropdown.selectEl, "Batch output");
				dropdown
					.addOptions(BATCH_OUTPUT_LABELS)
					.setValue(this.plugin.settings.batchWorkflowOutputMode)
					.onChange((value) => {
						this.plugin.settings.batchWorkflowOutputMode = normalizeBatchWorkflowOutputMode(value);
						void this.runSettingAction(() => this.plugin.saveSettings());
					});
			});
		const runButton = new ButtonComponent(outputSetting.controlEl)
			.setButtonText("Run batch")
			.setCta()
			.setClass("askmate-cta")
			.onClick(() => {
				this.focusAfterRebuild = "batch-run";
				void this.runBatch();
			});
		const cancelButton = new ButtonComponent(outputSetting.controlEl)
			.setButtonText("Cancel")
			.onClick(() => {
				this.activeBatch?.controller.abort();
			});
		this.batchElements = { progress, bar, fill, runButton, cancelButton };
		this.batchRefresh = refresh;
		this.renderBatchProgress();
		this.restoreFocus("batch-run", runButton.buttonEl);
	}

	private async runBatch(): Promise<void> {
		// A second concurrent batch would double API spend and duplicate result notes or queue items.
		if (this.activeBatch) {
			return;
		}

		// The plugin confirms the run itself with the real note count, so the tab does not ask first.
		const batch: ActiveBatchState = { controller: new AbortController(), message: "Starting batch...", percent: 0 };
		this.activeBatch = batch;
		this.renderBatchProgress();
		new Notice("AskMate batch started. It keeps running if you close settings. Reopen the batch runner to cancel it.", 8000);
		try {
			const summary = await this.plugin.runBatchWorkflow({
				folderPath: this.plugin.settings.batchWorkflowFolderPath,
				workflowId: this.plugin.settings.batchWorkflowId,
				maxFiles: this.plugin.settings.batchWorkflowMaxFiles,
				outputMode: this.plugin.settings.batchWorkflowOutputMode,
				contextBudgetMode: this.plugin.settings.contextBudgetMode
			}, (item) => {
				batch.message = item.message;
				batch.percent = item.total > 0 ? Math.round(((item.completed + item.failed) / item.total) * 100) : 0;
				this.renderBatchProgress();
			}, batch.controller.signal);
			const counts = `${summary.completed} completed, ${summary.failed} failed${summary.queuedReviews > 0 ? `, ${summary.queuedReviews} queued for review` : ""}.`;
			const firstFailure = summary.failures[0];
			const failureDetail = firstFailure ? ` First failure: ${firstFailure.path}: ${firstFailure.reason}` : "";
			const result = summary.stoppedReason
				? `Batch stopped: ${summary.stoppedReason} ${counts}${failureDetail}`
				: `Batch complete: ${counts}${failureDetail}`;
			this.lastBatchSummary = `Last run: ${result}`;
			new Notice(`AskMate ${result.charAt(0).toLowerCase()}${result.slice(1)}`, 10000);
		} catch (error) {
			const message = this.plugin.getErrorMessage(error);
			this.lastBatchSummary = `Last run failed: ${message}`;
			new Notice(message);
		} finally {
			this.activeBatch = null;
			// The batch can finish while the user is editing a field that saves on blur; commit it before the re-render drops it.
			this.flushPendingFieldCommits();
			this.batchRefresh?.();
		}
	}

	/** Lets the plugin stop a batch started from this tab when it unloads. */
	abortActiveBatch(): void {
		this.activeBatch?.controller.abort();
	}

	// Writes to whichever runner elements the latest render created, so progress survives display().
	private renderBatchProgress(): void {
		const elements = this.batchElements;
		if (!elements) {
			return;
		}

		const batch = this.activeBatch;
		const percent = batch?.percent ?? 0;
		elements.progress.setText(batch?.message ?? this.lastBatchSummary ?? "Idle.");
		elements.bar.setAttribute("aria-valuenow", String(percent));
		elements.fill.setCssProps({ "--askmate-batch-fill": `${percent}%` });
		elements.runButton.setDisabled(batch !== null);
		elements.cancelButton.setDisabled(batch === null);
	}

	private renderPendingReviews(containerEl: HTMLElement, refresh: () => void): void {
		const queue = containerEl.createDiv({ cls: "askmate-review-queue" });
		const pending = this.plugin.getPendingReviewQueueItems();
		const summary = queue.createEl("p", {
			cls: "askmate-settings-note",
			text: `${pluralise(pending.length, "pending AI-suggested note change")} (limit ${this.plugin.settings.reviewQueueMaxItems.toLocaleString("en-GB")}).`,
			attr: { tabindex: "-1", role: "status" }
		});
		if (pending.length === 0) {
			queue.createDiv({ cls: "askmate-usage-empty", text: "No queued reviews yet." });
			// An empty queue after the last item was handled leaves focus on the summary line instead of on nothing.
			this.restoreFocus("review-first", summary);
			return;
		}
		let firstApply: HTMLButtonElement | null = null;
		for (const item of pending.slice().reverse()) {
			const card = queue.createDiv({ cls: "askmate-review-item" });
			card.createDiv({ cls: "askmate-review-item-meta", text: `${formatUsageTimestamp(item.createdAt)} · ${item.sourcePath} · ${item.workflowName ?? item.title}` });
			card.createDiv({ cls: "askmate-review-excerpt", text: truncateLabel(item.proposedText, 360) });
			const actions = card.createDiv({ cls: "askmate-review-item-actions" });
			// Every card repeats the same three buttons, so each name says which note it acts on.
			const apply = actions.createEl("button", { cls: "mod-cta askmate-cta", text: "Apply", attr: { "aria-label": `Apply change to ${item.sourcePath}` } });
			apply.type = "button";
			firstApply ??= apply;
			apply.addEventListener("click", () => {
				apply.disabled = true;
				dismiss.disabled = true;
				this.focusAfterRebuild = "review-first";
				void this.plugin.applyReviewQueueItem(item.id).then((message) => {
					new Notice(message);
					summary.setText(message);
					refresh();
				}).catch((error) => new Notice(this.plugin.getErrorMessage(error))).finally(() => {
					apply.disabled = false;
					dismiss.disabled = false;
				});
			});
			const dismiss = actions.createEl("button", { text: "Dismiss", attr: { "aria-label": `Dismiss change to ${item.sourcePath}` } });
			dismiss.type = "button";
			dismiss.addEventListener("click", () => {
				apply.disabled = true;
				dismiss.disabled = true;
				this.focusAfterRebuild = "review-first";
				void this.plugin.dismissReviewQueueItem(item.id).then(refresh).catch((error) => {
					new Notice(this.plugin.getErrorMessage(error));
				}).finally(() => {
					apply.disabled = false;
					dismiss.disabled = false;
				});
			});
			const showProposal = actions.createEl("button", { text: "Show proposal", attr: { "aria-label": `Show proposal for ${item.sourcePath}` } });
			showProposal.type = "button";
			showProposal.addEventListener("click", () => new AskMateTextViewerModal(this.app, "AskMate review proposal", item.proposedText).open());
		}
		if (firstApply) {
			this.restoreFocus("review-first", firstApply);
		}
	}

	private renderUsageStatisticsPage(containerEl: HTMLElement, refresh: () => void): void {
		const settings = this.plugin.settings;
		renderUsageStatistics(containerEl, {
			records: this.plugin.getTokenUsageRecords(),
			summary: this.plugin.getTokenUsageSummary(),
			budget: {
				guardrailsEnabled: settings.usageGuardrailsEnabled,
				enforcement: settings.usageBudgetEnforcement,
				dailyUsed: this.plugin.getTodayTokenUsage(),
				dailyBudget: settings.usageDailyTokenBudget,
				monthlyUsed: this.plugin.getMonthTokenUsage(),
				monthlyBudget: settings.usageMonthlyTokenBudget
			},
			onReset: () => {
				void this.resetUsageStatistics(refresh);
			}
		});
	}

	private async resetUsageStatistics(refresh: () => void): Promise<void> {
		if (!(await askMateConfirm(this.app, "Reset AskMate usage statistics? The daily and monthly budget counters start again from zero. This cannot be undone.", {
			title: "Reset usage statistics",
			confirmLabel: "Reset statistics",
			destructive: true
		}))) {
			return;
		}

		try {
			await this.plugin.resetTokenUsageStats();
			new Notice("AskMate usage statistics reset.");
		} catch (error) {
			new Notice(this.plugin.getErrorMessage(error));
		}
		refresh();
	}
}

/** The value shown on the Instructions page entry. */
function summarizeInstructionsText(globalInstructions: string, folderRules: number): string {
	const parts = [
		globalInstructions.trim() ? "Instructions set" : null,
		folderRules > 0 ? pluralise(folderRules, "folder rule") : null
	].filter((part): part is string => part !== null);
	return parts.length > 0 ? parts.join(", ") : "Not set";
}
