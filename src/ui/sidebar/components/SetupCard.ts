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
	/** After a connection: the first starter that can be used, or the card's heading when none can, so the keyboard keeps its place. */
	focusStart(): void;
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

let setupCardCounter = 0;

/**
 * Draws the Connect card. It owns no state beyond the inputs: every decision is in the model, and every effect goes out
 * through a callback, so the same card serves first run, /setup and /welcome in any layout.
 */
export function renderSetupCard(parent: HTMLElement, model: SetupCardModel, callbacks: SetupCardCallbacks, draft: SetupCardDraft): SetupCardHandle {
	const card = parent.createDiv({ cls: `askmate-setup-card is-${model.phase}` });
	card.setAttribute("role", "region");

	const title = card.createDiv({ cls: "askmate-setup-title", text: model.title });
	// Named by its own title, not an aria-label: Obsidian shows an aria-label as a tooltip, and the card is redrawn under
	// the pointer during a connection, which left the tooltip on screen. The title also follows the phase.
	title.id = `askmate-setup-title-${++setupCardCounter}`;
	card.setAttribute("aria-labelledby", title.id);
	title.setAttribute("role", "heading");
	title.setAttribute("aria-level", "2");
	// Not in the tab order, but a place the keyboard can be put when the control that had it is gone.
	title.tabIndex = -1;
	// While a check runs the controls are not disabled: a disabled control cannot keep the keyboard focus, and the card is redrawn around it.
	const checking = model.phase === "testing";
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
		button.disabled = checking;
		button.addEventListener("click", () => callbacks.onSelectProvider(provider.id));
	}
	if (model.otherProvidersHint) {
		card.createEl("p", { text: model.otherProvidersHint });
	}

	let current: SetupCardDraft = { ...draft };
	const emit = (patch: Partial<SetupCardDraft>): void => {
		current = { ...current, ...patch };
		callbacks.onDraft(current);
	};

	// Enter in any field connects, as it does in the key field.
	const connectOnEnter = (input: HTMLInputElement): void => {
		input.addEventListener("keydown", (event) => {
			if (event.key === "Enter" && !event.isComposing) {
				event.preventDefault();
				if (!checking) {
					callbacks.onConnect(model.provider.id, current);
				}
			}
		});
	};
	const holdWhileChecking = (input: HTMLInputElement): void => {
		if (checking) {
			input.readOnly = true;
			input.setAttribute("aria-disabled", "true");
		}
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
			holdWhileChecking(input);
			input.addEventListener("input", () => emit({ apiKey: input.value }));
			connectOnEnter(input);
			keyInput = input;
			secretInput = input;
			if (model.provider.keyUrl) {
				const link = row.createEl("a", { cls: "askmate-setup-link", text: "Get an API key", href: model.provider.keyUrl });
				link.setAttribute("target", "_blank");
				link.setAttribute("rel", "noopener noreferrer");
			}
		} else {
			const address = addField(row, "Server address", "text");
			// The saved address, so a server on its own port is not replaced by the usual one the first time Connect is pressed.
			address.value = current.baseUrl || model.addressDefault;
			holdWhileChecking(address);
			address.addEventListener("input", () => emit({ baseUrl: address.value }));
			connectOnEnter(address);
			const modelInput = addField(row, "Model (optional)", "text");
			modelInput.placeholder = model.modelPlaceholder;
			modelInput.value = current.model;
			holdWhileChecking(modelInput);
			modelInput.addEventListener("input", () => emit({ model: modelInput.value }));
			connectOnEnter(modelInput);
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
		if (checking) {
			primary.setAttribute("aria-disabled", "true");
		}
		primary.addEventListener("click", () => {
			if (checking) {
				return;
			}
			if (model.primaryAction === "open-settings") {
				openSettings();
			} else {
				callbacks.onConnect(model.provider.id, current);
			}
		});
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
		focusKey: () => {
			keyInput?.focus();
			// The card scrolls inside the transcript: after a provider is picked or a problem is shown, Connect and Open settings
			// must be in view too, or a short sidebar hides the button the person needs next. The title is brought in first,
			// so when the card fits, both its title and its buttons show.
			title.scrollIntoView({ block: "nearest" });
			actions.scrollIntoView({ block: "nearest" });
		},
		focusStart: () => {
			const first = Array.from(card.querySelectorAll<HTMLButtonElement>(".askmate-starter-chip")).find((button) => !button.disabled);
			(first ?? title).focus();
		},
		getDraft: () => ({ ...current }),
		clearKey: () => {
			if (secretInput) {
				secretInput.value = "";
			}
			emit({ apiKey: "" });
		}
	};
}
