import { SecretComponent, type App, type ButtonComponent, type DropdownComponent, type ExtraButtonComponent, type Setting, type SettingDefinition, type SettingDefinitionItem, type SettingDefinitionPage, type TextComponent, type ToggleComponent } from "obsidian";
import type { AskMatePlugin } from "../../plugin/AskMatePlugin";
import {
	IDLE_SETUP_TEST,
	SETUP_ACTIONS,
	buildSecretId,
	checkApiKeyInput,
	deriveSetupState,
	describeSetupStage,
	getProviderCatalogEntry,
	mapProviderErrorToSetupCopy,
	providerKeyIssue,
	type SetupErrorCopy,
	type SetupStage,
	type SetupTestState
} from "../../setup";
import type { McpServerStatus, TrustOutcome } from "../../mcp";
import type { Diagnostic, Skill, SkillStatus } from "../../skills";
import {
	DEFAULT_LOCAL_BASE_URL,
	DEFAULT_PROVIDER_SETTINGS,
	GPT_IMAGE_2_MODEL_ID,
	REASONING_EFFORT_OPTIONS,
	TEXT_PROVIDER_IDS,
	getProviderLabel,
	normalizeProviderModelOptions,
	normalizeTextProviderId,
	validateAzureOpenAIBaseUrl,
	validateProviderBaseUrl,
	type AskMateSettings,
	type TextProviderId
} from "../../shared/core";
import { pluralise } from "./settingsSummaries";
import { resolveBaseUrlInput, type IntegerBounds, type SettingControlKey } from "./settingsInputs";

// ---------------------------------------------------------------------------------------------------------------------
// The surface of the settings tab that the page builders use, and the wave 2 members of the plugin
// ---------------------------------------------------------------------------------------------------------------------

export type FeedbackKind = "error" | "warning" | "success" | "info";
export type DefinitionExtras = { aliases?: string[]; visible?: boolean | (() => boolean) };

/**
 * What the skills service offers the settings page. The real SkillService satisfies it; the page reaches it through the plugin
 * with optional chaining, so it also works in a build where the service does not exist yet.
 */
export interface SkillServiceView {
	list(): readonly Skill[];
	issues?(): readonly Diagnostic[];
	statusOf(skill: Skill): SkillStatus;
	scan(): Promise<void>;
	trust(id: string, hash: string): Promise<void>;
	revoke?(id: string): Promise<void>;
	onChange(callback: () => void): () => void;
}

/** What the MCP service offers the settings page. */
export interface McpServiceView {
	status(): readonly McpServerStatus[];
	trust(serverId: string): Promise<TrustOutcome>;
	revokeTrust(serverId: string): Promise<void>;
	testConnection(serverId: string, signal?: AbortSignal): Promise<McpServerStatus | null>;
	reconcile(): Promise<void>;
	onStatusChange(callback: () => void): () => void;
	snapshotTools?(): { tools: ReadonlyArray<{ serverId: string; toolName: string; title: string; description: string; warnings: readonly string[]; pin: "new" | "approved" | "changed"; claimsReadOnly: boolean }> };
}

/** The result of a connection test, as far as this page needs it. */
export interface ConnectionTestView {
	ok: boolean;
	message: string;
	modelFound?: boolean | null;
	suggestedModel?: string | null;
}

/**
 * Plugin members that arrive with the wave 2 integration. Each is optional, so this page compiles and runs without them and
 * uses them once they exist.
 */
export interface PluginWave2Api {
	skillService?: SkillServiceView | null;
	mcpService?: McpServiceView | null;
	getSetupState?: () => SetupStage;
	saveProviderApiKey?: (providerId: TextProviderId, apiKey: string) => Promise<void>;
	testProviderConnectionDetailed?: () => Promise<ConnectionTestView>;
	openSettingsTab?: () => void;
	/**
	 * Forgets a server's device trust without the running service, which does not exist while tools are off. Not in the wave 2
	 * contract yet: the page uses it when the plugin offers it and otherwise says that trust cannot be revoked.
	 */
	revokeMcpTrust?: (serverId: string) => Promise<void>;
}

/** State the Connection page keeps across redraws of the page. */
export interface ConnectionState {
	lastTest: SetupTestState;
	showMoreOptions: boolean;
}

/** The helpers of the settings tab that the page builders share. The tab implements it. */
export interface SettingsPageHost {
	readonly app: App;
	readonly plugin: AskMatePlugin;
	readonly extras: PluginWave2Api;
	readonly connection: ConnectionState;
	/** Skill text approved in this session, so a later review can show what changed. Not stored: it ends with the session. */
	readonly approvedSkillText: Map<string, string>;
	/** A row that redraws the page takes focus again when it finds its key here, so a keyboard user does not lose their place. */
	focusAfterRebuild: string | null;
	hasSecret(secretName: string): boolean;
	currentStage(): SetupStage;
	update(): void;
	refreshDomState(): void;
	runSettingAction(action: () => Promise<void>): Promise<void>;
	saveUiSetting(refreshViews?: boolean): Promise<void>;
	scheduleSave(): void;
	setupToggle(toggle: ToggleComponent, label: string, value: boolean, onChange: (value: boolean) => void | Promise<void>): void;
	labelControl(el: HTMLElement, label: string): void;
	describeExtraButton(button: ExtraButtonComponent, label: string): void;
	setExtraButtonDisabled(button: ExtraButtonComponent, disabled: boolean): void;
	keepFocusWhileBusy(el: HTMLElement, setBusy: (busy: boolean) => void, action: () => Promise<void>): Promise<void>;
	prepareFieldFeedback(setting: Setting): HTMLElement;
	setFieldFeedback(setting: Setting, message: string | null, kind?: FeedbackKind): void;
	bindCommitOnBlurOrEnter(inputEl: HTMLInputElement, commit: () => Promise<void>): () => void;
	bindCommitOnBlur(inputEl: HTMLInputElement | HTMLTextAreaElement, commit: () => Promise<void>, commitOnEnter: boolean): () => void;
	toggleDefinition(key: SettingControlKey, name: string, desc: string, extras?: DefinitionExtras): SettingDefinition;
	dropdownDefinition(key: SettingControlKey, name: string, desc: string, options: Record<string, string>, extras?: DefinitionExtras): SettingDefinition;
	noteDefinition(text: string): SettingDefinition;
	integerDefinition(name: string, desc: string, options: { bounds: IntegerBounds; getValue: () => number; setValue: (value: number) => void }, extras?: DefinitionExtras): SettingDefinition;
	imperativePage(name: string, desc: string, renderPage: (containerEl: HTMLElement, refresh: () => void) => void, options?: { displayValue?: () => string; onHide?: () => void }): SettingDefinitionPage;
}

// ---------------------------------------------------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------------------------------------------------

export type ChipTone = "ready" | "warning" | "error" | "off" | "busy";

export function statusChipClass(tone: ChipTone): string {
	return `askmate-status-chip is-${tone}`;
}

/** The chip beside the connection status. The words carry the meaning, because colour alone is not announced. */
export function connectionChip(stage: SetupStage): { tone: ChipTone; label: string } {
	switch (stage.kind) {
		case "needs-key":
		case "needs-endpoint":
		case "needs-model":
			return { tone: "warning", label: "Setup needed" };
		case "key-missing":
			return { tone: "warning", label: "Key missing" };
		case "untested":
			return { tone: "off", label: "Not tested" };
		case "testing":
			return { tone: "busy", label: "Testing" };
		case "test-failed":
			return { tone: "error", label: "Connection failed" };
		case "ready":
			return { tone: "ready", label: "Connected" };
	}
}

export interface LinkPart {
	text: string;
	href: string;
}

/**
 * A description with links. The fragment is built with the DOM directly, because the settings API takes a fragment and the
 * elements must belong to the window the settings are shown in.
 */
export function linkFragment(parts: ReadonlyArray<string | LinkPart>): DocumentFragment {
	return createFragment((fragment) => {
		for (const part of parts) {
			if (typeof part === "string") {
				fragment.appendText(part);
			} else {
				fragment.createEl("a", { text: part.text, href: part.href, attr: { rel: "noopener noreferrer", target: "_blank" } });
			}
		}
	});
}

/** The key page for a provider, or null for one that has none (a local server, or a deployment you create yourself). */
export function keyLinkFor(providerId: TextProviderId): LinkPart | null {
	const url = getProviderCatalogEntry(providerId).keyUrl;
	return url ? { text: "Get an API key", href: url } : null;
}

export function describeKeyField(providerId: TextProviderId, hasStoredKey: boolean): string {
	const entry = getProviderCatalogEntry(providerId);
	const where = "Saved in your system keychain, never in your vault.";
	if (!entry.needsKey) {
		return `Optional for a local server. ${where}`;
	}
	return hasStoredKey ? `A key is saved on this device. Paste a new one to replace it. ${where}` : `Paste your key once. ${where}`;
}

/**
 * The secret id a pasted key is saved under. A key AskMate saved earlier for this provider is replaced in place, so updating a key
 * leaves nothing behind. Any other name is not AskMate's to overwrite (it may be another plugin's secret), so a new id is used.
 */
export function chooseSecretId(providerId: TextProviderId, currentName: string, existingIds: readonly string[]): string {
	const own = new RegExp(`^askmate-${providerId}-key(?:-\\d+)?$`);
	return own.test(currentName.trim()) ? currentName.trim() : buildSecretId(providerId, existingIds);
}

export type KeySavePlan = { ok: true; key: string; secretId: string } | { ok: false; message: string };

export function planKeySave(providerId: TextProviderId, rawKey: string, currentName: string, existingIds: readonly string[]): KeySavePlan {
	const checked = checkApiKeyInput(rawKey);
	return checked.ok ? { ok: true, key: checked.key, secretId: chooseSecretId(providerId, currentName, existingIds) } : checked;
}

/** What the page says about the key, mirroring the shared setup rules so it cannot disagree with the sidebar. */
export function describeKeyState(providerId: TextProviderId, settings: Pick<AskMateSettings, "providers">, hasSecret: (name: string) => boolean): string | null {
	return providerKeyIssue(providerId, settings, hasSecret) === "key-missing"
		? "A key name is saved, but this device has no key for it. Paste the key again."
		: null;
}

/**
 * The keychain picker draws a button called only "Link" or "Change", which names nothing. The component does not expose it,
 * so it is found in the row; when it is not there (a different Obsidian build) nothing is lost.
 */
export function nameSecretButton(container: HTMLElement, label: string): void {
	container.querySelector("button")?.setAttribute("aria-label", label);
}

/** Hides a row until `show` returns true. A row's own `visible` still applies, so both must hold. */
export function gatedBy(item: SettingDefinition, show: () => boolean): SettingDefinition {
	const own = item.visible;
	return { ...item, visible: () => show() && (own === undefined ? true : typeof own === "function" ? own() : own) };
}

export interface ConnectionOutcome {
	test: SetupTestState;
	feedback: { kind: FeedbackKind; message: string };
}

/**
 * Turns a connection test into the state the status row shows and the one line of feedback under the button. A model that the
 * provider does not list counts as a failure, because a request for it would fail, and the feedback names the closest listed one.
 */
export function interpretConnectionTest(input: { providerId: TextProviderId; model: string; baseUrl?: string; result: ConnectionTestView }): ConnectionOutcome {
	const { providerId, model, baseUrl, result } = input;
	const failed = (copy: SetupErrorCopy, extra = ""): ConnectionOutcome => ({
		test: { status: "failed", providerId, model, copy },
		feedback: { kind: "error", message: `${copy.message}${extra}` }
	});
	if (!result.ok) {
		return failed(mapProviderErrorToSetupCopy(new Error(result.message), { providerId, baseUrl, model }));
	}
	if (result.modelFound === false) {
		const copy = mapProviderErrorToSetupCopy(new Error(`The model "${model}" was not found.`), { providerId, baseUrl, model });
		const suggestion = result.suggestedModel ? ` The closest listed model is ${result.suggestedModel}.` : "";
		return failed({ ...copy, action: SETUP_ACTIONS["choose-model"] }, suggestion);
	}
	return { test: { status: "ok", providerId, model }, feedback: { kind: "success", message: result.message } };
}

/** Test connection wording for the provider, including how long it may take. Azure sends a real request, which can be slow. */
export function describeTestConnection(providerId: TextProviderId): string {
	if (providerId === "azure-openai" || providerId === "azure-ai") {
		return "Sends a short text request to the selected deployment. It may use a few tokens and can take up to a minute.";
	}
	return "Checks that the provider answers and lists the selected model. It times out after 10 seconds.";
}

export function isImageOnlyModel(model: string): boolean {
	return model.trim().toLowerCase().startsWith("gpt-image") || model.trim().toLowerCase() === GPT_IMAGE_2_MODEL_ID;
}

/** Image models answer image requests only, so the chat list leaves them out. The selected model always stays, so the list is never blank. */
export function chatModelOptions(options: readonly string[], selected: string): string[] {
	return options.filter((option) => option === selected || !isImageOnlyModel(option));
}

/** Removes one saved model or deployment. When it was the selected one, the first remaining takes its place, or none is selected. */
export function removeSavedModel(options: readonly string[], selected: string, removed: string): { options: string[]; model: string } {
	const remaining = options.filter((option) => option !== removed);
	return { options: remaining, model: selected === removed ? remaining[0] ?? "" : selected };
}

// ---------------------------------------------------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------------------------------------------------

/** Provider, key, model and test, then a "More options" group that stays closed until it is asked for. */
export function buildConnectionItems(host: SettingsPageHost): SettingDefinitionItem[] {
	const { plugin, app } = host;
	const providerId = plugin.getSelectedTextProviderId();
	const provider = plugin.getProviderSettings(providerId);
	const providerLabel = getProviderLabel(providerId);
	const isAzureOpenAI = providerId === "azure-openai";
	const isAzureAI = providerId === "azure-ai";
	const isCompatible = providerId === "openai-compatible";
	const modelLabel = isAzureOpenAI ? "Deployment" : "Model";

	let testSetting: Setting | null = null;
	let modelSetting: Setting | null = null;
	let modelDropdown: DropdownComponent | null = null;
	let manualModelText: TextComponent | null = null;
	let keyInput: HTMLInputElement | null = null;
	let keySetting: Setting | null = null;
	let statusSetting: Setting | null = null;
	let statusChip: HTMLElement | null = null;
	let statusList: HTMLElement | null = null;

	const paintStatus = (): void => {
		if (!statusSetting || !statusChip || !statusList) {
			return;
		}
		const stage = host.currentStage();
		const copy = describeSetupStage(stage);
		const chip = connectionChip(stage);
		statusSetting.setName(copy.headline);
		statusChip.className = statusChipClass(chip.tone);
		statusChip.setText(chip.label);
		statusList.empty();
		const issues = "issues" in stage ? stage.issues.map((issue) => issue.message) : [];
		// The warning border belongs to a row that still lists something to fix.
		statusSetting.settingEl.toggleClass("askmate-settings-setup", issues.length > 0);
		if (issues.length > 0) {
			for (const issue of issues) {
				statusList.createEl("li", { text: issue });
			}
		} else if (copy.detail) {
			statusList.createEl("li", { text: copy.detail });
		}
	};

	const clearTestResult = (): void => {
		host.connection.lastTest = IDLE_SETUP_TEST;
		if (testSetting) {
			host.setFieldFeedback(testSetting, null);
		}
	};

	const keyIsStored = (): boolean => provider.apiKeySecretName.trim() !== "" && host.hasSecret(provider.apiKeySecretName.trim());
	const keyDescription = (): string | DocumentFragment => {
		const link = keyLinkFor(providerId);
		const text = describeKeyField(providerId, keyIsStored());
		return link ? linkFragment([`${text} `, link]) : text;
	};
	// The key row says whether a key is saved, so it follows a save or a pick from the keychain without a redraw.
	const paintKey = (): void => {
		if (keySetting && keyInput) {
			keySetting.setDesc(keyDescription());
			keyInput.placeholder = keyIsStored() ? "Saved. Paste a new key to replace it" : "Paste your key";
		}
	};

	const afterConnectionChange = (): void => {
		clearTestResult();
		paintKey();
		paintStatus();
		host.refreshDomState();
	};

	const runTest = async (button: ButtonComponent): Promise<void> => {
		if (!testSetting) {
			return;
		}
		const setting = testSetting;
		await host.keepFocusWhileBusy(button.buttonEl, (busy) => {
			button.setButtonText(busy ? "Testing..." : "Test connection").setDisabled(busy);
		}, async () => {
			host.setFieldFeedback(setting, null);
			const model = plugin.getProviderSettings(providerId).model.trim();
			host.connection.lastTest = { status: "testing", providerId, model };
			paintStatus();
			let result: ConnectionTestView;
			try {
				result = host.extras.testProviderConnectionDetailed
					? await host.extras.testProviderConnectionDetailed()
					: { ok: true, message: await plugin.testSelectedProviderConnection(), modelFound: null };
			} catch (error) {
				result = { ok: false, message: plugin.getErrorMessage(error) };
			}
			const outcome = interpretConnectionTest({ providerId, model, baseUrl: provider.baseUrl, result });
			host.connection.lastTest = outcome.test;
			host.setFieldFeedback(setting, outcome.feedback.message, outcome.feedback.kind);
			paintStatus();
			host.refreshDomState();
		});
	};

	const saveKey = async (): Promise<void> => {
		if (!keyInput || !keySetting) {
			return;
		}
		const input = keyInput;
		const setting = keySetting;
		let existingIds: string[] = [];
		try {
			existingIds = app.secretStorage.listSecrets();
		} catch {
			existingIds = [];
		}
		const plan = planKeySave(providerId, input.value, provider.apiKeySecretName, existingIds);
		if (!plan.ok) {
			host.setFieldFeedback(setting, plan.message);
			return;
		}
		try {
			if (host.extras.saveProviderApiKey) {
				await host.extras.saveProviderApiKey(providerId, plan.key);
			} else {
				// setSecret throws for an id the keychain refuses, so a failure is reported here instead of being lost.
				app.secretStorage.setSecret(plan.secretId, plan.key);
				provider.apiKeySecretName = plan.secretId;
				await host.saveUiSetting();
			}
		} catch (error) {
			host.setFieldFeedback(setting, `AskMate could not save the key. ${plugin.getErrorMessage(error)}`);
			return;
		}
		input.value = "";
		host.setFieldFeedback(setting, "Key saved on this device. Checking the connection...", "success");
		afterConnectionChange();
		if (testSetting) {
			const testButton = testSetting.components.find((component): component is ButtonComponent => "buttonEl" in component);
			if (testButton) {
				await runTest(testButton);
			}
		}
		// The test has its own line, so this one goes back to saying only what was saved.
		host.setFieldFeedback(setting, "Key saved on this device.", "success");
	};

	const statusRow: SettingDefinition = {
		name: "Status",
		searchable: false,
		render: (setting) => {
			statusSetting = setting;
			setting.settingEl.addClass("askmate-settings-status");
			statusChip = setting.controlEl.createSpan({ cls: statusChipClass("off") });
			statusList = setting.descEl.createEl("ul", { cls: "askmate-settings-setup-list" });
			setting.addButton((button) => {
				button.setButtonText("Open AskMate").onClick(() => {
					void host.runSettingAction(async () => {
						// Called as a member: the real method reads `this`, so a detached reference would throw.
						await plugin.activateView();
						// Closing the settings window leaves the sidebar in view. The close method is not documented API, so it is optional.
						(app as unknown as { setting?: { close?: () => void } }).setting?.close?.();
					});
				});
			});
			paintStatus();
		}
	};

	const providerItems: SettingDefinition[] = [
		{
			name: "Chat provider",
			desc: "The provider that answers your questions and runs workflows.",
			render: (setting) => {
				setting.addDropdown((dropdown) => {
					host.labelControl(dropdown.selectEl, "Chat provider");
					for (const id of TEXT_PROVIDER_IDS) {
						dropdown.addOption(id, getProviderLabel(id));
					}
					dropdown.setValue(providerId).onChange(async (value) => {
						const nextProviderId = normalizeTextProviderId(value);
						plugin.settings.providerRoles.chatProviderId = nextProviderId;
						plugin.settings.selectedTextProvider = nextProviderId;
						host.connection.lastTest = IDLE_SETUP_TEST;
						await host.runSettingAction(() => host.saveUiSetting());
						// The key, address and model rows depend on the provider, so the page is rebuilt.
						host.update();
					});
				});
			}
		},
		{
			name: isCompatible ? "API key (optional)" : "API key",
			desc: keyDescription(),
			aliases: ["secret", "token", "credentials", "key"],
			render: (setting) => {
				keySetting = setting;
				host.prepareFieldFeedback(setting);
				const stateMessage = describeKeyState(providerId, plugin.settings, (name) => host.hasSecret(name));
				if (stateMessage) {
					host.setFieldFeedback(setting, stateMessage, "info");
				}
				setting.addText((text) => {
					keyInput = text.inputEl;
					text.inputEl.type = "password";
					text.inputEl.autocomplete = "off";
					text.inputEl.spellcheck = false;
					host.labelControl(text.inputEl, `${providerLabel} API key`);
					text.setPlaceholder(keyIsStored() ? "Saved. Paste a new key to replace it" : "Paste your key");
					text.inputEl.addEventListener("keydown", (event) => {
						if (event.key === "Enter" && !event.isComposing) {
							event.preventDefault();
							void host.runSettingAction(saveKey);
						}
					});
				});
				setting.addButton((button) => {
					host.labelControl(button.buttonEl, `Save ${providerLabel} API key`);
					button.setButtonText("Save key").setCta().onClick(() => {
						void host.keepFocusWhileBusy(button.buttonEl, (busy) => { button.setDisabled(busy); }, () => host.runSettingAction(saveKey));
					});
				});
			}
		}
	];

	if (isCompatible || isAzureOpenAI || isAzureAI) {
		const baseUrlFallback = DEFAULT_PROVIDER_SETTINGS[providerId].baseUrl;
		const baseUrlName = isAzureOpenAI ? "Azure OpenAI base URL" : isAzureAI ? "Azure AI Foundry endpoint" : "Local or self-hosted base URL";
		providerItems.push({
			name: baseUrlName,
			desc: isAzureOpenAI
				? "Use the v1 base URL, for example https://<resource>.openai.azure.com/openai/v1."
				: isAzureAI
					? "Use the inference endpoint, for example https://<resource>.services.ai.azure.com/models."
					: `The server address, for example ${DEFAULT_LOCAL_BASE_URL} for Ollama.`,
			render: (setting) => {
				host.prepareFieldFeedback(setting);
				setting.addText((text) => {
					host.labelControl(text.inputEl, baseUrlName);
					text
						.setPlaceholder(isAzureOpenAI ? "https://<resource>.openai.azure.com/openai/v1" : isAzureAI ? "https://<resource>.services.ai.azure.com/models" : DEFAULT_LOCAL_BASE_URL)
						.setValue(provider.baseUrl);
					// Validating per keystroke saved half-typed URLs, so commit only when editing ends.
					host.bindCommitOnBlurOrEnter(text.inputEl, async () => {
						const result = resolveBaseUrlInput(text.getValue(), baseUrlFallback, (value, fallback) => isAzureOpenAI
							? validateAzureOpenAIBaseUrl(value, fallback)
							: validateProviderBaseUrl(value, fallback, providerLabel));
						if (result.kind === "invalid") {
							host.setFieldFeedback(setting, `${result.message} The previous address is still saved.`);
							return;
						}
						text.setValue(result.value);
						if (result.kind === "restore-default") {
							host.setFieldFeedback(setting, result.value
								? `Field cleared, so AskMate restored the default: ${result.value}`
								: "Field cleared. Requests will fail until you enter an address.", result.value ? "info" : "error");
						} else {
							host.setFieldFeedback(setting, null);
						}
						if (result.value === provider.baseUrl) {
							return;
						}
						provider.baseUrl = result.value;
						await host.saveUiSetting();
						afterConnectionChange();
					});
				});
			}
		});
	}

	const syncModelDropdown = (): void => {
		if (!modelDropdown) {
			return;
		}
		modelDropdown.selectEl.empty();
		for (const model of chatModelOptions(provider.modelOptions, provider.model)) {
			modelDropdown.addOption(model, model);
		}
		modelDropdown.setValue(plugin.getSelectedModel());
		if (modelSetting) {
			host.setFieldFeedback(modelSetting, isImageOnlyModel(provider.model) ? "This is an image model. Chat requests to it will fail, so choose a text model." : null);
		}
	};

	const modelRow: SettingDefinition = {
		name: modelLabel,
		desc: isAzureOpenAI
			? "Pick a saved deployment, or add one with the name box below."
			: isAzureAI
				? "The Azure AI Foundry model or deployment that answers."
				: "The model that answers. Use the refresh button to load the list your provider offers.",
		// An Azure OpenAI deployment cannot be listed with a key, so the list stays hidden until one has been entered.
		visible: () => !isAzureOpenAI || provider.modelOptions.length > 0,
		render: (setting) => {
			modelSetting = setting;
			host.prepareFieldFeedback(setting);
			setting.addDropdown((dropdown) => {
				modelDropdown = dropdown;
				host.labelControl(dropdown.selectEl, modelLabel);
				syncModelDropdown();
				dropdown.onChange(async (value) => {
					provider.model = value;
					manualModelText?.setValue(value);
					await host.runSettingAction(() => host.saveUiSetting());
					syncModelDropdown();
					afterConnectionChange();
				});
			});
			if (isAzureOpenAI) {
				setting.addExtraButton((button) => {
					host.describeExtraButton(button.setIcon("trash"), "Remove the selected deployment from the list");
					button.onClick(() => {
						const next = removeSavedModel(provider.modelOptions, provider.model, modelDropdown?.getValue() ?? provider.model);
						provider.modelOptions = next.options;
						provider.model = next.model;
						manualModelText?.setValue(provider.model);
						void host.runSettingAction(() => host.saveUiSetting()).then(() => {
							syncModelDropdown();
							afterConnectionChange();
						});
					});
				});
				return;
			}
			setting.addExtraButton((button) => {
				host.describeExtraButton(button.setIcon("refresh-cw"), "Refresh models");
				button.onClick(() => {
					void host.keepFocusWhileBusy(button.extraSettingsEl, (busy) => host.setExtraButtonDisabled(button, busy), async () => {
						host.setFieldFeedback(setting, null);
						try {
							const models = await plugin.refreshSelectedProviderModels();
							syncModelDropdown();
							manualModelText?.setValue(provider.model);
							afterConnectionChange();
							host.setFieldFeedback(setting, `Loaded ${pluralise(models.length, "model")}.`, "success");
						} catch (error) {
							host.setFieldFeedback(setting, plugin.getErrorMessage(error));
						}
					});
				});
			});
		}
	};

	const testRow: SettingDefinition = {
		name: "Test connection",
		desc: describeTestConnection(providerId),
		render: (setting) => {
			testSetting = setting;
			host.prepareFieldFeedback(setting);
			setting.addButton((button) => {
				button.setButtonText("Test connection").onClick(() => {
					void runTest(button);
				});
			});
		}
	};

	const manualModelRow: SettingDefinition = {
		name: isAzureOpenAI ? "Deployment name" : isAzureAI ? "Model or deployment name" : "Model ID",
		desc: isAzureOpenAI
			? "Type the deployment name exactly as it appears in Azure. Deployments cannot be listed with an API key."
			: "Use this when your provider offers a model that the refresh button does not list.",
		render: (setting) => {
			host.prepareFieldFeedback(setting);
			setting.addText((text) => {
				manualModelText = text;
				host.labelControl(text.inputEl, isAzureOpenAI ? "Deployment name" : "Model ID");
				text.setPlaceholder(isAzureOpenAI ? "my-gpt-deployment" : DEFAULT_PROVIDER_SETTINGS[providerId].model).setValue(provider.model);
				host.bindCommitOnBlurOrEnter(text.inputEl, async () => {
					const model = text.getValue().trim();
					if (!model) {
						text.setValue(provider.model);
						host.setFieldFeedback(setting, provider.model
							? `Enter ${isAzureOpenAI ? "a deployment name" : "a model ID"}. AskMate kept ${provider.model}.`
							: `Enter ${isAzureOpenAI ? "a deployment name" : "a model ID"}.`, "info");
						return;
					}
					host.setFieldFeedback(setting, null);
					if (model === provider.model) {
						return;
					}
					provider.model = model;
					// Azure lists belong to the person, so no built-in suggestion is added back to them.
					const fallback = isAzureOpenAI || isAzureAI ? provider.modelOptions : DEFAULT_PROVIDER_SETTINGS[providerId].modelOptions;
					provider.modelOptions = normalizeProviderModelOptions(provider.modelOptions, fallback, model);
					await host.saveUiSetting();
					syncModelDropdown();
					afterConnectionChange();
				});
			});
		}
	};

	const savedKeyRow: SettingDefinition = {
		name: "Use a saved key",
		desc: "Pick a key you already saved in Obsidian's keychain.",
		render: (setting) => {
			setting.addComponent((el) => {
				const picker = new SecretComponent(app, el)
					.setValue(provider.apiKeySecretName)
					.onChange(async (value) => {
						provider.apiKeySecretName = value;
						await host.runSettingAction(() => host.saveUiSetting());
						afterConnectionChange();
					});
				nameSecretButton(el, `${providerLabel} API key from the keychain`);
				return picker;
			});
		}
	};

	// An Azure OpenAI deployment cannot be listed, so its name box is the only way to set a value the provider requires. It sits with
	// the provider rows instead of behind the switch, where a new install would never find it.
	const moreItems: SettingDefinition[] = isAzureOpenAI ? [savedKeyRow] : [manualModelRow, savedKeyRow];
	moreItems.push(host.dropdownDefinition(
		"reasoningEffort",
		"Reasoning effort",
		"How much OpenAI models think before answering. AskMate leaves it out for models that do not support the level.",
		Object.fromEntries(REASONING_EFFORT_OPTIONS.map((option) => [option.value, option.label])),
		{ visible: () => usesOpenAIReasoning(plugin) }
	));
	if (providerId !== "openai") {
		moreItems.push({
			name: "OpenAI image API key",
			desc: "Add an OpenAI key to use the Image button or the /image command. Images are always made with OpenAI.",
			render: (setting) => {
				setting.addComponent((el) => {
					const picker = new SecretComponent(app, el)
						.setValue(plugin.getProviderSettings("openai").apiKeySecretName)
						.onChange(async (value) => {
							plugin.getProviderSettings("openai").apiKeySecretName = value;
							await host.runSettingAction(() => host.saveUiSetting());
						});
					nameSecretButton(el, "OpenAI image API key from the keychain");
					return picker;
				});
			}
		});
	}
	moreItems.push(host.dropdownDefinition(
		"imagePromptPlanningProviderId",
		"Improve image prompts with",
		"The text provider that rewrites an image request into a better prompt before it is drawn.",
		{
			"same-as-chat": "Same as chat provider",
			...Object.fromEntries(TEXT_PROVIDER_IDS.map((id) => [id, getProviderLabel(id)]))
		}
	));

	// The extra rows follow the switch one by one, because a row's own visibility is re-evaluated in place without redrawing the page.
	const showMore = (): boolean => host.connection.showMoreOptions;
	return [
		statusRow,
		{ type: "group", heading: "Provider", items: [...providerItems, modelRow, ...(isAzureOpenAI ? [manualModelRow] : []), testRow] },
		{
			type: "group",
			heading: "More options",
			items: [
				{
					name: "Show more options",
					desc: "Manual model name, reasoning effort, saved keys, and image settings.",
					searchable: false,
					render: (setting) => {
						setting.addToggle((toggle) => {
							host.setupToggle(toggle, "Show more connection options", host.connection.showMoreOptions, (value) => {
								host.connection.showMoreOptions = value;
								host.refreshDomState();
							});
						});
					}
				},
				...moreItems.map((item) => gatedBy(item, showMore))
			]
		}
	];
}

// Only OpenAI requests carry reasoning effort: chat on OpenAI, or image prompt planning set to OpenAI.
function usesOpenAIReasoning(plugin: AskMatePlugin): boolean {
	return plugin.getSelectedTextProviderId() === "openai" || plugin.settings.providerRoles.imagePromptPlanningProviderId === "openai";
}

/** The setup stage derived from the settings and this device's keychain, used when the plugin offers no shared one. */
export function deriveLocalStage(plugin: AskMatePlugin, hasSecret: (name: string) => boolean, lastTest: SetupTestState): SetupStage {
	return deriveSetupState(plugin.settings, hasSecret, lastTest);
}
