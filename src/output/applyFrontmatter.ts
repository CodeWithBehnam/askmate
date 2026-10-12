import type { FrontmatterApplyPolicy } from "../shared/types";
import { splitMarkdownFrontmatter } from "./applyMath";

export interface FrontmatterApplyPlan {
	/** The note content to write, in the note's own line endings. */
	text: string;
	/** Short sentence for the Apply preview, or an empty string. */
	warning: string;
	/** A question the caller must put to the user first. If the user declines, the apply is cancelled. */
	confirm?: string;
}

function detectEol(text: string): "\r\n" | "\n" {
	return text.includes("\r\n") ? "\r\n" : "\n";
}

function normaliseToLf(text: string): string {
	return text.replace(/\r\n/g, "\n");
}

/**
 * Decides what a full-note Apply writes when the model's reply may or may not carry frontmatter, following the
 * frontmatter policy. It is pure: a question for the user is returned as `confirm` instead of being asked here.
 *
 * - The note's own frontmatter is read leniently, so it is never mistaken for body. The reply's is read strictly, so a
 *   reply that opens with a thematic break keeps all of its text.
 * - Every branch returns text in the note's line endings, so a CRLF note is never converted to LF.
 */
export function prepareFrontmatterAwareApply(before: string, proposed: string, policy: FrontmatterApplyPolicy): FrontmatterApplyPlan {
	const eol = detectEol(before);
	const withNoteLineEndings = (text: string): string => text.replace(/\r?\n/g, eol);
	const beforeBlock = splitMarkdownFrontmatter(before, { requireYaml: false });
	const proposedBlock = splitMarkdownFrontmatter(proposed);
	// An unclosed opening "---" in the reply is body text (often a thematic break), so it is never treated as frontmatter.
	const proposedHasFrontmatter = proposedBlock.exists && !proposedBlock.malformed;

	if (!beforeBlock.exists && !proposedHasFrontmatter) {
		return { text: withNoteLineEndings(proposed), warning: "" };
	}
	if (beforeBlock.malformed) {
		return {
			text: withNoteLineEndings(proposed),
			warning: "Existing YAML frontmatter looked malformed.",
			confirm: "The existing YAML frontmatter appears malformed. Continue with the AI replacement?"
		};
	}
	if (policy === "replace") {
		return {
			text: withNoteLineEndings(proposed),
			warning: proposedHasFrontmatter ? "AskMate will replace YAML frontmatter from the AI output." : ""
		};
	}
	if (policy === "confirm" && normaliseToLf(beforeBlock.frontmatter) !== normaliseToLf(proposedBlock.frontmatter)) {
		return {
			text: withNoteLineEndings(proposed),
			warning: "YAML frontmatter differs from the original note.",
			confirm: "AskMate output changes YAML frontmatter. Continue with the replacement?"
		};
	}
	if (policy === "preserve" && beforeBlock.exists) {
		const body = proposedHasFrontmatter ? proposedBlock.body : proposed;
		return {
			text: `${beforeBlock.frontmatter}${eol}${eol}${withNoteLineEndings(body.trimStart())}`,
			warning: proposedHasFrontmatter
				? "AskMate preserved the original YAML frontmatter and removed AI-proposed frontmatter."
				: "AskMate preserved the original YAML frontmatter."
		};
	}
	if (policy === "preserve" && proposedHasFrontmatter) {
		return {
			text: withNoteLineEndings(proposedBlock.body.trimStart()),
			warning: "AskMate preserved the original no-frontmatter state and removed AI-proposed frontmatter."
		};
	}
	return { text: withNoteLineEndings(proposed), warning: "" };
}
