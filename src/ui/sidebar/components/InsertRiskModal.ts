import { Modal, type App } from "obsidian";

export type InsertRiskChoice = "safe" | "anyway" | "cancel";

/**
 * Asked when a reply holds something that would be active inside a note. Closing the dialog any other way (Escape, the
 * close button) is a cancel, so nothing is written unless a button says so.
 */
class InsertRiskModal extends Modal {
	private choice: InsertRiskChoice = "cancel";

	constructor(app: App, private readonly findings: readonly string[], private readonly onChoice: (choice: InsertRiskChoice) => void) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText("This reply has active content");
		this.modalEl.setAttribute("role", "dialog");
		this.modalEl.setAttribute("aria-modal", "true");
		this.contentEl.empty();
		this.contentEl.createEl("p", {
			text: "Put in a note as written, it could load something from the internet, run code from another plugin, or hide text. AskMate can insert a safe version instead."
		});
		const list = this.contentEl.createEl("ul");
		for (const finding of this.findings) {
			list.createEl("li", { text: finding });
		}
		const buttons = this.contentEl.createDiv({ cls: "askmate-modal-buttons" });
		const safe = buttons.createEl("button", { text: "Insert safe version", cls: "mod-cta" });
		safe.addEventListener("click", () => this.finish("safe"));
		const anyway = buttons.createEl("button", { text: "Insert anyway" });
		anyway.addEventListener("click", () => this.finish("anyway"));
		const cancel = buttons.createEl("button", { text: "Cancel" });
		cancel.addEventListener("click", () => this.finish("cancel"));
		safe.focus();
	}

	onClose(): void {
		this.contentEl.empty();
		this.onChoice(this.choice);
	}

	private finish(choice: InsertRiskChoice): void {
		this.choice = choice;
		this.close();
	}
}

export function askInsertRiskChoice(app: App, findings: readonly string[]): Promise<InsertRiskChoice> {
	return new Promise((resolve) => {
		new InsertRiskModal(app, findings, resolve).open();
	});
}
