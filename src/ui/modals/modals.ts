import { App, Modal, Notice } from "obsidian";
import type { AskMatePlugin } from "../../plugin/AskMatePlugin";
import type { InspectedPrompt } from "../../plugin/promptInspection";
import {
	buildMarkdownLineDiff,
	formatOutputMode,
	getMarkdownDiffStats,
	formatRequestIntent,
	formatTokenCount,
	formatUsageTimestamp,
	truncateLabel,
	type DiffConfirmOptions,
	type PromptInspection
} from "../../shared/core";
import { addModalButton, applyDialogSemantics, copyWithNotice, createButtonRow } from "./dialog";
import { markInvisibleCharacters } from "./invisibleChars";

/** What a confirmation says and offers. Callers name the action, so a destructive prompt never reads like a routine one. */
export interface ConfirmOptions {
	/** Dialog title. Defaults to a generic one, which only suits callers that have not been updated yet. */
	title?: string;
	/** A specific verb such as "Delete conversations". Defaults to "Confirm". */
	confirmLabel?: string;
	cancelLabel?: string;
	/** Styles the confirm button as destructive. Cancel keeps the focus either way. */
	destructive?: boolean;
	/** Extra lines under the message, for example what is kept. */
	details?: readonly string[];
}

class AskMateConfirmModal extends Modal {
	private readonly message: string;
	private readonly options: ConfirmOptions;
	private readonly resolve: (value: boolean) => void;
	private resolved = false;

	constructor(app: App, message: string, options: ConfirmOptions, resolve: (value: boolean) => void) {
		super(app);
		this.message = message;
		this.options = options;
		this.resolve = resolve;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		this.setTitle(this.options.title ?? "Confirm AskMate action");
		const messageEl = contentEl.createEl("p", { cls: "askmate-modal-message", text: this.message });
		for (const detail of this.options.details ?? []) {
			contentEl.createEl("p", { cls: "askmate-modal-message", text: detail });
		}
		applyDialogSemantics(this, messageEl);
		const actions = createButtonRow(contentEl);
		const cancelButton = addModalButton(actions, this.options.cancelLabel ?? "Cancel", { onClick: () => this.finish(false) });
		addModalButton(actions, this.options.confirmLabel ?? "Confirm", {
			cta: !this.options.destructive,
			warning: this.options.destructive === true,
			onClick: () => this.finish(true)
		});
		// Cancel is the safe default for destructive confirmations; Enter activates whichever button has focus.
		cancelButton.focus();
	}

	onClose(): void {
		this.finish(false);
	}

	private finish(value: boolean): void {
		if (this.resolved) {
			return;
		}
		this.resolved = true;
		this.resolve(value);
		this.close();
	}
}

class AskMatePromptModal extends Modal {
	private readonly message: string;
	private readonly initialValue: string;
	private readonly resolve: (value: string | null) => void;
	private resolved = false;
	private inputEl: HTMLInputElement | null = null;

	constructor(app: App, message: string, initialValue: string, resolve: (value: string | null) => void) {
		super(app);
		this.message = message;
		this.initialValue = initialValue;
		this.resolve = resolve;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		this.setTitle("AskMate input");
		const messageEl = contentEl.createEl("p", { cls: "askmate-modal-message", text: this.message });
		applyDialogSemantics(this, messageEl);
		this.inputEl = contentEl.createEl("input", { type: "text", value: this.initialValue });
		// The message names the field through aria-labelledby on the dialog and aria-describedby here; a second label would repeat it.
		this.inputEl.setAttribute("aria-describedby", messageEl.id);
		this.inputEl.addClass("askmate-modal-input");
		this.inputEl.addEventListener("keydown", (event) => {
			// Enter while an IME candidate is open commits the candidate, not the prompt.
			if (event.key === "Enter" && !event.isComposing) {
				event.preventDefault();
				this.finish(this.inputEl?.value ?? "");
			}
		});
		const actions = createButtonRow(contentEl);
		addModalButton(actions, "Cancel", { onClick: () => this.finish(null) });
		addModalButton(actions, "Continue", { cta: true, onClick: () => this.finish(this.inputEl?.value ?? "") });
		this.inputEl.focus();
		this.inputEl.select();
	}

	onClose(): void {
		this.finish(null);
	}

	private finish(value: string | null): void {
		if (this.resolved) {
			return;
		}
		this.resolved = true;
		this.resolve(value);
		this.close();
	}
}

const DIFF_ROW_LABELS: Readonly<Record<string, string>> = {
	added: "Added line",
	removed: "Removed line",
	context: "Unchanged line",
	omitted: "Skipped lines"
};

export class AskMateDiffConfirmModal extends Modal {
	private readonly options: DiffConfirmOptions;
	private resolved = false;

	constructor(app: App, options: DiffConfirmOptions) {
		super(app);
		this.options = options;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		// Obsidian sizes the dialog on modalEl, so the wide layout class must go there.
		this.modalEl.addClass("askmate-modal-wide");
		contentEl.addClass("askmate-diff-modal");
		const title = this.options.scope === "selected-text"
			? "Apply AskMate output to selected text?"
			: this.options.scope === "append"
				? "Append AskMate output to the captured note?"
				: this.options.scope === "heading-section"
					? "Replace this heading section with AskMate output?"
					: "Replace the full note with AskMate output?";
		this.setTitle(title);
		const targetEl = contentEl.createDiv({ cls: "askmate-diff-summary", text: this.options.targetLabel });
		applyDialogSemantics(this, targetEl);
		contentEl.createDiv({
			cls: "askmate-diff-summary",
			text: `Before: ${this.options.before.split(/\r?\n/).length} lines, ${this.options.before.length.toLocaleString()} chars. After: ${this.options.after.split(/\r?\n/).length} lines, ${this.options.after.length.toLocaleString()} chars.`
		});
		const stats = getMarkdownDiffStats(this.options.before, this.options.after);
		contentEl.createDiv({
			cls: "askmate-diff-summary",
			text: `${stats.removed.toLocaleString()} line${stats.removed === 1 ? "" : "s"} removed, ${stats.added.toLocaleString()} line${stats.added === 1 ? "" : "s"} added.`
		});
		if (this.options.warning) {
			contentEl.createDiv({ cls: "askmate-diff-warning", text: this.options.warning });
		}
		const rows = buildMarkdownLineDiff(this.options.before, this.options.after).map((line) => ({ line, marked: markInvisibleCharacters(line.text) }));
		const flaggedCount = rows.filter((row) => row.marked.flagged).length;
		if (flaggedCount > 0) {
			contentEl.createDiv({
				cls: "askmate-diff-warning",
				text: `${flaggedCount.toLocaleString()} ${flaggedCount === 1 ? "line holds" : "lines hold"} characters you cannot normally see, such as zero-width or text direction controls. They are shown in square brackets, for example [U+200B].`
			});
		}
		// The changes are a labelled region that the keyboard can reach, because the view can be long and scrolls.
		const diffEl = contentEl.createDiv({ cls: "askmate-diff-view", attr: { role: "region", tabindex: "0", "aria-label": "Changes" } });
		for (const { line, marked } of rows) {
			const row = diffEl.createDiv({ cls: `askmate-diff-line askmate-diff-line-${line.kind}${marked.flagged ? " is-flagged" : ""}` });
			row.createSpan({ cls: "askmate-visually-hidden", text: `${DIFF_ROW_LABELS[line.kind] ?? "Line"}${marked.flagged ? " with hidden characters" : ""}: ` });
			row.createSpan({ cls: "askmate-diff-line-number", text: line.oldLineNumber === null ? "" : String(line.oldLineNumber), attr: { "aria-hidden": "true" } });
			row.createSpan({ cls: "askmate-diff-line-number", text: line.newLineNumber === null ? "" : String(line.newLineNumber), attr: { "aria-hidden": "true" } });
			const marker = line.kind === "added" ? "+" : line.kind === "removed" ? "-" : line.kind === "omitted" ? "…" : " ";
			row.createSpan({ text: `${marker} ${marked.text}` });
		}
		const actions = createButtonRow(contentEl);
		addModalButton(actions, "Cancel", { onClick: () => this.finish(false) }).focus();
		addModalButton(actions, "Apply", { cta: true, onClick: () => this.finish(true) });
	}

	onClose(): void {
		this.finish(false);
	}

	private finish(value: boolean): void {
		if (this.resolved) {
			return;
		}
		this.resolved = true;
		this.options.resolve(value);
		this.close();
	}
}

export class AskMateTextViewerModal extends Modal {
	private readonly title: string;
	private readonly value: string;

	constructor(app: App, title: string, value: string) {
		super(app);
		this.title = title;
		this.value = value;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		this.modalEl.addClass("askmate-modal-wide");
		contentEl.addClass("askmate-prompt-inspector");
		this.setTitle(this.title);
		applyDialogSemantics(this);
		const textarea = contentEl.createEl("textarea", { cls: "askmate-prompt-inspector-textarea" });
		textarea.setAttribute("aria-label", this.title);
		textarea.value = this.value;
		textarea.readOnly = true;
		textarea.rows = 14;
		const actions = createButtonRow(contentEl);
		addModalButton(actions, "Copy", { onClick: () => void copyWithNotice(this.value, "the text") });
		addModalButton(actions, "Close", { cta: true, onClick: () => this.close() }).focus();
	}
}

export class AskMatePromptInspectorModal extends Modal {
	private readonly inspection: PromptInspection & Partial<Pick<InspectedPrompt, "addedAtSend">>;

	constructor(app: App, inspection: PromptInspection & Partial<Pick<InspectedPrompt, "addedAtSend">>) {
		super(app);
		this.inspection = inspection;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		this.modalEl.addClass("askmate-modal-wide");
		contentEl.addClass("askmate-prompt-inspector");
		this.setTitle("Final prompt inspector");
		const metaEl = contentEl.createDiv({
			cls: "askmate-prompt-inspector-meta",
			text: `${this.inspection.providerName}: ${this.inspection.model} · about ${formatTokenCount(this.inspection.estimatedInputTokens)} input tokens · ${formatRequestIntent(this.inspection.request.metadata.intentKind)}`
		});
		applyDialogSemantics(this, metaEl);
		if (this.inspection.blockers.length > 0) {
			contentEl.createDiv({ cls: "askmate-budget-warning askmate-budget-blocker", text: this.inspection.blockers.join(" ") });
		}
		if (this.inspection.warnings.length > 0) {
			contentEl.createDiv({ cls: "askmate-budget-warning", text: this.inspection.warnings.join(" ") });
		}
		// What a run adds after this text is not built until it starts, so it is named rather than left out silently.
		for (const note of this.inspection.addedAtSend ?? []) {
			contentEl.createEl("p", { cls: "askmate-settings-note", text: note });
		}
		this.renderTextarea(contentEl, "Instructions", this.inspection.instructions);
		this.renderTextarea(contentEl, "Final prompt", this.inspection.input);
		if (this.inspection.secondaryInput.trim()) {
			this.renderTextarea(contentEl, "Secondary image prompt", this.inspection.secondaryInput);
		}
		const actions = createButtonRow(contentEl);
		addModalButton(actions, "Copy final prompt", { onClick: () => void copyWithNotice(this.inspection.input, "the final prompt") });
		addModalButton(actions, "Close", { cta: true, onClick: () => this.close() }).focus();
	}

	private renderTextarea(parent: HTMLElement, label: string, value: string): void {
		const labelEl = parent.createEl("label", { cls: "askmate-prompt-inspector-label", text: label });
		const textarea = parent.createEl("textarea", { cls: "askmate-prompt-inspector-textarea" });
		const id = `askmate-inspector-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
		labelEl.htmlFor = id;
		textarea.id = id;
		textarea.value = value;
		textarea.readOnly = true;
		textarea.rows = 10;
	}
}

export class AskMateNoteHistoryModal extends Modal {
	private readonly plugin: AskMatePlugin;
	private readonly sourcePath: string;

	constructor(app: App, plugin: AskMatePlugin, sourcePath: string) {
		super(app);
		this.plugin = plugin;
		this.sourcePath = sourcePath;
	}

	onOpen(): void {
		this.render();
	}

	private render(): void {
		const { contentEl } = this;
		contentEl.empty();
		this.modalEl.addClass("askmate-modal-wide");
		contentEl.addClass("askmate-note-history");
		this.setTitle("AskMate note history");
		const metaEl = contentEl.createDiv({ cls: "askmate-note-history-meta", text: this.sourcePath || "No active note" });
		applyDialogSemantics(this, metaEl);
		const turns = this.plugin.getNoteHistoryForPath(this.sourcePath).slice().reverse();
		if (turns.length === 0) {
			contentEl.createDiv({ cls: "askmate-usage-empty", text: "No AskMate history for this note yet." });
		} else {
			for (const turn of turns) {
				const card = contentEl.createDiv({ cls: "askmate-note-history-turn" });
				card.createDiv({ cls: "askmate-note-history-meta", text: `${formatUsageTimestamp(turn.createdAt)} · ${turn.providerName}: ${turn.model} · ${formatOutputMode(turn.outputMode)}` });
				card.createEl("strong", { text: turn.title });
				card.createEl("p", { text: truncateLabel(turn.question, 220) });
				card.createEl("p", { text: truncateLabel(turn.answer, 300) });
				const turnActions = card.createDiv({ cls: "askmate-note-history-actions" });
				const showQuestion = turnActions.createEl("button", { text: "Show question" });
				showQuestion.type = "button";
				showQuestion.addEventListener("click", () => new AskMateTextViewerModal(this.app, "AskMate question", turn.question).open());
				const showAnswer = turnActions.createEl("button", { text: "Show answer" });
				showAnswer.type = "button";
				showAnswer.addEventListener("click", () => new AskMateTextViewerModal(this.app, "AskMate answer", turn.answer).open());
			}
		}
		const actions = createButtonRow(contentEl);
		const clearButton = addModalButton(actions, "Clear note history", {
			warning: true,
			onClick: () => {
				void askMateConfirm(this.app, `Clear the stored AskMate history for "${this.sourcePath}"? The conversations you saved in the sidebar are not affected.`, {
					title: "Clear note history",
					confirmLabel: "Clear history",
					destructive: true
				}).then(async (confirmed) => {
					if (!confirmed) {
						return;
					}
					await this.plugin.clearNoteHistoryForPath(this.sourcePath);
					this.render();
				}).catch((error) => new Notice(this.plugin.getErrorMessage(error)));
			}
		});
		clearButton.disabled = turns.length === 0;
		addModalButton(actions, "Close", { cta: true, onClick: () => this.close() });
	}
}

export function askMateDiffConfirm(app: App, options: Omit<DiffConfirmOptions, "resolve">): Promise<boolean> {
	return new Promise((resolve) => {
		new AskMateDiffConfirmModal(app, { ...options, resolve }).open();
	});
}

/**
 * Asks a yes or no question. Cancel keeps the focus, and Escape or closing the dialog answers no. Pass `title`, `confirmLabel`
 * and `destructive` so the button says what it will do instead of "Confirm".
 */
export function askMateConfirm(app: App, message: string, options: ConfirmOptions = {}): Promise<boolean> {
	return new Promise((resolve) => {
		new AskMateConfirmModal(app, message, options, resolve).open();
	});
}

export function askMatePrompt(app: App, message: string, initialValue = ""): Promise<string | null> {
	return new Promise((resolve) => {
		new AskMatePromptModal(app, message, initialValue, resolve).open();
	});
}
