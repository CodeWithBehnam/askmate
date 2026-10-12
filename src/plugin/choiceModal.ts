import { App, Modal } from "obsidian";

export interface ModalChoice<T extends string> {
	id: T;
	label: string;
	/** Draws the button as the main action. */
	primary?: boolean;
}

export interface ChoiceModalOptions<T extends string> {
	title: string;
	message: string;
	choices: readonly ModalChoice<T>[];
	/** The button that has focus first. Pick the safe one. */
	focus: T;
	/** What closing the dialog without a click means. */
	dismiss: T;
}

const TITLE_ID = "askmate-choice-title";
const BODY_ID = "askmate-choice-body";

class ChoiceModal<T extends string> extends Modal {
	private resolved = false;

	constructor(app: App, private readonly options: ChoiceModalOptions<T>, private readonly resolve: (choice: T) => void) {
		super(app);
	}

	onOpen(): void {
		const { contentEl, modalEl } = this;
		contentEl.empty();
		modalEl.setAttribute("role", "dialog");
		modalEl.setAttribute("aria-modal", "true");
		modalEl.setAttribute("aria-labelledby", TITLE_ID);
		modalEl.setAttribute("aria-describedby", BODY_ID);
		const heading = contentEl.createEl("h2", { text: this.options.title });
		heading.id = TITLE_ID;
		const body = contentEl.createEl("p", { cls: "askmate-modal-message", text: this.options.message });
		body.id = BODY_ID;
		const row = contentEl.createDiv({ cls: "askmate-modal-buttons" });
		let focusTarget: HTMLButtonElement | null = null;
		for (const choice of this.options.choices) {
			const button = row.createEl("button", { text: choice.label, ...(choice.primary ? { cls: "mod-cta" } : {}) });
			button.type = "button";
			button.addEventListener("click", () => {
				this.finish(choice.id);
			});
			if (choice.id === this.options.focus) {
				focusTarget = button;
			}
		}
		focusTarget?.focus();
	}

	onClose(): void {
		this.finish(this.options.dismiss);
	}

	private finish(choice: T): void {
		if (this.resolved) {
			return;
		}
		this.resolved = true;
		this.resolve(choice);
		this.close();
	}
}

/** A dialog with more than yes and no. Resolves with the id of the chosen button, or `dismiss` when it is closed. */
export function askMateChoice<T extends string>(app: App, options: ChoiceModalOptions<T>): Promise<T> {
	return new Promise<T>((resolve) => {
		new ChoiceModal(app, options, resolve).open();
	});
}
