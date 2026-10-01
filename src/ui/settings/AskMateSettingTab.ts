import { ButtonComponent, debounce, Notice, PluginSettingTab, SecretComponent, Setting, setIcon, type App, type TextComponent, type ToggleComponent } from "obsidian";
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
	formatApiEndpoint,
	formatDuration,
	formatOperationKind,
	formatOperationStatus,
	formatOutputMode,
	formatTokenCount,
	formatUsageTimestamp,
	getProviderLabel,
	MAX_CONTEXT_PATH_LENGTH,
	MAX_WORKFLOW_CUSTOM_INSTRUCTIONS_LENGTH,
	normalizeApplyApprovalMode,
	normalizeApplyScope,
	normalizeBatchWorkflowOutputMode,
	normalizeBudgetEnforcementMode,
	normalizeComposerLayout,
	normalizeContextBudgetMode,
	normalizeContextPathList,
	normalizeFrontmatterApplyPolicy,
	normalizeImagePromptPlanningProviderId,
	normalizeOptionalString,
	normalizeProviderModelOptions,
	normalizeSendShortcut,
	normalizeTemplateString,
	normalizeTextProviderId,
	normalizeTranslationTargetLanguage,
	normalizeWorkflowAccent,
	OutputMode,
	REASONING_EFFORT_OPTIONS,
	RECENT_TOKEN_BAR_RECORD_LIMIT,
	RECENT_TOKEN_TABLE_RECORD_LIMIT,
	TEXT_PROVIDER_IDS,
	TOKEN_RUN_CHART_RECORD_LIMIT,
	TokenUsageRecord,
	TokenUsageSummary,
	truncateLabel,
	validateAzureOpenAIBaseUrl,
	validateProviderBaseUrl,
	WORKFLOW_ACCENTS,
	type CustomWorkflow,
	type WorkflowOutputKind
} from "../../shared/core";
import { AskMateTextViewerModal, askMateConfirm } from "../modals/modals";
import { formatIntegerRange, resolveBaseUrlInput, resolveFolderPathInput, resolveIntegerInput, type IntegerBounds } from "./settingsInputs";

type SettingsSectionId = "providers" | "request" | "context" | "output" | "workflows" | "usage";

interface SettingsSectionDefinition {
	id: SettingsSectionId;
	title: string;
	description: string;
	icon: string;
	defaultOpen: boolean;
	render: (containerEl: HTMLElement) => void;
}

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

interface ActiveBatchState {
	controller: AbortController;
	message: string;
	percent: number;
}

interface BatchRunnerElements {
	progress: HTMLElement;
	fill: HTMLElement;
	runButton: ButtonComponent;
	cancelButton: ButtonComponent;
}

type CustomWorkflowTextField = "name" | "shortName" | "description" | "icon" | "prompt" | "resultNoteTemplate";

const TEXT_SAVE_DELAY_MS = 600;

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

export class AskMateSettingTab extends PluginSettingTab {
	private readonly plugin: AskMatePlugin;
	private readonly expandedSettingsSections = new Set<SettingsSectionId>();
	private readonly settingsSectionElements = new Map<SettingsSectionId, HTMLDetailsElement>();
	private hasInitializedSettingsSectionState = false;
	// The tab instance outlives each render, so a running batch keeps its cancel handle and progress across display().
	private activeBatch: ActiveBatchState | null = null;
	private batchElements: BatchRunnerElements | null = null;

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

	// The visible container is not what receives keyboard focus; the checkbox inside it is, so that element carries the name.
	private labelToggle(toggle: ToggleComponent, label: string): void {
		const focusTarget = toggle.toggleEl.querySelector("input") ?? toggle.toggleEl;
		focusTarget.setAttribute("aria-label", label);
	}

	// Re-rendering after failures too shows the state that was actually kept rather than the one the control displays.
	private runSettingActionAndRender(action: () => Promise<void>): void {
		void this.runSettingAction(action).then(() => this.display());
	}

	private bindCommitOnBlurOrEnter(inputEl: HTMLInputElement, commit: () => Promise<void>): void {
		const run = (): void => {
			void this.runSettingAction(commit);
		};
		inputEl.addEventListener("blur", run);
		inputEl.addEventListener("keydown", (event) => {
			if (event.key === "Enter") {
				event.preventDefault();
				run();
			}
		});
	}

	private bindIntegerInput(text: TextComponent, options: IntegerInputOptions): void {
		const { bounds, label } = options;
		const range = formatIntegerRange(bounds);
		text.inputEl.type = "number";
		text.inputEl.min = String(bounds.min);
		text.inputEl.max = String(bounds.max);
		text.inputEl.step = "1";
		text.inputEl.setAttribute("aria-label", `${label} (${range})`);
		text.setPlaceholder(label).setValue(String(options.getValue()));
		this.bindCommitOnBlurOrEnter(text.inputEl, async () => {
			const current = options.getValue();
			const result = resolveIntegerInput(text.getValue(), bounds);
			if (result.kind === "ignored") {
				text.setValue(String(current));
				return;
			}

			text.setValue(String(result.value));
			if (result.clamped) {
				new Notice(`${label} must be ${range}. AskMate saved ${result.value.toLocaleString("en-GB")}.`);
			}
			if (result.value === current) {
				return;
			}
			options.setValue(result.value);
			// Budgets and limits feed the sidebar request preview, which must not keep showing an old blocker.
			await this.saveUiSetting();
		});
	}

	// "." and ".." segments are refused here, because the save-time normaliser would otherwise replace them without telling the user.
	private bindFolderPathInput(text: TextComponent, options: FolderPathInputOptions): void {
		text.setValue(options.getValue());
		this.bindCommitOnBlurOrEnter(text.inputEl, async () => {
			const current = options.getValue();
			const result = resolveFolderPathInput(text.getValue());
			if (result.kind === "unsafe") {
				new Notice(`${options.label} cannot contain "." or ".." segments. AskMate kept the previous value${current ? `: ${current}` : ""}.`);
				text.setValue(current);
				return;
			}

			text.setValue(result.value);
			if (result.value === current) {
				return;
			}
			options.setValue(result.value);
			await this.saveUiSetting();
		});
	}

	// Blurring commits fields that save on blur (base URLs, limits, folders, workflow fields); their in-memory update is synchronous.
	private commitFocusedField(): void {
		const activeEl = this.containerEl.ownerDocument.activeElement;
		if (activeEl instanceof HTMLElement && this.containerEl.contains(activeEl)) {
			activeEl.blur();
		}
	}

	hide(): void {
		this.commitFocusedField();
		this.debouncedSave.run();
		// Debounced text settings save without refreshing, so open sidebars catch up once when settings close.
		this.plugin.refreshOpenAskMateViews();
		super.hide();
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.addClass("askmate-settings-tab");
		this.settingsSectionElements.clear();

		const sections = this.getSettingsSections();
		this.ensureDefaultSettingsSectionsOpen(sections);
		this.renderSettingsNavigation(containerEl, sections);

		const sectionsEl = containerEl.createDiv({ cls: "askmate-settings-sections" });
		for (const section of sections) {
			this.renderSettingsSection(sectionsEl, section);
		}

		containerEl.createEl("p", {
			cls: "askmate-settings-note",
			text: `AskMate ${this.plugin.manifest.version}. Text providers support OpenAI, Azure OpenAI, Azure AI Foundry, OpenRouter, Anthropic Claude, Google Gemini, and OpenAI-compatible local endpoints. Image generation still uses OpenAI gpt-image-2 and may require OpenAI organization verification.`
		});
	}

	private getSettingsSections(): SettingsSectionDefinition[] {
		return [
			{
				id: "providers",
				title: "Providers and models",
				description: "API keys, provider routing, model selection, and reasoning effort.",
				icon: "plug",
				defaultOpen: true,
				render: (containerEl) => this.renderProviderModelSettings(containerEl)
			},
			{
				id: "request",
				title: "Request defaults",
				description: "Composer behavior, output defaults, preview, privacy, and context budget.",
				icon: "sliders-horizontal",
				defaultOpen: true,
				render: (containerEl) => this.renderRequestDefaultSettings(containerEl)
			},
			{
				id: "context",
				title: "Context sources",
				description: "Thread history, extra notes, folders, drawings, images, evidence, style guides, and glossaries.",
				icon: "layers-3",
				defaultOpen: false,
				render: (containerEl) => this.renderContextSourceSettings(containerEl)
			},
			{
				id: "output",
				title: "Output, Apply, and review",
				description: "Result notes, image output paths, Apply preview, frontmatter, placement, and review queue.",
				icon: "file-check-2",
				defaultOpen: false,
				render: (containerEl) => this.renderOutputApplySettings(containerEl)
			},
			{
				id: "workflows",
				title: "Workflows and automation",
				description: "Sidebar workflow organization, custom workflows, presets, and batch runs.",
				icon: "workflow",
				defaultOpen: false,
				render: (containerEl) => this.renderWorkflowAutomationSettings(containerEl)
			},
			{
				id: "usage",
				title: "Usage and guardrails",
				description: "Token budgets, warnings, operation statistics, charts, and reset controls.",
				icon: "bar-chart-3",
				defaultOpen: false,
				render: (containerEl) => this.renderUsageStatistics(containerEl)
			}
		];
	}

	private ensureDefaultSettingsSectionsOpen(sections: SettingsSectionDefinition[]): void {
		if (this.hasInitializedSettingsSectionState) {
			return;
		}

		for (const section of sections) {
			if (section.defaultOpen) {
				this.expandedSettingsSections.add(section.id);
			}
		}
		this.hasInitializedSettingsSectionState = true;
	}

	private isSettingsSectionOpen(section: SettingsSectionDefinition): boolean {
		return this.expandedSettingsSections.has(section.id);
	}

	private renderSettingsNavigation(parent: HTMLElement, sections: SettingsSectionDefinition[]): void {
		const nav = parent.createDiv({ cls: "askmate-settings-nav" });
		const copy = nav.createDiv({ cls: "askmate-settings-nav-copy" });
		new Setting(copy).setName("Categories").setHeading();
		copy.createEl("p", { text: "Jump to a category or expand sections as needed." });

		const buttons = nav.createDiv({ cls: "askmate-settings-nav-buttons" });
		for (const section of sections) {
			const button = buttons.createEl("button", { cls: "askmate-settings-nav-button", text: section.title });
			button.type = "button";
			button.addEventListener("click", () => this.openSettingsSection(section.id, true));
		}

		const actions = nav.createDiv({ cls: "askmate-settings-nav-actions" });
		const expandAll = actions.createEl("button", { text: "Expand all" });
		expandAll.type = "button";
		expandAll.addEventListener("click", () => this.setAllSettingsSectionsOpen(sections, true));

		const collapseAll = actions.createEl("button", { text: "Collapse all" });
		collapseAll.type = "button";
		collapseAll.addEventListener("click", () => this.setAllSettingsSectionsOpen(sections, false));
	}

	private renderSettingsSection(parent: HTMLElement, section: SettingsSectionDefinition): void {
		const details = parent.createEl("details", { cls: "askmate-settings-section" });
		details.id = this.getSettingsSectionElementId(section.id);
		details.open = this.isSettingsSectionOpen(section);
		this.settingsSectionElements.set(section.id, details);

		const summary = details.createEl("summary", { cls: "askmate-settings-section-summary" });
		const iconEl = summary.createSpan({ cls: "askmate-settings-section-icon" });
		setIcon(iconEl, section.icon);
		const copy = summary.createDiv({ cls: "askmate-settings-section-copy" });
		copy.createDiv({ cls: "askmate-settings-section-title", text: section.title });
		copy.createDiv({ cls: "askmate-settings-section-description", text: section.description });
		summary.createSpan({ cls: "askmate-settings-section-chevron", text: "⌄" });

		const content = details.createDiv({ cls: "askmate-settings-section-content" });
		section.render(content);

		details.addEventListener("toggle", () => {
			if (details.open) {
				this.expandedSettingsSections.add(section.id);
			} else {
				this.expandedSettingsSections.delete(section.id);
			}
		});
	}

	private setAllSettingsSectionsOpen(sections: SettingsSectionDefinition[], open: boolean): void {
		for (const section of sections) {
			const details = this.settingsSectionElements.get(section.id);
			if (open) {
				this.expandedSettingsSections.add(section.id);
			} else {
				this.expandedSettingsSections.delete(section.id);
			}
			if (details) {
				details.open = open;
			}
		}
	}

	private openSettingsSection(sectionId: SettingsSectionId, scrollIntoView: boolean): void {
		this.expandedSettingsSections.add(sectionId);
		const details = this.settingsSectionElements.get(sectionId);
		if (!details) {
			return;
		}

		details.open = true;
		if (scrollIntoView) {
			details.scrollIntoView({ behavior: "smooth", block: "start" });
			const summary = details.querySelector("summary");
			summary?.focus();
		}
	}

	private getSettingsSectionElementId(sectionId: SettingsSectionId): string {
		return `askmate-settings-section-${sectionId}`;
	}

	private renderProviderModelSettings(containerEl: HTMLElement): void {
		const selectedProviderId = this.plugin.getSelectedTextProviderId();
		const selectedProvider = this.plugin.getProviderSettings(selectedProviderId);

		new Setting(containerEl)
			.setName("Chat provider")
			.setDesc("Choose the provider AskMate uses for text chat and workflows.")
			.addDropdown((dropdown) => {
				for (const providerId of TEXT_PROVIDER_IDS) {
					dropdown.addOption(providerId, getProviderLabel(providerId));
				}
				dropdown
					.setValue(selectedProviderId)
					.onChange(async (value) => {
						const providerId = normalizeTextProviderId(value);
						this.plugin.settings.providerRoles.chatProviderId = providerId;
						this.plugin.settings.selectedTextProvider = providerId;
						await this.saveUiSetting();
						this.display();
					});
			});

		new Setting(containerEl)
			.setName("Image prompt planning provider")
			.setDesc("Choose the text provider that improves image prompts before OpenAI gpt-image-2 generation. Image generation itself remains OpenAI-only.")
			.addDropdown((dropdown) => {
				dropdown.addOption("same-as-chat", "Same as chat provider");
				for (const providerId of TEXT_PROVIDER_IDS) {
					dropdown.addOption(providerId, getProviderLabel(providerId));
				}
				dropdown
					.setValue(this.plugin.settings.providerRoles.imagePromptPlanningProviderId)
					.onChange(async (value) => {
						this.plugin.settings.providerRoles.imagePromptPlanningProviderId = normalizeImagePromptPlanningProviderId(value);
						await this.saveUiSetting();
						this.display();
					});
			});

		new Setting(containerEl)
			.setName(`${getProviderLabel(selectedProviderId)} API key`)
			.setDesc(selectedProviderId === "openai-compatible"
				? "Optional for local providers. Stored with Obsidian SecretStorage when provided."
				: selectedProviderId === "azure-openai"
					? "Azure OpenAI Phase 1 uses API-key auth. Stored with Obsidian SecretStorage. AskMate saves only the secret name in plugin settings."
					: selectedProviderId === "azure-ai"
						? "Azure AI Foundry uses API-key auth for this provider. Stored with Obsidian SecretStorage. AskMate saves only the secret name in plugin settings."
						: "Stored with Obsidian SecretStorage. AskMate saves only the secret name in plugin settings.")
			.addComponent((el) => {
				return new SecretComponent(this.app, el)
					.setValue(selectedProvider.apiKeySecretName)
					.onChange(async (value) => {
						selectedProvider.apiKeySecretName = value;
						await this.saveUiSetting();
					});
			});

		if (selectedProviderId === "openai-compatible" || selectedProviderId === "azure-openai" || selectedProviderId === "azure-ai") {
			const isAzureOpenAI = selectedProviderId === "azure-openai";
			const isAzureAI = selectedProviderId === "azure-ai";
			const baseUrlFallback = DEFAULT_PROVIDER_SETTINGS[selectedProviderId].baseUrl;
			const baseUrlPlaceholder = isAzureOpenAI
				? "https://<resource>.openai.azure.com/openai/v1"
				: isAzureAI
					? "https://<resource>.services.ai.azure.com/models"
					: DEFAULT_LOCAL_BASE_URL;

			new Setting(containerEl)
				.setName(isAzureOpenAI ? "Azure OpenAI base URL" : isAzureAI ? "Azure AI Foundry endpoint" : "Local provider base URL")
				.setDesc(isAzureOpenAI
					? "Use the v1 base URL, for example https://<resource>.openai.azure.com/openai/v1. The model field is your Azure deployment name."
					: isAzureAI
						? "Use the Azure AI inference endpoint, for example https://<resource>.services.ai.azure.com/models. AskMate adds /models when it is omitted."
						: "OpenAI-compatible endpoint, for example Ollama at http://localhost:11434/v1 or a self-hosted server.")
				.addText((text) => {
					text
						.setPlaceholder(baseUrlPlaceholder)
						.setValue(selectedProvider.baseUrl);
					// Validating per keystroke stacked error notices and saved half-typed URLs, so commit only when editing ends.
					let lastRejectedInput: string | null = null;
					this.bindCommitOnBlurOrEnter(text.inputEl, async () => {
						const provider = this.plugin.getProviderSettings(selectedProviderId);
						const input = text.getValue();
						const result = resolveBaseUrlInput(input, baseUrlFallback, (value, fallback) => isAzureOpenAI
							? validateAzureOpenAIBaseUrl(value, fallback)
							: validateProviderBaseUrl(value, fallback, getProviderLabel(selectedProviderId)));
						if (result.kind === "invalid") {
							// Enter followed by blur would otherwise report the same rejection twice.
							if (input !== lastRejectedInput) {
								new Notice(`${result.message} The previous URL is still saved.`);
							}
							lastRejectedInput = input;
							return;
						}
						lastRejectedInput = null;

						text.setValue(result.value);
						if (result.value === provider.baseUrl) {
							return;
						}
						if (result.kind === "restore-default") {
							new Notice(result.value
								? `${getProviderLabel(selectedProviderId)} base URL cleared. AskMate restored the default: ${result.value}`
								: `${getProviderLabel(selectedProviderId)} base URL cleared. Requests will fail until you enter one.`);
						}
						provider.baseUrl = result.value;
						await this.saveUiSetting();
					});
				});
		}

		new Setting(containerEl)
			.setName("Test provider connection")
			.setDesc(selectedProviderId === "azure-openai"
				? "Sends a minimal text request to the selected Azure deployment. This may consume a small number of tokens. Times out after 10 seconds."
				: selectedProviderId === "azure-ai"
					? "Sends a minimal text request to the selected Azure AI Foundry model. This may consume a small number of tokens. Times out after 10 seconds."
					: "Checks whether the selected provider can list models. Times out after 10 seconds.")
			.addButton((button) => {
				button.setButtonText("Test API").onClick(async () => {
					button.setButtonText("Testing...");
					button.setDisabled(true);
					try {
						const message = await this.plugin.testSelectedProviderConnection();
						new Notice(message);
					} catch (error) {
						new Notice(this.plugin.getErrorMessage(error));
					} finally {
						button.setButtonText("Test API");
						button.setDisabled(false);
					}
				});
			});

		// Azure OpenAI deployments cannot be listed with an API key, so a refresh button would only ever fail.
		if (selectedProviderId !== "azure-openai") {
			new Setting(containerEl)
				.setName("Refresh provider models")
				.setDesc(selectedProviderId === "azure-ai"
					? "Best-effort model info for Azure AI Foundry. If listing fails or omits your deployment, keep using the manual model name below."
					: "Loads model IDs visible to the selected provider. You can also type a manual model ID below.")
				.addButton((button) => {
					button.setButtonText("Refresh models").onClick(async () => {
						button.setButtonText("Refreshing...");
						button.setDisabled(true);
						try {
							const models = await this.plugin.refreshSelectedProviderModels();
							new Notice(`AskMate loaded ${models.length} model options.`);
							this.display();
						} catch (error) {
							new Notice(this.plugin.getErrorMessage(error));
						} finally {
							button.setButtonText("Refresh models");
							button.setDisabled(false);
						}
					});
				});
		}

		new Setting(containerEl)
			.setName("Model")
			.setDesc(selectedProviderId === "openai"
				? "Choose any model ID returned by the OpenAI Models API. Text chat requires a model that supports the Responses API; gpt-image-2 is used for image generation."
				: selectedProviderId === "azure-openai"
					? "Choose a saved Azure OpenAI deployment for text chat, workflows, and image prompt planning. Add deployments by typing their names below. Image generation remains OpenAI-only."
					: selectedProviderId === "azure-ai"
						? "Choose the Azure AI Foundry model or deployment used for text chat, workflows, and image prompt planning. Image generation remains OpenAI-only."
						: "Choose the selected provider model for text chat, workflows, and image prompt planning.")
			.addDropdown((dropdown) => {
				for (const model of selectedProvider.modelOptions) {
					dropdown.addOption(model, model);
				}
				dropdown
					.setValue(this.plugin.getSelectedModel())
					.onChange(async (value) => {
						selectedProvider.model = value;
						await this.saveUiSetting();
					});
			});

		new Setting(containerEl)
			.setName(selectedProviderId === "azure-openai" ? "Manual deployment name" : selectedProviderId === "azure-ai" ? "Manual model or deployment name" : "Manual model ID")
			.setDesc(selectedProviderId === "azure-openai"
				? "Type your Azure OpenAI deployment name exactly as it appears in Azure AI Foundry. Deployments cannot be listed with an API key, so AskMate does not offer a refresh for this provider."
				: selectedProviderId === "azure-ai"
					? "Enter your Azure AI Foundry model or deployment name. Model refresh may not list every deployment."
					: "Use this when a provider supports a model that is not returned by model refresh.")
			.addText((text) => {
				text
					.setPlaceholder(selectedProviderId === "azure-openai" ? "my-gpt-deployment" : DEFAULT_PROVIDER_SETTINGS[selectedProviderId].model)
					.setValue(selectedProvider.model);
				this.bindCommitOnBlurOrEnter(text.inputEl, async () => {
					const model = text.getValue().trim();
					if (!model || model === selectedProvider.model) return;
					selectedProvider.model = model;
					selectedProvider.modelOptions = normalizeProviderModelOptions(selectedProvider.modelOptions, DEFAULT_PROVIDER_SETTINGS[selectedProviderId].modelOptions, model);
					await this.saveUiSetting();
				});
			});

		if (selectedProviderId !== "openai") {
			new Setting(containerEl)
				.setName("OpenAI image API key")
				.setDesc("Image generation still uses OpenAI gpt-image-2. Add an OpenAI key here if you use the Image button or /image command.")
				.addComponent((el) => {
					return new SecretComponent(this.app, el)
						.setValue(this.plugin.getProviderSettings("openai").apiKeySecretName)
						.onChange(async (value) => {
							this.plugin.getProviderSettings("openai").apiKeySecretName = value;
							await this.saveUiSetting();
						});
				});
		}

		new Setting(containerEl)
			.setName("Reasoning effort")
			.setDesc("Controls OpenAI GPT-5.5 reasoning effort. Other providers ignore this setting.")
			.addDropdown((dropdown) => {
				for (const option of REASONING_EFFORT_OPTIONS) {
					dropdown.addOption(option.value, option.label);
				}

				dropdown
					.setValue(this.plugin.getSelectedReasoningEffort())
					.onChange((value) => {
						void this.runSettingAction(async () => {
							await this.plugin.setReasoningEffort(value);
							// The sidebar shows its own reasoning selector, which must follow this setting.
							this.plugin.refreshOpenAskMateViews();
						});
					});
			});
	}

	private renderRequestDefaultSettings(containerEl: HTMLElement): void {

		new Setting(containerEl)
			.setName("Send shortcut")
			.setDesc("Choose how the composer sends messages. When Enter sends, use Shift+Enter to insert a newline.")
			.addDropdown((dropdown) => {
				dropdown
					.addOption("enter", "Enter sends")
					.addOption("ctrl-enter", "Ctrl/Cmd+Enter sends")
					.setValue(this.plugin.settings.sendShortcut)
					.onChange(async (value) => {
						this.plugin.settings.sendShortcut = normalizeSendShortcut(value);
						await this.saveUiSetting();
					});
			});

		new Setting(containerEl)
			.setName("Translation target language")
			.setDesc("Used by Translate Preserve. Persian is the default. Use a language name such as Persian, German, Brazilian Portuguese, or فارسی.")
			.addText((text) => {
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

		new Setting(containerEl)
			.setName("Default output")
			.setDesc("Choose whether responses stay in the sidebar, become new notes, or apply to the captured Markdown note or selection.")
			.addDropdown((dropdown) => {
				dropdown
					.addOption("chat", "Show in sidebar chat")
					.addOption("note", "Create new note")
					.addOption("apply", "Apply to captured note or selection")
					.setValue(this.plugin.settings.outputMode)
					.onChange(async (value) => {
						this.plugin.settings.outputMode = value as OutputMode;
						await this.saveUiSetting();
					});
			});

		new Setting(containerEl)
			.setName("Detect image requests automatically")
			.setDesc("When on, questions that start with a request to create an image, such as \"Draw me a cat\", generate an image instead of a text answer. When off, AskMate answers in text. The /image command and the Image button always generate images.")
			.addToggle((toggle) => {
				this.labelToggle(toggle, "Detect image requests automatically");
				toggle
					.setValue(this.plugin.settings.autoImageIntentEnabled)
					.onChange(async (value) => {
						this.plugin.settings.autoImageIntentEnabled = value;
						await this.saveUiSetting();
					});
			});

		new Setting(containerEl)
			.setName("Sidebar layout")
			.setDesc("Compact keeps the dense sidebar controls. Expanded gives the composer more spacing and a taller text box. Console is a keyboard-first, monospaced layout: type /help in it for commands, or /layout compact to switch back.")
			.addDropdown((dropdown) => {
				dropdown
					.addOption("compact", "Compact")
					.addOption("expanded", "Expanded")
					.addOption("console", "Console")
					.setValue(this.plugin.settings.composerLayout)
					.onChange(async (value) => {
						this.plugin.settings.composerLayout = normalizeComposerLayout(value);
						await this.plugin.saveSettings();
						this.plugin.refreshOpenAskMateViews();
					});
			});

		let onboardingToggle: ToggleComponent | null = null;
		new Setting(containerEl)
			.setName("Onboarding tips")
			.setDesc("Show a small first-use tip card in the sidebar until dismissed.")
			.addToggle((toggle) => {
				onboardingToggle = toggle;
				this.labelToggle(toggle, "Show onboarding tips");
				toggle
					.setValue(this.plugin.settings.showOnboardingTips)
					.onChange(async (value) => {
						this.plugin.settings.showOnboardingTips = value;
						if (value) {
							this.plugin.settings.onboardingTipsDismissedAt = null;
						}
						await this.plugin.saveSettings();
						this.plugin.refreshOpenAskMateViews();
					});
			})
			.addButton((button) => {
				button.setButtonText("Show again").onClick(() => {
					void this.runSettingAction(async () => {
						this.plugin.settings.onboardingTipsDismissedAt = null;
						this.plugin.settings.showOnboardingTips = true;
						await this.saveUiSetting();
						onboardingToggle?.setValue(true);
					});
				});
			});

		new Setting(containerEl)
			.setName("Show request preview")
			.setDesc("Shows source, context size, provider, output mode, and privacy controls in the sidebar composer.")
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.settings.showRequestPreview)
					.onChange(async (value) => {
						this.plugin.settings.showRequestPreview = value;
						await this.saveUiSetting();
					});
			});

		new Setting(containerEl)
			.setName("Include note and attached context by default")
			.setDesc("Controls whether new requests include the captured note and note-derived attachments. When off, the note's path and title are withheld too. You can override this per request.")
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.settings.requestPrivacyDefaults.includeNoteContext)
					.onChange(async (value) => {
						this.plugin.settings.requestPrivacyDefaults.includeNoteContext = value;
						await this.saveUiSetting();
					});
			});

		new Setting(containerEl)
			.setName("Default image reference privacy")
			.setDesc("Controls whether new requests include Markdown image references by default. You can override this per request.")
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.settings.requestPrivacyDefaults.includeImageReferences)
					.onChange(async (value) => {
						this.plugin.settings.requestPrivacyDefaults.includeImageReferences = value;
						await this.saveUiSetting();
					});
			});

		new Setting(containerEl)
			.setName("Default context budget")
			.setDesc("Choose how much note context AskMate sends by default. Expanded preserves the previous full-context behavior.")
			.addDropdown((dropdown) => {
				for (const option of CONTEXT_BUDGET_OPTIONS) {
					dropdown.addOption(option.value, option.label);
				}
				dropdown
					.setValue(this.plugin.settings.contextBudgetMode)
					.onChange(async (value) => {
						this.plugin.settings.contextBudgetMode = normalizeContextBudgetMode(value);
						await this.saveUiSetting();
					});
			});
	}

	private renderContextSourceSettings(containerEl: HTMLElement): void {

		new Setting(containerEl)
			.setName("Threaded chat mode")
			.setDesc(`Opt in to sending recent AskMate user and assistant turns as extra context for follow-up requests. The number sets how many recent turns are sent (${formatIntegerRange(THREADED_CHAT_MAX_TURNS_BOUNDS)}).`)
			.addToggle((toggle) => {
				this.labelToggle(toggle, "Enable threaded chat mode");
				toggle.setValue(this.plugin.settings.threadedChatEnabled).onChange(async (value) => {
					this.plugin.settings.threadedChatEnabled = value;
					await this.saveUiSetting();
				});
			})
			.addText((text) => {
				this.bindIntegerInput(text, {
					label: "Max turns",
					bounds: THREADED_CHAT_MAX_TURNS_BOUNDS,
					getValue: () => this.plugin.settings.threadedChatMaxTurns,
					setValue: (value) => {
						this.plugin.settings.threadedChatMaxTurns = value;
					}
				});
			});

		new Setting(containerEl)
			.setName("Default additional note paths")
			.setDesc("Optional explicit multi-note context. Enter one Markdown path or wikilink per line. Sidebar preview can override this per request.")
			.addTextArea((text) => {
				text.inputEl.rows = 4;
				text.setValue(this.plugin.settings.additionalContextPaths.join("\n")).onChange((value) => {
					this.plugin.settings.additionalContextPaths = normalizeContextPathList(value);
					this.scheduleSave();
				});
			});

		new Setting(containerEl)
			.setName("Additional note character limit")
			.setDesc(`Hard cap across additional notes before the normal request context budget is applied (${formatIntegerRange(ADDITIONAL_CONTEXT_MAX_CHARACTERS_BOUNDS)} characters).`)
			.addText((text) => {
				this.bindIntegerInput(text, {
					label: "Max characters",
					bounds: ADDITIONAL_CONTEXT_MAX_CHARACTERS_BOUNDS,
					getValue: () => this.plugin.settings.additionalContextMaxCharacters,
					setValue: (value) => {
						this.plugin.settings.additionalContextMaxCharacters = value;
					}
				});
			});

		new Setting(containerEl)
			.setName("Default folder context")
			.setDesc("Explicit folder-level Markdown context. It is off by default and bounded by file and character limits.")
			.addToggle((toggle) => {
				this.labelToggle(toggle, "Enable default folder context");
				toggle.setValue(this.plugin.settings.folderContextEnabled).onChange(async (value) => {
					this.plugin.settings.folderContextEnabled = value;
					await this.saveUiSetting();
				});
			})
			.addText((text) => {
				text.inputEl.setAttribute("aria-label", "Default folder context path");
				text.setPlaceholder("Folder path");
				this.bindFolderPathInput(text, {
					label: "Folder context path",
					getValue: () => this.plugin.settings.folderContextPath,
					setValue: (value) => {
						this.plugin.settings.folderContextPath = value;
					}
				});
			});

		new Setting(containerEl)
			.setName("Folder context limits")
			.setDesc(`Maximum files (${formatIntegerRange(FOLDER_CONTEXT_MAX_FILES_BOUNDS)}) and characters (${formatIntegerRange(FOLDER_CONTEXT_MAX_CHARACTERS_BOUNDS)}) read from the folder before the normal request context budget is applied.`)
			.addText((text) => {
				this.bindIntegerInput(text, {
					label: "Max files",
					bounds: FOLDER_CONTEXT_MAX_FILES_BOUNDS,
					getValue: () => this.plugin.settings.folderContextMaxFiles,
					setValue: (value) => {
						this.plugin.settings.folderContextMaxFiles = value;
					}
				});
			})
			.addText((text) => {
				this.bindIntegerInput(text, {
					label: "Max characters",
					bounds: FOLDER_CONTEXT_MAX_CHARACTERS_BOUNDS,
					getValue: () => this.plugin.settings.folderContextMaxCharacters,
					setValue: (value) => {
						this.plugin.settings.folderContextMaxCharacters = value;
					}
				});
			});

		new Setting(containerEl)
			.setName("Excalidraw summaries")
			.setDesc(`Extract readable text and embedded references from Excalidraw files as text context. This is not pixel-level visual analysis. The number caps characters per drawing (${formatIntegerRange(EXCALIDRAW_SUMMARY_MAX_CHARACTERS_BOUNDS)}).`)
			.addToggle((toggle) => {
				this.labelToggle(toggle, "Include Excalidraw summaries");
				toggle.setValue(this.plugin.settings.includeExcalidrawSummaries).onChange(async (value) => {
					this.plugin.settings.includeExcalidrawSummaries = value;
					await this.saveUiSetting();
				});
			})
			.addText((text) => {
				this.bindIntegerInput(text, {
					label: "Max characters",
					bounds: EXCALIDRAW_SUMMARY_MAX_CHARACTERS_BOUNDS,
					getValue: () => this.plugin.settings.excalidrawSummaryMaxCharacters,
					setValue: (value) => {
						this.plugin.settings.excalidrawSummaryMaxCharacters = value;
					}
				});
			});

		new Setting(containerEl)
			.setName("Image manifest context")
			.setDesc("Include image paths, labels, extensions, file sizes, and reference lines as metadata context when image references are allowed. This does not send image pixels.")
			.addToggle((toggle) => {
				toggle.setValue(this.plugin.settings.includeImageManifests).onChange(async (value) => {
					this.plugin.settings.includeImageManifests = value;
					await this.saveUiSetting();
				});
			});

		new Setting(containerEl)
			.setName("Evidence-linked answers")
			.setDesc(`Ask text models to cite evidence sources like [S1], then show jump-to-source actions on cited replies. The number caps how many sources are offered (${formatIntegerRange(EVIDENCE_MAX_SOURCES_BOUNDS)}).`)
			.addToggle((toggle) => {
				this.labelToggle(toggle, "Enable evidence-linked answers");
				toggle.setValue(this.plugin.settings.evidenceLinkedAnswersEnabled).onChange(async (value) => {
					this.plugin.settings.evidenceLinkedAnswersEnabled = value;
					await this.saveUiSetting();
				});
			})
			.addText((text) => {
				this.bindIntegerInput(text, {
					label: "Max sources",
					bounds: EVIDENCE_MAX_SOURCES_BOUNDS,
					getValue: () => this.plugin.settings.evidenceMaxSources,
					setValue: (value) => {
						this.plugin.settings.evidenceMaxSources = value;
					}
				});
			});

		new Setting(containerEl)
			.setName("Note-specific AskMate history")
			.setDesc("First switch: store successful AskMate turns per source note. Second switch: include that history as context for future requests.")
			.addToggle((toggle) => {
				this.labelToggle(toggle, "Store note-specific history");
				toggle.setValue(this.plugin.settings.noteHistoryEnabled).onChange(async (value) => {
					this.plugin.settings.noteHistoryEnabled = value;
					await this.saveUiSetting();
				});
			})
			.addToggle((toggle) => {
				this.labelToggle(toggle, "Include note history in context");
				toggle.setValue(this.plugin.settings.noteHistoryIncludeInContext).onChange(async (value) => {
					this.plugin.settings.noteHistoryIncludeInContext = value;
					await this.saveUiSetting();
				});
			});

		new Setting(containerEl)
			.setName("Style guide context role")
			.setDesc("Pin a Markdown note as a persistent style guide context attachment.")
			.addToggle((toggle) => {
				this.labelToggle(toggle, "Include style guide context");
				toggle.setValue(this.plugin.settings.includeStyleGuideContext).onChange(async (value) => {
					this.plugin.settings.includeStyleGuideContext = value;
					await this.saveUiSetting();
				});
			})
			.addText((text) => text.setPlaceholder("Path or wikilink").then((component) => component.inputEl.setAttribute("aria-label", "Style guide note path")).setValue(this.plugin.settings.styleGuideContextPath).onChange((value) => {
				this.plugin.settings.styleGuideContextPath = normalizeOptionalString(value, MAX_CONTEXT_PATH_LENGTH);
				this.scheduleSave();
			}));

		new Setting(containerEl)
			.setName("Glossary context role")
			.setDesc("Pin a Markdown note as a persistent glossary or terminology context attachment.")
			.addToggle((toggle) => {
				this.labelToggle(toggle, "Include glossary context");
				toggle.setValue(this.plugin.settings.includeGlossaryContext).onChange(async (value) => {
					this.plugin.settings.includeGlossaryContext = value;
					await this.saveUiSetting();
				});
			})
			.addText((text) => text.setPlaceholder("Path or wikilink").then((component) => component.inputEl.setAttribute("aria-label", "Glossary note path")).setValue(this.plugin.settings.glossaryContextPath).onChange((value) => {
				this.plugin.settings.glossaryContextPath = normalizeOptionalString(value, MAX_CONTEXT_PATH_LENGTH);
				this.scheduleSave();
			}));
	}

	private renderOutputApplySettings(containerEl: HTMLElement): void {

		new Setting(containerEl)
			.setName("Result folder")
			.setDesc("Folder for notes created by AskMate.")
			.addText((text) => {
				text.setPlaceholder(DEFAULT_SETTINGS.resultFolder);
				this.bindFolderPathInput(text, {
					label: "Result folder",
					getValue: () => this.plugin.settings.resultFolder,
					setValue: (value) => {
						this.plugin.settings.resultFolder = value;
					}
				});
			});

		new Setting(containerEl)
			.setName("Result note template")
			.setDesc("Markdown template for text result notes. Variables include {{title}}, {{sourceLink}}, {{providerName}}, {{model}}, {{request}}, and {{response}}.")
			.addTextArea((text) => {
				text.inputEl.rows = 8;
				text.inputEl.addClass("askmate-settings-template-input");
				text
					.setValue(this.plugin.settings.resultNoteTemplate)
					.onChange((value) => {
						this.plugin.settings.resultNoteTemplate = normalizeTemplateString(value, DEFAULT_RESULT_NOTE_TEMPLATE);
						this.scheduleSave();
					});
			});

		new Setting(containerEl)
			.setName("Image result note template")
			.setDesc("Markdown template for generated image notes. Variables include {{imageEmbed}}, {{imagePrompt}}, {{revisedPromptSection}}, and {{planningModel}}.")
			.addTextArea((text) => {
				text.inputEl.rows = 8;
				text.inputEl.addClass("askmate-settings-template-input");
				text
					.setValue(this.plugin.settings.imageResultNoteTemplate)
					.onChange((value) => {
						this.plugin.settings.imageResultNoteTemplate = normalizeTemplateString(value, DEFAULT_IMAGE_RESULT_NOTE_TEMPLATE);
						this.scheduleSave();
					});
			});

		new Setting(containerEl)
			.setName("Image folder template")
			.setDesc("Folder template for generated PNG files. Use {{resultFolder}}, {{date}}, {{noteTitle}}, or {{workflowName}}.")
			.addText((text) => {
				text
					.setPlaceholder(DEFAULT_IMAGE_FOLDER_TEMPLATE)
					.setValue(this.plugin.settings.imageFolderTemplate)
					.onChange((value) => {
						this.plugin.settings.imageFolderTemplate = normalizeTemplateString(value, DEFAULT_IMAGE_FOLDER_TEMPLATE);
						this.scheduleSave();
					});
			});

		new Setting(containerEl)
			.setName("Image file name template")
			.setDesc("Base file name template for generated PNG files. AskMate still adds a timestamp and resolves duplicates.")
			.addText((text) => {
				text
					.setPlaceholder(DEFAULT_IMAGE_FILE_NAME_TEMPLATE)
					.setValue(this.plugin.settings.imageFileNameTemplate)
					.onChange((value) => {
						this.plugin.settings.imageFileNameTemplate = normalizeTemplateString(value, DEFAULT_IMAGE_FILE_NAME_TEMPLATE);
						this.scheduleSave();
					});
			});

		new Setting(containerEl)
			.setName("Default partial Apply scope")
			.setDesc("Auto replaces captured selected text, otherwise appends to the captured note. Choose full-note replacement only for intentional whole-note rewrites.")
			.addDropdown((dropdown) => {
				dropdown
					.addOption("auto", "Auto")
					.addOption("selected-block", "Selected block")
					.addOption("heading-section", "Heading section")
					.addOption("full-note", "Full note replacement")
					.setValue(this.plugin.settings.partialApplyDefaultScope)
					.onChange(async (value) => {
						this.plugin.settings.partialApplyDefaultScope = normalizeApplyScope(value);
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Apply approval mode")
			.setDesc("Controls when AskMate asks before writing generated text into notes. Auto approve skips selected-text, append, and heading-section diff previews, but still confirms full-note replacement. Full approves full-note and heading-section replacements. Manual approves every text Apply write with a diff. All modes keep truncated-context, frontmatter, captured-file, and exact-match safeguards.")
			.addDropdown((dropdown) => {
				dropdown
					.addOption("auto-approve", "Auto approve")
					.addOption("full", "Full")
					.addOption("manual", "Manual")
					.setValue(this.plugin.settings.applyApprovalMode)
					.onChange(async (value) => {
						this.plugin.settings.applyApprovalMode = normalizeApplyApprovalMode(value, this.plugin.settings.showApplyPreview);
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Frontmatter Apply handling")
			.setDesc("Controls how full-note Apply handles YAML frontmatter.")
			.addDropdown((dropdown) => dropdown
				.addOption("preserve", "Preserve original frontmatter")
				.addOption("confirm", "Confirm frontmatter changes")
				.addOption("replace", "Replace from AI output")
				.setValue(this.plugin.settings.frontmatterApplyPolicy)
				.onChange(async (value) => {
					this.plugin.settings.frontmatterApplyPolicy = normalizeFrontmatterApplyPolicy(value);
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName("Smart result-note placement")
			.setDesc("First switch: create result notes under an AskMate subfolder beside the source note. Second switch: append a backlink to the result note in the source note.")
			.addToggle((toggle) => {
				this.labelToggle(toggle, "Place result notes beside the source note");
				toggle.setValue(this.plugin.settings.smartResultPlacementEnabled).onChange(async (value) => {
					this.plugin.settings.smartResultPlacementEnabled = value;
					await this.plugin.saveSettings();
				});
			})
			.addToggle((toggle) => {
				this.labelToggle(toggle, "Append result backlink to the source note");
				toggle.setValue(this.plugin.settings.appendResultBacklinkToSource).onChange(async (value) => {
					this.plugin.settings.appendResultBacklinkToSource = value;
					await this.plugin.saveSettings();
				});
			});

		this.renderReviewQueue(containerEl);
	}

	private renderWorkflowAutomationSettings(containerEl: HTMLElement): void {
		this.renderWorkflowDisplaySettings(containerEl);
		this.renderCustomWorkflows(containerEl);
		this.renderBatchWorkflowRunner(containerEl);
	}


	private renderBatchWorkflowRunner(containerEl: HTMLElement): void {
		new Setting(containerEl).setName("Batch workflow runner").setHeading();
		const box = containerEl.createDiv({ cls: "askmate-batch-runner" });
		const progress = box.createDiv({ cls: "askmate-batch-progress", text: this.activeBatch?.message ?? "Idle." });
		const bar = box.createDiv({ cls: "askmate-batch-progress-bar" });
		const fill = bar.createDiv({ cls: "askmate-batch-progress-fill" });
		fill.style.width = `${this.activeBatch?.percent ?? 0}%`;

		new Setting(box)
			.setName("Batch folder")
			.setDesc("Run one workflow separately for each Markdown note in this folder.")
			.addText((text) => {
				text.setPlaceholder("Folder path");
				this.bindFolderPathInput(text, {
					label: "Batch folder",
					getValue: () => this.plugin.settings.batchWorkflowFolderPath,
					setValue: (value) => {
						this.plugin.settings.batchWorkflowFolderPath = value;
					}
				});
			});

		new Setting(box)
			.setName("Batch workflow")
			.setDesc(`Workflow to run, and the maximum number of notes to process (${formatIntegerRange(BATCH_WORKFLOW_MAX_FILES_BOUNDS)}).`)
			.addDropdown((dropdown) => {
				for (const workflow of this.plugin.getAllWorkflows()) {
					dropdown.addOption(workflow.id, workflow.name);
				}
				dropdown.selectEl.setAttribute("aria-label", "Batch workflow");
				dropdown.setValue(this.plugin.settings.batchWorkflowId).onChange((value) => {
					this.plugin.settings.batchWorkflowId = value;
					void this.runSettingAction(() => this.plugin.saveSettings());
				});
			})
			.addText((text) => {
				this.bindIntegerInput(text, {
					label: "Max files",
					bounds: BATCH_WORKFLOW_MAX_FILES_BOUNDS,
					getValue: () => this.plugin.settings.batchWorkflowMaxFiles,
					setValue: (value) => {
						this.plugin.settings.batchWorkflowMaxFiles = value;
					}
				});
			});

		const outputSetting = new Setting(box)
			.setName("Batch output")
			.addDropdown((dropdown) => dropdown
				.addOption("note", "Create result notes")
				.addOption("review-queue", "Queue proposed note changes")
				.setValue(this.plugin.settings.batchWorkflowOutputMode)
				.onChange((value) => {
					this.plugin.settings.batchWorkflowOutputMode = normalizeBatchWorkflowOutputMode(value);
					void this.runSettingAction(() => this.plugin.saveSettings());
				}));
		const runButton = new ButtonComponent(outputSetting.controlEl)
			.setButtonText("Run batch")
			.setDisabled(this.activeBatch !== null)
			.onClick(() => {
				void this.runBatch();
			});
		const cancelButton = new ButtonComponent(outputSetting.controlEl)
			.setButtonText("Cancel")
			.setDisabled(this.activeBatch === null)
			.onClick(() => {
				this.activeBatch?.controller.abort();
			});
		this.batchElements = { progress, fill, runButton, cancelButton };
	}

	private async runBatch(): Promise<void> {
		// A second concurrent batch would double API spend and duplicate result notes or queue items.
		if (this.activeBatch) {
			return;
		}

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
			new Notice(summary.stoppedReason
				? `AskMate batch stopped: ${summary.stoppedReason} ${counts}${failureDetail}`
				: `AskMate batch complete: ${counts}${failureDetail}`, 10000);
		} catch (error) {
			new Notice(this.plugin.getErrorMessage(error));
		} finally {
			this.activeBatch = null;
			// The batch can finish while the user is editing a field that saves on blur; commit it before the re-render drops it.
			this.commitFocusedField();
			this.display();
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
		elements.progress.setText(batch?.message ?? "Idle.");
		elements.fill.style.width = `${batch?.percent ?? 0}%`;
		elements.runButton.setDisabled(batch !== null);
		elements.cancelButton.setDisabled(batch === null);
	}

	private renderReviewQueue(containerEl: HTMLElement): void {
		new Setting(containerEl).setName("Review queue").setHeading();
		const queue = containerEl.createDiv({ cls: "askmate-review-queue" });
		const pending = this.plugin.getPendingReviewQueueItems();
		new Setting(queue)
			.setName("Review queue max items")
			.setDesc(`${pending.length} pending AI-suggested note change${pending.length === 1 ? "" : "s"}. Limits how many items the queue keeps (${formatIntegerRange(REVIEW_QUEUE_MAX_ITEMS_BOUNDS)}). Pending items are never discarded: lowering the limit only removes older applied or dismissed items, and new items cannot be queued while the pending count is at the limit.`)
			.addText((text) => {
				this.bindIntegerInput(text, {
					label: "Max items",
					bounds: REVIEW_QUEUE_MAX_ITEMS_BOUNDS,
					getValue: () => this.plugin.settings.reviewQueueMaxItems,
					setValue: (value) => {
						this.plugin.settings.reviewQueueMaxItems = value;
					}
				});
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
			const apply = actions.createEl("button", { cls: "mod-cta", text: "Apply" });
			apply.type = "button";
			apply.addEventListener("click", () => {
				apply.disabled = true;
				dismiss.disabled = true;
				void this.plugin.applyReviewQueueItem(item.id).then((message) => {
					new Notice(message);
					this.display();
				}).catch((error) => new Notice(this.plugin.getErrorMessage(error))).finally(() => {
					apply.disabled = false;
					dismiss.disabled = false;
				});
			});
			const dismiss = actions.createEl("button", { text: "Dismiss" });
			dismiss.type = "button";
			dismiss.addEventListener("click", () => {
				apply.disabled = true;
				dismiss.disabled = true;
				void this.plugin.dismissReviewQueueItem(item.id).then(() => this.display()).catch((error) => {
					new Notice(this.plugin.getErrorMessage(error));
				}).finally(() => {
					apply.disabled = false;
					dismiss.disabled = false;
				});
			});
			const showProposal = actions.createEl("button", { text: "Show proposal" });
			showProposal.type = "button";
			showProposal.addEventListener("click", () => new AskMateTextViewerModal(this.app, "AskMate review proposal", item.proposedText).open());
		}
	}

	private renderWorkflowDisplaySettings(containerEl: HTMLElement): void {
		new Setting(containerEl).setName("Workflow sidebar").setHeading();
		containerEl.createEl("p", {
			cls: "askmate-settings-note",
			text: "Favorite, hide, or reorder workflows in the sidebar. Built-in command palette workflows are not changed."
		});

		const list = containerEl.createDiv({ cls: "askmate-workflow-display-list" });
		const workflows = this.plugin.getSidebarWorkflowOrderForSettings();

		for (const workflow of workflows) {
			const preference = this.plugin.getWorkflowDisplayPreference(workflow.id);
			const customWorkflow = workflow.isCustom
				? this.plugin.settings.customWorkflows.find((item) => item.id === workflow.id)
				: null;
			const isHidden = Boolean(preference?.hidden) || Boolean(customWorkflow?.hidden);
			const card = list.createDiv({ cls: "askmate-workflow-display-card" });
			card.createDiv({ cls: "askmate-workflow-display-title", text: workflow.name });

			new Setting(card)
				.setName("Favorite")
				.addToggle((toggle) => {
					this.labelToggle(toggle, `Favorite ${workflow.name}`);
					toggle.setValue(Boolean(preference?.favorite)).onChange((value) => {
						this.runSettingActionAndRender(() => this.plugin.updateWorkflowDisplayPreference(workflow.id, { favorite: value }));
					});
				})
				.addButton((button) => {
					button.buttonEl.setAttribute("aria-label", `Move ${workflow.name} up`);
					button.setButtonText("Up").onClick(() => {
						this.runSettingActionAndRender(() => this.plugin.moveWorkflowDisplayPreference(workflow.id, "up"));
					});
				})
				.addButton((button) => {
					button.buttonEl.setAttribute("aria-label", `Move ${workflow.name} down`);
					button.setButtonText("Down").onClick(() => {
						this.runSettingActionAndRender(() => this.plugin.moveWorkflowDisplayPreference(workflow.id, "down"));
					});
				});

			new Setting(card)
				.setName("Hide from sidebar")
				.setDesc(workflow.isCustom ? "This only affects the sidebar workflow panel." : "Built-in command palette commands remain available.")
				.addToggle((toggle) => {
					this.labelToggle(toggle, `Hide ${workflow.name} from sidebar`);
					toggle.setValue(isHidden).onChange((value) => {
						this.runSettingActionAndRender(async () => {
							if (workflow.isCustom) {
								await this.plugin.updateCustomWorkflow(workflow.id, { hidden: value });
							}
							await this.plugin.updateWorkflowDisplayPreference(workflow.id, { hidden: value });
						});
					});
				});
		}
	}

	private renderCustomWorkflows(containerEl: HTMLElement): void {
		new Setting(containerEl).setName("Custom workflows").setHeading();
		containerEl.createEl("p", {
			cls: "askmate-settings-note",
			text: "Custom workflows appear in the AskMate sidebar. Built-in workflows remain available from the command palette. Variables available in workflow prompts: {{noteTitle}}, {{sourcePath}}, {{contextSource}}, {{selectedText}}, {{currentDate}}, {{currentDateTime}}, and {{customInstructions}}."
		});

		new Setting(containerEl)
			.setName("Workflow custom instructions")
			.setDesc("Optional preferences added to every workflow, built-in and custom. Custom workflows can choose where they go with {{customInstructions}}; otherwise they are appended at the end.")
			.addTextArea((text) => {
				text.inputEl.rows = 4;
				text
					.setValue(this.plugin.settings.workflowCustomInstructions)
					.onChange((value) => {
						this.plugin.settings.workflowCustomInstructions = normalizeOptionalString(value, MAX_WORKFLOW_CUSTOM_INSTRUCTIONS_LENGTH);
						this.scheduleSave();
					});
			});

		let importJson = "";
		new Setting(containerEl)
			.setName("Workflow presets")
			.setDesc("Export custom workflows as JSON, or paste a preset JSON export and import it. Imports append workflows and do not overwrite existing ones.")
			.addButton((button) => {
				button.setButtonText("Show export JSON").onClick(() => {
					new AskMateTextViewerModal(this.app, "AskMate workflow preset export", this.plugin.exportCustomWorkflowPresets()).open();
				});
			})
			.addButton((button) => {
				button.setButtonText("Import pasted JSON").onClick(async () => {
					try {
						const count = await this.plugin.importCustomWorkflowPresets(importJson);
						new Notice(`AskMate imported ${count} custom workflow${count === 1 ? "" : "s"}.`);
						this.display();
					} catch (error) {
						new Notice(this.plugin.getErrorMessage(error));
					}
				});
			});

		new Setting(containerEl)
			.setName("Preset JSON")
			.setDesc("Paste an AskMate workflow preset export here before clicking Import pasted JSON.")
			.addTextArea((text) => {
				text.inputEl.rows = 6;
				text.inputEl.addClass("askmate-settings-template-input");
				text.setPlaceholder("{\n  \"version\": 1,\n  \"source\": \"AskMate\",\n  \"workflows\": []\n}");
				text.onChange((value) => {
					importJson = value;
				});
			});

		new Setting(containerEl)
			.setName("Add custom workflow")
			.setDesc("Create a sidebar workflow you can edit below.")
			.addButton((button) => {
				button.setButtonText("Add workflow").onClick(() => {
					this.runSettingActionAndRender(() => this.plugin.addCustomWorkflow());
				});
			});

		const list = containerEl.createDiv({ cls: "askmate-custom-workflow-list" });

		if (this.plugin.settings.customWorkflows.length === 0) {
			list.createDiv({
				cls: "askmate-usage-empty",
				text: "No custom workflows yet."
			});
			return;
		}

		for (const workflow of this.plugin.settings.customWorkflows) {
			const card = list.createDiv({ cls: "askmate-custom-workflow-card" });
			new Setting(card).setName(workflow.name).setHeading();

			new Setting(card)
				.setName("Name")
				.addText((text) => {
					text.setValue(workflow.name);
					this.bindCustomWorkflowField(workflow.id, text.inputEl, "name");
				});

			new Setting(card)
				.setName("Short name")
				.addText((text) => {
					text.setValue(workflow.shortName);
					this.bindCustomWorkflowField(workflow.id, text.inputEl, "shortName");
				});

			new Setting(card)
				.setName("Description")
				.addText((text) => {
					text.setValue(workflow.description);
					this.bindCustomWorkflowField(workflow.id, text.inputEl, "description");
				});

			new Setting(card)
				.setName("Icon")
				.setDesc("Lucide icon name, for example wand-2, lightbulb, or file-text.")
				.addText((text) => {
					text.setValue(workflow.icon);
					this.bindCustomWorkflowField(workflow.id, text.inputEl, "icon");
				});

			new Setting(card)
				.setName("Accent")
				.addDropdown((dropdown) => {
					for (const accent of WORKFLOW_ACCENTS) {
						dropdown.addOption(accent, accent);
					}
					dropdown.selectEl.setAttribute("aria-label", `Accent for ${workflow.name}`);
					dropdown.setValue(workflow.accent).onChange((value) => {
						void this.runSettingAction(() => this.plugin.updateCustomWorkflow(workflow.id, { accent: normalizeWorkflowAccent(value) }));
					});
				});

			new Setting(card)
				.setName("Prompt")
				.setDesc("Use outcome-first instructions. AskMate will provide the current note or selection as context.")
				.addTextArea((text) => {
					text.inputEl.rows = 8;
					text.setValue(workflow.prompt);
					this.bindCustomWorkflowField(workflow.id, text.inputEl, "prompt");
				});

			new Setting(card)
				.setName("Output kind")
				.setDesc("Revised note: the output is a full revised version of the note and may replace it, for example in batch review. New content: summaries, analysis, or other new material that is appended or saved as a note.")
				.addDropdown((dropdown) => {
					dropdown.selectEl.setAttribute("aria-label", `Output kind for ${workflow.name}`);
					dropdown
						.addOption("note-edit", "Revised note")
						.addOption("new-content", "New content")
						.setValue(workflow.outputKind ?? "new-content")
						.onChange((value) => {
							const outputKind: WorkflowOutputKind = value === "note-edit" ? "note-edit" : "new-content";
							void this.runSettingAction(() => this.plugin.updateCustomWorkflow(workflow.id, { outputKind }));
						});
				});

			new Setting(card)
				.setName("Result note template")
				.setDesc("Optional per-workflow Markdown template. Leave empty to use the global result note template.")
				.addTextArea((text) => {
					text.inputEl.rows = 6;
					text.inputEl.addClass("askmate-settings-template-input");
					text.setValue(workflow.resultNoteTemplate);
					this.bindCustomWorkflowField(workflow.id, text.inputEl, "resultNoteTemplate", (value) => normalizeTemplateString(value, ""));
				});

			const hiddenPreference = this.plugin.getWorkflowDisplayPreference(workflow.id);
			const isHidden = workflow.hidden || Boolean(hiddenPreference?.hidden);

			new Setting(card)
				.setName("Hidden")
				.setDesc("Hide this workflow from the sidebar without deleting it.")
				.addToggle((toggle) => {
					this.labelToggle(toggle, `Hide ${workflow.name}`);
					toggle.setValue(isHidden).onChange((value) => {
						this.runSettingActionAndRender(async () => {
							await this.plugin.updateCustomWorkflow(workflow.id, { hidden: value });
							await this.plugin.updateWorkflowDisplayPreference(workflow.id, { hidden: value });
						});
					});
				})
				.addButton((button) => {
					button.setWarning();
					button.buttonEl.setAttribute("aria-label", `Delete ${workflow.name}`);
					button.setButtonText("Delete").onClick(async () => {
						if (!(await askMateConfirm(this.app, `Delete custom workflow "${workflow.name}"?`))) {
							return;
						}

						this.runSettingActionAndRender(() => this.plugin.deleteCustomWorkflow(workflow.id));
					});
				});
		}
	}

	// Each workflow update re-registers commands and refreshes every sidebar, so commit when editing ends, not per keystroke.
	private bindCustomWorkflowField(
		workflowId: string,
		inputEl: HTMLInputElement | HTMLTextAreaElement,
		field: CustomWorkflowTextField,
		normalize: (value: string) => string = (value) => value
	): void {
		const commit = async (): Promise<void> => {
			const workflow = this.plugin.settings.customWorkflows.find((item) => item.id === workflowId);
			const value = normalize(inputEl.value);
			if (!workflow || workflow[field] === value) {
				return;
			}
			const patch: Partial<Pick<CustomWorkflow, CustomWorkflowTextField>> = {};
			patch[field] = value;
			await this.plugin.updateCustomWorkflow(workflowId, patch);
		};

		if (inputEl instanceof HTMLTextAreaElement) {
			inputEl.addEventListener("blur", () => {
				void this.runSettingAction(commit);
			});
			return;
		}
		this.bindCommitOnBlurOrEnter(inputEl, commit);
	}

	private renderUsageStatistics(containerEl: HTMLElement): void {
		const records = this.plugin.getTokenUsageRecords();
		const summary = this.plugin.getTokenUsageSummary();
		new Setting(containerEl).setName("Usage statistics").setHeading();

		const statsEl = containerEl.createDiv({ cls: "askmate-usage-stats" });
		const header = statsEl.createDiv({ cls: "askmate-usage-header" });
		const copy = header.createDiv({ cls: "askmate-usage-copy" });
		new Setting(copy).setName("Operation usage").setHeading();
		copy.createEl("p", {
			text: "Tracks AskMate API operations by provider, including text responses, image prompt planning, and image generation. Images API rows may show zero tokens."
		});

		this.renderUsageGuardrailSettings(statsEl);

		const actions = header.createDiv({ cls: "askmate-usage-actions" });
		const resetButton = actions.createEl("button", {
			cls: "mod-warning",
			text: "Reset statistics"
		});
		resetButton.type = "button";
		resetButton.disabled = records.length === 0;
		resetButton.addEventListener("click", () => {
			void this.resetUsageStatistics();
		});

		this.renderSummaryCards(statsEl, summary);

		if (records.length === 0) {
			statsEl.createDiv({
				cls: "askmate-usage-empty",
				text: "No usage has been recorded yet. Ask a question or run a workflow to populate the charts."
			});
			return;
		}

		const chartGrid = statsEl.createDiv({ cls: "askmate-chart-grid" });
		this.renderRecentTokenBarChart(chartGrid, records.slice(-RECENT_TOKEN_BAR_RECORD_LIMIT));
		this.renderTokenRunChart(chartGrid, records.slice(-TOKEN_RUN_CHART_RECORD_LIMIT));
		this.renderRecentUsageTable(statsEl, records.slice(-RECENT_TOKEN_TABLE_RECORD_LIMIT).reverse());
	}

	private renderUsageGuardrailSettings(parent: HTMLElement): void {
		const card = parent.createDiv({ cls: "askmate-usage-guardrails" });
		new Setting(card)
			.setName("Usage budgets and guardrails")
			.setDesc("Warn or block requests before they use a large context or exceed daily or monthly token budgets.")
			.addToggle((toggle) => {
				this.labelToggle(toggle, "Enable usage budgets and guardrails");
				toggle.setValue(this.plugin.settings.usageGuardrailsEnabled).onChange(async (value) => {
					this.plugin.settings.usageGuardrailsEnabled = value;
					await this.saveUiSetting();
				});
			})
			.addDropdown((dropdown) => dropdown.then((component) => component.selectEl.setAttribute("aria-label", "Budget enforcement")).addOption("warn", "Warn").addOption("block", "Block budgets").setValue(this.plugin.settings.usageBudgetEnforcement).onChange(async (value) => {
				this.plugin.settings.usageBudgetEnforcement = normalizeBudgetEnforcementMode(value);
				await this.saveUiSetting();
			}));
		new Setting(card)
			.setName("Token budgets")
			.setDesc(`Daily (${formatIntegerRange(DAILY_TOKEN_BUDGET_BOUNDS)}) and monthly (${formatIntegerRange(MONTHLY_TOKEN_BUDGET_BOUNDS)}) token budgets. Use 0 to disable a limit. Values are estimated before sending and recorded after completion.`)
			.addText((text) => {
				this.bindIntegerInput(text, {
					label: "Daily budget",
					bounds: DAILY_TOKEN_BUDGET_BOUNDS,
					getValue: () => this.plugin.settings.usageDailyTokenBudget,
					setValue: (value) => {
						this.plugin.settings.usageDailyTokenBudget = value;
					}
				});
			})
			.addText((text) => {
				this.bindIntegerInput(text, {
					label: "Monthly budget",
					bounds: MONTHLY_TOKEN_BUDGET_BOUNDS,
					getValue: () => this.plugin.settings.usageMonthlyTokenBudget,
					setValue: (value) => {
						this.plugin.settings.usageMonthlyTokenBudget = value;
					}
				});
			});
		new Setting(card)
			.setName("Per-request thresholds")
			.setDesc(`Warn above the warning threshold. Hard limit always blocks. Each accepts ${formatIntegerRange(PER_REQUEST_TOKEN_BOUNDS)} tokens; use 0 to disable.`)
			.addText((text) => {
				this.bindIntegerInput(text, {
					label: "Warning threshold",
					bounds: PER_REQUEST_TOKEN_BOUNDS,
					getValue: () => this.plugin.settings.usagePerRequestWarningTokens,
					setValue: (value) => {
						this.plugin.settings.usagePerRequestWarningTokens = value;
					}
				});
			})
			.addText((text) => {
				this.bindIntegerInput(text, {
					label: "Hard limit",
					bounds: PER_REQUEST_TOKEN_BOUNDS,
					getValue: () => this.plugin.settings.usagePerRequestHardLimitTokens,
					setValue: (value) => {
						this.plugin.settings.usagePerRequestHardLimitTokens = value;
					}
				});
			});
	}

	private async resetUsageStatistics(): Promise<void> {
		if (!(await askMateConfirm(this.app, "Reset AskMate usage statistics? This cannot be undone."))) {
			return;
		}

		try {
			await this.plugin.resetTokenUsageStats();
			new Notice("AskMate usage statistics reset.");
		} catch (error) {
			new Notice(this.plugin.getErrorMessage(error));
		}
		this.display();
	}

	private renderSummaryCards(parent: HTMLElement, summary: TokenUsageSummary): void {
		const grid = parent.createDiv({ cls: "askmate-stat-grid" });
		this.createStatCard(grid, "Operations", formatTokenCount(summary.requests), "Recorded AskMate API operations");
		this.createStatCard(grid, "Sent", formatTokenCount(summary.inputTokens), "Responses API input tokens");
		this.createStatCard(grid, "Received", formatTokenCount(summary.outputTokens), "Responses API output tokens");
		this.createStatCard(grid, "Total", formatTokenCount(summary.totalTokens), "Tracked tokens");
		this.createStatCard(grid, "Avg operation", formatTokenCount(summary.averageTotalTokens), "Tokens per operation");
		this.createStatCard(grid, "Avg time", formatDuration(summary.averageDurationMs), "Operation duration");

		if (summary.completedOperations > 0) {
			this.createStatCard(grid, "Completed", formatTokenCount(summary.completedOperations), "Completed operations");
		}

		if (summary.failedOperations > 0) {
			this.createStatCard(grid, "Failed", formatTokenCount(summary.failedOperations), "Failed operations");
		}

		if (summary.abortedOperations > 0) {
			this.createStatCard(grid, "Aborted", formatTokenCount(summary.abortedOperations), "Stopped operations");
		}

		if (summary.fallbackOperations > 0) {
			this.createStatCard(grid, "Fallback", formatTokenCount(summary.fallbackOperations), "Operations that used fallback behavior");
		}

		if (summary.imageOperations > 0) {
			this.createStatCard(grid, "Image ops", formatTokenCount(summary.imageOperations), "Images API generations");
		}

		if (summary.cachedInputTokens > 0) {
			this.createStatCard(grid, "Cached", formatTokenCount(summary.cachedInputTokens), "Cached input tokens");
		}

		if (summary.reasoningOutputTokens > 0) {
			this.createStatCard(grid, "Reasoning", formatTokenCount(summary.reasoningOutputTokens), "Reasoning output tokens");
		}

		if (summary.estimatedRecords > 0) {
			this.createStatCard(grid, "Estimated", formatTokenCount(summary.estimatedRecords), "Operations with estimated or unavailable usage");
		}

		if (summary.lastRecord) {
			this.createStatCard(grid, "Latest", formatUsageTimestamp(summary.lastRecord.timestamp), truncateLabel(summary.lastRecord.title, 36));
		}
	}

	private createStatCard(parent: HTMLElement, label: string, value: string, description: string): void {
		const card = parent.createDiv({ cls: "askmate-stat-card" });
		card.createDiv({ cls: "askmate-stat-label", text: label });
		card.createDiv({ cls: "askmate-stat-value", text: value });
		card.createDiv({ cls: "askmate-stat-desc", text: description });
	}

	private renderRecentTokenBarChart(parent: HTMLElement, records: TokenUsageRecord[]): void {
		const card = this.createChartCard(
			parent,
			"Recent sent vs received tokens",
			"Stacked bars show input and output tokens for recent operations. Images API rows may be zero."
		);
		this.renderChartLegend(card, [
			["Sent", "askmate-chart-legend-input"],
			["Received", "askmate-chart-legend-output"]
		]);

		const width = 640;
		const height = 300;
		const margin = { top: 24, right: 20, bottom: 70, left: 62 };
		const bottom = height - margin.bottom;
		const plotWidth = width - margin.left - margin.right;
		const yMax = this.getNiceChartMax(records.reduce((max, record) => Math.max(max, record.totalTokens, record.inputTokens + record.outputTokens), 1));
		const yScale = (value: number) => bottom - (Math.max(0, value) / yMax) * (bottom - margin.top);
		const svg = this.createChartSvg(card, width, height, "Recent token mix bar chart");

		this.renderChartYAxis(svg, margin.left, margin.top, bottom, width - margin.right, yMax, yScale);

		const count = Math.max(1, records.length);
		const step = plotWidth / count;
		const barWidth = Math.max(6, Math.min(34, step * 0.72));
		const labelEvery = Math.max(1, Math.ceil(records.length / 8));
		this.appendSvgLine(svg, margin.left, bottom, width - margin.right, bottom, "askmate-chart-axis-line");

		records.forEach((record, index) => {
			const x = margin.left + index * step + (step - barWidth) / 2;
			const inputY = yScale(record.inputTokens);
			const totalY = yScale(record.inputTokens + record.outputTokens);
			const inputHeight = Math.max(0, bottom - inputY);
			const outputHeight = Math.max(0, inputY - totalY);

			const inputBar = this.appendSvgElement(svg, "rect", {
				class: "askmate-chart-bar-input",
				x,
				y: inputY,
				width: barWidth,
				height: inputHeight
			});
			this.appendSvgTitle(inputBar, this.formatBarTooltip(record));

			const outputBar = this.appendSvgElement(svg, "rect", {
				class: "askmate-chart-bar-output",
				x,
				y: totalY,
				width: barWidth,
				height: outputHeight
			});
			this.appendSvgTitle(outputBar, this.formatBarTooltip(record));

			if (index % labelEvery === 0 || index === records.length - 1) {
				const label = this.appendSvgText(svg, x + barWidth / 2, bottom + 18, formatUsageTimestamp(record.timestamp), "askmate-chart-axis-label");
				label.setAttribute("transform", `rotate(-30 ${x + barWidth / 2} ${bottom + 18})`);
				label.setAttribute("text-anchor", "end");
			}
		});
	}

	private renderTokenRunChart(parent: HTMLElement, records: TokenUsageRecord[]): void {
		type RunChartDatum = {
			record: TokenUsageRecord;
			date: Date;
			totalTokens: number;
		};

		const card = this.createChartCard(
			parent,
			"Token run chart",
			"Line chart of total tokens per operation over time."
		);
		const data = records
			.map((record): RunChartDatum => ({
				record,
				date: new Date(record.timestamp),
				totalTokens: record.totalTokens
			}))
			.filter((datum) => !Number.isNaN(datum.date.getTime()))
			.sort((a, b) => a.date.getTime() - b.date.getTime());
		const width = 640;
		const height = 300;
		const margin = { top: 24, right: 22, bottom: 58, left: 62 };
		const bottom = height - margin.bottom;
		const firstDate = data[0]?.date ?? new Date();
		const lastDate = data[data.length - 1]?.date ?? firstDate;
		const domainStart = firstDate.getTime() === lastDate.getTime()
			? new Date(firstDate.getTime() - 60 * 60 * 1000)
			: firstDate;
		const domainEnd = firstDate.getTime() === lastDate.getTime()
			? new Date(lastDate.getTime() + 60 * 60 * 1000)
			: lastDate;
		const timeSpan = Math.max(1, domainEnd.getTime() - domainStart.getTime());
		const yMax = this.getNiceChartMax(data.reduce((max, datum) => Math.max(max, datum.totalTokens), 1));
		const xScale = (date: Date) => margin.left + ((date.getTime() - domainStart.getTime()) / timeSpan) * (width - margin.left - margin.right);
		const yScale = (value: number) => bottom - (Math.max(0, value) / yMax) * (bottom - margin.top);
		const svg = this.createChartSvg(card, width, height, "Token run chart");
		const average = data.length > 0
			? data.reduce((sum, datum) => sum + datum.totalTokens, 0) / data.length
			: 0;

		this.renderChartYAxis(svg, margin.left, margin.top, bottom, width - margin.right, yMax, yScale);
		this.appendSvgLine(svg, margin.left, bottom, width - margin.right, bottom, "askmate-chart-axis-line");
		this.renderTimeAxisLabels(svg, domainStart, domainEnd, margin.left, width - margin.right, bottom);
		this.appendSvgLine(svg, margin.left, yScale(average), width - margin.right, yScale(average), "askmate-chart-average");

		if (data.length > 0) {
			this.appendSvgElement(svg, "path", {
				class: "askmate-chart-line",
				d: data.map((datum, index) => `${index === 0 ? "M" : "L"}${xScale(datum.date).toFixed(2)},${yScale(datum.totalTokens).toFixed(2)}`).join(" ")
			});
		}

		for (const datum of data) {
			const dot = this.appendSvgElement(svg, "circle", {
				class: "askmate-chart-dot",
				cx: xScale(datum.date),
				cy: yScale(datum.totalTokens),
				r: 4
			});
			this.appendSvgTitle(dot, [
				`${datum.record.title} (${formatUsageTimestamp(datum.record.timestamp)})`,
				`Operation: ${formatOperationKind(datum.record.operationKind)}`,
				`Status: ${formatOperationStatus(datum.record.status)}`,
				`Total: ${formatTokenCount(datum.record.totalTokens)}`,
				`Duration: ${formatDuration(datum.record.durationMs)}`
			].join("\n"));
		}
	}

	private renderRecentUsageTable(parent: HTMLElement, records: TokenUsageRecord[]): void {
		const card = parent.createDiv({ cls: "askmate-usage-table-card" });
		new Setting(card).setName("Recent operations").setHeading();
		const wrapper = card.createDiv({ cls: "askmate-usage-table-wrapper" });
		const table = wrapper.createEl("table", { cls: "askmate-usage-table" });
		const thead = table.createEl("thead");
		const headerRow = thead.createEl("tr");

		for (const heading of ["Time", "Task", "Operation", "Status", "Provider", "Endpoint", "Output", "Model", "Sent", "Received", "Total", "Duration", "Source", "Usage"] as const) {
			headerRow.createEl("th", { text: heading });
		}

		const tbody = table.createEl("tbody");

		for (const record of records) {
			const row = tbody.createEl("tr");
			row.createEl("td", { text: formatUsageTimestamp(record.timestamp) });
			row.createEl("td", { text: truncateLabel(record.title, 30) });
			row.createEl("td", { text: formatOperationKind(record.operationKind) });
			const statusCell = row.createEl("td", { text: formatOperationStatus(record.status) });
			if (record.errorMessage) {
				statusCell.setAttribute("title", record.errorMessage);
			}
			row.createEl("td", { text: truncateLabel(record.providerName, 20) });
			row.createEl("td", { text: formatApiEndpoint(record.endpoint) });
			row.createEl("td", { text: formatOutputMode(record.outputMode) });
			row.createEl("td", { text: truncateLabel(record.model, 24) });
			row.createEl("td", { text: formatTokenCount(record.inputTokens) });
			row.createEl("td", { text: formatTokenCount(record.outputTokens) });
			row.createEl("td", { text: formatTokenCount(record.totalTokens) });
			row.createEl("td", { text: formatDuration(record.durationMs) });
			const sourceLabel = record.sourcePath
				? `${record.contextSource}: ${truncateLabel(record.sourcePath, 38)}`
				: record.contextSource;
			const sourceCell = row.createEl("td", { text: sourceLabel });
			sourceCell.setAttribute("title", record.sourcePath || record.contextSource);
			row.createEl("td", { text: record.estimated ? "Estimated" : "API" });
		}
	}

	private createChartCard(parent: HTMLElement, title: string, description: string): HTMLElement {
		const card = parent.createDiv({ cls: "askmate-chart-card" });
		new Setting(card).setName(title).setHeading();
		card.createEl("p", { text: description });
		return card;
	}

	private createChartSvg(parent: HTMLElement, width: number, height: number, label: string): SVGSVGElement {
		const svg = activeDocument.createElementNS("http://www.w3.org/2000/svg", "svg");
		const id = `askmate-chart-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
		svg.setAttribute("class", "askmate-chart-svg");
		svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
		svg.setAttribute("role", "img");
		svg.setAttribute("aria-labelledby", `${id}-title ${id}-desc`);
		const title = activeDocument.createElementNS("http://www.w3.org/2000/svg", "title");
		title.id = `${id}-title`;
		title.textContent = label;
		svg.appendChild(title);
		const description = activeDocument.createElementNS("http://www.w3.org/2000/svg", "desc");
		description.id = `${id}-desc`;
		description.textContent = `${label}. Detailed operation data is available in the recent operations table below.`;
		svg.appendChild(description);
		parent.appendChild(svg);
		return svg;
	}

	private appendSvgElement<K extends keyof SVGElementTagNameMap>(
		parent: SVGElement,
		tagName: K,
		attributes: Record<string, string | number>
	): SVGElementTagNameMap[K] {
		const element = activeDocument.createElementNS("http://www.w3.org/2000/svg", tagName);
		for (const [key, value] of Object.entries(attributes)) {
			element.setAttribute(key, String(value));
		}
		parent.appendChild(element);
		return element;
	}

	private appendSvgLine(parent: SVGElement, x1: number, y1: number, x2: number, y2: number, className: string): SVGLineElement {
		return this.appendSvgElement(parent, "line", {
			class: className,
			x1,
			y1,
			x2,
			y2
		});
	}

	private appendSvgText(parent: SVGElement, x: number, y: number, text: string, className: string): SVGTextElement {
		const element = this.appendSvgElement(parent, "text", {
			class: className,
			x,
			y
		});
		element.textContent = text;
		return element;
	}

	private appendSvgTitle(parent: SVGElement, text: string): void {
		const title = activeDocument.createElementNS("http://www.w3.org/2000/svg", "title");
		title.textContent = text;
		parent.appendChild(title);
	}

	private renderChartYAxis(
		svg: SVGSVGElement,
		x: number,
		top: number,
		bottom: number,
		right: number,
		yMax: number,
		yScale: (value: number) => number
	): void {
		this.appendSvgLine(svg, x, top, x, bottom, "askmate-chart-axis-line");
		for (let index = 0; index <= 4; index += 1) {
			const value = Math.round((yMax / 4) * index);
			const y = yScale(value);
			this.appendSvgLine(svg, x - 4, y, right, y, index === 0 ? "askmate-chart-grid-line askmate-chart-grid-line-base" : "askmate-chart-grid-line");
			const label = this.appendSvgText(svg, x - 8, y + 4, formatTokenCount(value), "askmate-chart-axis-label");
			label.setAttribute("text-anchor", "end");
		}
	}

	private renderTimeAxisLabels(svg: SVGSVGElement, start: Date, end: Date, left: number, right: number, bottom: number): void {
		for (let index = 0; index <= 4; index += 1) {
			const ratio = index / 4;
			const x = left + (right - left) * ratio;
			const date = new Date(start.getTime() + (end.getTime() - start.getTime()) * ratio);
			const label = this.appendSvgText(svg, x, bottom + 22, formatUsageTimestamp(date.toISOString()), "askmate-chart-axis-label");
			label.setAttribute("text-anchor", index === 0 ? "start" : index === 4 ? "end" : "middle");
		}
	}

	private getNiceChartMax(value: number): number {
		if (!Number.isFinite(value) || value <= 0) {
			return 1;
		}

		const exponent = Math.floor(Math.log10(value));
		const base = 10 ** exponent;
		const normalized = value / base;
		const niceNormalized = normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
		return niceNormalized * base;
	}

	private formatBarTooltip(record: TokenUsageRecord): string {
		return [
			`${record.title} (${formatUsageTimestamp(record.timestamp)})`,
			`Operation: ${formatOperationKind(record.operationKind)}`,
			`Status: ${formatOperationStatus(record.status)}`,
			`Sent: ${formatTokenCount(record.inputTokens)}`,
			`Received: ${formatTokenCount(record.outputTokens)}`,
			`Total: ${formatTokenCount(record.totalTokens)}`,
			record.estimated ? "Usage is estimated or unavailable" : "Usage is from the API"
		].join("\n");
	}

	private renderChartLegend(parent: HTMLElement, items: Array<[string, string]>): void {
		const legend = parent.createDiv({ cls: "askmate-chart-legend" });

		for (const [label, swatchClass] of items) {
			const item = legend.createDiv({ cls: "askmate-chart-legend-item" });
			item.createSpan({ cls: `askmate-chart-legend-swatch ${swatchClass}` });
			item.createSpan({ text: label });
		}
	}
}
