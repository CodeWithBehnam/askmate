/**
 * Rules for putting text into the composer without destroying what the user was typing. Edit on a past question and
 * Use reply both bring text into the composer; if a draft is already there, the new text goes below it behind a
 * separator, and the previous draft is kept for one level of undo.
 */

export const DRAFT_SEPARATOR = "\n\n---\n\n";

export interface DraftChange {
	/** The text the composer should hold. */
	text: string;
	/** True when the incoming text was added below an existing draft. */
	appended: boolean;
	/** What the composer held before, or null when nothing was there and no undo is needed. */
	previous: string | null;
}

export function mergeIntoDraft(current: string, incoming: string): DraftChange {
	const next = incoming.trim();
	if (!current.trim()) {
		return { text: next, appended: false, previous: null };
	}
	if (!next) {
		return { text: current, appended: false, previous: null };
	}
	// The same text again is not worth a second copy.
	if (current.trim() === next || current.trimEnd().endsWith(next)) {
		return { text: current, appended: false, previous: null };
	}
	return { text: `${current.trimEnd()}${DRAFT_SEPARATOR}${next}`, appended: true, previous: current };
}

/** One level of undo for the last merge. A second merge replaces it. */
export interface DraftUndo {
	previous: string;
	/** What the merge produced; the undo is offered only while the composer still holds exactly this. */
	merged: string;
}

export function canUndoDraft(undo: DraftUndo | null, currentValue: string): undo is DraftUndo {
	return undo !== null && undo.merged === currentValue;
}
