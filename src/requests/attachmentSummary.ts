import type { ContextAttachment } from "../shared/types";

// ContextService writes each history message as one "User: " or "AskMate: " line, so user lines count the turns.
const USER_TURN_PATTERN = /^User: /gm;

const plural = (count: number, singular: string, pluralForm = `${singular}s`): string => `${count} ${count === 1 ? singular : pluralForm}`;

/**
 * The preview's attachment line. The threaded chat history is the previous conversation, not something the person
 * attached, so it is reported as earlier turns and kept out of the attachment count.
 */
export function formatAttachmentSummary(attachments: readonly ContextAttachment[]): string {
	const history = attachments.filter((attachment) => attachment.kind === "thread_history");
	const attached = attachments.length - history.length;
	const turns = history.reduce((total, attachment) => total + Math.max(1, attachment.content.match(USER_TURN_PATTERN)?.length ?? 0), 0);
	const parts = [
		...(attached > 0 ? [plural(attached, "attachment")] : []),
		...(turns > 0 ? [`${plural(turns, "earlier turn")}`] : [])
	];
	return parts.length > 0 ? parts.join(", ") : "no attachments";
}
