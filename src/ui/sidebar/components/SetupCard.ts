import type { SetupAction, StarterChip } from "../../../setup";
import type { TextProviderId } from "../../../shared/types";
import type { SetupCardModel } from "./setupCardModel";

/** What the person has typed into the card. The view keeps it between redraws so a status change never loses a pasted key. */
export interface SetupCardDraft {
	apiKey: string;
	baseUrl: string;
	model: string;
}

export interface SetupCardCallbacks {
	onSelectProvider: (id: TextProviderId) => void;
	/** Connect, Test connection and Try again all land here; the view decides what to do from the draft and the stage. */
	onConnect: (providerId: TextProviderId, draft: SetupCardDraft) => void;
	onAction: (action: SetupAction) => void;
	onStarter: (chip: StarterChip) => void;
	onDismiss: () => void;
	onDraft: (draft: SetupCardDraft) => void;
}

export interface SetupCardHandle {
	el: HTMLElement;
	focusKey(): void;
	getDraft(): SetupCardDraft;
	/** Empties the key field and the card's own copy of the key. A key is used once; nothing here may hold it afterwards. */
	clearKey(): void;
}

function addField(parent: HTMLElement, label: string, type: "password" | "text"): HTMLInputElement {
	const id = `askmate-setup-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${Math.random().toString(36).slice(2, 8)}`;
	const field = parent.createDiv({ cls: "askmate-setup-field" });
	const labelEl = field.createEl("label", { text: label });
	const input = field.createEl("input", { type });
	input.id = id;
	labelEl.htmlFor = id;
	return input;
}

/**
 * Draws the Connect card. It owns no state beyond the inputs: every decision is in the model, and every effect goes out
 * through a callback, so the same card serves first run, /setup and /welcome in any layout.
 */
export function renderSetupCard(parent: HTMLElement, model: SetupCardModel, callbacks: SetupCardCallbacks, draft: SetupCardDraft): SetupCardHandle {
	const card = parent.createDiv({ cls: `askmate-setup-card is-${model.phase}` });
	card.setAttribute("role", "region");
	card.setAttribute("aria-label", "Connect AskMate to an AI provider");

	const title = card.createDiv({ cls: "askmate-setup-title", text: model.title });
	title.setAttribute("role", "heading");
	title.setAttribute("aria-level", "2");
	card.createEl("p", { text: model.detail });

	const steps = card.createDiv({ cls: "askmate-setup-steps" });
	for (const step of model.steps) {
		const el = steps.createDiv({ cls: `askmate-setup-step is-${step.state}`, text: step.label });
		if (step.state === "current") {
			el.setAttribute("aria-current", "step");
		}
	}

	const providers = card.createDiv({ cls: "askmate-setup-providers" });
	providers.setAttribute("role", "group");
	providers.setAttribute("aria-label", "Provider");
	for (const provider of model.providers) {
		const button = providers.createEl("button", { cls: provider.selected ? "askmate-setup-provider is-selected" : "askmate-setup-provider", text: provider.label });
		button.type = "button";
		button.setAttribute("aria-pressed", String(provider.selected));
		button.disabled = model.phase === "testing";
		button.addEventListener("click", () => callbacks.onSelectProvider(provider.id));
	}

	let current: SetupCardDraft = { ...draft };
	const emit = (patch: Partial<SetupCardDraft>): void => {
		current = { ...current, ...patch };
		callbacks.onDraft(current);
	};

	let keyInput: HTMLInputElement | null = null;
	let secretInput: HTMLInputElement | null = null;
	if (model.showKeyField || model.showAddressField) {
		const row = card.createDiv({ cls: "askmate-setup-key-row" });
		if (model.showKeyField) {
			const input = addField(row, "API key", "password");
			input.autocomplete = "off";
			input.spellcheck = false;
			input.placeholder = model.hasStoredKey ? "Stored on this device. Paste a new key to replace it." : "Paste your API key";
			input.value = current.apiKey;
			input.disabled = model.phase === "testing";
			input.addEventListener("input", () => emit({ apiKey: input.value }));
			input.addEventListener("keydown", (event) => {
				if (event.key === "Enter" && !event.isComposing) {
					event.preventDefault();
					callbacks.onConnect(model.provider.id, current);
				}
			});
			keyInput = input;
			secretInput = input;
			if (model.provider.keyUrl) {
				const link = row.createEl("a", { cls: "askmate-setup-link", text: "Get an API key", href: model.provider.keyUrl });
				link.setAttribute("target", "_blank");
				link.setAttribute("rel", "noopener noreferrer");
			}
		} else {
			const address = addField(row, "Server address", "text");
			address.value = current.baseUrl || model.provider.defaultBaseUrl;
			address.disabled = model.phase === "testing";
			address.addEventListener("input", () => emit({ baseUrl: address.value }));
			const modelInput = addField(row, "Model", "text");
			modelInput.placeholder = model.provider.defaultModel;
			modelInput.value = current.model;
			modelInput.disabled = model.phase === "testing";
			modelInput.addEventListener("input", () => emit({ model: modelInput.value }));
			keyInput = address;
			if (model.provider.helpUrl) {
				const link = row.createEl("a", { cls: "askmate-setup-link", text: "Get a local server", href: model.provider.helpUrl });
				link.setAttribute("target", "_blank");
				link.setAttribute("rel", "noopener noreferrer");
			}
		}
	}

	if (model.error) {
		const error = card.createDiv({ cls: "askmate-setup-error" });
		error.setAttribute("role", "alert");
		error.createDiv({ text: model.error.message });
		if (model.error.detail) {
			const details = error.createEl("details");
			details.createEl("summary", { text: "Details" });
			details.createEl("pre", { text: model.error.detail });
		}
		const fix = error.createEl("button", { text: model.error.action.label });
		fix.type = "button";
		const action = model.error.action;
		fix.addEventListener("click", () => callbacks.onAction(action));
	}

	const actions = card.createDiv({ cls: "askmate-setup-actions" });
	if (model.phase !== "connected") {
		const openSettings = (): void => callbacks.onAction({ kind: "open-settings", label: "Open settings" });
		const primary = actions.createEl("button", { cls: "mod-cta", text: model.primaryLabel });
		primary.type = "button";
		primary.disabled = model.phase === "testing";
		primary.addEventListener("click", () => (model.primaryAction === "open-settings" ? openSettings() : callbacks.onConnect(model.provider.id, current)));
		// A provider finished in settings already has that button as its main one.
		if (model.primaryAction !== "open-settings") {
			const settings = actions.createEl("button", { text: "Open settings" });
			settings.type = "button";
			settings.addEventListener("click", openSettings);
		}
	}

	if (model.starters.length > 0) {
		const chips = card.createDiv({ cls: "askmate-starter-chips" });
		for (const chip of model.starters) {
			const button = chips.createEl("button", { cls: "askmate-starter-chip", text: chip.label });
			button.type = "button";
			button.disabled = chip.disabled;
			if (chip.disabledReason) {
				button.setAttribute("title", chip.disabledReason);
			}
			button.addEventListener("click", () => callbacks.onStarter(chip));
		}
		const dismiss = actions.createEl("button", { text: "Hide this card" });
		dismiss.type = "button";
		dismiss.addEventListener("click", () => callbacks.onDismiss());
	}

	card.createEl("p", { cls: "askmate-setup-privacy", text: model.privacy });

	return {
		el: card,
		focusKey: () => keyInput?.focus(),
		getDraft: () => ({ ...current }),
		clearKey: () => {
			if (secretInput) {
				secretInput.value = "";
			}
			emit({ apiKey: "" });
		}
	};
}
