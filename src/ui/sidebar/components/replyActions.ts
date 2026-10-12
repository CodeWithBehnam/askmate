/**
 * Which actions a reply offers. Three stay in view (Insert, Copy, Apply); the rest sit in one menu with text labels,
 * and the items that change a note come after a separator so a read-only action is never next to a write.
 */

export type ReplyActionId =
	| "insert"
	| "copy"
	| "apply"
	| "show-text"
	| "use-reply"
	| "rerun-without-skill"
	| "queue"
	| "new-note"
	| "replace-note"
	| "apply-selection"
	| "apply-heading";

export interface ReplyActionSpec {
	id: ReplyActionId;
	label: string;
	icon: string;
	/** Needs the sidebar idle, because it writes or queues something. */
	requiresIdle: boolean;
	/** Why the action is off, or null. */
	disabledReason: string | null;
}

export interface ReplyActionContext {
	/** A reply restored from a saved conversation has no request behind it, so only Insert and Copy work. */
	hasRequest: boolean;
	/** Context source of the request: "Current note", "Selected text", or "No note". */
	source: string;
	/** An automatic skill shaped this reply. */
	skillWasAutomatic: boolean;
	/** Set when the reply must not be written anywhere, for example a diagram that did not draw. */
	writeBlockedReason: string | null;
}

export interface ReplyActionPlan {
	primary: ReplyActionSpec[];
	/** Read-only items, then (after the separator) the items that change a note. */
	menuRead: ReplyActionSpec[];
	menuWrite: ReplyActionSpec[];
}

export const NO_NOTE_APPLY_REASON = "Open a note to apply this reply to it.";

export function planReplyActions(context: ReplyActionContext): ReplyActionPlan {
	const noNote = context.source === "No note";
	const writeReason = context.writeBlockedReason ?? (noNote ? NO_NOTE_APPLY_REASON : null);
	const spec = (id: ReplyActionId, label: string, icon: string, requiresIdle: boolean, disabledReason: string | null = null): ReplyActionSpec => ({
		id,
		label,
		icon,
		requiresIdle,
		disabledReason
	});
	const primary: ReplyActionSpec[] = [
		spec("insert", "Insert", "text-cursor-input", false, context.writeBlockedReason),
		spec("copy", "Copy", "copy", false)
	];
	const menuRead: ReplyActionSpec[] = [
		spec("show-text", "Show reply text", "eye", false),
		spec("use-reply", "Use reply as a new question", "corner-down-left", false)
	];
	if (!context.hasRequest) {
		return { primary, menuRead, menuWrite: [] };
	}
	primary.push(spec("apply", "Apply", "pencil", true, writeReason));
	if (context.skillWasAutomatic) {
		menuRead.push(spec("rerun-without-skill", "Run again without skill", "rotate-ccw", true));
	}
	const menuWrite: ReplyActionSpec[] = [
		spec("queue", "Queue for review", "inbox", true, writeReason),
		spec("new-note", "Save as new note", "file-plus", true, context.writeBlockedReason)
	];
	if (context.source === "Current note") {
		menuWrite.push(spec("replace-note", "Replace the whole note", "replace", true, writeReason));
	}
	if (context.source === "Selected text") {
		menuWrite.push(spec("apply-selection", "Apply to the selected text", "text-select", true, writeReason));
	}
	menuWrite.push(spec("apply-heading", "Apply to a heading", "heading-1", true, writeReason));
	return { primary, menuRead, menuWrite };
}
