/**
 * Pure rules for what a result note holds: which name it gets, that the answer is always in it, and that a cut-off
 * answer says so. The plugin renders the template and writes the file; nothing here touches the vault.
 */
import { analyzeTemplate, splitMarkdownFrontmatter, trimOuterBlankLines } from "../output";
import { sanitizeFileName } from "../output/paths";

const DEFAULT_ANSWER_TITLE = "AskMate Answer";
const MAX_QUESTION_TITLE = 60;

export interface ResultTitleInput {
	title: string;
	question: string;
	workflowName: string | null;
	sourceBasename: string | null;
}

/**
 * A name that says what the note is. A workflow result is "<workflow> - <note>", so a batch never writes a hundred notes
 * with one title. A free-form answer with the stock title takes the first line of the question. Anything the caller
 * titled on purpose is kept.
 */
export function deriveResultNoteTitle(input: ResultTitleInput): string {
	const workflow = input.workflowName?.trim() ?? "";
	const source = input.sourceBasename?.trim() ?? "";
	if (workflow && source) {
		return `${workflow} - ${source}`;
	}
	if (input.title.trim() !== DEFAULT_ANSWER_TITLE) {
		return input.title;
	}
	const firstLine = input.question.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "";
	const shortened = firstLine.length > MAX_QUESTION_TITLE ? `${firstLine.slice(0, MAX_QUESTION_TITLE - 1).trimEnd()}...` : firstLine;
	return shortened || input.title;
}

/** File name for a derived title, with the fallback the vault code already uses. */
export function resultNoteBaseName(input: ResultTitleInput): string {
	return sanitizeFileName(deriveResultNoteTitle(input));
}

/**
 * A template is the user's to edit, and one without {{response}} would write a note with no answer in it. When the
 * template never places the variable, the answer is appended under its own heading.
 */
export function ensureTemplateKeepsAnswer(
	rendered: string,
	template: string,
	variable: "response" | "imageEmbed",
	value: string
): string {
	if (!value.trim() || analyzeTemplate(template, [variable]).placeholders.includes(variable)) {
		return rendered;
	}
	const heading = variable === "response" ? "Response" : "Image";
	return `${trimOuterBlankLines(rendered)}\n\n## ${heading}\n\n${value.trim()}\n`;
}

/** The callout placed above a reply that stopped early, so a saved note never passes for a finished one. */
export function buildIncompleteCallout(reason: string): string {
	const why = reason.trim() ? ` The provider stopped it (${reason.trim()}).` : "";
	return `> [!warning] Incomplete reply\n> This answer was cut off.${why} Check it before relying on it, or ask again.`;
}

/** Puts the callout below the note's frontmatter, if it has any, so the properties stay valid. */
export function withIncompleteCallout(note: string, reason: string | null | undefined): string {
	if (!reason) {
		return note;
	}
	const callout = buildIncompleteCallout(reason);
	const block = splitMarkdownFrontmatter(note);
	if (block.exists && !block.malformed) {
		const eol = note.includes("\r\n") ? "\r\n" : "\n";
		// The split drops the blank lines after the properties, so they are put back around the callout.
		return `${block.frontmatter}${eol}${eol}${callout.replace(/\n/g, eol)}${eol}${eol}${block.body}`;
	}
	return `${callout}\n\n${note}`;
}
