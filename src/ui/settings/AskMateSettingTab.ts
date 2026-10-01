import {
	ButtonComponent,
	debounce,
	Notice,
	PluginSettingTab,
	SecretComponent,
	Setting,
	SettingGroup,
	SettingPage,
	setIcon,
	type App,
	type DropdownComponent,
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
import {
	CONTEXT_BUDGET_OPTIONS,
	DEFAULT_IMAGE_FILE_NAME_TEMPLATE,
	DEFAULT_IMAGE_FOLDER_TEMPLATE,
	DEFAULT_IMAGE_RESULT_NOTE_TEMPLATE,
	DEFAULT_LOCAL_BASE_URL,
	DEFAULT_PROVIDER_SETTINGS,
	DEFAULT_RESULT_NOTE_TEMPLATE,
	DEFAULT_SETTINGS,
	DEFAULT_TRANSLATION_TARGET_LANGUAGE,
	formatUsageTimestamp,
	getProviderLabel,
	MAX_CONTEXT_PATH_LENGTH,
	MAX_WORKFLOW_CUSTOM_INSTRUCTIONS_LENGTH,
	normalizeBatchWorkflowOutputMode,
	normalizeContextPathList,
	normalizeOptionalString,
	normalizeProviderModelOptions,
	normalizeTemplateString,
	normalizeTextProviderId,
	normalizeTranslationTargetLanguage,
	normalizeWorkflowAccent,
	REASONING_EFFORT_OPTIONS,
	TEXT_PROVIDER_IDS,
	truncateLabel,
	validateAzureOpenAIBaseUrl,
	validateProviderBaseUrl,
	WORKFLOW_ACCENTS,
	type BatchWorkflowOutputMode,
	type CustomWorkflow,
	type Workflow,
	type WorkflowOutputKind
} from "../../shared/core";
import { AskMateTextViewerModal, askMateConfirm } from "../modals/modals";
import { attachFolderSuggest, attachMarkdownFileSuggest, isPathSuggestOpen } from "./pathSuggest";
import {
	formatIntegerRange,
	readSettingControl,
	resolveBaseUrlInput,
	resolveFolderPathInput,
	resolveIntegerInput,
	uniqueLabels,
	writeSettingControl,
	type IntegerBounds,
	type SettingControlKey
} from "./settingsInputs";
import {
	getUsageGuardrailStatus,
	pluralise,
	summarizeContextSources,
	summarizeOutputApply,
	summarizeProviderSetup,
	summarizeRequestDefaults,
	summarizeUsageGuardrails,
	summarizeWorkflows
} from "./settingsSummaries";
import { renderUsageStatistics } from "./usageStatistics";

type PageRenderer = (containerEl: HTMLElement, refresh: () => void) => void;
type FeedbackKind = "error" | "success" | "info";
type DefinitionExtras = Pick<SettingDefinitionBase, "aliases" | "visible">;

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

export class AskMateSettingTab extends PluginSettingTab {
	private readonly plugin: AskMatePlugin;
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

	constructor(app: App, plugin: AskMatePlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	private async saveUiSetting(refreshViews = true): Promise<void> {
		await this.plugin.saveSettings();
		if (refreshViews) {
			this.plugin.refreshOpenAskMateViews();
		}
	}

	// data.json also holds history, usage and the review queue, so text fields must not rewrite it on every keystroke.
	private readonly debouncedSave = debounce(() => {
		void this.runSettingAction(() => this.plugin.saveSettings());
	}, TEXT_SAVE_DELAY_MS, true);

	private scheduleSave(): void {
		this.debouncedSave();
	}

	private async runSettingAction(action: () => Promise<void>): Promise<void> {
		try {
			await action();
		} catch (error) {
			new Notice(this.plugin.getErrorMessage(error));
		}
	}

	/**
	 * Obsidian focuses the toggle's container label, not the hidden checkbox inside it, and gives it no role or state,
	 * so the container carries the name, the switch role and aria-checked. The value is set before the handler is attached
	 * because ToggleComponent.setValue fires onChange whenever the value changes.
	 */
	private setupToggle(toggle: ToggleComponent, label: string, value: boolean, onChange: (value: boolean) => void | Promise<void>): void {
		const switchEl = toggle.toggleEl;
		switchEl.setAttribute("role", "switch");
		switchEl.setAttribute("aria-label", label);
		switchEl.querySelector("input")?.setAttribute("aria-hidden", "true");
		toggle.setValue(value);
		switchEl.setAttribute("aria-checked", String(value));
		toggle.onChange(async (next) => {
			switchEl.setAttribute("aria-checked", String(next));
			await onChange(next);
		});
	}

	// Obsidian does not tie a row's name to its controls, so each control is named directly.
	private labelControl(el: HTMLElement, label: string): void {
		el.setAttribute("aria-label", label);
	}

	// Extra buttons are plain divs named only by their tooltip; the role and disabled state make them read as buttons.
	private describeExtraButton(button: ExtraButtonComponent, label: string): void {
		button.setTooltip(label);
		button.extraSettingsEl.setAttribute("role", "button");
		button.extraSettingsEl.setAttribute("aria-label", label);
		button.extraSettingsEl.setAttribute("aria-disabled", "false");
	}

	private setExtraButtonDisabled(button: ExtraButtonComponent, disabled: boolean): void {
		button.setDisabled(disabled);
		button.extraSettingsEl.setAttribute("aria-disabled", String(disabled));
	}

	/**
	 * Disabling a focused control drops focus to the page, so a keyboard user who started an action
	 * gets focus back on the same control once it is enabled again.
	 */
	private async keepFocusWhileBusy(el: HTMLElement, setBusy: (busy: boolean) => void, action: () => Promise<void>): Promise<void> {
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
	private bindCommitOnBlur(inputEl: HTMLInputElement | HTMLTextAreaElement, commit: () => Promise<void>, commitOnEnter: boolean): () => void {
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

	private bindCommitOnBlurOrEnter(inputEl: HTMLInputElement, commit: () => Promise<void>): () => void {
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
	private prepareFieldFeedback(setting: Setting): HTMLElement {
		const existing = setting.infoEl.querySelector<HTMLElement>(":scope > .askmate-settings-feedback");
		if (existing) {
			existing.empty();
			existing.removeClass("is-error", "is-success", "is-info");
			return existing;
		}
		return setting.infoEl.createDiv({ cls: "askmate-settings-feedback", attr: { role: "status" } });
	}

	// One line under the description for errors, results and corrections alike, so the control never shifts.
	private setFieldFeedback(setting: Setting, message: string | null, kind: FeedbackKind = "error"): void {
		const feedbackEl = setting.infoEl.querySelector<HTMLElement>(":scope > .askmate-settings-feedback") ?? this.prepareFieldFeedback(setting);
		feedbackEl.setText(message ?? "");
		feedbackEl.toggleClass("is-error", message !== null && kind === "error");
		feedbackEl.toggleClass("is-success", message !== null && kind === "success");
		feedbackEl.toggleClass("is-info", message !== null && kind === "info");
	}

	private bindIntegerInput(setting: Setting, text: TextComponent, options: IntegerInputOptions): void {
		const { bounds, label } = options;
		const range = formatIntegerRange(bounds);
		this.prepareFieldFeedback(setting);
		text.inputEl.type = "number";
		text.inputEl.min = String(bounds.min);
		text.inputEl.max = String(bounds.max);
		text.inputEl.step = "1";
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

	// Obsidian draws each row from its name and description, which also feed settings search; render adds the controls.
	// Page summaries are functions, so the entries show current values each time a page is left and the list redraws.
	getSettingDefinitions(): SettingDefinitionItem[] {
		const settings = this.plugin.settings;
		return [
			{
				type: "page",
				name: "Providers and models",
				desc: "API keys, models, reasoning effort, and image generation.",
				displayValue: () => summarizeProviderSetup(settings).displayValue,
				status: () => summarizeProviderSetup(settings).status,
				items: this.getProviderModelDefinitions()
			},
			{
				type: "page",
				name: "Request defaults",
				desc: "Sidebar layout, composer behavior, output defaults, privacy, and context budget.",
				displayValue: () => summarizeRequestDefaults(settings),
				items: this.getRequestDefaultDefinitions()
			},
			{
				type: "page",
				name: "Context sources",
				desc: "Thread history, extra notes, folders, drawings, images, evidence, style guides, and glossaries.",
				displayValue: () => summarizeContextSources(settings),
				items: this.getContextSourceDefinitions()
			},
			{
				type: "page",
				name: "Output, Apply, and review",
				desc: "Result notes, image output paths, Apply approval, frontmatter, placement, and review queue.",
				displayValue: () => summarizeOutputApply(settings, this.plugin.getPendingReviewQueueItems().length),
				items: this.getOutputApplyDefinitions()
			},
			{
				type: "page",
				name: "Workflows and automation",
				desc: "Sidebar workflow organization, custom workflows, workflow defaults, presets, and batch runs.",
				displayValue: () => summarizeWorkflows(settings),
				items: this.getWorkflowAutomationDefinitions()
			},
			{
				type: "page",
				name: "Usage and guardrails",
				desc: "Token budgets, warnings, operation statistics, charts, and reset controls.",
				displayValue: () => summarizeUsageGuardrails(settings, this.plugin.getTodayTokenUsage(), this.plugin.getMonthTokenUsage()),
				status: () => getUsageGuardrailStatus(settings, this.plugin.getTodayTokenUsage(), this.plugin.getMonthTokenUsage()),
				items: this.getUsageDefinitions()
			},
			{
				name: `AskMate ${this.plugin.manifest.version}`,
				desc: "Text providers: OpenAI, Azure OpenAI, Azure AI Foundry, OpenRouter, Anthropic Claude, Google Gemini, and OpenAI-compatible local endpoints."
			}
		];
	}

	private imperativePage(name: string, desc: string, renderPage: PageRenderer, options: ImperativePageOptions = {}): SettingDefinitionPage {
		return {
			type: "page",
			name,
			desc,
			displayValue: options.displayValue,
			page: () => new AskMateSettingsPage(name, renderPage, () => {
				this.flushPendingFieldCommits();
				options.onHide?.();
			})
		};
	}

	// Render rows rather than declarative controls, because Obsidian gives declarative controls no accessible name.
	// Rows that depend on the value use `visible`, so each change re-evaluates them with refreshDomState().
	private toggleDefinition(key: SettingControlKey, name: string, desc: string, extras: DefinitionExtras = {}): SettingDefinition {
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

	private dropdownDefinition(key: SettingControlKey, name: string, desc: string, options: Record<string, string>, extras: DefinitionExtras = {}): SettingDefinition {
		return {
			name,
			desc,
			...extras,
			render: (setting) => {
				setting.addDropdown((dropdown) => {
					this.labelControl(dropdown.selectEl, name);
					dropdown
						.addOptions(options)
						.setValue(String(this.getControlValue(key) ?? ""))
						.onChange(async (value) => {
							await this.setControlValue(key, value);
							this.refreshDomState();
						});
				});
			}
		};
	}

	private integerDefinition(name: string, desc: string, options: Omit<IntegerInputOptions, "label">, extras: DefinitionExtras = {}): SettingDefinition {
		return {
			name,
			desc,
			...extras,
			render: (setting) => {
				setting.addText((text) => this.bindIntegerInput(setting, text, { ...options, label: name }));
			}
		};
	}

	private folderPathDefinition(name: string, desc: string, options: Omit<FolderPathInputOptions, "label"> & { placeholder: string }, extras: DefinitionExtras = {}): SettingDefinition {
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
	private noteDefinition(text: string): SettingDefinition {
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

	// Only OpenAI requests carry reasoning effort: chat on OpenAI, or image prompt planning set to OpenAI.
	// Other providers are always text-capable, so planning never falls back to OpenAI behind the user's back.
	private usesOpenAIReasoning(): boolean {
		const chatProviderId = this.plugin.getSelectedTextProviderId();
		const planningProviderId = this.plugin.settings.providerRoles.imagePromptPlanningProviderId;
		return chatProviderId === "openai" || planningProviderId === "openai";
	}

	private getProviderModelDefinitions(): SettingDefinitionItem[] {
		const providerId = this.plugin.getSelectedTextProviderId();
		const provider = this.plugin.getProviderSettings(providerId);
		const providerLabel = getProviderLabel(providerId);
		const isAzureOpenAI = providerId === "azure-openai";
		const isAzureAI = providerId === "azure-ai";
		const modelLabel = isAzureOpenAI ? "Deployment" : "Model";
		// The setup list is refilled in place and shown or hidden with refreshDomState(), so a commit never rebuilds the page under the user.
		let setupList: HTMLElement | null = null;
		const fillSetupList = (): void => {
			if (!setupList) {
				return;
			}
			setupList.empty();
			for (const issue of summarizeProviderSetup(this.plugin.settings).issues) {
				setupList.createEl("li", { text: issue });
			}
		};
		const refreshSetup = (): void => {
			fillSetupList();
			this.refreshDomState();
		};
		// The model dropdown and the manual model field change each other, so both rows keep a handle on the other's control.
		let modelDropdown: DropdownComponent | null = null;
		let manualModelText: TextComponent | null = null;
		const syncModelDropdown = (): void => {
			if (!modelDropdown) {
				return;
			}
			modelDropdown.selectEl.empty();
			for (const model of provider.modelOptions) {
				modelDropdown.addOption(model, model);
			}
			modelDropdown.setValue(this.plugin.getSelectedModel());
		};

		const setupRow: SettingDefinition = {
			name: "Finish setup",
			desc: "AskMate needs these before it can send requests.",
			visible: () => summarizeProviderSetup(this.plugin.settings).issues.length > 0,
			render: (setting) => {
				setting.settingEl.addClass("askmate-settings-setup");
				setting.descEl.querySelector(":scope > .askmate-settings-setup-list")?.remove();
				setupList = setting.descEl.createEl("ul", { cls: "askmate-settings-setup-list" });
				fillSetupList();
			}
		};

		const connectionItems: SettingDefinition[] = [
			{
				name: "Chat provider",
				desc: "Choose the provider AskMate uses for text chat and workflows.",
				render: (setting) => {
					setting.addDropdown((dropdown) => {
						this.labelControl(dropdown.selectEl, "Chat provider");
						for (const id of TEXT_PROVIDER_IDS) {
							dropdown.addOption(id, getProviderLabel(id));
						}
						dropdown
							.setValue(providerId)
							.onChange(async (value) => {
								const nextProviderId = normalizeTextProviderId(value);
								this.plugin.settings.providerRoles.chatProviderId = nextProviderId;
								this.plugin.settings.selectedTextProvider = nextProviderId;
								await this.runSettingAction(() => this.saveUiSetting());
								// Key, URL and model rows depend on the provider, so the page is rebuilt.
								this.update();
							});
					});
				}
			},
			{
				name: `${providerLabel} API key`,
				desc: providerId === "openai-compatible"
					? "Optional for local servers. Stored in Obsidian SecretStorage when provided."
					: isAzureOpenAI || isAzureAI
						? "Uses API-key authentication. Stored in Obsidian SecretStorage; AskMate saves only the secret name in its settings."
						: "Stored in Obsidian SecretStorage. AskMate saves only the secret name in its settings.",
				aliases: ["secret", "token", "credentials"],
				render: (setting) => {
					setting.addComponent((el) => new SecretComponent(this.app, el)
						.setValue(provider.apiKeySecretName)
						.onChange(async (value) => {
							provider.apiKeySecretName = value;
							await this.runSettingAction(() => this.saveUiSetting());
							refreshSetup();
						}));
				}
			}
		];

		if (providerId === "openai-compatible" || isAzureOpenAI || isAzureAI) {
			const baseUrlFallback = DEFAULT_PROVIDER_SETTINGS[providerId].baseUrl;
			const baseUrlName = isAzureOpenAI ? "Azure OpenAI base URL" : isAzureAI ? "Azure AI Foundry endpoint" : "Local or self-hosted base URL";
			connectionItems.push({
				name: baseUrlName,
				desc: isAzureOpenAI
					? "Use the v1 base URL, for example https://<resource>.openai.azure.com/openai/v1."
					: isAzureAI
						? "Use the Azure AI inference endpoint, for example https://<resource>.services.ai.azure.com/models. AskMate adds /models when it is omitted."
						: "OpenAI-compatible endpoint, for example Ollama at http://localhost:11434/v1 or a self-hosted server.",
				render: (setting) => {
					this.prepareFieldFeedback(setting);
					setting.addText((text) => {
						this.labelControl(text.inputEl, baseUrlName);
						text
							.setPlaceholder(isAzureOpenAI
								? "https://<resource>.openai.azure.com/openai/v1"
								: isAzureAI
									? "https://<resource>.services.ai.azure.com/models"
									: DEFAULT_LOCAL_BASE_URL)
							.setValue(provider.baseUrl);
						// Validating per keystroke saved half-typed URLs, so commit only when editing ends.
						this.bindCommitOnBlurOrEnter(text.inputEl, async () => {
							const result = resolveBaseUrlInput(text.getValue(), baseUrlFallback, (value, fallback) => isAzureOpenAI
								? validateAzureOpenAIBaseUrl(value, fallback)
								: validateProviderBaseUrl(value, fallback, providerLabel));
							if (result.kind === "invalid") {
								this.setFieldFeedback(setting, `${result.message} The previous URL is still saved.`);
								return;
							}

							text.setValue(result.value);
							if (result.kind === "restore-default") {
								this.setFieldFeedback(setting, result.value
									? `Field cleared, so AskMate restored the default: ${result.value}`
									: "Field cleared. Requests will fail until you enter a URL.", result.value ? "info" : "error");
							} else {
								this.setFieldFeedback(setting, null);
							}
							if (result.value === provider.baseUrl) {
								return;
							}
							provider.baseUrl = result.value;
							await this.saveUiSetting();
							refreshSetup();
						});
					});
				}
			});
		}

		connectionItems.push({
			name: "Test connection",
			desc: isAzureOpenAI
				? "Sends a minimal text request to the selected Azure deployment. This may consume a small number of tokens. Times out after 10 seconds."
				: isAzureAI
					? "Sends a minimal text request to the selected Azure AI Foundry model. This may consume a small number of tokens. Times out after 10 seconds."
					: "Checks whether the selected provider can list models. Times out after 10 seconds.",
			render: (setting) => {
				this.prepareFieldFeedback(setting);
				setting.addButton((button) => {
					button.setButtonText("Test connection").onClick(() => {
						void this.keepFocusWhileBusy(button.buttonEl, (busy) => {
							button.setButtonText(busy ? "Testing..." : "Test connection").setDisabled(busy);
						}, async () => {
							this.setFieldFeedback(setting, null);
							try {
								this.setFieldFeedback(setting, await this.plugin.testSelectedProviderConnection(), "success");
							} catch (error) {
								this.setFieldFeedback(setting, this.plugin.getErrorMessage(error));
							}
						});
					});
				});
			}
		});

		const modelItems: SettingDefinition[] = [
			{
				name: modelLabel,
				desc: providerId === "openai"
					? "Choose any model ID returned by the OpenAI Models API. Text chat requires a model that supports the Responses API."
					: isAzureOpenAI
						? "Choose a saved Azure OpenAI deployment for text chat, workflows, and image prompt planning. Add deployments by typing their names below."
						: isAzureAI
							? "Choose the Azure AI Foundry model or deployment used for text chat, workflows, and image prompt planning. Use the refresh button for best-effort model info."
							: "Choose the selected provider model for text chat, workflows, and image prompt planning. Use the refresh button to load the models the provider offers.",
				render: (setting) => {
					this.prepareFieldFeedback(setting);
					setting.addDropdown((dropdown) => {
						modelDropdown = dropdown;
						this.labelControl(dropdown.selectEl, modelLabel);
						syncModelDropdown();
						dropdown.onChange(async (value) => {
							provider.model = value;
							manualModelText?.setValue(value);
							await this.runSettingAction(() => this.saveUiSetting());
							refreshSetup();
						});
					});
					// Azure OpenAI deployments cannot be listed with an API key, so a refresh button would only ever fail.
					if (isAzureOpenAI) {
						return;
					}
					setting.addExtraButton((button) => {
						this.describeExtraButton(button.setIcon("refresh-cw"), "Refresh models");
						button.onClick(() => {
							void this.refreshProviderModels(setting, button, () => {
								syncModelDropdown();
								manualModelText?.setValue(provider.model);
								refreshSetup();
							});
						});
					});
				}
			},
			{
				name: isAzureOpenAI ? "Manual deployment name" : isAzureAI ? "Manual model or deployment name" : "Manual model ID",
				desc: isAzureOpenAI
					? "Type your Azure OpenAI deployment name exactly as it appears in Azure AI Foundry. Deployments cannot be listed with an API key, so AskMate does not offer a refresh for this provider."
					: isAzureAI
						? "Enter your Azure AI Foundry model or deployment name. Model refresh may not list every deployment."
						: "Use this when a provider supports a model that is not returned by model refresh.",
				render: (setting) => {
					this.prepareFieldFeedback(setting);
					setting.addText((text) => {
						manualModelText = text;
						this.labelControl(text.inputEl, isAzureOpenAI ? "Manual deployment name" : "Manual model ID");
						text
							.setPlaceholder(isAzureOpenAI ? "my-gpt-deployment" : DEFAULT_PROVIDER_SETTINGS[providerId].model)
							.setValue(provider.model);
						this.bindCommitOnBlurOrEnter(text.inputEl, async () => {
							const model = text.getValue().trim();
							if (!model) {
								text.setValue(provider.model);
								this.setFieldFeedback(setting, provider.model
									? `Enter ${isAzureOpenAI ? "a deployment name" : "a model ID"}. AskMate kept ${provider.model}.`
									: `Enter ${isAzureOpenAI ? "a deployment name" : "a model ID"}.`, "info");
								return;
							}
							this.setFieldFeedback(setting, null);
							if (model === provider.model) {
								return;
							}
							provider.model = model;
							provider.modelOptions = normalizeProviderModelOptions(provider.modelOptions, DEFAULT_PROVIDER_SETTINGS[providerId].modelOptions, model);
							await this.saveUiSetting();
							syncModelDropdown();
							refreshSetup();
						});
					});
				}
			},
			this.dropdownDefinition(
				"reasoningEffort",
				"Reasoning effort",
				"How much reasoning OpenAI models use before answering, including image prompt planning on OpenAI. AskMate leaves it out for models that do not support the selected level.",
				Object.fromEntries(REASONING_EFFORT_OPTIONS.map((option) => [option.value, option.label])),
				{ visible: () => this.usesOpenAIReasoning() }
			)
		];

		const imageItems: SettingDefinition[] = [
			this.noteDefinition("Images are always generated with OpenAI gpt-image-2, whichever chat provider you use. It may require OpenAI organization verification.")
		];
		if (providerId !== "openai") {
			imageItems.push({
				name: "OpenAI image API key",
				desc: "Add an OpenAI key to use the Image button or the /image command.",
				render: (setting) => {
					setting.addComponent((el) => new SecretComponent(this.app, el)
						.setValue(this.plugin.getProviderSettings("openai").apiKeySecretName)
						.onChange(async (value) => {
							this.plugin.getProviderSettings("openai").apiKeySecretName = value;
							await this.runSettingAction(() => this.saveUiSetting());
						}));
				}
			});
		}
		imageItems.push(this.dropdownDefinition(
			"imagePromptPlanningProviderId",
			"Image prompt planning provider",
			"Text provider that improves image prompts before generation.",
			{
				"same-as-chat": "Same as chat provider",
				...Object.fromEntries(TEXT_PROVIDER_IDS.map((id) => [id, getProviderLabel(id)]))
			}
		));

		return [
			setupRow,
			{ type: "group", heading: "Connection", items: connectionItems },
			{ type: "group", heading: "Model", items: modelItems },
			{ type: "group", heading: "Image generation", items: imageItems }
		];
	}

	private async refreshProviderModels(setting: Setting, button: ExtraButtonComponent, onRefreshed: () => void): Promise<void> {
		await this.keepFocusWhileBusy(button.extraSettingsEl, (busy) => this.setExtraButtonDisabled(button, busy), async () => {
			this.setFieldFeedback(setting, null);
			try {
				const models = await this.plugin.refreshSelectedProviderModels();
				onRefreshed();
				this.setFieldFeedback(setting, `Loaded ${pluralise(models.length, "model")}.`, "success");
			} catch (error) {
				this.setFieldFeedback(setting, this.plugin.getErrorMessage(error));
			}
		});
	}

	private getRequestDefaultDefinitions(): SettingDefinitionItem[] {
		const contextBudgetSummary = CONTEXT_BUDGET_OPTIONS
			.map((option) => option.maxCharacters === null
				? `${option.label} sends the whole note`
				: `${option.label} up to ${option.maxCharacters.toLocaleString("en-GB")} characters`)
			.join(", ");
		return [
			{
				type: "group",
				heading: "Sidebar and composer",
				items: [
					this.dropdownDefinition(
						"composerLayout",
						"Sidebar layout",
						"Console is keyboard-first and monospaced (type /help for commands). Compact is denser. Expanded gives the composer more room.",
						{ console: "Console", compact: "Compact", expanded: "Expanded" },
						{ aliases: ["console", "compact", "expanded", "composer"] }
					),
					this.dropdownDefinition(
						"sendShortcut",
						"Send shortcut",
						"Choose how the composer sends messages. When Enter sends, use Shift+Enter to insert a newline.",
						{ enter: "Enter sends", "ctrl-enter": "Ctrl/Cmd+Enter sends" }
					),
					this.toggleDefinition(
						"showRequestPreview",
						"Show request preview",
						"Shows source, context size, provider, output mode, and privacy controls in the sidebar composer."
					),
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
					}
				]
			},
			{
				type: "group",
				heading: "Responses",
				items: [
					this.dropdownDefinition(
						"outputMode",
						"Default output",
						"Choose whether responses stay in the sidebar, become new notes, or apply to the captured Markdown note or selection.",
						{ chat: "Show in sidebar chat", note: "Create new note", apply: "Apply to captured note or selection" }
					),
					this.toggleDefinition(
						"autoImageIntentEnabled",
						"Detect image requests automatically",
						"Treat questions that start with an image request, such as \"Draw me a cat\", as image generation. When off, AskMate answers in text; the /image command and Image button always generate images."
					)
				]
			},
			{
				type: "group",
				heading: "Privacy and context",
				items: [
					this.toggleDefinition(
						"includeNoteContext",
						"Include note and attached context by default",
						"Include the captured note and its attachments in new requests. When off, the note's path and title are withheld too. You can override this per request."
					),
					this.toggleDefinition(
						"includeImageReferences",
						"Include image references by default",
						"Include Markdown image references in new requests. You can override this per request."
					),
					this.dropdownDefinition(
						"contextBudgetMode",
						"Default context budget",
						`How much of the note AskMate sends by default. ${contextBudgetSummary}.`,
						Object.fromEntries(CONTEXT_BUDGET_OPTIONS.map((option) => [option.value, option.label]))
					)
				]
			}
		];
	}

	private getContextSourceDefinitions(): SettingDefinitionItem[] {
		const settings = this.plugin.settings;
		return [
			{
				type: "group",
				heading: "Conversation",
				items: [
					this.toggleDefinition(
						"threadedChatEnabled",
						"Threaded chat mode",
						"Send recent AskMate user and assistant turns as extra context for follow-up requests."
					),
					this.integerDefinition(
						"Threaded chat turns",
						`How many recent turns threaded chat sends (${formatIntegerRange(THREADED_CHAT_MAX_TURNS_BOUNDS)}).`,
						{
							bounds: THREADED_CHAT_MAX_TURNS_BOUNDS,
							getValue: () => settings.threadedChatMaxTurns,
							setValue: (value) => {
								settings.threadedChatMaxTurns = value;
							}
						},
						{ visible: () => settings.threadedChatEnabled }
					),
					this.toggleDefinition(
						"noteHistoryEnabled",
						"Store note-specific history",
						"Keep successful AskMate turns for each source note. Turn this off to stop recording new turns."
					),
					this.toggleDefinition(
						"noteHistoryIncludeInContext",
						"Include note history in context",
						"Send the stored AskMate history for the source note as context with future requests.",
						{ visible: () => settings.noteHistoryEnabled }
					)
				]
			},
			{
				type: "group",
				heading: "Extra notes and folders",
				items: [
					{
						name: "Default additional note paths",
						desc: "Optional explicit multi-note context. Enter one Markdown path or wikilink per line. Sidebar preview can override this per request.",
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
						`Hard cap across additional notes before the normal request context budget is applied (${formatIntegerRange(ADDITIONAL_CONTEXT_MAX_CHARACTERS_BOUNDS)} characters).`,
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
						"Send Markdown notes from one folder as context. It is off by default and bounded by file and character limits."
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
						`Maximum notes read from the folder (${formatIntegerRange(FOLDER_CONTEXT_MAX_FILES_BOUNDS)}).`,
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
						`Maximum characters read from the folder before the normal request context budget is applied (${formatIntegerRange(FOLDER_CONTEXT_MAX_CHARACTERS_BOUNDS)}).`,
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
						"Extract readable text and embedded references from Excalidraw files as text context. This is not pixel-level visual analysis."
					),
					this.integerDefinition(
						"Excalidraw character limit",
						`Maximum characters taken from each drawing (${formatIntegerRange(EXCALIDRAW_SUMMARY_MAX_CHARACTERS_BOUNDS)}).`,
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
						"Include image paths, labels, extensions, file sizes, and reference lines as metadata context when image references are allowed. This does not send image pixels."
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
						"Ask text models to cite evidence sources like [S1], then show jump-to-source actions on cited replies."
					),
					this.integerDefinition(
						"Evidence source limit",
						`Maximum evidence sources offered to the model (${formatIntegerRange(EVIDENCE_MAX_SOURCES_BOUNDS)}).`,
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
						"Pin a Markdown note as a persistent style guide context attachment."
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
						"Pin a Markdown note as a persistent glossary or terminology context attachment."
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

	private notePathDefinition(name: string, getValue: () => string, setValue: (value: string) => void, extras: DefinitionExtras): SettingDefinition {
		return {
			name,
			desc: "Type a path to browse notes folder by folder, or enter a wikilink.",
			...extras,
			render: (setting) => {
				setting.addText((text) => {
					text.setPlaceholder("Path or wikilink").setValue(getValue()).onChange((value) => {
						setValue(normalizeOptionalString(value, MAX_CONTEXT_PATH_LENGTH));
						this.scheduleSave();
					});
					this.labelControl(text.inputEl, name);
					// A picked note is a finished edit, so it saves at once instead of waiting for the typing delay.
					attachMarkdownFileSuggest(this.app, text.inputEl, () => this.debouncedSave.run());
				});
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
				const bindField = (component: TextComponent | TextAreaComponent): void => {
					field = component;
					this.labelControl(component.inputEl, name);
					component.setValue(options.getValue()).onChange((value) => {
						options.setValue(normalizeTemplateString(value, options.defaultValue));
						if (restoreButton) {
							this.setExtraButtonDisabled(restoreButton, isDefault());
						}
						this.setFieldFeedback(setting, null);
						this.scheduleSave();
					});
					// An empty template is saved as the default, so the field shows what was kept once editing ends.
					component.inputEl.addEventListener("blur", () => {
						if (!component.getValue().trim() && options.getValue() === options.defaultValue) {
							component.setValue(options.defaultValue);
							this.setFieldFeedback(setting, "Empty template replaced with the default.", "info");
						}
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
							if (!(await askMateConfirm(this.app, `Restore the default ${name.toLowerCase()}? Your current version will be replaced.`))) {
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
					this.folderPathDefinition(
						"Result folder",
						"Folder for notes created by AskMate.",
						{
							placeholder: DEFAULT_SETTINGS.resultFolder,
							getValue: () => settings.resultFolder,
							setValue: (value) => {
								settings.resultFolder = value;
							}
						}
					),
					this.toggleDefinition(
						"smartResultPlacementEnabled",
						"Place result notes beside the source note",
						"Create result notes in an AskMate subfolder next to the source note instead of the result folder."
					),
					this.toggleDefinition(
						"appendResultBacklinkToSource",
						"Link result notes from the source note",
						"Append a link to each new result note at the end of its source note."
					),
					this.templateDefinition(
						"Result note template",
						"Markdown template for text result notes. Variables include {{title}}, {{sourceLink}}, {{providerName}}, {{model}}, {{request}}, and {{response}}.",
						{
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
						"Markdown template for generated image notes. Variables include {{imageEmbed}}, {{imagePrompt}}, {{revisedPromptSection}}, and {{planningModel}}.",
						{
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
						"Folder template for generated PNG files. Use {{resultFolder}}, {{date}}, {{noteTitle}}, or {{workflowName}}.",
						{
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
						"Base file name template for generated PNG files. AskMate still adds a timestamp and resolves duplicates.",
						{
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
				heading: "Apply",
				items: [
					this.dropdownDefinition(
						"applyApprovalMode",
						"Apply approval mode",
						"Controls when AskMate shows a diff before writing generated text into a note. Auto approve confirms only full-note replacement, Full also confirms heading-section replacement, and Manual confirms every write. Truncated-context, frontmatter, captured-file, and exact-match safeguards apply in every mode.",
						{ "auto-approve": "Auto approve", full: "Full", manual: "Manual" },
						{ aliases: ["preview", "confirm", "diff"] }
					),
					this.dropdownDefinition(
						"partialApplyDefaultScope",
						"Default partial Apply scope",
						"Auto replaces captured selected text, otherwise appends to the captured note. Append to note never replaces text. Choose full-note replacement only for intentional whole-note rewrites.",
						{ auto: "Auto", append: "Append to note", "selected-block": "Selected block", "heading-section": "Heading section", "full-note": "Full note replacement" }
					),
					this.dropdownDefinition(
						"frontmatterApplyPolicy",
						"Frontmatter Apply handling",
						"Controls how full-note Apply handles YAML frontmatter.",
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
						`Limits how many items the queue keeps (${formatIntegerRange(REVIEW_QUEUE_MAX_ITEMS_BOUNDS)}). Lowering it removes older applied or dismissed items; pending items are never discarded, and new items cannot be queued while the pending count is at the limit.`,
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
				heading: "Sidebar",
				items: [
					{
						type: "page",
						name: "Workflow sidebar",
						desc: "Favorite, hide, or reorder workflows in the sidebar. Built-in command palette workflows are not changed.",
						displayValue: () => `${this.plugin.getVisibleWorkflows().length.toLocaleString("en-GB")} of ${this.plugin.getAllWorkflows().length.toLocaleString("en-GB")} shown`,
						items: this.getWorkflowSidebarDefinitions()
					},
					{
						type: "page",
						name: "Custom workflows",
						desc: "Create and edit your own sidebar workflows, and export or import workflow presets.",
						displayValue: () => pluralise(this.plugin.settings.customWorkflows.length, "workflow"),
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
						desc: "Optional preferences added to every workflow, built-in and custom. Custom workflows can choose where they go with {{customInstructions}}; otherwise they are appended at the end.",
						render: (setting) => {
							setting.addTextArea((text) => {
								text.inputEl.rows = 4;
								text.inputEl.addClass("askmate-settings-prompt-input");
								this.labelControl(text.inputEl, "Workflow custom instructions");
								text
									.setValue(this.plugin.settings.workflowCustomInstructions)
									.onChange((value) => {
										this.plugin.settings.workflowCustomInstructions = normalizeOptionalString(value, MAX_WORKFLOW_CUSTOM_INSTRUCTIONS_LENGTH);
										this.scheduleSave();
									});
							});
						}
					},
					{
						name: "Translation target language",
						desc: "Language used by Translate Preserve (default: Persian). Enter a language name such as German, Brazilian Portuguese, or فارسی.",
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
		return [
			this.noteDefinition("Drag a row by its handle, or focus a row and press Alt+Up or Alt+Down, to change the order. Favorites always appear first. Hidden built-in workflows stay available from the command palette."),
			{
				type: "list",
				heading: "Sidebar order",
				onReorder: (fromIndex, toIndex) => {
					// Favorites re-sort to the top and row descriptions change, so the list is rebuilt from the new order.
					this.applyWorkflowDisplayChange(this.plugin.reorderWorkflowDisplay(fromIndex, toIndex));
				},
				items: workflows.map((workflow, index) => this.workflowSidebarRow(workflow, labels[index] ?? workflow.name))
			}
		];
	}

	private workflowSidebarRow(workflow: Workflow, label: string): SettingDefinition {
		const preference = this.plugin.getWorkflowDisplayPreference(workflow.id);
		const customWorkflow = workflow.isCustom
			? this.plugin.settings.customWorkflows.find((item) => item.id === workflow.id)
			: undefined;
		const isFavorite = Boolean(preference?.favorite);
		const isHidden = Boolean(preference?.hidden) || Boolean(customWorkflow?.hidden);
		return {
			name: label,
			desc: [workflow.isCustom ? "Custom" : "Built-in", isFavorite ? "Favorite" : null, isHidden ? "Hidden" : null]
				.filter((part): part is string => part !== null)
				.join(" · "),
			render: (setting) => {
				setting.settingEl.toggleClass("askmate-workflow-row-hidden", isHidden);
				setting.addExtraButton((button) => {
					this.describeExtraButton(button.setIcon("star"), isFavorite ? `Remove ${workflow.name} from favorites` : `Add ${workflow.name} to favorites`);
					button.extraSettingsEl.setAttribute("aria-pressed", String(isFavorite));
					button.onClick(() => {
						this.applyWorkflowDisplayChange(this.plugin.updateWorkflowDisplayPreference(workflow.id, { favorite: !isFavorite }));
					});
					button.extraSettingsEl.addClass("askmate-workflow-favorite");
					button.extraSettingsEl.toggleClass("is-active", isFavorite);
				});
				setting.addExtraButton((button) => {
					this.describeExtraButton(button.setIcon(isHidden ? "eye-off" : "eye"), isHidden ? `Show ${workflow.name} in the sidebar` : `Hide ${workflow.name} from the sidebar`);
					button.onClick(() => {
						// Both updates mutate settings before their first await, and saves are chained, so they can start together.
						this.applyWorkflowDisplayChange(Promise.all([
							workflow.isCustom ? this.plugin.updateCustomWorkflow(workflow.id, { hidden: !isHidden }) : Promise.resolve(),
							this.plugin.updateWorkflowDisplayPreference(workflow.id, { hidden: !isHidden })
						]));
					});
				});
			}
		};
	}

	/**
	 * Takes a change that has already mutated settings synchronously and is now saving. The list is rebuilt at once,
	 * because Obsidian moves focus to the new row position straight after a keyboard reorder.
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
			{
				type: "list",
				heading: "Your workflows",
				emptyState: "No custom workflows yet.",
				addItem: {
					name: "Add workflow",
					action: () => {
						void this.runSettingAction(() => this.plugin.addCustomWorkflow()).then(() => this.update());
					}
				},
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
						desc: "Show your custom workflows as JSON you can copy and share.",
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
						desc: "Paste an AskMate workflow preset export, then select Import. Imported workflows are added and never replace existing ones.",
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
		if (!workflow || !(await askMateConfirm(this.app, `Delete custom workflow "${workflow.name}"?`))) {
			return;
		}

		await this.runSettingAction(() => this.plugin.deleteCustomWorkflow(workflow.id));
		this.update();
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
				setting
					.setName("Prompt")
					.setDesc("Use outcome-first instructions. AskMate will provide the current note or selection as context.")
					.addTextArea((text) => {
						text.inputEl.rows = 8;
						text.inputEl.addClass("askmate-settings-prompt-input");
						this.labelControl(text.inputEl, "Prompt");
						text.setValue(workflow.prompt);
						this.bindCustomWorkflowField(workflow.id, text.inputEl, "prompt", false);
					});
			})
			.addSetting((setting) => {
				setting
					.setName("Output kind")
					.setDesc("Revised note: the output is a full revised version of the note and may replace it, for example in batch review. New content: summaries, analysis, or other new material that is appended or saved as a note.")
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
				setting
					.setName("Result note template")
					.setDesc("Optional per-workflow Markdown template. Leave empty to use the global result note template.")
					.addTextArea((text) => {
						text.inputEl.rows = 6;
						text.inputEl.addClass("askmate-settings-template-input");
						this.labelControl(text.inputEl, "Result note template");
						text.setValue(workflow.resultNoteTemplate);
						this.bindCustomWorkflowField(workflow.id, text.inputEl, "resultNoteTemplate", false, (value) => normalizeTemplateString(value, ""));
					});
			});

		const isHidden = workflow.hidden || Boolean(this.plugin.getWorkflowDisplayPreference(workflow.id)?.hidden);
		new SettingGroup(containerEl)
			.setHeading("Manage")
			.addSetting((setting) => {
				setting
					.setName("Hide from sidebar")
					.setDesc("Hide this workflow from the sidebar without deleting it. Its command palette entry and hotkey keep working.")
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
					.setDesc("Removes this workflow, its sidebar button, and its command. This cannot be undone.")
					.addButton((button) => {
						this.labelControl(button.buttonEl, "Delete this workflow");
						button.setButtonText("Delete").setDestructive().onClick(() => {
							void this.runSettingAction(async () => {
								const currentName = this.plugin.settings.customWorkflows.find((item) => item.id === workflow.id)?.name ?? workflow.name;
								if (!(await askMateConfirm(this.app, `Delete custom workflow "${currentName}"?`))) {
									return;
								}
								// Uncommitted edits on this page still flush on hide, but find no workflow and save nothing.
								await this.plugin.deleteCustomWorkflow(workflow.id);
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
				heading: "Guardrails",
				items: [
					this.toggleDefinition(
						"usageGuardrailsEnabled",
						"Usage budgets and guardrails",
						"Warn or block requests before they use a large context or exceed daily or monthly token budgets."
					),
					this.dropdownDefinition(
						"usageBudgetEnforcement",
						"Budget enforcement",
						"Choose whether going over a daily or monthly budget shows a warning or blocks the request. The per-request hard limit always blocks.",
						{ warn: "Warn", block: "Block" },
						{ visible: guardrailsOn }
					),
					this.integerDefinition(
						"Daily token budget",
						`Tokens per local calendar day (${formatIntegerRange(DAILY_TOKEN_BUDGET_BOUNDS)}). Use 0 for no daily limit. Values are estimated before sending and recorded after completion.`,
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
						`Tokens per calendar month (${formatIntegerRange(MONTHLY_TOKEN_BUDGET_BOUNDS)}). Use 0 for no monthly limit.`,
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
						`Warn when a request is estimated above this many input tokens (${formatIntegerRange(PER_REQUEST_TOKEN_BOUNDS)}). Use 0 to turn off.`,
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
						`Block requests estimated above this many input tokens (${formatIntegerRange(PER_REQUEST_TOKEN_BOUNDS)}). Use 0 to turn off.`,
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
			this.imperativePage(
				"Usage statistics",
				"Budgets, operation counts, token charts, recent operations, and a reset control.",
				(containerEl, refresh) => this.renderUsageStatisticsPage(containerEl, refresh),
				{ displayValue: () => pluralise(this.plugin.getTokenUsageRecords().length, "operation") }
			)
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
				for (const workflow of this.plugin.getAllWorkflows()) {
					dropdown.addOption(workflow.id, workflow.name);
				}
				this.labelControl(dropdown.selectEl, "Batch workflow");
				dropdown.setValue(this.plugin.settings.batchWorkflowId).onChange((value) => {
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
			.onClick(() => {
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
		queue.createEl("p", {
			cls: "askmate-settings-note",
			text: `${pluralise(pending.length, "pending AI-suggested note change")} (limit ${this.plugin.settings.reviewQueueMaxItems.toLocaleString("en-GB")}).`
		});
		if (pending.length === 0) {
			queue.createDiv({ cls: "askmate-usage-empty", text: "No queued reviews yet." });
			return;
		}
		for (const item of pending.slice().reverse()) {
			const card = queue.createDiv({ cls: "askmate-review-item" });
			card.createDiv({ cls: "askmate-review-item-meta", text: `${formatUsageTimestamp(item.createdAt)} · ${item.sourcePath} · ${item.workflowName ?? item.title}` });
			card.createDiv({ cls: "askmate-review-excerpt", text: truncateLabel(item.proposedText, 360) });
			const actions = card.createDiv({ cls: "askmate-review-item-actions" });
			// Every card repeats the same three buttons, so each name says which note it acts on.
			const apply = actions.createEl("button", { cls: "mod-cta", text: "Apply", attr: { "aria-label": `Apply change to ${item.sourcePath}` } });
			apply.type = "button";
			apply.addEventListener("click", () => {
				apply.disabled = true;
				dismiss.disabled = true;
				void this.plugin.applyReviewQueueItem(item.id).then((message) => {
					new Notice(message);
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
		if (!(await askMateConfirm(this.app, "Reset AskMate usage statistics? This cannot be undone."))) {
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
