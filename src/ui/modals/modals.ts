import { App, Modal, Notice, Setting } from "obsidian";
import type { AskMatePlugin } from "../../plugin/AskMatePlugin";
import {
	buildMarkdownLineDiff,
	formatOutputMode,
	formatRequestIntent,
	formatTokenCount,
	formatUsageTimestamp,
	truncateLabel,
	type DiffConfirmOptions,
	type PromptInspection
} from "../../shared/core";

class AskMateConfirmModal extends Modal {
	private readonly message: string;
	private readonly resolve: (value: boolean) => void;
	private resolved = false;

	constructor(app: App, message: string, resolve: (value: boolean) => void) {
		super(app);
		this.message = message;
		this.resolve = resolve;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		this.setTitle("Confirm AskMate action");
		contentEl.createEl("p", { cls: "askmate-modal-message", text: this.message });
		const actions = contentEl.createDiv({ cls: "askmate-modal-actions" });
		const cancelButton = actions.createEl("button", { text: "Cancel" });
		cancelButton.type = "button";
		cancelButton.addEventListener("click", () => {
			this.finish(false);
		});
		const confirmButton = actions.createEl("button", { cls: "mod-cta", text: "Confirm" });
		confirmButton.type = "button";
		confirmButton.addEventListener("click", () => {
			this.finish(true);
		});
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
		messageEl.id = "askmate-prompt-message";
		this.inputEl = contentEl.createEl("input", { type: "text", value: this.initialValue });
		this.inputEl.setAttribute("aria-label", this.message);
		this.inputEl.setAttribute("aria-describedby", messageEl.id);
		this.inputEl.addClass("askmate-modal-input");
		this.inputEl.addEventListener("keydown", (event) => {
			if (event.key === "Enter") {
				this.finish(this.inputEl?.value ?? "");
			}
			if (event.key === "Escape") {
				this.finish(null);
			}
		});
		const actions = contentEl.createDiv({ cls: "askmate-modal-actions" });
		const cancelButton = actions.createEl("button", { text: "Cancel" });
		cancelButton.type = "button";
		cancelButton.addEventListener("click", () => {
			this.finish(null);
		});
		const submitButton = actions.createEl("button", { cls: "mod-cta", text: "Continue" });
		submitButton.type = "button";
		submitButton.addEventListener("click", () => {
			this.finish(this.inputEl?.value ?? "");
		});
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
		contentEl.addClass("askmate-diff-modal");
		const title = this.options.scope === "selected-text"
			? "Apply AskMate output to selected text?"
			: this.options.scope === "append"
				? "Append AskMate output to the captured note?"
				: this.options.scope === "heading-section"
					? "Replace this heading section with AskMate output?"
					: "Replace the full note with AskMate output?";
		this.setTitle(title);
		contentEl.createDiv({ cls: "askmate-diff-summary", text: this.options.targetLabel });
		contentEl.createDiv({
			cls: "askmate-diff-summary",
			text: `Before: ${this.options.before.split(/\r?\n/).length} lines, ${this.options.before.length.toLocaleString()} chars. After: ${this.options.after.split(/\r?\n/).length} lines, ${this.options.after.length.toLocaleString()} chars.`
		});
		if (this.options.warning) {
			contentEl.createDiv({ cls: "askmate-diff-warning", text: this.options.warning });
		}
		const diffEl = contentEl.createDiv({ cls: "askmate-diff-view" });
		for (const line of buildMarkdownLineDiff(this.options.before, this.options.after)) {
			const row = diffEl.createDiv({ cls: `askmate-diff-line askmate-diff-line-${line.kind}` });
			row.createSpan({ cls: "askmate-diff-line-number", text: line.oldLineNumber === null ? "" : String(line.oldLineNumber) });
			row.createSpan({ cls: "askmate-diff-line-number", text: line.newLineNumber === null ? "" : String(line.newLineNumber) });
			row.createSpan({ text: `${line.kind === "added" ? "+" : line.kind === "removed" ? "-" : " "} ${line.text}` });
		}
		const actions = contentEl.createDiv({ cls: "askmate-modal-actions" });
		const cancelButton = actions.createEl("button", { text: "Cancel" });
		cancelButton.type = "button";
		cancelButton.addEventListener("click", () => this.finish(false));
		const applyButton = actions.createEl("button", { cls: "mod-cta", text: "Apply" });
		applyButton.type = "button";
		applyButton.addEventListener("click", () => this.finish(true));
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
		contentEl.addClass("askmate-prompt-inspector");
		this.setTitle(this.title);
		const textarea = contentEl.createEl("textarea", { cls: "askmate-prompt-inspector-textarea" });
		textarea.setAttribute("aria-label", this.title);
		textarea.value = this.value;
		textarea.readOnly = true;
		textarea.rows = 14;
		const actions = contentEl.createDiv({ cls: "askmate-modal-actions" });
		const closeButton = actions.createEl("button", { cls: "mod-cta", text: "Close" });
		closeButton.type = "button";
		closeButton.addEventListener("click", () => this.close());
		closeButton.focus();
	}
}

export class AskMatePromptInspectorModal extends Modal {
	private readonly inspection: PromptInspection;

	constructor(app: App, inspection: PromptInspection) {
		super(app);
		this.inspection = inspection;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("askmate-prompt-inspector");
		this.setTitle("Final prompt inspector");
		contentEl.createDiv({
			cls: "askmate-prompt-inspector-meta",
			text: `${this.inspection.providerName}: ${this.inspection.model} · about ${formatTokenCount(this.inspection.estimatedInputTokens)} input tokens · ${formatRequestIntent(this.inspection.request.metadata.intentKind)}`
		});
		if (this.inspection.blockers.length > 0) {
			contentEl.createDiv({ cls: "askmate-budget-blocker", text: this.inspection.blockers.join(" ") });
		}
		if (this.inspection.warnings.length > 0) {
			contentEl.createDiv({ cls: "askmate-budget-warning", text: this.inspection.warnings.join(" ") });
		}
		this.renderTextarea(contentEl, "Instructions", this.inspection.instructions);
		this.renderTextarea(contentEl, "Final prompt", this.inspection.input);
		if (this.inspection.secondaryInput.trim()) {
			this.renderTextarea(contentEl, "Secondary image prompt", this.inspection.secondaryInput);
		}
		const actions = contentEl.createDiv({ cls: "askmate-modal-actions" });
		const closeButton = actions.createEl("button", { cls: "mod-cta", text: "Close" });
		closeButton.type = "button";
		closeButton.addEventListener("click", () => this.close());
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
		contentEl.addClass("askmate-note-history");
		this.setTitle("AskMate note history");
		contentEl.createDiv({ cls: "askmate-note-history-meta", text: this.sourcePath || "No active note" });
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
				const actions = card.createDiv({ cls: "askmate-note-history-actions" });
				const showQuestion = actions.createEl("button", { text: "Show question" });
				showQuestion.type = "button";
				showQuestion.addEventListener("click", () => new AskMateTextViewerModal(this.app, "AskMate question", turn.question).open());
				const showAnswer = actions.createEl("button", { text: "Show answer" });
				showAnswer.type = "button";
				showAnswer.addEventListener("click", () => new AskMateTextViewerModal(this.app, "AskMate answer", turn.answer).open());
			}
		}
		const actions = contentEl.createDiv({ cls: "askmate-modal-actions" });
		const clearButton = actions.createEl("button", { cls: "mod-warning", text: "Clear note history" });
		clearButton.type = "button";
		clearButton.disabled = turns.length === 0;
		clearButton.addEventListener("click", () => {
			void askMateConfirm(this.app, `Clear stored AskMate history for "${this.sourcePath}"?`).then(async (confirmed) => {
				if (!confirmed) {
					return;
				}
				await this.plugin.clearNoteHistoryForPath(this.sourcePath);
				this.render();
			}).catch((error) => new Notice(this.plugin.getErrorMessage(error)));
		});
		const closeButton = actions.createEl("button", { cls: "mod-cta", text: "Close" });
		closeButton.type = "button";
		closeButton.addEventListener("click", () => this.close());
	}
}

export function askMateDiffConfirm(app: App, options: Omit<DiffConfirmOptions, "resolve">): Promise<boolean> {
	return new Promise((resolve) => {
		new AskMateDiffConfirmModal(app, { ...options, resolve }).open();
	});
}

export function askMateConfirm(app: App, message: string): Promise<boolean> {
	return new Promise((resolve) => {
		new AskMateConfirmModal(app, message, resolve).open();
	});
}

export function askMatePrompt(app: App, message: string, initialValue = ""): Promise<string | null> {
	return new Promise((resolve) => {
		new AskMatePromptModal(app, message, initialValue, resolve).open();
	});
}
