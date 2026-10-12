import { Notice } from "obsidian";

/**
 * Shared pieces for AskMate modals: dialog semantics so a screen reader announces a safety prompt as a dialog with a name,
 * one button row, and the clipboard copy that the text viewers use.
 */

export interface DialogParts {
	modalEl: HTMLElement;
	titleEl: HTMLElement;
}

let dialogCounter = 0;

/**
 * Marks the modal as a dialog named by its title. `describedBy` is the element that states what the dialog asks, so a screen
 * reader reads it after the name. Call it from onOpen after the title is set. Each call gets fresh ids, so a modal that
 * redraws itself never leaves two elements with one id.
 */
export function applyDialogSemantics(parts: DialogParts, describedBy: HTMLElement | null = null): void {
	dialogCounter += 1;
	const titleId = `askmate-dialog-title-${dialogCounter}`;
	parts.titleEl.id = titleId;
	parts.modalEl.setAttribute("role", "dialog");
	parts.modalEl.setAttribute("aria-modal", "true");
	parts.modalEl.setAttribute("aria-labelledby", titleId);
	if (describedBy) {
		const descId = `askmate-dialog-desc-${dialogCounter}`;
		describedBy.id = descId;
		parts.modalEl.setAttribute("aria-describedby", descId);
	} else {
		parts.modalEl.removeAttribute("aria-describedby");
	}
}

/** Obsidian's own button container gives the row its layout and spacing; the AskMate classes keep the old selectors working. */
export function createButtonRow(parent: HTMLElement): HTMLElement {
	return parent.createDiv({ cls: ["modal-button-container", "askmate-modal-buttons", "askmate-modal-actions"] });
}

export function addModalButton(row: HTMLElement, label: string, options: { cta?: boolean; warning?: boolean; onClick: () => void }): HTMLButtonElement {
	const classes = options.warning ? "mod-warning" : options.cta ? "mod-cta" : undefined;
	const button = row.createEl("button", { text: label, cls: classes });
	button.type = "button";
	button.addEventListener("click", options.onClick);
	return button;
}

/** Copies text with the async clipboard API (writing is allowed; only reading is not). True when the copy succeeded. */
export async function copyTextToClipboard(text: string): Promise<boolean> {
	try {
		await activeWindow.navigator.clipboard.writeText(text);
		return true;
	} catch {
		return false;
	}
}

/** Copies and says what happened, because a silent copy leaves the person unsure whether it worked. */
export async function copyWithNotice(text: string, subject: string): Promise<void> {
	new Notice((await copyTextToClipboard(text)) ? `Copied ${subject}.` : `AskMate could not copy ${subject}. Select the text and copy it by hand.`);
}
