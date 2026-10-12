/**
 * The safety rules for model text that is about to become vault content. Every write path (Apply, append, Insert, result
 * notes, the review queue, exports) goes through prepareReplyForWrite, so the same defusing and the same warnings apply
 * whichever button the person pressed.
 */
import { detectActiveContent, planRangeEdit, prepareModelOutputForWrite, type Finding } from "../safety";

export interface PreparedWrite {
	text: string;
	/** True when the text was altered to make it safe. */
	changed: boolean;
	findings: Finding[];
}

export interface WriteOptions {
	/**
	 * The text this reply replaces. Constructs it already holds are left alone one for one, so a faithful rewrite of a note
	 * that has a Dataview block keeps it. Leave it out for text that is added beside the note or goes into a new note.
	 */
	sourceText?: string;
	/** The reply holds a diagram that AskMate validated, so the header it built is allowed through. */
	allowDiagramHeader?: boolean;
}

export function prepareReplyForWrite(text: string, options: WriteOptions = {}): PreparedWrite {
	const prepared = prepareModelOutputForWrite(text, {
		...(options.sourceText === undefined ? {} : { sourceText: options.sourceText }),
		...(options.allowDiagramHeader ? { allowPluginMermaidHeader: true } : {})
	});
	return { text: prepared.text, changed: prepared.changed, findings: prepared.findings };
}

const MAX_MESSAGES_SHOWN = 3;

/** One sentence that says what was changed, for the preview and confirm dialogs. Empty when nothing was. */
export function describeWriteChanges(prepared: Pick<PreparedWrite, "changed" | "findings">): string {
	if (!prepared.changed) {
		return "";
	}
	const messages = [...new Set(prepared.findings.map((finding) => finding.message))];
	if (messages.length === 0) {
		return "AskMate changed the reply to make it safe to write into a note.";
	}
	const shown = messages.slice(0, MAX_MESSAGES_SHOWN).join(" ");
	const more = messages.length > MAX_MESSAGES_SHOWN ? ` ${messages.length - MAX_MESSAGES_SHOWN} more changes were made.` : "";
	return `AskMate changed the reply before writing it. ${shown}${more}`;
}

/**
 * A second look at what an Apply really adds. The text the edit inserts is scanned for anything that stays active in a
 * note, so even auto-approve stops when the reply reaches the note carrying something it should not.
 */
export function describeActiveContentAdded(before: string, after: string): string {
	const added = planRangeEdit(before, after).insert;
	if (!added.trim()) {
		return "";
	}
	const findings = detectActiveContent(added);
	if (findings.length === 0) {
		return "";
	}
	const kinds = [...new Set(findings.map((finding) => finding.message))].slice(0, MAX_MESSAGES_SHOWN).join(" ");
	return `The text this adds holds ${findings.length === 1 ? "something" : `${findings.length} things`} that stays active in a note. ${kinds}`;
}

/** Joins the non-empty warnings into one paragraph. */
export function joinWarnings(...parts: ReadonlyArray<string | undefined>): string {
	return parts.filter((part): part is string => typeof part === "string" && part.trim() !== "").join(" ");
}
