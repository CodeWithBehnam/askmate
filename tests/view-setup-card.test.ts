import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { DEFAULT_SETTINGS } from "../src/settings/defaults";
import { deriveProviderSetupState, getProviderCatalogEntry, mapProviderErrorToSetupCopy, type SetupAction, type SetupStage } from "../src/setup";
import type { AskMateSettings, ProviderSettings, TextProviderId } from "../src/shared/types";
import { renderSetupCard, type SetupCardCallbacks, type SetupCardDraft } from "../src/ui/sidebar/components/SetupCard";
import { canFinishInCard, deriveSetupCardModel, overlayTestResult, SETUP_PRIVACY_LINE, type SetupCardInput } from "../src/ui/sidebar/components/setupCardModel";
import { createFakeEl, fireDomEvent, installDomGlobals } from "./support/fake-dom";

function settingsFor(providerId: TextProviderId, patch: Partial<ProviderSettings> = {}): AskMateSettings {
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.providerRoles.chatProviderId = providerId;
	settings.selectedTextProvider = providerId;
	settings.providers[providerId] = { ...settings.providers[providerId], ...patch };
	return settings;
}

const stageOf = (providerId: TextProviderId, patch: Partial<ProviderSettings> = {}, test: Parameters<typeof deriveProviderSetupState>[3] = { status: "idle" }): SetupStage =>
	deriveProviderSetupState(providerId, settingsFor(providerId, patch), () => true, test);

function input(overrides: Partial<SetupCardInput> = {}): SetupCardInput {
	return {
		stage: stageOf("openai"),
		selectedProvider: "openai",
		flowOpen: false,
		welcomeOpen: false,
		hasOpenNote: true,
		hasStoredKey: false,
		...overrides
	};
}

describe("when the card shows", () => {
	test("a fresh install shows the connect card in every layout, because the stage is not ready", () => {
		const model = deriveSetupCardModel(input());
		expect(model.visible).toBe(true);
		expect(model.phase).toBe("connect");
		expect(model.title).toBe("Connect an AI provider");
		expect(model.showKeyField).toBe(true);
		expect(model.primaryLabel).toBe("Connect");
		expect(model.privacy).toBe(SETUP_PRIVACY_LINE);
	});

	test("a returning user with a key is left alone", () => {
		const model = deriveSetupCardModel(input({ stage: stageOf("openai", { apiKeySecretName: "askmate-openai-key" }), hasStoredKey: true }));
		expect(model.visible).toBe(false);
	});

	test("the same user sees it when they ask, with a test button instead of a connect button", () => {
		const model = deriveSetupCardModel(input({ stage: stageOf("openai", { apiKeySecretName: "askmate-openai-key" }), hasStoredKey: true, flowOpen: true }));
		expect(model.visible).toBe(true);
		expect(model.primaryLabel).toBe("Test connection");
	});

	test("a key that is missing on this device asks for it again", () => {
		const stage = deriveProviderSetupState("openai", settingsFor("openai", { apiKeySecretName: "askmate-openai-key" }), () => false);
		expect(deriveSetupCardModel(input({ stage })).visible).toBe(true);
	});

	test("a test in progress shows its own title", () => {
		const stage = stageOf("openai", { apiKeySecretName: "k" }, { status: "testing", providerId: "openai", model: DEFAULT_SETTINGS.providers.openai.model });
		const model = deriveSetupCardModel(input({ stage, flowOpen: true }));
		expect(model.phase).toBe("testing");
		expect(model.primaryLabel).toBe("Testing...");
	});

	test("a failed test shows the plain message and the button that fixes it", () => {
		const copy = mapProviderErrorToSetupCopy(new Error("HTTP 401 invalid api key"), { providerId: "openai" });
		const stage = stageOf("openai", { apiKeySecretName: "k" }, { status: "failed", providerId: "openai", model: DEFAULT_SETTINGS.providers.openai.model, copy });
		const hidden = deriveSetupCardModel(input({ stage }));
		expect(hidden.visible).toBe(false);
		const shown = deriveSetupCardModel(input({ stage, flowOpen: true }));
		expect(shown.phase).toBe("failed");
		expect(shown.error?.action.label).toBe("Update key");
		expect(shown.error?.message).toContain("rejected the API key");
		expect(shown.primaryLabel).toBe("Try again");
	});

	test("after a passing test it offers the starters, disabled with a reason when no note is open", () => {
		const stage = stageOf("openai", { apiKeySecretName: "k" }, { status: "ok", providerId: "openai", model: DEFAULT_SETTINGS.providers.openai.model });
		const withNote = deriveSetupCardModel(input({ stage, flowOpen: true, hasOpenNote: true }));
		expect(withNote.phase).toBe("connected");
		expect(withNote.starters.map((chip) => chip.label)).toEqual(["Summarise this note", "Make a diagram", "Find gaps"]);
		expect(withNote.starters.every((chip) => !chip.disabled)).toBe(true);
		const withoutNote = deriveSetupCardModel(input({ stage, flowOpen: true, hasOpenNote: false }));
		expect(withoutNote.starters.every((chip) => chip.disabled && chip.disabledReason === "Open a note first.")).toBe(true);
	});

	test("/welcome shows a connected card even when the flow is closed", () => {
		const stage = stageOf("openai", { apiKeySecretName: "k" }, { status: "ok", providerId: "openai", model: DEFAULT_SETTINGS.providers.openai.model });
		expect(deriveSetupCardModel(input({ stage, welcomeOpen: true })).phase).toBe("connected");
		expect(deriveSetupCardModel(input({ stage })).visible).toBe(false);
	});

	test("choosing a provider that is not the chat provider yet starts from the connect step", () => {
		const model = deriveSetupCardModel(input({ selectedProvider: "anthropic", flowOpen: true }));
		expect(model.phase).toBe("connect");
		expect(model.provider.id).toBe("anthropic");
		expect(model.providers.find((chip) => chip.selected)?.label).toBe("Anthropic");
	});

	test("the local provider asks for an address and needs no key", () => {
		const stage = stageOf("openai-compatible");
		const model = deriveSetupCardModel(input({ stage, selectedProvider: "openai-compatible", flowOpen: true }));
		expect(model.showKeyField).toBe(false);
		expect(model.showAddressField).toBe(true);
		expect(model.steps[1]?.label).toBe("Check the address");
	});

	test("the three steps move forward with the phase", () => {
		const states = (phase: ReturnType<typeof deriveSetupCardModel>) => phase.steps.map((step) => step.state);
		expect(states(deriveSetupCardModel(input()))).toEqual(["done", "current", "todo"]);
		const stage = stageOf("openai", { apiKeySecretName: "k" }, { status: "ok", providerId: "openai", model: DEFAULT_SETTINGS.providers.openai.model });
		expect(states(deriveSetupCardModel(input({ stage, flowOpen: true })))).toEqual(["done", "done", "current"]);
	});

	test("lists the four providers a first run needs", () => {
		expect(deriveSetupCardModel(input()).providers.map((chip) => chip.label)).toEqual(["OpenAI", "Anthropic", "Gemini", "Local"]);
	});
});

describe("what the card starts from", () => {
	const local = (overrides: Partial<SetupCardInput> = {}) =>
		deriveSetupCardModel(input({ stage: stageOf("openai-compatible"), selectedProvider: "openai-compatible", flowOpen: true, ...overrides }));

	test("a local server starts from its saved address and model, and from the usual ones when none is saved", () => {
		const saved = local({ savedBaseUrl: " http://localhost:1234/v1 ", savedModel: "qwen2.5" });
		expect(saved.addressDefault).toBe("http://localhost:1234/v1");
		expect(saved.modelPlaceholder).toBe("qwen2.5");
		const fresh = local();
		expect(fresh.addressDefault).toBe(fresh.provider.defaultBaseUrl);
		expect(fresh.modelPlaceholder).toBe(fresh.provider.defaultModel);
		expect(local({ savedBaseUrl: "  ", savedModel: "" }).addressDefault).toBe(fresh.provider.defaultBaseUrl);
	});

	test("with no note open the connected card says so in words, not only in a tooltip", () => {
		const stage = stageOf("openai", { apiKeySecretName: "k" }, { status: "ok", providerId: "openai", model: DEFAULT_SETTINGS.providers.openai.model });
		const without = deriveSetupCardModel(input({ stage, flowOpen: true, hasOpenNote: false }));
		expect(without.detail).toBe("Open a note, then pick a starter. They work on the note you have open.");
		const withNote = deriveSetupCardModel(input({ stage, flowOpen: true, hasOpenNote: true }));
		expect(withNote.detail).toBe("Pick a starter to see what AskMate does with the note you have open.");
	});

	test("the first step says where the providers without a chip are set up, and nothing else does", () => {
		const first = deriveSetupCardModel(input());
		expect(first.otherProvidersHint).toBe("Using Azure OpenAI, Azure AI Foundry or OpenRouter? Choose Open settings, then Chat provider.");
		// Someone whose provider already has a chip is not sent elsewhere, and later steps stay short.
		expect(deriveSetupCardModel(input({ stage: stageOf("openrouter"), selectedProvider: "openrouter" })).otherProvidersHint).toBeNull();
		const copy = mapProviderErrorToSetupCopy(new Error("HTTP 401"), { providerId: "openai" });
		const failed = stageOf("openai", { apiKeySecretName: "k" }, { status: "failed", providerId: "openai", model: DEFAULT_SETTINGS.providers.openai.model, copy });
		expect(deriveSetupCardModel(input({ stage: failed, flowOpen: true })).otherProvidersHint).toBeNull();
	});

	test("the privacy line names what is really sent: the question, the note, earlier turns and the context turned on", () => {
		expect(SETUP_PRIVACY_LINE).toContain("your question");
		expect(SETUP_PRIVACY_LINE).toContain("recent turns of this conversation");
		expect(SETUP_PRIVACY_LINE).toContain("extra context or skills you turn on");
		expect(SETUP_PRIVACY_LINE).not.toContain("only the note text");
	});
});

describe("providers that are not one of the four chips", () => {
	const azureComplete = { apiKeySecretName: "k", baseUrl: "https://res.openai.azure.com/openai/v1", model: "my-deployment" };

	test("OpenRouter without a key shows the card on open, with its own chip selected and a key field", () => {
		const stage = stageOf("openrouter");
		const model = deriveSetupCardModel(input({ stage, selectedProvider: "openrouter" }));
		expect(model.visible).toBe(true);
		expect(model.phase).toBe("connect");
		expect(model.provider.id).toBe("openrouter");
		expect(model.title).toBe("Connect an AI provider");
		expect(model.showKeyField).toBe(true);
		expect(model.primaryAction).toBe("connect");
		expect(model.providers.map((chip) => `${chip.label}${chip.selected ? "*" : ""}`)).toEqual(["OpenRouter*", "OpenAI", "Anthropic", "Gemini", "Local"]);
	});

	test("the chat provider keeps its chip while another chip is the chosen one", () => {
		const model = deriveSetupCardModel(input({ stage: stageOf("openrouter"), selectedProvider: "anthropic", flowOpen: true }));
		expect(model.providers.map((chip) => `${chip.label}${chip.selected ? "*" : ""}`)).toEqual(["OpenRouter", "OpenAI", "Anthropic*", "Gemini", "Local"]);
		expect(model.provider.id).toBe("anthropic");
	});

	test("the four first-run providers add no extra chip", () => {
		expect(deriveSetupCardModel(input({ stage: stageOf("anthropic"), selectedProvider: "anthropic" })).providers).toHaveLength(4);
	});

	test("canFinishInCard is true for a key, a local address and OpenRouter, and false for Azure", () => {
		const finish = (id: TextProviderId) => canFinishInCard(getProviderCatalogEntry(id));
		expect(["openai", "anthropic", "google-gemini", "openai-compatible", "openrouter"].map((id) => finish(id as TextProviderId))).toEqual([true, true, true, true, true]);
		expect(finish("azure-openai")).toBe(false);
		expect(finish("azure-ai")).toBe(false);
	});

	test("Azure with something missing names the provider and the gap, and makes Open settings the main button", () => {
		const model = deriveSetupCardModel(input({ stage: stageOf("azure-openai"), selectedProvider: "azure-openai" }));
		expect(model.visible).toBe(true);
		expect(model.title).toBe("Finish setting up Azure OpenAI");
		expect(model.detail).toBe("Add an API key for Azure OpenAI. Azure OpenAI needs an address as well as a key, so it is set up in AskMate settings.");
		expect(model.primaryLabel).toBe("Open settings");
		expect(model.primaryAction).toBe("open-settings");
		expect(model.showKeyField).toBe(false);
		expect(model.showAddressField).toBe(false);
		expect(model.steps[1]?.label).toBe("Finish in settings");
	});

	test("Azure with the address missing says that gap instead", () => {
		const model = deriveSetupCardModel(input({ stage: stageOf("azure-openai", { apiKeySecretName: "k" }), selectedProvider: "azure-openai" }));
		expect(model.detail).toContain("Set the Azure OpenAI base URL.");
		expect(model.primaryAction).toBe("open-settings");
	});

	test("Azure that is complete offers a test, not settings, and says how to change it", () => {
		const model = deriveSetupCardModel(input({ stage: stageOf("azure-openai", azureComplete), selectedProvider: "azure-openai", hasStoredKey: true, flowOpen: true }));
		expect(model.phase).toBe("connect");
		expect(model.primaryAction).toBe("connect");
		expect(model.primaryLabel).toBe("Test connection");
		expect(model.detail).toContain("open AskMate settings to change its key or address");
		expect(model.showKeyField).toBe(false);
	});

	test("Azure that failed its test offers Try again and shows the failure", () => {
		const copy = mapProviderErrorToSetupCopy(new Error("HTTP 401 invalid api key"), { providerId: "azure-openai" });
		const stage = stageOf("azure-openai", azureComplete, { status: "failed", providerId: "azure-openai", model: "my-deployment", copy });
		const model = deriveSetupCardModel(input({ stage, selectedProvider: "azure-openai", flowOpen: true }));
		expect(model.phase).toBe("failed");
		expect(model.primaryLabel).toBe("Try again");
		expect(model.primaryAction).toBe("connect");
		expect(model.error?.message).toContain("rejected the API key");
	});
});

describe("overlayTestResult", () => {
	const untested = stageOf("openai", { apiKeySecretName: "k" });
	const model = DEFAULT_SETTINGS.providers.openai.model;

	test("a passing test for the same provider and model makes the stage ready", () => {
		expect(overlayTestResult(untested, { status: "ok", providerId: "openai", model }).kind).toBe("ready");
	});

	test("a result for another model is ignored", () => {
		expect(overlayTestResult(untested, { status: "ok", providerId: "openai", model: "other" }).kind).toBe("untested");
	});

	test("it never turns a stage that still lacks a key into a connection", () => {
		const ready = stageOf("openai", { apiKeySecretName: "k" }, { status: "ok", providerId: "openai", model });
		expect(overlayTestResult(ready, null)).toBe(ready);
		const needsKey = stageOf("openai");
		expect(overlayTestResult(needsKey, { status: "ok", providerId: "openai", model }).kind).toBe("needs-key");
	});

	test("a newer result from this view replaces an older failure or success the plugin remembers", () => {
		const copy = mapProviderErrorToSetupCopy(new Error("HTTP 401"), { providerId: "openai" });
		const failed = stageOf("openai", { apiKeySecretName: "k" }, { status: "failed", providerId: "openai", model, copy });
		expect(overlayTestResult(failed, { status: "ok", providerId: "openai", model }).kind).toBe("ready");
		const ready = stageOf("openai", { apiKeySecretName: "k" }, { status: "ok", providerId: "openai", model });
		expect(overlayTestResult(ready, { status: "failed", providerId: "openai", model, copy }).kind).toBe("test-failed");
	});
});

describe("the card DOM", () => {
	let restore: () => void;
	beforeAll(() => {
		restore = installDomGlobals();
	});
	afterAll(() => restore());

	function callbacks() {
		const log: string[] = [];
		const drafts: SetupCardDraft[] = [];
		const handlers: SetupCardCallbacks = {
			onSelectProvider: (id) => log.push(`select:${id}`),
			onConnect: (id, draft) => log.push(`connect:${id}:${draft.apiKey}`),
			onAction: (action: SetupAction) => log.push(`action:${action.kind}`),
			onStarter: (chip) => log.push(`starter:${chip.id}`),
			onDismiss: () => log.push("dismiss"),
			onDraft: (draft) => drafts.push(draft)
		};
		return { log, drafts, handlers };
	}

	const emptyDraft: SetupCardDraft = { apiKey: "", baseUrl: "", model: "" };

	test("draws the contract classes, the provider chips and a masked key field", () => {
		const parent = createFakeEl();
		const { handlers } = callbacks();
		renderSetupCard(parent, deriveSetupCardModel(input()), handlers, emptyDraft);
		expect(parent.querySelector(".askmate-setup-card")).not.toBeNull();
		expect(parent.querySelector(".askmate-setup-title")?.textContent).toBe("Connect an AI provider");
		expect(parent.querySelectorAll(".askmate-setup-step")).toHaveLength(3);
		expect(parent.querySelectorAll(".askmate-setup-step.is-done")).toHaveLength(1);
		expect(parent.querySelectorAll(".askmate-setup-step.is-current")).toHaveLength(1);
		expect(parent.querySelectorAll(".askmate-setup-provider")).toHaveLength(4);
		expect(parent.querySelector(".askmate-setup-provider.is-selected")?.textContent).toBe("OpenAI");
		expect(parent.querySelector(".askmate-setup-key-row input")?.getAttribute("type")).toBe("password");
		expect(parent.querySelector(".askmate-setup-actions button.mod-cta")?.textContent).toBe("Connect");
		expect(parent.querySelector(".askmate-setup-privacy")?.textContent).toBe(SETUP_PRIVACY_LINE);
	});

	test("Connect reports the pasted key and the provider; Enter in the field does the same", () => {
		const parent = createFakeEl();
		const { handlers, log, drafts } = callbacks();
		renderSetupCard(parent, deriveSetupCardModel(input()), handlers, emptyDraft);
		const field = parent.querySelector<HTMLInputElement>(".askmate-setup-key-row input");
		if (!field) {
			throw new Error("expected the key field");
		}
		field.value = "sk-test-12345678";
		fireDomEvent(field, "input");
		expect(drafts.at(-1)?.apiKey).toBe("sk-test-12345678");
		parent.querySelector<HTMLButtonElement>(".askmate-setup-actions button.mod-cta")?.click();
		fireDomEvent(field, "keydown", { key: "Enter" });
		expect(log).toEqual(["connect:openai:sk-test-12345678", "connect:openai:sk-test-12345678"]);
	});

	test("a pasted key survives a redraw through the draft", () => {
		const parent = createFakeEl();
		const { handlers } = callbacks();
		renderSetupCard(parent, deriveSetupCardModel(input()), handlers, { apiKey: "kept-key-123", baseUrl: "", model: "" });
		expect(parent.querySelector<HTMLInputElement>(".askmate-setup-key-row input")?.value).toBe("kept-key-123");
	});

	test("clearKey empties the field and the card's own copy, and reports the cleared draft", () => {
		const parent = createFakeEl();
		const { handlers, drafts, log } = callbacks();
		const handle = renderSetupCard(parent, deriveSetupCardModel(input()), handlers, { apiKey: "kept-key-123", baseUrl: "", model: "" });
		const field = parent.querySelector<HTMLInputElement>(".askmate-setup-key-row input");
		expect(field?.value).toBe("kept-key-123");
		handle.clearKey();
		expect(field?.value).toBe("");
		expect(handle.getDraft().apiKey).toBe("");
		expect(drafts.at(-1)?.apiKey).toBe("");
		// Connect after a clear reports no key, not the one that was there.
		parent.querySelector<HTMLButtonElement>(".askmate-setup-actions button.mod-cta")?.click();
		expect(log).toEqual(["connect:openai:"]);
	});

	test("the main button of a provider finished in settings opens settings and there is no second Open settings", () => {
		const parent = createFakeEl();
		const { handlers, log } = callbacks();
		renderSetupCard(parent, deriveSetupCardModel(input({ stage: stageOf("azure-openai"), selectedProvider: "azure-openai" })), handlers, emptyDraft);
		const buttons = Array.from(parent.querySelectorAll<HTMLButtonElement>(".askmate-setup-actions button"));
		expect(buttons.map((button) => button.textContent)).toEqual(["Open settings"]);
		expect(buttons[0]?.classList.contains("mod-cta")).toBe(true);
		expect(parent.querySelectorAll(".askmate-setup-key-row")).toHaveLength(0);
		buttons[0]?.click();
		expect(log).toEqual(["action:open-settings"]);
	});

	test("clicking a provider chip reports it", () => {
		const parent = createFakeEl();
		const { handlers, log } = callbacks();
		renderSetupCard(parent, deriveSetupCardModel(input()), handlers, emptyDraft);
		const chips = parent.querySelectorAll<HTMLButtonElement>(".askmate-setup-provider");
		chips[1]?.click();
		expect(log).toEqual(["select:anthropic"]);
	});

	test("an error shows with one button that carries the fix", () => {
		const parent = createFakeEl();
		const { handlers, log } = callbacks();
		const copy = mapProviderErrorToSetupCopy(new Error("HTTP 401"), { providerId: "openai" });
		const stage = stageOf("openai", { apiKeySecretName: "k" }, { status: "failed", providerId: "openai", model: DEFAULT_SETTINGS.providers.openai.model, copy });
		renderSetupCard(parent, deriveSetupCardModel(input({ stage, flowOpen: true })), handlers, emptyDraft);
		const error = parent.querySelector(".askmate-setup-error");
		expect(error?.getAttribute("role")).toBe("alert");
		const fix = error?.querySelector("button");
		expect(fix?.textContent).toBe("Update key");
		fix?.click();
		expect(log).toEqual(["action:update-key"]);
	});

	test("starter chips are real buttons, disabled with a tooltip when no note is open", () => {
		const parent = createFakeEl();
		const { handlers, log } = callbacks();
		const stage = stageOf("openai", { apiKeySecretName: "k" }, { status: "ok", providerId: "openai", model: DEFAULT_SETTINGS.providers.openai.model });
		renderSetupCard(parent, deriveSetupCardModel(input({ stage, flowOpen: true, hasOpenNote: false })), handlers, emptyDraft);
		const chips = parent.querySelectorAll<HTMLButtonElement>(".askmate-starter-chips .askmate-starter-chip");
		expect(chips).toHaveLength(3);
		expect(chips[0]?.disabled).toBe(true);
		expect(chips[0]?.getAttribute("title")).toBe("Open a note first.");
		const open = createFakeEl();
		renderSetupCard(open, deriveSetupCardModel(input({ stage, flowOpen: true, hasOpenNote: true })), handlers, emptyDraft);
		open.querySelectorAll<HTMLButtonElement>(".askmate-starter-chip")[1]?.click();
		expect(log).toEqual(["starter:diagram"]);
	});

	test("the local provider has an address and a model field instead of a key", () => {
		const parent = createFakeEl();
		const { handlers } = callbacks();
		const model = deriveSetupCardModel(input({ stage: stageOf("openai-compatible"), selectedProvider: "openai-compatible", flowOpen: true }));
		renderSetupCard(parent, model, handlers, emptyDraft);
		const fields = parent.querySelectorAll<HTMLInputElement>(".askmate-setup-key-row input");
		expect(fields).toHaveLength(2);
		expect(fields[0]?.type).toBe("text");
		expect(fields[0]?.value).toBe(model.provider.defaultBaseUrl);
	});

	test("the local card shows the saved address and model, and Enter in either field connects", () => {
		const parent = createFakeEl();
		const { handlers, log } = callbacks();
		const model = deriveSetupCardModel(input({ stage: stageOf("openai-compatible"), selectedProvider: "openai-compatible", flowOpen: true, savedBaseUrl: "http://localhost:1234/v1", savedModel: "qwen2.5" }));
		renderSetupCard(parent, model, handlers, emptyDraft);
		const fields = parent.querySelectorAll<HTMLInputElement>(".askmate-setup-key-row input");
		expect(fields[0]?.value).toBe("http://localhost:1234/v1");
		expect(fields[1]?.placeholder).toBe("qwen2.5");
		expect(parent.querySelectorAll(".askmate-setup-field label")[1]?.textContent).toBe("Model (optional)");
		fireDomEvent(fields[0]!, "keydown", { key: "Enter" });
		fireDomEvent(fields[1]!, "keydown", { key: "Enter" });
		expect(log).toEqual(["connect:openai-compatible:", "connect:openai-compatible:"]);
	});

	test("while a check runs nothing is disabled, so the keyboard keeps its place, and the main button ignores a second press", () => {
		const parent = createFakeEl();
		// Focus only lands on an element that is in the document.
		activeDocument.body.appendChild(parent);
		const { handlers, log } = callbacks();
		const stage = stageOf("openai", { apiKeySecretName: "k" }, { status: "testing", providerId: "openai", model: DEFAULT_SETTINGS.providers.openai.model });
		renderSetupCard(parent, deriveSetupCardModel(input({ stage, flowOpen: true, hasStoredKey: true })), handlers, emptyDraft);
		const field = parent.querySelector<HTMLInputElement>(".askmate-setup-key-row input");
		expect(field?.disabled).toBe(false);
		expect(field?.readOnly).toBe(true);
		expect(field?.getAttribute("aria-disabled")).toBe("true");
		field?.focus();
		expect(activeDocument.activeElement).toBe(field);
		fireDomEvent(field!, "keydown", { key: "Enter" });
		const primary = parent.querySelector<HTMLButtonElement>(".askmate-setup-actions button.mod-cta");
		expect(primary?.disabled).toBe(false);
		expect(primary?.getAttribute("aria-disabled")).toBe("true");
		primary?.click();
		// Neither Enter nor the button starts a second check while one is running.
		expect(log).toEqual([]);
		parent.remove();
	});

	test("after a connection the keyboard goes to the first starter that can be used, or to the heading when none can", () => {
		const stage = stageOf("openai", { apiKeySecretName: "k" }, { status: "ok", providerId: "openai", model: DEFAULT_SETTINGS.providers.openai.model });
		const withNote = createFakeEl();
		activeDocument.body.appendChild(withNote);
		renderSetupCard(withNote, deriveSetupCardModel(input({ stage, flowOpen: true, hasOpenNote: true })), callbacks().handlers, emptyDraft).focusStart();
		expect(activeDocument.activeElement?.classList.contains("askmate-starter-chip")).toBe(true);
		expect(activeDocument.activeElement?.textContent).toBe("Summarise this note");
		withNote.remove();
		const withoutNote = createFakeEl();
		activeDocument.body.appendChild(withoutNote);
		renderSetupCard(withoutNote, deriveSetupCardModel(input({ stage, flowOpen: true, hasOpenNote: false })), callbacks().handlers, emptyDraft).focusStart();
		expect(activeDocument.activeElement?.classList.contains("askmate-setup-title")).toBe(true);
		expect(activeDocument.activeElement?.getAttribute("tabindex")).toBe("-1");
		withoutNote.remove();
	});

	test("the first step has the line about the other providers, under the chips", () => {
		const parent = createFakeEl();
		renderSetupCard(parent, deriveSetupCardModel(input()), callbacks().handlers, emptyDraft);
		const hint = (root: HTMLElement): string | undefined => Array.from(root.querySelectorAll("p"), (paragraph) => paragraph.textContent ?? "").find((text) => text.includes("Azure AI Foundry"));
		expect(hint(parent)).toContain("Choose Open settings");
		const stage = stageOf("openai", { apiKeySecretName: "k" }, { status: "ok", providerId: "openai", model: DEFAULT_SETTINGS.providers.openai.model });
		const later = createFakeEl();
		renderSetupCard(later, deriveSetupCardModel(input({ stage, flowOpen: true })), callbacks().handlers, emptyDraft);
		expect(hint(later)).toBeUndefined();
	});
});
