import { Modal, type App } from "obsidian";
import type { Skill } from "../../skills";
import { buildMarkdownLineDiff, getMarkdownDiffStats } from "../../shared/core";
import { addModalButton, applyDialogSemantics, createButtonRow } from "./dialog";
import { markInvisibleCharacters } from "./invisibleChars";

export interface SkillReviewModel {
	title: string;
	intro: string;
	/** Text recovered from invisible tag characters. Always shown prominently, because it is how instructions are hidden. */
	hiddenText: string | null;
	/** What AskMate removes before the model sees the skill, so the person knows the model's view differs from the file. */
	removed: readonly string[];
	/** Advisory findings. They help a reader look in the right place and never block a skill. */
	findings: readonly { label: string; excerpt: string; hidden: boolean }[];
	/** Problems with the file itself, for example a name that was normalised. */
	notes: readonly string[];
	/** Parts of the Agent Skills format this version ignores. */
	ignored: readonly string[];
	/** Set when an earlier version was approved in this session: how much changed since. */
	changeSummary: string | null;
	confirmLabel: string;
	cancelLabel: string;
}

function plural(count: number, noun: string): string {
	return `${count.toLocaleString("en-GB")} ${noun}${count === 1 ? "" : "s"}`;
}

/** The words of the review dialog, with nothing drawn yet. */
export function buildSkillReviewModel(skill: Skill, previousRaw: string | null = null): SkillReviewModel {
	const { invisibleRemoved, commentsRemoved, hiddenText } = skill.sanitised;
	const removed = [
		invisibleRemoved > 0 ? `${plural(invisibleRemoved, "invisible character")} (zero-width, text direction and tag characters)` : null,
		commentsRemoved > 0 ? `${plural(commentsRemoved, "comment")} (HTML and %% comments)` : null
	].filter((line): line is string => line !== null);
	let changeSummary: string | null = null;
	if (previousRaw !== null && previousRaw !== skill.raw) {
		const stats = getMarkdownDiffStats(previousRaw, skill.raw);
		changeSummary = `Since the version you approved: ${plural(stats.removed, "line")} removed, ${plural(stats.added, "line")} added.`;
	}
	return {
		title: previousRaw === null ? `Review the skill "${skill.manifest.title || skill.name}"` : `Review the changed skill "${skill.manifest.title || skill.name}"`,
		intro: "A skill is text that AskMate adds to its instructions when the skill is used. Read all of it before you approve. If the file changes later, AskMate asks you to review it again.",
		hiddenText: hiddenText.trim() ? hiddenText.trim() : null,
		removed,
		findings: skill.lint.map((finding) => ({ label: finding.label, excerpt: finding.excerpt, hidden: finding.hidden })),
		notes: skill.diagnostics.map((diagnostic) => diagnostic.message),
		ignored: skill.ignored,
		changeSummary,
		confirmLabel: "Approve this version",
		cancelLabel: "Cancel"
	};
}

/**
 * The skill review dialog. It shows the raw text with hidden characters made visible, what AskMate strips, advisory findings and,
 * for a skill that was approved earlier in this session, a diff. Cancel keeps the focus, and leaving the dialog any other way
 * answers no.
 */
export class SkillReviewModal extends Modal {
	private resolved = false;

	constructor(
		app: App,
		private readonly skill: Skill,
		private readonly previousRaw: string | null,
		private readonly resolve: (approved: boolean) => void
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl, skill } = this;
		const model = buildSkillReviewModel(skill, this.previousRaw);
		contentEl.empty();
		this.modalEl.addClass("askmate-skill-review-modal");
		this.modalEl.addClass("askmate-modal-wide");
		this.setTitle(model.title);
		const intro = contentEl.createEl("p", { cls: "askmate-modal-message", text: model.intro });
		applyDialogSemantics(this, intro);

		contentEl.createEl("p", { cls: "askmate-settings-note", text: `File: ${skill.path || "built-in"} · ${plural(skill.characters, "character")} after cleaning` });
		if (model.hiddenText) {
			contentEl.createDiv({
				cls: "askmate-settings-callout is-warning",
				text: `Hidden text found in invisible characters: "${model.hiddenText}". Approve only if you wrote it.`,
				attr: { role: "alert" }
			});
		}
		for (const finding of model.findings) {
			contentEl.createDiv({
				cls: "askmate-settings-callout is-warning",
				text: `${finding.label}${finding.hidden ? " (in hidden text)" : ""}: ${finding.excerpt}`
			});
		}
		if (model.removed.length > 0) {
			contentEl.createEl("p", { cls: "askmate-settings-note", text: `AskMate removes these before the model sees the skill: ${model.removed.join("; ")}.` });
		}
		for (const note of model.notes) {
			contentEl.createEl("p", { cls: "askmate-settings-note", text: note });
		}
		if (model.ignored.length > 0) {
			contentEl.createEl("p", { cls: "askmate-settings-note", text: `Not used by AskMate: ${model.ignored.join(", ")}. Skills here are instructions only.` });
		}

		const label = contentEl.createEl("label", { cls: "askmate-prompt-inspector-label", text: "Skill text, exactly as saved" });
		const textarea = contentEl.createEl("textarea", { cls: "askmate-prompt-inspector-textarea" });
		const id = "askmate-skill-review-text";
		label.htmlFor = id;
		textarea.id = id;
		textarea.readOnly = true;
		textarea.rows = 14;
		textarea.value = markInvisibleCharacters(skill.raw).text;

		if (model.changeSummary && this.previousRaw !== null) {
			contentEl.createEl("p", { cls: "askmate-modal-message", text: model.changeSummary });
			const diffEl = contentEl.createDiv({ cls: "askmate-diff-view", attr: { role: "region", tabindex: "0", "aria-label": "Changes since you approved this skill" } });
			for (const line of buildMarkdownLineDiff(this.previousRaw, skill.raw)) {
				const row = diffEl.createDiv({ cls: `askmate-diff-line askmate-diff-line-${line.kind}` });
				const prefix = line.kind === "added" ? "Added line: " : line.kind === "removed" ? "Removed line: " : line.kind === "omitted" ? "Skipped lines: " : "Unchanged line: ";
				row.createSpan({ cls: "askmate-visually-hidden", text: prefix });
				const marker = line.kind === "added" ? "+" : line.kind === "removed" ? "-" : line.kind === "omitted" ? "..." : " ";
				row.createSpan({ text: `${marker} ${markInvisibleCharacters(line.text).text}` });
			}
		}

		const actions = createButtonRow(contentEl);
		addModalButton(actions, model.cancelLabel, { onClick: () => this.finish(false) }).focus();
		addModalButton(actions, model.confirmLabel, { cta: true, onClick: () => this.finish(true) });
	}

	onClose(): void {
		this.finish(false);
	}

	private finish(approved: boolean): void {
		if (this.resolved) {
			return;
		}
		this.resolved = true;
		this.resolve(approved);
		this.close();
	}
}

/** Opens the review dialog and resolves true only when the person approved this exact version. */
export function askSkillReview(app: App, skill: Skill, previousRaw: string | null = null): Promise<boolean> {
	return new Promise((resolve) => {
		new SkillReviewModal(app, skill, previousRaw, resolve).open();
	});
}
